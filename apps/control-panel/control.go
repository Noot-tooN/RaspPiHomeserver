package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

type audioState struct {
	Available bool   `json:"available"`
	Volume    int    `json:"volume"`
	Muted     bool   `json:"muted"`
	Error     string `json:"error,omitempty"`
}

type serviceState struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Load   string `json:"load"`
	Active string `json:"active"`
	Sub    string `json:"sub"`
	Result string `json:"result"`
	Error  string `json:"error,omitempty"`
}

type state struct {
	Players  []playerState  `json:"players"`
	Audio    audioState     `json:"audio"`
	Services []serviceState `json:"services"`
}

var services = []struct{ id, name, unit string }{
	{"spotify", "Spotify", "spotify.service"},
	{"youtube", "YouTube", "youtube-tv.service"},
}

func serviceUnit(id string) (string, bool) {
	for _, service := range services {
		if service.id == id {
			return service.unit, true
		}
	}
	return "", false
}

type controller interface {
	Player(context.Context, playerAction) error
	State(context.Context) state
	Volume(context.Context, int) error
	Mute(context.Context, bool) error
	Restart(context.Context, string) error
	PairYouTube(context.Context) (pairingCode, error)
}

type pairingCode struct {
	Code string `json:"code"`
}

var tvCodePattern = regexp.MustCompile(`^[0-9]{12}$`)

type commandRunner func(context.Context, string, ...string) ([]byte, error)

// Bound subprocess output as well as its lifetime. stderr is deliberately not
// returned to the browser: it can contain paths or application/account details.
type limitedOutput struct{ bytes.Buffer }

func (b *limitedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 1024*1024 {
		return 0, errors.New("command output limit exceeded")
	}
	return b.Buffer.Write(p)
}

func runCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	return runWithTimeout(ctx, 3*time.Second, name, args...)
}

func runWithTimeout(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	var output limitedOutput
	cmd.Stdout = &output
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

type systemController struct {
	youtubeTitles              youtubeTitleCache
	pactl, systemctl, sink     string
	pairingCommand             string
	spotifyURL, youtubeCommand string
	run                        commandRunner
}

func (c *systemController) PairYouTube(ctx context.Context) (pairingCode, error) {
	var result pairingCode
	if c.pairingCommand == "" {
		return result, errors.New("pairing helper is not configured")
	}
	data, err := runWithTimeout(ctx, 28*time.Second, c.pairingCommand)
	if err != nil {
		return result, err
	}
	if json.Unmarshal(data, &result) != nil || !tvCodePattern.MatchString(result.Code) {
		return pairingCode{}, errors.New("invalid TV pairing code")
	}
	return result, nil
}

func (c *systemController) State(ctx context.Context) state {
	// Independent, bounded reads run together; one slow receiver cannot delay
	// the master-volume and service checks by the sum of all timeouts.
	var result state
	result.Players = make([]playerState, 2)
	var wait sync.WaitGroup
	wait.Add(4)
	go func() { defer wait.Done(); result.Audio = c.audio(ctx) }()
	go func() { defer wait.Done(); result.Services = c.serviceStates(ctx) }()
	go func() { defer wait.Done(); result.Players[0], _ = c.spotify(ctx) }()
	go func() { defer wait.Done(); result.Players[1] = c.youtube(ctx) }()
	wait.Wait()
	return result
}

func (c *systemController) audio(ctx context.Context) audioState {
	data, err := c.run(ctx, c.pactl, "--format=json", "list", "sinks")
	if err != nil {
		return audioState{Error: "Audio server unavailable"}
	}
	var sinks []struct {
		Name   string `json:"name"`
		Mute   bool   `json:"mute"`
		Volume map[string]struct {
			Value uint32 `json:"value"`
		} `json:"volume"`
	}
	if json.Unmarshal(data, &sinks) != nil {
		return audioState{Error: "Could not read audio state"}
	}
	for _, sink := range sinks {
		if sink.Name != c.sink {
			continue
		}
		if len(sink.Volume) == 0 {
			return audioState{Error: "DAC volume unavailable"}
		}
		// Show the loudest channel, like a master fader. pactl's raw volume
		// uses 65536 for 100%, not a linear-amplitude percentage.
		var maximum uint32
		for _, channel := range sink.Volume {
			maximum = max(maximum, channel.Value)
		}
		return audioState{Available: true, Volume: int(math.Round(float64(maximum) * 100 / 65536)), Muted: sink.Mute}
	}
	return audioState{Error: "Waiting for DAC Pro"}
}

func (c *systemController) serviceStates(ctx context.Context) []serviceState {
	args := []string{"--user", "show", "--no-pager", "--property=Id,LoadState,ActiveState,SubState,Result"}
	for _, service := range services {
		args = append(args, service.unit)
	}
	data, err := c.run(ctx, c.systemctl, args...)
	units := make(map[string]map[string]string)
	for _, block := range strings.Split(strings.TrimSpace(string(data)), "\n\n") {
		properties := make(map[string]string)
		for _, line := range strings.Split(block, "\n") {
			key, value, ok := strings.Cut(line, "=")
			if ok {
				properties[key] = value
			}
		}
		units[properties["Id"]] = properties
	}
	result := make([]serviceState, 0, len(services))
	for _, service := range services {
		p := units[service.unit]
		s := serviceState{ID: service.id, Name: service.name, Load: p["LoadState"], Active: p["ActiveState"], Sub: p["SubState"], Result: p["Result"]}
		if err != nil || s.Load == "" || s.Active == "" {
			s.Error = "Service status unavailable"
		} else if s.Load != "loaded" {
			s.Error = "Service not loaded"
		}
		result = append(result, s)
	}
	return result
}

func (c *systemController) Volume(ctx context.Context, volume int) error {
	if volume < 0 || volume > 100 {
		return errors.New("volume out of range")
	}
	_, err := c.run(ctx, c.pactl, "set-sink-volume", c.sink, fmt.Sprintf("%d%%", volume))
	return err
}

func (c *systemController) Mute(ctx context.Context, muted bool) error {
	value := "0"
	if muted {
		value = "1"
	}
	_, err := c.run(ctx, c.pactl, "set-sink-mute", c.sink, value)
	return err
}

func (c *systemController) Restart(ctx context.Context, id string) error {
	unit, ok := serviceUnit(id)
	if !ok {
		return errors.New("unknown service")
	}
	// Queue the restart without keeping an HTTP request open while YouTube
	// shuts down. The next status snapshot reports the actual service state.
	_, err := c.run(ctx, c.systemctl, "--user", "--no-block", "restart", unit)
	return err
}
