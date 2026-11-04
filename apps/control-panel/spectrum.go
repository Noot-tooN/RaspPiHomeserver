package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/cmplx"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const spectrumBands = 24
const spectrumSamples = 2048
const spectrumRate = 24000

type spectrumValue struct {
	Bands  [spectrumBands]uint8 `json:"bands"`
	Status string               `json:"status"`
}
type spectrumFrame map[string]spectrumValue

// One analysis session is shared by all visible panels. No listeners means no
// discovery commands, capture processes, FFTs, or raw audio retained anywhere.
type spectrumHub struct {
	mu         sync.Mutex
	clients    map[chan spectrumFrame]bool
	cancel     context.CancelFunc
	generation uint64
	run        func(context.Context, func(spectrumFrame))
}

func (h *spectrumHub) subscribe() (<-chan spectrumFrame, func()) {
	h.mu.Lock()
	if h.clients == nil {
		h.clients = make(map[chan spectrumFrame]bool)
	}
	ch := make(chan spectrumFrame, 1)
	h.clients[ch] = true
	if len(h.clients) == 1 {
		ctx, cancel := context.WithCancel(context.Background())
		h.cancel = cancel
		h.generation++
		generation := h.generation
		go h.run(ctx, func(frame spectrumFrame) {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.generation != generation || ctx.Err() != nil {
				return
			}
			for client := range h.clients {
				select {
				case <-client:
				default:
				}
				client <- frame
			}
		})
	}
	h.mu.Unlock()
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			delete(h.clients, ch)
			if len(h.clients) == 0 {
				h.cancel()
			}
		})
	}
}

type pulseInput struct {
	Index      uint32            `json:"index"`
	Corked     bool              `json:"corked"`
	Mute       bool              `json:"mute"`
	Properties map[string]string `json:"properties"`
}

func streamPlayer(p map[string]string) string {
	if p["application.name"] == "go-librespot" {
		return "spotify"
	}
	// The Pi runs only the dedicated Brave receiver. Prefer its systemd unit,
	// with Brave's explicit client identity as a fallback if no PID is exposed.
	if pid, err := strconv.Atoi(p["application.process.id"]); err == nil && pid > 0 {
		if group, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid)); err == nil && strings.Contains(string(group), "/youtube-tv.service") {
			return "youtube"
		}
	}
	if p["application.name"] == "Brave" || p["application.process.binary"] == "brave" || p["application.process.binary"] == "brave-browser" {
		return "youtube"
	}
	return ""
}
func selectStreams(inputs []pulseInput) map[uint32]string {
	result := make(map[uint32]string)
	counts := map[string]int{}
	sort.Slice(inputs, func(i, j int) bool { return inputs[i].Index > inputs[j].Index })
	for _, input := range inputs {
		if input.Corked || input.Mute {
			continue
		}
		id := streamPlayer(input.Properties)
		// A browser may briefly overlap media streams during a video transition.
		if id != "" && counts[id] < 2 {
			result[input.Index] = id
			counts[id]++
		}
	}
	return result
}

type capturedSpectrum struct {
	index uint32
	bands [spectrumBands]uint8
	at    time.Time
}
type spectrumCapture struct {
	player string
	cancel context.CancelFunc
	done   chan struct{}
	last   capturedSpectrum
}
type streamDiscovery struct {
	streams map[uint32]string
	err     error
}

func runSpectrum(ctx context.Context, pactl, parec string, publish func(spectrumFrame)) {
	discoveries := make(chan streamDiscovery, 1)
	go func() {
		for {
			data, err := runWithTimeout(ctx, 2*time.Second, pactl, "--format=json", "list", "sink-inputs")
			var inputs []pulseInput
			if err == nil {
				err = json.Unmarshal(data, &inputs)
			}
			result := streamDiscovery{err: err}
			if err == nil {
				result.streams = selectStreams(inputs)
			}
			select {
			case discoveries <- result:
			case <-ctx.Done():
				return
			}
			select {
			case <-time.After(2 * time.Second):
			case <-ctx.Done():
				return
			}
		}
	}()
	updates := make(chan capturedSpectrum, 8)
	captures := make(map[uint32]*spectrumCapture)
	defer func() {
		for _, capture := range captures {
			capture.cancel()
		}
		for _, capture := range captures {
			<-capture.done
		}
	}()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	discoveryOK := false
	for {
		select {
		case <-ctx.Done():
			return
		case result := <-discoveries:
			discoveryOK = result.err == nil
			for index, capture := range captures {
				ended := false
				select {
				case <-capture.done:
					ended = true
				default:
				}
				if ended || result.streams[index] != capture.player {
					capture.cancel()
					<-capture.done
					delete(captures, index)
				}
			}
			for index, player := range result.streams {
				if _, exists := captures[index]; exists {
					continue
				}
				captureCtx, cancel := context.WithCancel(ctx)
				capture := &spectrumCapture{player: player, cancel: cancel, done: make(chan struct{})}
				captures[index] = capture
				go func(index uint32, capture *spectrumCapture) {
					defer close(capture.done)
					captureSpectrum(captureCtx, parec, index, updates)
				}(index, capture)
			}
		case update := <-updates:
			if capture := captures[update.index]; capture != nil {
				capture.last = update
			}
		case now := <-ticker.C:
			status := "idle"
			if !discoveryOK {
				status = "unavailable"
			}
			frame := spectrumFrame{"spotify": {Status: status}, "youtube": {Status: status}}
			for _, capture := range captures {
				value := frame[capture.player]
				if capture.last.at.IsZero() {
					if value.Status != "live" {
						value.Status = "unavailable"
					}
					frame[capture.player] = value
					continue
				}
				if now.Sub(capture.last.at) > 400*time.Millisecond {
					continue
				}
				value.Status = "live"
				for i, level := range capture.last.bands {
					if level > value.Bands[i] {
						value.Bands[i] = level
					}
				}
				frame[capture.player] = value
			}
			publish(frame)
		}
	}
}

func captureSpectrum(ctx context.Context, parec string, index uint32, updates chan<- capturedSpectrum) {
	cmd := exec.CommandContext(ctx, parec, "--raw", "--format=float32le", "--rate=24000", "--channels=2", "--latency-msec=100", "--client-name=RaspPi visualizer", "--stream-name=RaspPi visualizer", "--monitor-stream="+strconv.FormatUint(uint64(index), 10))
	cmd.WaitDelay = time.Second
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	if cmd.Start() != nil {
		return
	}
	defer func() { _ = pipe.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	raw := make([]byte, spectrumSamples*2*4)
	left, right := make([]complex128, spectrumSamples), make([]complex128, spectrumSamples)
	for {
		if _, err := io.ReadFull(pipe, raw); err != nil {
			return
		}
		levels := audioSpectrum(raw, left, right)
		select {
		case updates <- capturedSpectrum{index: index, bands: levels, at: time.Now()}:
		case <-ctx.Done():
			return
		}
	}
}

// Hann-windowed stereo FFT. Analyze both channels independently so opposite
// phase stereo does not disappear when summed to mono. Only magnitudes leave
// this process; audio is neither saved nor sent to the browser.
func audioSpectrum(raw []byte, left, right []complex128) (levels [spectrumBands]uint8) {
	n := len(left)
	for i := range left {
		window := .5 * (1 - math.Cos(2*math.Pi*float64(i)/float64(n-1)))
		l := float64(math.Float32frombits(binary.LittleEndian.Uint32(raw[i*8:])))
		r := float64(math.Float32frombits(binary.LittleEndian.Uint32(raw[i*8+4:])))
		if math.IsNaN(l) || math.IsInf(l, 0) {
			l = 0
		}
		if math.IsNaN(r) || math.IsInf(r, 0) {
			r = 0
		}
		left[i] = complex(l*window, 0)
		right[i] = complex(r*window, 0)
	}
	fft(left)
	fft(right)
	for band := range levels {
		low := 40 * math.Pow(300, float64(band)/spectrumBands)
		high := 40 * math.Pow(300, float64(band+1)/spectrumBands)
		start := max(1, int(math.Round(low*float64(n)/spectrumRate)))
		end := min(n/2, max(start+1, int(math.Round(high*float64(n)/spectrumRate))))
		peak := 0.0
		for k := start; k < end; k++ {
			peak = max(peak, cmplx.Abs(left[k]), cmplx.Abs(right[k]))
		}
		amplitude := peak * 4 / float64(n)
		if amplitude > 0 {
			levels[band] = uint8(math.Round(min(100, max(0, (20*math.Log10(amplitude)+65)*100/65))))
		}
	}
	return
}
func fft(values []complex128) {
	n := len(values)
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j ^= bit
		if i < j {
			values[i], values[j] = values[j], values[i]
		}
	}
	for size := 2; size <= n; size <<= 1 {
		step := cmplx.Rect(1, -2*math.Pi/float64(size))
		for start := 0; start < n; start += size {
			weight := complex(1, 0)
			for k := 0; k < size/2; k++ {
				even := values[start+k]
				odd := weight * values[start+k+size/2]
				values[start+k] = even + odd
				values[start+k+size/2] = even - odd
				weight *= step
			}
		}
	}
}
