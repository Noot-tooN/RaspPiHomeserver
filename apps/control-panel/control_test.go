package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const sinkFixture = `[
 {"name":"hdmi","mute":false,"volume":{"left":{"value":65536}}},
 {"name":"rasppi-dac","mute":true,"volume":{"front-left":{"value":26214},"front-right":{"value":19661}}}
]`
const serviceFixture = `Id=spotify.service
LoadState=loaded
ActiveState=active
SubState=running
Result=success

Id=youtube-tv.service
LoadState=loaded
ActiveState=failed
SubState=failed
Result=exit-code
`

func TestReadActualSinkAndIndependentServiceStates(t *testing.T) {
	c := systemController{pactl: "pactl", systemctl: "systemctl", sink: "rasppi-dac", run: func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name == "pactl" {
			return []byte(sinkFixture), nil
		}
		return []byte(serviceFixture), nil
	}}
	s := c.State(context.Background())
	if !s.Audio.Available || s.Audio.Volume != 40 || !s.Audio.Muted {
		t.Fatalf("wrong DAC state: %+v", s.Audio)
	}
	if s.Services[0].Active != "active" || s.Services[1].Active != "failed" || s.Services[1].Result != "exit-code" {
		t.Fatalf("wrong service states: %+v", s.Services)
	}
}

func TestUnavailableIsNotReportedAsStoppedOrHealthy(t *testing.T) {
	for _, data := range []string{"[]", "broken JSON", `[{"name":"rasppi-dac","volume":{}}]`} {
		t.Run(data, func(t *testing.T) {
			c := systemController{pactl: "pactl", systemctl: "systemctl", sink: "rasppi-dac", run: func(_ context.Context, name string, _ ...string) ([]byte, error) {
				if name == "pactl" {
					return []byte(data), nil
				}
				return nil, errors.New("private diagnostic data")
			}}
			s := c.State(context.Background())
			if s.Audio.Available || s.Audio.Error == "" || s.Services[0].Error == "" || s.Services[0].Active != "" {
				t.Fatalf("misleading state: %+v", s)
			}
			if strings.Contains(s.Services[0].Error, "private") {
				t.Fatal("leaked command diagnostic")
			}
		})
	}
}

func TestCommandsUseFixedArgumentsWithoutAShell(t *testing.T) {
	var calls [][]string
	c := systemController{pactl: "/nix/pactl", systemctl: "/nix/systemctl", sink: "rasppi-dac", run: func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{name}, args...))
		return nil, nil
	}}
	ctx := context.Background()
	if c.Volume(ctx, 0) != nil || c.Mute(ctx, false) != nil || c.Restart(ctx, "youtube") != nil {
		t.Fatal("valid operation failed")
	}
	expected := [][]string{
		{"/nix/pactl", "set-sink-volume", "rasppi-dac", "0%"},
		{"/nix/pactl", "set-sink-mute", "rasppi-dac", "0"},
		{"/nix/systemctl", "--user", "--no-block", "restart", "youtube-tv.service"},
	}
	if !reflect.DeepEqual(calls, expected) {
		t.Fatalf("commands: %#v", calls)
	}
	for _, id := range []string{"sshd", "spotify.service", "youtube; reboot", "--all"} {
		if c.Restart(ctx, id) == nil {
			t.Fatalf("accepted %q", id)
		}
	}
	if c.Volume(ctx, -1) == nil || c.Volume(ctx, 101) == nil || len(calls) != 3 {
		t.Fatal("invalid input reached runner")
	}
}

func TestCommandOutputIsBounded(t *testing.T) {
	var output limitedOutput
	if _, err := output.Write(make([]byte, 1024*1024)); err != nil {
		t.Fatal(err)
	}
	if _, err := output.Write([]byte("extra")); err == nil {
		t.Fatal("output exceeded limit")
	}
}

func TestPairingHelperAcceptsOnlyNumericTVCodes(t *testing.T) {
	for _, tt := range []struct {
		output string
		valid  bool
	}{
		{`{"code":"012345678901"}`, true},
		{`{"code":"ABC-DEF-GHIJ"}`, false},
		{`{"code":"0123456789012"}`, false},
		{`{"error":"private account data"}`, false},
		{`not json`, false},
	} {
		t.Run(tt.output, func(t *testing.T) {
			helper := filepath.Join(t.TempDir(), "pairing")
			if err := os.WriteFile(helper, []byte("#!/bin/sh\nprintf '%s\\n' '"+tt.output+"'\n"), 0700); err != nil {
				t.Fatal(err)
			}
			c := systemController{pairingCommand: helper}
			result, err := c.PairYouTube(context.Background())
			if (err == nil) != tt.valid || (tt.valid && result.Code != "012345678901") || (!tt.valid && result.Code != "") {
				t.Fatalf("unexpected code validation: %+v, %v", result, err)
			}
		})
	}
}
