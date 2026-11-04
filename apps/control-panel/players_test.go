package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
			fmt.Fprint(w, `{"paused":true,"stopped":false,"volume":10,"volume_steps":20,"track":{"name":"A track"},"username":"private-account"}`)
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
	if !state.Available || !state.Active || !state.Paused || *state.Volume != 50 || state.Title != "A track" || !slices.Contains(state.Capabilities, "play") {
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
