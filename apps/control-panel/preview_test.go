package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
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
	c.preview = true
	c.queueTitles = &youtubeTitleCache{}
	autoplay := true
	spotifyVolume, youtubeVolume := 37, 65
	spotifyPosition, spotifyDuration, youtubePosition, youtubeDuration := int64(72000), int64(244000), int64(3216000), int64(4359000)
	c.state.Players = []playerState{
		{ID: "spotify", Available: true, Active: true, Volume: &spotifyVolume, TrackID: "spotify:track:preview", PositionMS: &spotifyPosition, DurationMS: &spotifyDuration, Title: "I Wish You Were Here", Artist: "Alpha Blondy", ArtworkURL: "https://i.scdn.co/image/ab67616d00001e0291f3bb8309fc2ef2066cabfe", Capabilities: []string{"volume", "mute", "seek", "pause", "previous", "next"}},
		{ID: "youtube", Autoplay: &autoplay, Available: true, Active: true, Paused: true, Volume: &youtubeVolume, VideoID: "gnLwexnUp2o", PositionMS: &youtubePosition, DurationMS: &youtubeDuration, ArtworkURL: "https://i.ytimg.com/vi/gnLwexnUp2o/hqdefault.jpg", Title: "DARK TRANCE MIX | Andrea Botez @ OAKLAND WAREHOUSE [4K]", Artist: "Andrea Botez", Capabilities: []string{"volume", "mute", "seek", "play", "load", "enqueue", "autoplay", "clearqueue", "removequeue", "playqueue", "reorderqueue"}},
	}
	// Example next-track metadata for layout review, not a live Spotify prediction.
	c.state.Players[0].NextTrack = &upcomingTrack{Title: "Next track preview", Artist: "Alpha Blondy", ArtworkURL: c.state.Players[0].ArtworkURL}
	if file := os.Getenv("RASPPI_PANEL_RECOMMENDATION_FILE"); file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var recommendation queuedVideo
		if err := json.Unmarshal(data, &recommendation); err != nil {
			t.Fatal(err)
		}
		if !youtubeIDPattern.MatchString(recommendation.VideoID) {
			t.Fatal("invalid preview recommendation")
		}
		c.state.Players[1].Recommendation = &recommendation
	}
	// Repeated sample videos intentionally exercise overflow without live playback.
	if os.Getenv("RASPPI_PANEL_QUEUE_PREVIEW") == "1" {
		player := &c.state.Players[1]
		samples := []queuedVideo{{VideoID: player.VideoID, Title: player.Title}}
		if player.Recommendation != nil {
			samples = append(samples, *player.Recommendation)
		}
		for i := 0; i < 8; i++ {
			entry := samples[i%len(samples)]
			entry.ID = fmt.Sprintf("11111111-0000-4000-8000-%012d", i+1)
			player.Queue = append(player.Queue, entry)
		}
		player.QueueCount = len(player.Queue)
	}
	c.previewYouTubeNavigation(&c.state.Players[1], playerAction{})
	p := newPanel(c, []string{"127.0.0.1:8098", "localhost:8098"})
	p.eq = &equalizer{file: filepath.Join(t.TempDir(), "equalizer.json"), run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return []byte(`[{"id":1,"info":{"props":{"node.name":"rasppi-eq","media.class":"Audio/Sink"}}}]`), nil
	}}
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
	// Playback time must keep advancing even with the visualizer disabled.
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		last := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				elapsed := now.Sub(last).Milliseconds()
				last = now
				c.mu.Lock()
				for i := range c.state.Players {
					player := &c.state.Players[i]
					if player.Active && !player.Paused && player.PositionMS != nil && player.DurationMS != nil {
						position := min(*player.DurationMS, *player.PositionMS+elapsed)
						player.PositionMS = &position
					}
				}
				c.mu.Unlock()
			}
		}
	}()
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
	// Local-only connection demo: the regular app and production binary have no
	// simulation controls or forced-disconnect hooks.
	mux.HandleFunc("GET /connection-preview", func(w http.ResponseWriter, r *http.Request) {
		page, err := web.ReadFile("web/index.html")
		if err != nil {
			t.Error(err)
			http.Error(w, "Preview unavailable", 500)
			return
		}
		page = bytes.Replace(page, []byte("<head>"), []byte(`<head><base href="/"><script src="/__test/connection.js" defer></script>`), 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(page)
	})
	mux.HandleFunc("GET /__test/connection.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript")
		w.Write([]byte(connectionPreviewJS))
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

// Simulated navigation for visual review; production uses the receiver's history.
func (c *fakeController) previewYouTubeNavigation(p *playerState, action playerAction) {
	var target *playerState
	if action.Action == "previous" && len(c.youtubeHistory) > 0 {
		previous := c.youtubeHistory[len(c.youtubeHistory)-1]
		c.youtubeHistory = c.youtubeHistory[:len(c.youtubeHistory)-1]
		target = &previous
	}
	if action.Action == "playqueue" {
		for index, item := range p.Queue {
			if item.ID == action.QueueID {
				c.youtubeHistory = append(c.youtubeHistory, *p)
				target = &playerState{VideoID: item.VideoID, Title: item.Title, ArtworkURL: "https://i.ytimg.com/vi/" + item.VideoID + "/hqdefault.jpg"}
				p.Queue = slices.Delete(p.Queue, index, index+1)
				p.QueueCount = len(p.Queue)
				break
			}
		}
	}
	if action.Action == "next" {
		var next *queuedVideo
		if len(p.Queue) > 0 {
			item := p.Queue[0]
			next = &item
			p.Queue = p.Queue[1:]
			p.QueueCount = len(p.Queue)
		} else if p.Autoplay != nil && *p.Autoplay {
			next = p.Recommendation
		}
		if next != nil {
			c.youtubeHistory = append(c.youtubeHistory, *p)
			target = &playerState{VideoID: next.VideoID, Title: next.Title, ArtworkURL: "https://i.ytimg.com/vi/" + next.VideoID + "/hqdefault.jpg"}
		}
	}
	if target != nil {
		p.VideoID, p.Title, p.Artist, p.ArtworkURL = target.VideoID, target.Title, target.Artist, target.ArtworkURL
		p.Recommendation, p.DurationMS = target.Recommendation, target.DurationMS
		zero := int64(0)
		p.PositionMS, p.Active, p.Paused = &zero, true, false
	}
	p.Capabilities = slices.DeleteFunc(p.Capabilities, func(v string) bool {
		return v == "next" || v == "previous" || v == "play" || v == "pause" || v == "seek"
	})
	if len(p.Queue) > 0 || (p.Autoplay != nil && *p.Autoplay && p.Recommendation != nil) {
		p.Capabilities = append(p.Capabilities, "next")
	}
	if len(c.youtubeHistory) > 0 {
		p.Capabilities = append(p.Capabilities, "previous")
	}
	if p.DurationMS != nil {
		p.Capabilities = append(p.Capabilities, "seek")
	}
	if p.Paused {
		p.Capabilities = append(p.Capabilities, "play")
	} else {
		p.Capabilities = append(p.Capabilities, "pause")
	}
}

// Wait for DOMContentLoaded so all of the application's deferred scripts have run.
const connectionPreviewJS = `
document.addEventListener('DOMContentLoaded', () => {
  const toolbar = document.createElement('nav');
  toolbar.setAttribute('aria-label', 'Connection animation preview');
  toolbar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 20px;background:#202222';
  const label = document.createElement('span');
  label.textContent = 'Connection preview';
  toolbar.append(label);
  document.body.prepend(toolbar);
  const hiddenImages = new Map();
  function restoreImages() {
    for (const [image, hidden] of hiddenImages) image.hidden = hidden;
    hiddenImages.clear();
  }
  function simulate(noArtwork) {
    if (!current) return;
    restoreImages();
    if (events) events.close();
    events = null;
    clearTimeout(staleTimer); clearTimeout(spectrumTimer);
    connection(true);
    if (noArtwork) {
      for (const id of ['spotify', 'youtube']) {
        const image = $(id + '-artwork');
        hiddenImages.set(image, image.hidden);
        image.hidden = true;
      }
    }
    connection(false);
  }
  for (const [text, action] of [
    ['With cover', () => simulate(false)],
    ['Without cover', () => simulate(true)],
    ['Recover', () => { restoreImages(); connect(); }]
  ]) {
    const button = document.createElement('button');
    button.textContent = text; button.addEventListener('click', action);
    toolbar.append(button);
  }
});
`
