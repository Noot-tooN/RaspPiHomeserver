package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testPCM(frequency, amplitude float64, opposite bool) []byte {
	raw := make([]byte, spectrumSamples*8)
	for i := 0; i < spectrumSamples; i++ {
		sample := float32(amplitude * math.Sin(2*math.Pi*frequency*float64(i)/spectrumRate))
		binary.LittleEndian.PutUint32(raw[i*8:], math.Float32bits(sample))
		if opposite {
			sample = -sample
		}
		binary.LittleEndian.PutUint32(raw[i*8+4:], math.Float32bits(sample))
	}
	return raw
}
func TestSpectrumSeparatesFrequenciesAndHandlesStereo(t *testing.T) {
	analyze := func(raw []byte) [spectrumBands]uint8 {
		return audioSpectrum(raw, make([]complex128, spectrumSamples), make([]complex128, spectrumSamples))
	}
	if analyze(testPCM(300, 0, false)) != [spectrumBands]uint8{} {
		t.Fatal("silence is not flat")
	}
	low, high := analyze(testPCM(300, .1, false)), analyze(testPCM(3000, .1, false))
	lowBand, highBand := int(math.Log(300.0/40)/math.Log(300)*spectrumBands), int(math.Log(3000.0/40)/math.Log(300)*spectrumBands)
	if low[lowBand] < 60 || low[highBand] > 5 || high[highBand] < 60 || high[lowBand] > 5 {
		t.Fatalf("frequency leakage: %v / %v", low, high)
	}
	if low != analyze(testPCM(300, .1, true)) {
		t.Fatal("opposite-phase stereo cancelled")
	}
	quiet := analyze(testPCM(300, .01, false))
	if quiet[lowBand] >= low[lowBand]-20 {
		t.Fatal("amplitude change missing")
	}
	raw := testPCM(300, 0, false)
	binary.LittleEndian.PutUint32(raw, math.Float32bits(float32(math.NaN())))
	binary.LittleEndian.PutUint32(raw[12:], math.Float32bits(float32(math.Inf(1))))
	if analyze(raw) != [spectrumBands]uint8{} {
		t.Fatal("nonfinite samples contaminated spectrum")
	}
}
func TestSpectrumStreamSelection(t *testing.T) {
	input := func(index uint32, name string) pulseInput {
		return pulseInput{Index: index, Properties: map[string]string{"application.name": name}}
	}
	inputs := []pulseInput{input(1, "go-librespot"), input(2, "Brave"), input(3, "unrelated"), input(4, "Brave"), input(5, "Brave"), input(6, "go-librespot"), input(7, "go-librespot")}
	inputs[5].Corked = true
	inputs[6].Mute = true
	selected := selectStreams(inputs)
	if len(selected) != 3 || selected[1] != "spotify" || selected[4] != "youtube" || selected[5] != "youtube" {
		t.Fatalf("wrong streams: %v", selected)
	}
	if streamPlayer(map[string]string{"application.process.binary": "brave-browser"}) != "youtube" {
		t.Fatal("browser identity missing")
	}
}
func receiveWithin[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("timed out")
		var zero T
		return zero
	}
}
func TestSpectrumHubSharesAndStopsWorker(t *testing.T) {
	started, stopped := make(chan func(spectrumFrame), 4), make(chan bool, 4)
	hub := &spectrumHub{run: func(ctx context.Context, publish func(spectrumFrame)) {
		started <- publish
		<-ctx.Done()
		stopped <- true
	}}
	a, closeA := hub.subscribe()
	defer closeA()
	publish := receiveWithin(t, started)
	b, closeB := hub.subscribe()
	defer closeB()
	select {
	case <-started:
		t.Fatal("second worker started")
	default:
	}
	for i := 0; i < 100; i++ {
		publish(spectrumFrame{"spotify": {Status: "live", Bands: [spectrumBands]uint8{uint8(i)}}})
	}
	if receiveWithin(t, a)["spotify"].Bands[0] != 99 || receiveWithin(t, b)["spotify"].Bands[0] != 99 {
		t.Fatal("slow client retained old frames")
	}
	closeA()
	select {
	case <-stopped:
		t.Fatal("stopped while a viewer remains")
	default:
	}
	closeB()
	receiveWithin(t, stopped)
	c, closeC := hub.subscribe()
	defer closeC()
	nextPublish := receiveWithin(t, started)
	publish(spectrumFrame{"spotify": {Status: "stale"}})
	select {
	case <-c:
		t.Fatal("old worker leaked into new session")
	default:
	}
	nextPublish(spectrumFrame{"spotify": {Status: "live"}})
	if receiveWithin(t, c)["spotify"].Status != "live" {
		t.Fatal("new session failed")
	}
	closeC()
	receiveWithin(t, stopped)
}
func TestSpectrumSSEAndOptOut(t *testing.T) {
	for _, query := range []string{"", "?spectrum=0"} {
		t.Run(query, func(t *testing.T) {
			started, stopped := make(chan bool, 1), make(chan bool, 1)
			p := newPanel(fixtureController(), nil)
			p.spectra = &spectrumHub{run: func(ctx context.Context, publish func(spectrumFrame)) {
				started <- true
				publish(spectrumFrame{"spotify": {Status: "idle"}})
				<-ctx.Done()
				stopped <- true
			}}
			server := httptest.NewServer(http.HandlerFunc(p.events))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+query, nil)
			response, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			scanner := bufio.NewScanner(response.Body)
			found := false
			for scanner.Scan() {
				line := scanner.Text()
				if query != "" && strings.HasPrefix(line, "data:") {
					break
				}
				if line == "event: spectrum" {
					found = true
					break
				}
			}
			if query == "" {
				if !found {
					t.Fatal("missing spectrum SSE event")
				}
				receiveWithin(t, started)
				response.Body.Close()
				cancel()
				receiveWithin(t, stopped)
			} else {
				select {
				case <-started:
					t.Fatal("opt-out started analyzer")
				default:
				}
			}
		})
	}
}
func TestCaptureCancellationStopsBlockedReader(t *testing.T) {
	// A child that never produces PCM must still stop promptly on cancellation.
	path := filepath.Join(t.TempDir(), "parec")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexec sleep 60\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan bool, 1)
	go func() { captureSpectrum(ctx, path, 1, make(chan capturedSpectrum)); done <- true }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	receiveWithin(t, done)
}
func BenchmarkAudioSpectrum(b *testing.B) {
	raw := testPCM(440, .1, false)
	left, right := make([]complex128, spectrumSamples), make([]complex128, spectrumSamples)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		audioSpectrum(raw, left, right)
	}
}
