package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestEqualizerSaveAndRestore(t *testing.T) {
	e := &equalizer{file: filepath.Join(t.TempDir(), "equalizer.json")}
	e.run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "pw-cli" || !strings.Contains(args[3], `"band1:Gain" 4.0`) {
			t.Fatalf("unexpected command %s %v", name, args)
		}
		return nil, nil
	}
	bass, err := curveFrom([]int{2, 4, 3, 1, 0, 0, 0, 0, 0, 0})
	if err != nil || bass.Preamp >= 1 {
		t.Fatal(bass, err)
	}
	if err := e.update(context.Background(), 78, bass); err != nil {
		t.Fatal(err)
	}
	restored, err := e.saved()
	if err != nil || restored != bass {
		t.Fatal(restored, err)
	}
	e.run = func(context.Context, string, ...string) ([]byte, error) { return nil, errors.New("disconnected") }
	err = e.update(context.Background(), 78, eqCurve{Preamp: 1})
	if err == nil {
		t.Fatal("expected write to fail")
	}
	restored, err = e.saved()
	if err != nil || restored != bass {
		t.Fatal("failed change replaced saved curve", restored, err)
	}
}
