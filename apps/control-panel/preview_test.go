package main

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"
)

// Opt-in local UI fixture. This code is excluded from the production binary and
// never runs pactl or systemctl. It only binds loopback, for visual/browser tests.
func TestPreview(t *testing.T) {
	if os.Getenv("RASPPI_PANEL_PREVIEW") != "1" {
		t.Skip("set RASPPI_PANEL_PREVIEW=1 for a local fixture at 127.0.0.1:8098")
	}
	c := fixtureController()
	spotifyVolume, youtubeVolume := 37, 65
	spotifyPosition, spotifyDuration, youtubePosition, youtubeDuration := int64(72000), int64(244000), int64(3216000), int64(4359000)
	c.state.Players = []playerState{
		{ID: "spotify", Available: true, Active: true, Volume: &spotifyVolume, TrackID: "spotify:track:preview", PositionMS: &spotifyPosition, DurationMS: &spotifyDuration, Title: "Midnight City", Artist: "M83", Capabilities: []string{"volume", "mute", "seek", "pause", "previous", "next"}},
		{ID: "youtube", Available: true, Active: true, Paused: true, Volume: &youtubeVolume, VideoID: "gnLwexnUp2o", PositionMS: &youtubePosition, DurationMS: &youtubeDuration, ArtworkURL: "https://i.ytimg.com/vi/gnLwexnUp2o/hqdefault.jpg", Title: "DARK TRANCE MIX | Andrea Botez @ OAKLAND WAREHOUSE [4K]", Artist: "Andrea Botez", Capabilities: []string{"volume", "mute", "seek", "play", "load"}},
	}
	p := newPanel(c, []string{"127.0.0.1:8098", "localhost:8098"})
	p.spectra = &spectrumHub{run: func(ctx context.Context, publish func(spectrumFrame)) {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		left, right := make([]complex128, spectrumSamples), make([]complex128, spectrumSamples)
		n := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// Synthetic PCM in memory only. The paused YouTube fixture stays flat.
				n++
				bands := audioSpectrum(testPCM(150+float64(n%40)*35, .2, false), left, right)
				c.mu.Lock()
				active := len(c.state.Players) > 0 && c.state.Players[0].Active && !c.state.Players[0].Paused
				c.mu.Unlock()
				frame := spectrumFrame{"spotify": {Status: "idle"}, "youtube": {Status: "idle"}}
				if active {
					frame["spotify"] = spectrumValue{Status: "live", Bands: bands}
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
