package main

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestPublicOriginValidation(t *testing.T) {
	for _, origin := range []string{"", "rasppi", "ftp://rasppi", "https://rasppi/audio", "https://user@rasppi", "https://rasppi?", "https://rasppi?x=1", "https://rasppi#fragment"} {
		if err := newPanel(fixtureController(), nil).allowPublicOrigin(origin); err == nil {
			t.Errorf("accepted invalid public origin %q", origin)
		}
	}
}

func TestAudioBehindHTTPSProxy(t *testing.T) {
	const host = "rasppi.tail0fa2e4.ts.net"
	const origin = "https://" + host
	c := fixtureController()
	p := newPanel(c, nil)
	if err := p.allowPublicOrigin(origin); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.monitor(ctx)
	backend := httptest.NewServer(p.handler())
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1
	// Simulate Caddy terminating HTTPS, preserving Host/Origin and stripping
	// /audio before forwarding over loopback HTTP.
	edge := httptest.NewServer(http.StripPrefix("/audio", proxy))
	defer edge.Close()
	client := &http.Client{Timeout: 3 * time.Second}
	for _, path := range []string{"/audio/", "/audio/style.css", "/audio/app.js"} {
		req, _ := http.NewRequest("GET", edge.URL+path, nil)
		req.Host = host
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || len(body) == 0 {
			t.Fatalf("asset %s: %d", path, resp.StatusCode)
		}
		if path == "/audio/" && (!strings.Contains(string(body), `href="style.css"`) || !strings.Contains(string(body), `src="app.js"`)) {
			t.Fatal("assets escape the mounted audio path")
		}
		if path == "/audio/app.js" && strings.Contains(string(body), "'/api/") {
			t.Fatal("API requests escape the mounted audio path")
		}
	}
	for _, tt := range []struct {
		host, origin string
		status       int
	}{
		{host, origin, 202},
		{host, "http://" + host, 403},
		{host, "https://evil.example", 403},
		{"evil.example", origin, 403},
	} {
		req, _ := http.NewRequest("POST", edge.URL+"/audio/api/volume", strings.NewReader(`{"volume":45}`))
		req.Host = tt.host
		req.Header.Set("Origin", tt.origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Requested-With", "rasppi-control-panel")
		// Forged forwarding headers must not grant access.
		req.Header.Set("X-Forwarded-Host", host)
		req.Header.Set("X-Forwarded-Proto", "https")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != tt.status {
			t.Fatalf("host %q origin %q: %d", tt.host, tt.origin, resp.StatusCode)
		}
	}
	c.mu.Lock()
	calls, volume := c.calls, c.state.Audio.Volume
	c.mu.Unlock()
	if calls != 1 || volume != 45 {
		t.Fatal("proxy origin checks did not protect audio changes")
	}
	req, _ := http.NewRequest("GET", edge.URL+"/audio/api/events", nil)
	req.Host = host
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewScanner(resp.Body)
	for reader.Scan() {
		if strings.HasPrefix(reader.Text(), "data: ") {
			return
		}
	}
	t.Fatal("live status did not stream through the proxy")
}
