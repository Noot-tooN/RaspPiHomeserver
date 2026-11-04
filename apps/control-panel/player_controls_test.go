package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestSpotifySeekMuteAndPersistentRestore(t *testing.T) {
	volume := 13
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/status" {
			fmt.Fprintf(w, `{"volume":%d,"volume_steps":20,"track":{"uri":"spotify:track:one","name":"Track","position":12000,"duration":240000,"album_cover_url":"https://i.scdn.co/image/abc"}}`, volume)
			return
		}
		calls++
		var body map[string]int64
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("bad payload")
		}
		switch r.URL.Path {
		case "/player/volume":
			volume = int(body["volume"])
		case "/player/seek":
			if body["position"] != 90000 {
				t.Error("seek units", body)
			}
		default:
			t.Error("unexpected request", r.URL.Path)
		}
	}))
	defer server.Close()
	c := &systemController{spotifyURL: server.URL}
	dir := t.TempDir()
	c.spotifyRestore.load(dir)
	state, _ := c.spotify(context.Background())
	if *state.PositionMS != 12000 || *state.DurationMS != 240000 || state.ArtworkURL == "" || !slices.Contains(state.Capabilities, "seek") {
		t.Fatal(state)
	}
	position := int64(90000)
	if err := c.Player(context.Background(), playerAction{Player: "spotify", Action: "seek", PositionMS: &position, MediaID: "spotify:track:other"}); err == nil || calls != 0 {
		t.Fatal("stale track was seeked")
	}
	if err := c.Player(context.Background(), playerAction{Player: "spotify", Action: "seek", PositionMS: &position, MediaID: "spotify:track:one"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Player(context.Background(), playerAction{Player: "spotify", Action: "mute"}); err != nil || volume != 0 {
		t.Fatal("mute failed", err, volume)
	}
	restored := &systemController{spotifyURL: server.URL}
	restored.spotifyRestore.load(dir)
	if err := restored.Player(context.Background(), playerAction{Player: "spotify", Action: "unmute"}); err != nil || volume != 13 {
		t.Fatal("did not restore exact native volume", err, volume)
	}
	info, err := os.Stat(filepath.Join(dir, "spotify-volume.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("private state permissions", err)
	}
	volume = 0
	unknown := &systemController{spotifyURL: server.URL}
	if err := unknown.Player(context.Background(), playerAction{Player: "spotify", Action: "unmute"}); err == nil {
		t.Fatal("invented a restore volume")
	}
}
func TestSeekInputValidationAndArtworkAllowlist(t *testing.T) {
	c := fixtureController()
	p := newPanel(c, []string{"rasppi:8090"})
	for _, body := range []string{
		`{"player":"youtube","action":"seek","position_ms":-1,"media_id":"abcdefghijk"}`,
		`{"player":"youtube","action":"seek","position_ms":1000}`,
		`{"player":"spotify","action":"seek","position_ms":0.1,"media_id":"track"}`,
		`{"player":"spotify","action":"seek","position_ms":604800001,"media_id":"track"}`,
		`{"player":"spotify","action":"mute","volume":20}`,
		`{"player":"youtube","action":"pause","position_ms":1000,"media_id":"abcdefghijk"}`,
	} {
		if w := request(p, "/api/player", body); w.Code != 400 || c.calls != 0 {
			t.Fatal("accepted invalid control", body, w.Code)
		}
	}
	for _, raw := range []string{"http://i.scdn.co/image/x", "https://i.scdn.co.evil.test/image/x", "https://u@i.scdn.co/image/x", "https://i.ytimg.com:443/vi/id/a.jpg", "https://example.com/image.jpg", "data:image/svg+xml,bad"} {
		if safeArtwork(raw) != "" {
			t.Fatal("unsafe image accepted", raw)
		}
	}
	for _, raw := range []string{"https://i.scdn.co/image/abc", "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"} {
		if safeArtwork(raw) != raw {
			t.Fatal("image rejected", raw)
		}
	}
}
