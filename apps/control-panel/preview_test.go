package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Opt-in local UI fixture. This code is excluded from the production binary and
// never runs pactl or systemctl. It only binds loopback, for visual/browser tests.
func TestPreview(t *testing.T) {
	if os.Getenv("RASPPI_PANEL_PREVIEW") != "1" {
		t.Skip("set RASPPI_PANEL_PREVIEW=1 for a local fixture at 127.0.0.1:8098")
	}
	// Optional real spectrum capture; replay only, with no production controls.
	var recordedBands [][spectrumBands]uint8
	if file := os.Getenv("RASPPI_PANEL_SPECTRUM_FILE"); file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &recordedBands); err != nil {
			t.Fatal(err)
		}
		if len(recordedBands) == 0 {
			t.Fatal("spectrum recording is empty")
		}
	}
	c := fixtureController()
	spotifyVolume, youtubeVolume := 37, 65
	spotifyPosition, spotifyDuration, youtubePosition, youtubeDuration := int64(72000), int64(244000), int64(3216000), int64(4359000)
	c.state.Players = []playerState{
		{ID: "spotify", Available: true, Active: true, Volume: &spotifyVolume, TrackID: "spotify:track:preview", PositionMS: &spotifyPosition, DurationMS: &spotifyDuration, Title: "I Wish You Were Here", Artist: "Alpha Blondy", ArtworkURL: "https://i.scdn.co/image/ab67616d00001e0291f3bb8309fc2ef2066cabfe", Capabilities: []string{"volume", "mute", "seek", "pause", "previous", "next"}},
		{ID: "youtube", Available: true, Active: true, Paused: true, Volume: &youtubeVolume, VideoID: "gnLwexnUp2o", PositionMS: &youtubePosition, DurationMS: &youtubeDuration, ArtworkURL: "https://i.ytimg.com/vi/gnLwexnUp2o/hqdefault.jpg", Title: "DARK TRANCE MIX | Andrea Botez @ OAKLAND WAREHOUSE [4K]", Artist: "Andrea Botez", Capabilities: []string{"volume", "mute", "seek", "play", "load"}},
	}
	p := newPanel(c, []string{"127.0.0.1:8098", "localhost:8098"})
	p.eq = &equalizer{file: filepath.Join(t.TempDir(), "equalizer.json"), run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return []byte(`[{"id":1,"info":{"props":{"node.name":"rasppi-eq","media.class":"Audio/Sink"}}}]`), nil
	}}
	p.spectra = &spectrumHub{run: func(ctx context.Context, publish func(spectrumFrame)) {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		left, right := make([]complex128, spectrumSamples), make([]complex128, spectrumSamples)
		n := 0
		last := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				elapsed := now.Sub(last).Milliseconds()
				last = now
				// Synthetic PCM in memory only; neither fake player produces audio.
				n++
				var bands [spectrumBands]uint8
				if len(recordedBands) > 0 {
					bands = recordedBands[(n-1)%len(recordedBands)]
				} else {
					bands = audioSpectrum(previewPCM(n), left, right)
				}
				c.mu.Lock()
				active := make(map[string]bool)
				for i := range c.state.Players {
					player := &c.state.Players[i]
					active[player.ID] = player.Active && !player.Paused && !player.Muted
					if player.Active && !player.Paused && player.PositionMS != nil && player.DurationMS != nil {
						position := min(*player.DurationMS, *player.PositionMS+elapsed)
						player.PositionMS = &position
					}
				}
				c.mu.Unlock()
				frame := spectrumFrame{"spotify": {Status: "idle"}, "youtube": {Status: "idle"}}
				for id, playing := range active {
					if playing {
						frame[id] = spectrumValue{Status: "live", Bands: bands}
					}
				}
				publish(frame)
			}
		}
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.monitor(ctx)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /__test/unavailable", func(w http.ResponseWriter, _ *http.Request) {
		c.mu.Lock()
		c.state.Audio = audioState{Error: "Waiting for DAC Pro"}
		c.state.Services[1].Active = "failed"
		c.mu.Unlock()
		p.refresh()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /__test/idle", func(w http.ResponseWriter, _ *http.Request) {
		c.mu.Lock()
		c.state.Players = []playerState{{ID: "spotify", Available: true}, {ID: "youtube", Available: true, Capabilities: []string{"load"}}}
		c.mu.Unlock()
		p.refresh()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", p.handler())
	t.Fatal(http.ListenAndServe("127.0.0.1:8098", mux))
}

// Synthetic demo only: a rhythmic bass pulse with moving mid/high harmonics.
func previewPCM(frame int) []byte {
	raw := make([]byte, spectrumSamples*8)
	t := float64(frame) / 10
	for sample := 0; sample < spectrumSamples; sample++ {
		at := float64(sample) / spectrumRate
		value := 0.0
		for band := 0; band < spectrumBands; band++ {
			frequency := 40 * math.Pow(300, (float64(band)+0.5)/spectrumBands)
			pulse := math.Pow((1+math.Cos(t*math.Pi*4-float64(band)*.35))/2, 3)
			envelope := .2 + .8*math.Pow((1+math.Sin(t*(1.1+float64(band%5)*.17)+float64(band)*1.7))/2, 2)
			amplitude := (.003 + .014*envelope + .009*pulse) / (1 + float64(band)*.07)
			value += amplitude * math.Sin(2*math.Pi*frequency*at+float64(band))
		}
		bits := math.Float32bits(float32(value))
		binary.LittleEndian.PutUint32(raw[sample*8:], bits)
		binary.LittleEndian.PutUint32(raw[sample*8+4:], bits)
	}
	return raw
}
