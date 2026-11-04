package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeController struct {
	mu    sync.Mutex
	state state
	calls int
	reads int
	fail  bool
}

func fixtureController() *fakeController {
	return &fakeController{state: state{Audio: audioState{Available: true, Volume: 40}, Services: []serviceState{
		{ID: "spotify", Name: "Spotify", Load: "loaded", Active: "active", Sub: "running", Result: "success"},
		{ID: "youtube", Name: "YouTube", Load: "loaded", Active: "active", Sub: "running", Result: "success"},
	}}}
}

func (c *fakeController) State(context.Context) state {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reads++
	s := c.state
	s.Services = append([]serviceState(nil), s.Services...)
	s.Players = append([]playerState(nil), s.Players...)
	return s
}
func (c *fakeController) Volume(_ context.Context, v int) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	if c.fail {
		return errors.New("private account diagnostic")
	}
	c.state.Audio.Volume = v
	return nil
}
func (c *fakeController) Mute(_ context.Context, v bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	c.state.Audio.Muted = v
	return nil
}
func (c *fakeController) Restart(_ context.Context, _ string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	return nil
}

func (c *fakeController) PairYouTube(context.Context) (pairingCode, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	if c.fail {
		return pairingCode{}, errors.New("private browser diagnostic")
	}
	return pairingCode{Code: "123456789012"}, nil
}

func TestPairingIsAnExplicitProtectedAction(t *testing.T) {
	c := fixtureController()
	p := newPanel(c, []string{"rasppi:8090"})
	for _, body := range []string{`{"url":"https://example.com"}`, `{"command":"anything"}`} {
		if w := request(p, "/api/youtube/pairing", body); w.Code != 400 || c.calls != 0 {
			t.Fatal("pairing accepted arbitrary instructions")
		}
	}
	r := httptest.NewRequest("POST", "http://rasppi:8090/api/youtube/pairing", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	p.handler().ServeHTTP(w, r)
	if w.Code != 403 || c.calls != 0 {
		t.Fatal("pairing bypassed same-origin protection")
	}
	w = request(p, "/api/youtube/pairing", `{}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "123456789012") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("pairing failed: %d %s", w.Code, w.Body.String())
	}
	if w := request(p, "/api/youtube/pairing", `{}`); w.Code != 429 || c.calls != 1 {
		t.Fatal("pairing flood was not limited")
	}
	c.fail = true
	p.lastPairing = time.Time{}
	w = request(p, "/api/youtube/pairing", `{}`)
	if w.Code != 503 || strings.Contains(w.Body.String(), "private") {
		t.Fatal("pairing error leaked browser details")
	}
}

func request(p *panel, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "http://rasppi:8090"+path, strings.NewReader(body))
	r.Header.Set("Origin", "http://rasppi:8090")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Requested-With", "rasppi-control-panel")
	w := httptest.NewRecorder()
	p.handler().ServeHTTP(w, r)
	return w
}

func TestRejectUntrustedRequestsBeforeAnyAction(t *testing.T) {
	tests := []struct{ name, host, origin, contentType, marker, method string }{
		{"foreign origin", "rasppi:8090", "https://evil.example", "application/json", "rasppi-control-panel", "POST"},
		{"missing origin", "rasppi:8090", "", "application/json", "rasppi-control-panel", "POST"},
		{"null origin", "rasppi:8090", "null", "application/json", "rasppi-control-panel", "POST"},
		{"rebinding host", "evil.example:8090", "http://evil.example:8090", "application/json", "rasppi-control-panel", "POST"},
		{"form", "rasppi:8090", "http://rasppi:8090", "application/x-www-form-urlencoded", "", "POST"},
		{"missing header", "rasppi:8090", "http://rasppi:8090", "application/json", "", "POST"},
		{"origin userinfo", "rasppi:8090", "http://user@rasppi:8090", "application/json", "rasppi-control-panel", "POST"},
		{"origin path", "rasppi:8090", "http://rasppi:8090/fake", "application/json", "rasppi-control-panel", "POST"},
		{"preflight", "rasppi:8090", "http://evil.example", "", "", "OPTIONS"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := fixtureController()
			p := newPanel(c, []string{"rasppi:8090"})
			r := httptest.NewRequest(tt.method, "http://"+tt.host+"/api/volume", strings.NewReader(`{"volume":70}`))
			r.Header.Set("Origin", tt.origin)
			r.Header.Set("Content-Type", tt.contentType)
			r.Header.Set("X-Requested-With", tt.marker)
			w := httptest.NewRecorder()
			p.handler().ServeHTTP(w, r)
			if w.Code != 403 || c.calls != 0 {
				t.Fatalf("status %d, calls %d", w.Code, c.calls)
			}
		})
	}
}

func TestInvalidBodiesCannotChangeAudioOrRestartOtherServices(t *testing.T) {
	for _, tt := range []struct{ path, body string }{
		{"volume", `{}`}, {"volume", `{"volume":null}`}, {"volume", `{"volume":101}`},
		{"volume", `{"volume":-1}`}, {"volume", `{"volume":2.5}`}, {"volume", `{"volume":"40"}`},
		{"volume", `{"volume":40,"command":"reboot"}`}, {"volume", `{"volume":40} {}`},
		{"volume", strings.Repeat(" ", 1025) + `{"volume":40}`},
		{"mute", `{}`}, {"mute", `{"muted":1}`}, {"restart", `{"service":"sshd"}`},
		{"restart", `{"service":"spotify; reboot"}`}, {"restart", `{"service":"--all"}`},
	} {
		t.Run(tt.path+tt.body[:min(len(tt.body), 30)], func(t *testing.T) {
			c := fixtureController()
			p := newPanel(c, []string{"rasppi:8090"})
			w := request(p, "/api/"+tt.path, tt.body)
			if w.Code != 400 || c.calls != 0 {
				t.Fatalf("status %d, calls %d", w.Code, c.calls)
			}
		})
	}
}

func TestActionsErrorsAndRestartCooldown(t *testing.T) {
	c := fixtureController()
	p := newPanel(c, []string{"rasppi:8090"})
	for _, tt := range []struct{ path, body string }{
		{"volume", `{"volume":0}`}, {"mute", `{"muted":true}`}, {"mute", `{"muted":false}`}, {"restart", `{"service":"spotify"}`},
	} {
		if w := request(p, "/api/"+tt.path, tt.body); w.Code != 202 {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
	}
	if c.state.Audio.Volume != 0 || c.state.Audio.Muted {
		t.Fatal("zero volume / unmute not accepted")
	}
	if w := request(p, "/api/restart", `{"service":"spotify"}`); w.Code != 429 || c.calls != 4 {
		t.Fatal("restart flood not stopped")
	}
	c.fail = true
	w := request(p, "/api/volume", `{"volume":30}`)
	if w.Code != 503 || strings.Contains(w.Body.String(), "private") {
		t.Fatal("command failure was hidden or leaked details")
	}
	p.actions <- struct{}{}
	w = request(p, "/api/mute", `{"muted":true}`)
	<-p.actions
	if w.Code != 429 {
		t.Fatal("concurrent action not rejected")
	}
}

func TestEmbeddedUIAndSecurityHeaders(t *testing.T) {
	p := newPanel(fixtureController(), []string{"rasppi:8090"})
	for _, path := range []string{"/", "/app.js", "/style.css"} {
		w := httptest.NewRecorder()
		p.handler().ServeHTTP(w, httptest.NewRequest("GET", "http://rasppi:8090"+path, nil))
		if w.Code != 200 || w.Body.Len() == 0 || w.Header().Get("X-Frame-Options") != "DENY" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("bad asset %s: %d", path, w.Code)
		}
	}
	w := httptest.NewRecorder()
	p.handler().ServeHTTP(w, httptest.NewRequest("GET", "http://rasppi:8090/api/restart?service=spotify", nil))
	if w.Code != 404 && w.Code != 405 {
		t.Fatalf("GET mutation status: %d", w.Code)
	}
}

func TestLiveUpdatesAndIdleMonitor(t *testing.T) {
	c := fixtureController()
	p := newPanel(c, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.monitor(ctx)
	p.refresh()
	time.Sleep(20 * time.Millisecond)
	c.mu.Lock()
	reads := c.reads
	c.mu.Unlock()
	if reads != 0 {
		t.Fatal("monitor reads with no viewers")
	}
	server := httptest.NewServer(p.handler())
	defer server.Close()
	u, _ := url.Parse(server.URL)
	p.origins[u.Host] = "http"
	reqCtx, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	req, _ := http.NewRequestWithContext(reqCtx, "GET", server.URL+"/api/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewScanner(resp.Body)
	for reader.Scan() {
		if data, ok := strings.CutPrefix(reader.Text(), "data: "); ok {
			var s state
			if json.Unmarshal([]byte(data), &s) != nil || s.Audio.Volume != 40 {
				t.Fatal("invalid live state")
			}
			return
		}
	}
	t.Fatal("no state event received")
}

func (c *fakeController) Player(_ context.Context, action playerAction) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	for index := range c.state.Players {
		p := &c.state.Players[index]
		if p.ID != action.Player {
			continue
		}
		if action.Volume != nil {
			value := *action.Volume
			p.Volume = &value
		}
		if action.Action == "play" || action.Action == "pause" {
			p.Paused = action.Action == "pause"
			p.Capabilities = []string{"volume"}
			if p.Paused {
				p.Capabilities = append(p.Capabilities, "play")
			} else {
				p.Capabilities = append(p.Capabilities, "pause")
			}
		}
	}
	return nil
}
