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

func TestPlayerActionsRejectInvalidInputs(t *testing.T) {
	c := fixtureController()
	p := newPanel(c, []string{"rasppi:8090"})
	for _, body := range []string{
		`{}`, `{"player":"sshd","action":"play"}`, `{"player":"spotify","action":"stop"}`,
		`{"player":"spotify","action":"volume"}`, `{"player":"spotify","action":"volume","volume":101}`,
		`{"player":"youtube","action":"volume","volume":-1}`, `{"player":"youtube","action":"volume","volume":0.5}`,
		`{"player":"youtube","action":"play","volume":30}`, `{"player":"youtube","action":"play","url":"https://example.com"}`,
	} {
		if w := request(p, "/api/player", body); w.Code != 400 || c.calls != 0 {
			t.Fatalf("accepted %s: %d", body, w.Code)
		}
	}
	for _, body := range []string{`{"player":"spotify","action":"pause"}`, `{"player":"youtube","action":"volume","volume":0}`} {
		if w := request(p, "/api/player", body); w.Code != 202 {
			t.Fatalf("valid action rejected: %d", w.Code)
		}
	}
}

func TestSpotifyNativeStateAndVolumeMapping(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/status":
			fmt.Fprint(w, `{"paused":true,"stopped":false,"volume":10,"volume_steps":20,"track":{"name":"A track","artist_names":["First artist","Second artist"],"uri":"spotify:track:example"},"username":"private-account"}`)
		case "/player/volume":
			if r.Method != "POST" {
				t.Error("wrong method")
			}
			var body map[string]int
			if json.NewDecoder(r.Body).Decode(&body) != nil || body["volume"] != 5 {
				t.Error("wrong native volume")
			}
			calls++
		case "/player/resume":
			calls++
		default:
			t.Error("unexpected endpoint", r.URL.Path)
		}
	}))
	defer server.Close()
	c := &systemController{spotifyURL: server.URL}
	state, _ := c.spotify(context.Background())
	if !state.Available || !state.Active || !state.Paused || *state.Volume != 50 || state.Title != "A track" || state.Artist != "First artist, Second artist" || state.TrackID != "spotify:track:example" || !slices.Contains(state.Capabilities, "play") {
		t.Fatalf("wrong state: %+v", state)
	}
	volume := 25
	for _, a := range []playerAction{{Player: "spotify", Action: "volume", Volume: &volume}, {Player: "spotify", Action: "play"}} {
		if err := c.Player(context.Background(), a); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 2 {
		t.Fatalf("mutation calls = %d", calls)
	}
	// Attempting a capability that is not advertised cannot send a mutation.
	if c.Player(context.Background(), playerAction{Player: "spotify", Action: "pause"}) == nil || calls != 2 {
		t.Fatal("unsupported action accepted")
	}
}

func TestSpotifyIdleAndFailuresNeverStartPlayback(t *testing.T) {
	for _, code := range []int{204, 500, 302} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			mutations := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					mutations++
				}
				w.Header().Set("Location", "http://127.0.0.1:1/untrusted")
				w.WriteHeader(code)
			}))
			defer server.Close()
			c := &systemController{spotifyURL: server.URL}
			s, _ := c.spotify(context.Background())
			if s.Active || len(s.Capabilities) != 0 || s.Available != (code == 204) {
				t.Fatalf("wrong idle/error state %+v", s)
			}
			if c.Player(context.Background(), playerAction{Player: "spotify", Action: "play"}) == nil || mutations != 0 {
				t.Fatal("inactive receiver got a playback command")
			}
		})
	}
}

func TestYouTubeVideoLinks(t *testing.T) {
	for _, raw := range []string{
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		" https://youtu.be/dQw4w9WgXcQ?si=tracking&t=90 ",
		"https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=ignored",
		"http://youtube.com/shorts/dQw4w9WgXcQ",
		"https://www.youtube.com/live/dQw4w9WgXcQ",
		"https://www.youtube.com/embed/dQw4w9WgXcQ",
		"https://music.youtube.com/watch?v=dQw4w9WgXcQ",
	} {
		id, err := youtubeVideoID(raw)
		if err != nil || id != "dQw4w9WgXcQ" {
			t.Fatalf("rejected video link %q: %v", raw, err)
		}
	}
	c := fixtureController()
	p := newPanel(c, []string{"rasppi:8090"})
	for _, raw := range []string{
		"", "dQw4w9WgXcQ", "javascript:alert(1)", "file:///etc/passwd",
		"https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
		"https://youtube.com@evil.test/watch?v=dQw4w9WgXcQ",
		"https://user@youtube.com/watch?v=dQw4w9WgXcQ",
		"https://youtube.com:443/watch?v=dQw4w9WgXcQ",
		"https://127.0.0.1/watch?v=dQw4w9WgXcQ",
		"https://www.youtube.com/playlist?list=PLanything",
		"https://youtu.be/dQw4w9WgXcQ/extra",
		"https://www.youtube.com/watch?v=short",
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=abcdefghijk",
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ&bad=%ZZ",
		"https://youtu.be/dQw4w9WgXcQ;reboot",
	} {
		body, _ := json.Marshal(playerAction{Player: "youtube", Action: "load", URL: raw})
		if w := request(p, "/api/player", string(body)); w.Code != 400 || c.calls != 0 {
			t.Fatalf("invalid URL reached controller: %q, status %d", raw, w.Code)
		}
	}
	for _, body := range []string{
		`{"player":"spotify","action":"load","url":"https://youtu.be/dQw4w9WgXcQ"}`,
		`{"player":"youtube","action":"load","url":"https://youtu.be/dQw4w9WgXcQ","volume":50}`,
		`{"player":"youtube","action":"pause","url":"https://youtu.be/dQw4w9WgXcQ"}`,
	} {
		if w := request(p, "/api/player", body); w.Code != 400 || c.calls != 0 {
			t.Fatal("invalid action accepted", body)
		}
	}
	if w := request(p, "/api/player", `{"player":"youtube","action":"load","url":"https://youtu.be/dQw4w9WgXcQ"}`); w.Code != 202 || c.calls != 1 {
		t.Fatal("valid link rejected")
	}
}

func TestYouTubeLoadPassesOnlyValidatedVideoID(t *testing.T) {
	helper := filepath.Join(t.TempDir(), "youtube-control")
	script := `#!/bin/sh
[ "$#" = 2 ] && [ "$1" = load ] && [ "$2" = --video-id=-abcdefghij ] || exit 1
printf '%s\n' '{"accepted":true}'
`
	if err := os.WriteFile(helper, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	c := systemController{youtubeCommand: helper}
	if err := c.Player(context.Background(), playerAction{Player: "youtube", Action: "load", URL: "https://youtu.be/-abcdefghij?si=ignored&t=10"}); err != nil {
		t.Fatal(err)
	}
}
