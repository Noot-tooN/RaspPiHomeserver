package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const bandCount = 10

type equalizer struct {
	mu   sync.Mutex
	file string
	run  commandRunner
}

type eqCurve struct {
	Gains  [bandCount]int `json:"gains"`
	Preamp float64        `json:"preamp"`
}

func curveFrom(gains []int) (eqCurve, error) {
	var curve eqCurve
	if len(gains) != bandCount {
		return curve, errors.New("Choose ten equalizer gains")
	}
	peak := 0
	for i, g := range gains {
		if g < -6 || g > 6 {
			return curve, errors.New("Each gain must be between −6 and +6 dB")
		}
		curve.Gains[i] = g
		peak = max(peak, g)
	}
	// Adjacent octave bands overlap. Reserve twice the largest positive
	// gain in dB as headroom. Flat and cut-only curves keep unity gain.
	curve.Preamp = math.Pow(10, -2*float64(peak)/20)
	return curve, nil
}

func (e *equalizer) saved() (eqCurve, error) {
	data, err := os.ReadFile(e.file)
	if errors.Is(err, os.ErrNotExist) {
		return eqCurve{Preamp: 1}, nil
	}
	if err != nil {
		return eqCurve{}, err
	}
	var input struct {
		Gains []int `json:"gains"`
	}
	if err := json.Unmarshal(data, &input); err != nil {
		return eqCurve{}, err
	}
	return curveFrom(input.Gains)
}

func (e *equalizer) node(ctx context.Context) (int, error) {
	out, err := e.run(ctx, "pw-dump", "-N", "rasppi-eq")
	if err != nil {
		return 0, err
	}
	var nodes []struct {
		ID   int
		Info struct{ Props map[string]any }
	}
	if err := json.Unmarshal(out, &nodes); err != nil {
		return 0, err
	}
	for _, n := range nodes {
		if n.Info.Props["node.name"] == "rasppi-eq" && n.Info.Props["media.class"] == "Audio/Sink" {
			return n.ID, nil
		}
	}
	return 0, errors.New("equalizer sink unavailable")
}

func (e *equalizer) apply(ctx context.Context, node int, curve eqCurve) error {
	var params strings.Builder
	fmt.Fprintf(&params, `{ params: [ "preamp:Mult" %.9f`, curve.Preamp)
	for i, g := range curve.Gains {
		fmt.Fprintf(&params, ` "band%d:Gain" %d.0`, i, g)
	}
	params.WriteString(" ] }")
	_, err := e.run(ctx, "pw-cli", "set-param", strconv.Itoa(node), "Props", params.String())
	return err
}

func (e *equalizer) update(ctx context.Context, node int, curve eqCurve) error {
	previous, err := e.saved()
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(e.file), ".equalizer-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	writeErr := json.NewEncoder(file).Encode(curve)
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	if err := e.apply(ctx, node, curve); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), e.file); err != nil {
		return errors.Join(err, e.apply(context.WithoutCancel(ctx), node, previous))
	}
	return nil
}

func (p *panel) equalizerAPI(w http.ResponseWriter, r *http.Request) {
	e := p.eq
	if e == nil {
		fail(w, 503, "Equalizer unavailable")
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	node, err := e.node(r.Context())
	if err != nil {
		fail(w, 503, "Equalizer unavailable")
		return
	}
	var curve eqCurve
	if r.Method == http.MethodPost {
		var input struct {
			Gains []int `json:"gains"`
		}
		if !decode(w, r, &input) {
			return
		}
		curve, err = curveFrom(input.Gains)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		err = e.update(r.Context(), node, curve)
	} else {
		curve, err = e.saved()
	}
	if err != nil {
		log.Printf("equalizer: %v", err)
		fail(w, 503, "Could not read or apply the equalizer settings")
		return
	}
	jsonReply(w, 200, curve)
}
