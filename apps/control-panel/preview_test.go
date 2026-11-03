package main

import (
	"context"
	"net/http"
	"os"
	"testing"
)

// Opt-in local UI fixture. This code is excluded from the production binary and
// never runs pactl or systemctl. It only binds loopback, for visual/browser tests.
func TestPreview(t *testing.T) {
	if os.Getenv("RASPPI_PANEL_PREVIEW") != "1" {
		t.Skip("set RASPPI_PANEL_PREVIEW=1 for a local fixture at 127.0.0.1:8098")
	}
	c := fixtureController()
	p := newPanel(c, []string{"127.0.0.1:8098", "localhost:8098"})
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
	mux.Handle("/", p.handler())
	t.Fatal(http.ListenAndServe("127.0.0.1:8098", mux))
}
