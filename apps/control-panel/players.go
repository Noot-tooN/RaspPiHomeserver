package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
)

type playerState struct {
	ID           string   `json:"id"`
	Available    bool     `json:"available"`
	Active       bool     `json:"active"`
	Paused       bool     `json:"paused"`
	Volume       *int     `json:"volume"`
	Muted        bool     `json:"muted"`
	Title        string   `json:"title"`
	Artist       string   `json:"artist,omitempty"`
	TrackID      string   `json:"track_id,omitempty"`
	Capabilities []string `json:"capabilities"`
	Error        string   `json:"error,omitempty"`
}

type playerAction struct {
	Player string `json:"player"`
	Action string `json:"action"`
	Volume *int   `json:"volume,omitempty"`
	URL    string `json:"url,omitempty"`
}

func (a playerAction) valid() bool {
	if a.Player != "spotify" && a.Player != "youtube" {
		return false
	}
	if a.Action == "load" {
		_, err := youtubeVideoID(a.URL)
		return a.Player == "youtube" && a.Volume == nil && err == nil
	}
	if a.URL != "" {
		return false
	}
	switch a.Action {
	case "volume":
		return a.Volume != nil && *a.Volume >= 0 && *a.Volume <= 100
	case "play", "pause", "previous", "next":
		return a.Volume == nil
	}
	return false
}

var youtubeIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// Extract only a video ID. Never fetch the submitted URL or pass it to a shell
// or browser navigation command. Tracking, playlist and timestamp fields are
// ignored: this action plays one video from its beginning.
func youtubeVideoID(raw string) (string, error) {
	invalid := errors.New("Paste a YouTube video link, such as youtube.com/watch?v=… or youtu.be/…")
	if len(raw) > 512 {
		return "", invalid
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.Port() != "" {
		return "", invalid
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return "", invalid
	}
	var id string
	switch strings.ToLower(u.Host) {
	case "youtu.be":
		id = strings.TrimPrefix(u.Path, "/")
	case "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com":
		if u.Path == "/watch" && len(query["v"]) == 1 {
			id = query.Get("v")
		} else {
			for _, prefix := range []string{"/shorts/", "/live/", "/embed/"} {
				if strings.HasPrefix(u.Path, prefix) {
					id = strings.TrimPrefix(u.Path, prefix)
					break
				}
			}
		}
	}
	if !youtubeIDPattern.MatchString(id) {
		return "", invalid
	}
	return id, nil
}

var playerHTTP = &http.Client{
	Timeout:       2 * time.Second,
	Transport:     &http.Transport{Proxy: nil, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func (c *systemController) spotifyRequest(ctx context.Context, method, path string, payload any) ([]byte, int, error) {
	if c.spotifyURL == "" {
		return nil, 0, errors.New("Spotify API not configured")
	}
	var body []byte
	if payload != nil {
		body, _ = json.Marshal(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.spotifyURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := playerHTTP.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 512*1024+1))
	if err != nil || len(data) > 512*1024 {
		return nil, 0, errors.New("Invalid player response")
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusNoContent {
		return nil, response.StatusCode, errors.New("Player unavailable")
	}
	return data, response.StatusCode, nil
}

type spotifyStatus struct {
	Paused      bool `json:"paused"`
	Stopped     bool `json:"stopped"`
	Volume      int  `json:"volume"`
	VolumeSteps int  `json:"volume_steps"`
	Track       *struct {
		Name        string   `json:"name"`
		ArtistNames []string `json:"artist_names"`
		URI         string   `json:"uri"`
	} `json:"track"`
}

func (c *systemController) spotify(ctx context.Context) (playerState, int) {
	state := playerState{ID: "spotify", Capabilities: []string{}}
	data, status, err := c.spotifyRequest(ctx, "GET", "/status", nil)
	if err != nil {
		state.Error = "Spotify player unavailable"
		return state, 0
	}
	state.Available = true
	if status == http.StatusNoContent {
		return state, 0
	}
	var result spotifyStatus
	if json.Unmarshal(data, &result) != nil || result.VolumeSteps < 1 || result.VolumeSteps > 65535 || result.Volume < 0 || result.Volume > result.VolumeSteps {
		state.Available = false
		state.Error = "Could not read Spotify state"
		return state, 0
	}
	volume := int(math.Round(float64(result.Volume) * 100 / float64(result.VolumeSteps)))
	state.Volume = &volume
	state.Capabilities = []string{"volume"}
	state.Active = result.Track != nil && !result.Stopped
	state.Paused = result.Paused
	if state.Active {
		state.Title = result.Track.Name
		state.Artist = strings.Join(result.Track.ArtistNames, ", ")
		state.TrackID = result.Track.URI
		state.Capabilities = append(state.Capabilities, "previous", "next")
		if state.Paused {
			state.Capabilities = append(state.Capabilities, "play")
		} else {
			state.Capabilities = append(state.Capabilities, "pause")
		}
	}
	return state, result.VolumeSteps
}

func (c *systemController) youtube(ctx context.Context) playerState {
	state := playerState{ID: "youtube", Capabilities: []string{}, Error: "YouTube player unavailable"}
	if c.youtubeCommand == "" {
		return state
	}
	data, err := runWithTimeout(ctx, 4*time.Second, c.youtubeCommand, "state")
	if err != nil {
		return state
	}
	var result playerState
	if json.Unmarshal(data, &result) != nil || result.ID != "youtube" || !result.Available {
		return state
	}
	return result
}

func (c *systemController) Player(ctx context.Context, action playerAction) error {
	if !action.valid() {
		return errors.New("Invalid player control")
	}
	if action.Player == "youtube" {
		if c.youtubeCommand == "" {
			return errors.New("YouTube unavailable")
		}
		args := []string{action.Action}
		if action.Action == "load" {
			id, err := youtubeVideoID(action.URL)
			if err != nil {
				return err
			}
			args = append(args, "--video-id="+id)
		}
		if action.Volume != nil {
			args = append(args, fmt.Sprint(*action.Volume))
		}
		data, err := runWithTimeout(ctx, 4*time.Second, c.youtubeCommand, args...)
		if err != nil {
			return err
		}
		var result struct {
			Accepted bool `json:"accepted"`
		}
		if json.Unmarshal(data, &result) != nil || !result.Accepted {
			return errors.New("YouTube control unavailable")
		}
		return nil
	}
	state, steps := c.spotify(ctx)
	if !slices.Contains(state.Capabilities, action.Action) {
		return errors.New("Spotify control unavailable")
	}
	endpoints := map[string]string{"play": "resume", "pause": "pause", "previous": "prev", "next": "next", "volume": "volume"}
	payload := map[string]int{}
	if action.Action == "volume" {
		payload["volume"] = int(math.Round(float64(*action.Volume) * float64(steps) / 100))
	}
	_, status, err := c.spotifyRequest(ctx, "POST", "/player/"+endpoints[action.Action], payload)
	if err == nil && status != http.StatusOK {
		return errors.New("Spotify session ended")
	}
	return err
}
