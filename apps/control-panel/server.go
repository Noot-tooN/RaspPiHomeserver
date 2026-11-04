package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

//go:embed web/*
var web embed.FS

type panel struct {
	control     controller
	origins     map[string]string
	actions     chan struct{}
	mu          sync.Mutex
	clients     map[chan []byte]bool
	wake        chan struct{}
	lastRestart map[string]time.Time
	lastPairing time.Time
}

func newPanel(c controller, authorities []string) *panel {
	p := &panel{control: c, origins: make(map[string]string), actions: make(chan struct{}, 1), clients: make(map[chan []byte]bool), wake: make(chan struct{}, 1), lastRestart: make(map[string]time.Time)}
	for _, host := range authorities {
		p.origins[strings.ToLower(host)] = "http"
	}
	return p
}

// A reverse proxy preserves the public Host and Origin. Trust only the
// explicitly configured origin, never client-supplied forwarding headers.
func (p *panel) allowPublicOrigin(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return fmt.Errorf("public origin must be an http(s) origin without a path, credentials, query, or fragment")
	}
	p.origins[strings.ToLower(u.Host)] = u.Scheme
	return nil
}

func (p *panel) refresh() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// A single monitor serves every open page. With no visible viewers it runs no
// subprocesses. Actions request an immediate refresh; external changes are
// picked up every five seconds while a page is visible.
func (p *panel) monitor(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-p.wake:
		}
		p.mu.Lock()
		active := len(p.clients) > 0
		p.mu.Unlock()
		if !active {
			continue
		}
		data, err := json.Marshal(p.control.State(ctx))
		if err != nil {
			continue
		}
		p.mu.Lock()
		for client := range p.clients {
			select {
			case <-client:
			default:
			}
			client <- data
		}
		p.mu.Unlock()
	}
}

func (p *panel) events(w http.ResponseWriter, r *http.Request) {
	client := make(chan []byte, 1)
	p.mu.Lock()
	if len(p.clients) >= 32 {
		p.mu.Unlock()
		fail(w, http.StatusServiceUnavailable, "Too many open panels")
		return
	}
	p.clients[client] = true
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.clients, client)
		p.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	response := http.NewResponseController(w)
	_ = response.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.WriteString(w, "retry: 3000\n\n"); err != nil || response.Flush() != nil {
		return
	}
	p.refresh()
	for {
		select {
		case <-r.Context().Done():
			return
		case data := <-client:
			_ = response.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil || response.Flush() != nil {
				return
			}
		}
	}
}

func jsonReply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func fail(w http.ResponseWriter, status int, message string) {
	jsonReply(w, status, map[string]string{"error": message})
}

func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(value) != nil || d.Decode(new(any)) != io.EOF {
		fail(w, http.StatusBadRequest, "Invalid request")
		return false
	}
	return true
}

func (p *panel) action(w http.ResponseWriter, r *http.Request) {
	select {
	case p.actions <- struct{}{}:
		defer func() { <-p.actions }()
	default:
		fail(w, http.StatusTooManyRequests, "Another change is in progress. Try again shortly.")
		return
	}
	var err error
	switch r.URL.Path {
	case "/api/player":
		var input playerAction
		if !decode(w, r, &input) {
			return
		}
		if input.Player == "youtube" && input.Action == "load" {
			if _, parseErr := youtubeVideoID(input.URL); parseErr != nil {
				fail(w, 400, parseErr.Error())
				return
			}
		}
		if !input.valid() {
			fail(w, 400, "Invalid player control")
			return
		}
		err = p.control.Player(r.Context(), input)
	case "/api/youtube/pairing":
		var input struct{}
		if !decode(w, r, &input) {
			return
		}
		if time.Since(p.lastPairing) < 15*time.Second {
			fail(w, 429, "A code was just requested. Wait a few seconds before trying again.")
			return
		}
		p.lastPairing = time.Now()
		// Opening TV settings can take longer than a volume/status command.
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(32 * time.Second))
		code, pairingErr := p.control.PairYouTube(r.Context())
		if pairingErr != nil || !tvCodePattern.MatchString(code.Code) {
			fail(w, 503, "Could not get a TV code. Wait for YouTube to load and try again.")
			return
		}
		jsonReply(w, http.StatusOK, code)
		return
	case "/api/volume":
		var input struct {
			Volume *int `json:"volume"`
		}
		if !decode(w, r, &input) {
			return
		}
		if input.Volume == nil || *input.Volume < 0 || *input.Volume > 100 {
			fail(w, 400, "Volume must be between 0 and 100")
			return
		}
		err = p.control.Volume(r.Context(), *input.Volume)
	case "/api/mute":
		var input struct {
			Muted *bool `json:"muted"`
		}
		if !decode(w, r, &input) {
			return
		}
		if input.Muted == nil {
			fail(w, 400, "Choose mute or unmute")
			return
		}
		err = p.control.Mute(r.Context(), *input.Muted)
	case "/api/restart":
		var input struct {
			Service string `json:"service"`
		}
		if !decode(w, r, &input) {
			return
		}
		if _, ok := serviceUnit(input.Service); !ok {
			fail(w, 400, "Unknown service")
			return
		}
		if time.Since(p.lastRestart[input.Service]) < 5*time.Second {
			fail(w, 429, "Restart already requested. Wait a few seconds.")
			return
		}
		err = p.control.Restart(r.Context(), input.Service)
		if err == nil {
			p.lastRestart[input.Service] = time.Now()
		}
	default:
		http.NotFound(w, r)
		return
	}
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "Could not apply the change. Check the app or audio service and try again.")
		return
	}
	p.refresh()
	jsonReply(w, http.StatusAccepted, map[string]bool{"accepted": true})
}

func (p *panel) handler() http.Handler {
	assets, _ := fs.Sub(web, "web")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/events", p.events)
	for _, route := range []string{"/api/player", "/api/volume", "/api/mute", "/api/restart", "/api/youtube/pairing"} {
		mux.HandleFunc("POST "+route, p.action)
	}
	files := http.FileServer(http.FS(assets))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/", "/app.js", "/style.css":
			files.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		// An exact authority allowlist also prevents DNS-rebinding attacks on
		// a service whose authentication is provided by the Tailscale network.
		scheme, allowed := p.origins[strings.ToLower(r.Host)]
		if !allowed {
			fail(w, 403, "Host not allowed")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			origin, err := url.Parse(r.Header.Get("Origin"))
			mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || origin.Scheme != scheme || !strings.EqualFold(origin.Host, r.Host) || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" || mediaType != "application/json" || r.Header.Get("X-Requested-With") != "rasppi-control-panel" {
				fail(w, 403, "Only requests from this panel are allowed")
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}
