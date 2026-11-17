package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func healthyDiagnosticFixture() (state, unitStates) {
	units := unitStates{}
	for _, name := range diagnosticUnits {
		units[name] = map[string]string{"ActiveState": "active", "LoadState": "loaded", "InvocationID": "new"}
	}
	units["rasppi-audio-recovery.service"]["ActiveState"] = "inactive"
	return state{Audio: audioState{sinksKnown: true, dacPresent: true, equalizerPresent: true}, Services: []serviceState{{ID: "spotify", Name: "Spotify", Active: "active"}, {ID: "youtube", Name: "YouTube", Active: "active"}}, Players: []playerState{{ID: "spotify", Available: true}, {ID: "youtube", Available: true}}}, units
}
func TestMissingOutputExplainsSharedFailureAndRecovery(t *testing.T) {
	s, units := healthyDiagnosticFixture()
	s.Audio.equalizerPresent = false
	c := systemController{}
	c.diagnose(&s, units, nil)
	for _, service := range s.Services {
		d := service.Diagnostic
		if d == nil || d.Code != "equalizer_missing" || d.Scope != "audio" || d.Recovery != "scheduled" {
			t.Fatalf("missing actual cause: %+v", d)
		}
	}
	units["rasppi-audio-recovery.service"]["ActiveState"] = "activating"
	c.diagnose(&s, units, nil)
	if s.Services[0].Diagnostic.Recovery != "recovering" {
		t.Fatal("running recovery not reported")
	}
	units["rasppi-audio-recovery.timer"]["ActiveState"] = "inactive"
	c.diagnose(&s, units, nil)
	if s.Services[0].Diagnostic.Recovery != "disabled" {
		t.Fatal("disabled recovery reported as enabled")
	}
}
func TestRestartRequiresNewHealthySessionAndCanRecoverAfterBlocked(t *testing.T) {
	now := time.Now()
	c := systemController{restarts: map[string]*restartRequest{"youtube": {RequestedAt: now.UnixMilli(), PreviousInvocation: "old"}}}
	if got := c.restartOutcome("youtube", "old", true, nil, now); got.Status != "pending" {
		t.Fatalf("old session counted as success: %+v", got)
	}
	d := issue("audio", "equalizer_missing", "Equalizer output is missing", "")
	d.Recovery = "scheduled"
	if got := c.restartOutcome("youtube", "new", false, d, now); got.Status != "blocked" {
		t.Fatalf("failed restart counted as success: %+v", got)
	}
	if got := c.restartOutcome("youtube", "new", true, nil, now); got.Status != "completed" {
		t.Fatalf("new healthy session not acknowledged: %+v", got)
	}
	if got := c.restartOutcome("youtube", "new", false, d, now); got.Status != "completed" {
		t.Fatal("later failure rewrote completed restart")
	}
}
func TestRestartTimeoutDoesNotClaimSuccess(t *testing.T) {
	now := time.Now()
	c := systemController{restarts: map[string]*restartRequest{"spotify": {RequestedAt: now.Add(-3 * time.Minute).UnixMilli(), PreviousInvocation: "same"}}}
	if got := c.restartOutcome("spotify", "same", true, nil, now); got.Status != "timed_out" {
		t.Fatalf("%+v", got)
	}
}
func TestRuntimeReportsRejectStaleAndUnknownDetails(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "rasppi-youtube")
	os.Mkdir(sub, 0700)
	now := time.Now()
	for _, test := range []struct {
		code  string
		age   time.Duration
		valid bool
	}{{"page_loading", 0, true}, {"private browser text", 0, false}, {"page_loading", 2 * time.Minute, false}, {"page_loading", -time.Minute, false}} {
		data, _ := json.Marshal(runtimeReport{Phase: "starting", Code: test.code, UpdatedAt: now.Add(-test.age).UnixMilli()})
		os.WriteFile(filepath.Join(sub, "status.json"), data, 0600)
		if got := readRuntimeReport(dir, "rasppi-youtube", now, time.Minute); (got != nil) != test.valid {
			t.Fatalf("code %s age %v: %+v", test.code, test.age, got)
		}
	}
}
func TestYouTubeDiagnosticIgnoresPreviousInvocationAsCurrentCause(t *testing.T) {
	s, units := healthyDiagnosticFixture()
	s.Players[1].Available = false
	s.Players[1].ErrorCode = "control_timeout"
	dir := t.TempDir()
	sub := filepath.Join(dir, "rasppi-youtube")
	os.Mkdir(sub, 0700)
	report := runtimeReport{Phase: "starting", Code: "page_loading", Invocation: "previous", UpdatedAt: time.Now().UnixMilli()}
	data, _ := json.Marshal(report)
	os.WriteFile(filepath.Join(sub, "status.json"), data, 0600)
	c := systemController{runtimeDir: dir}
	c.diagnose(&s, units, nil)
	if d := s.Services[1].Diagnostic; d.Code != "control_timeout" || d.Recovery == "recovering" {
		t.Fatalf("stale invocation misled status: %+v", d)
	}
	report.Invocation = "new"
	data, _ = json.Marshal(report)
	os.WriteFile(filepath.Join(sub, "status.json"), data, 0600)
	c.diagnose(&s, units, nil)
	if d := s.Services[1].Diagnostic; d.Code != "page_loading" || d.Recovery != "recovering" {
		t.Fatalf("current startup not shown: %+v", d)
	}
}
func TestStoppedPlayerReportsExitReason(t *testing.T) {
	s, units := healthyDiagnosticFixture()
	s.Services[0].Active = "failed"
	units["spotify.service"]["Result"] = "exit-code"
	units["spotify.service"]["ExecMainStatus"] = "42"
	c := systemController{}
	c.diagnose(&s, units, nil)
	if got := s.Services[0].Diagnostic.Detail; got != "The process exited with code 42." {
		t.Fatal(got)
	}
}

func TestNewPlayerAPIWarmupIsProgressNotBlocked(t *testing.T) {
	s, units := healthyDiagnosticFixture()
	s.Players[0].Available = false
	c := systemController{restarts: map[string]*restartRequest{"spotify": {RequestedAt: time.Now().UnixMilli(), PreviousInvocation: "old"}}}
	c.diagnose(&s, units, nil)
	if d := s.Services[0].Diagnostic; d.Code != "player_starting" || d.Recovery != "recovering" || s.Services[0].Restart.Status != "pending" {
		t.Fatalf("warm-up marked failed: %+v %+v", d, s.Services[0].Restart)
	}
	s.Audio.equalizerPresent = false
	c.diagnose(&s, units, nil)
	if s.Services[0].Restart.Status != "blocked" {
		t.Fatal("real dependency failure hidden by warm-up")
	}
	s.Audio.equalizerPresent = true
	c.restarts["spotify"].RequestedAt = time.Now().Add(-3 * time.Minute).UnixMilli()
	c.diagnose(&s, units, nil)
	if s.Services[0].Diagnostic.Recovery == "recovering" || s.Services[0].Restart.Status == "pending" {
		t.Fatal("unresponsive API reported as warming forever")
	}
}
