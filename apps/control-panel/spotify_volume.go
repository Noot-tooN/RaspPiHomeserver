package main

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sync"
)

type savedVolume struct {
	Volume int `json:"volume"`
	Steps  int `json:"steps"`
}
type spotifyVolumeMemory struct {
	mu   sync.Mutex
	last savedVolume
	dir  string
}

func (m *spotifyVolumeMemory) load(dir string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.dir = dir
	if dir == "" {
		return
	}
	data, err := os.ReadFile(filepath.Join(dir, "spotify-volume.json"))
	var value savedVolume
	if err == nil && len(data) < 1024 && json.Unmarshal(data, &value) == nil && value.Volume > 0 && value.Volume <= value.Steps && value.Steps <= 65535 {
		m.last = value
	}
}
func (m *spotifyVolumeMemory) observe(volume, steps int) {
	if volume <= 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.last = savedVolume{Volume: volume, Steps: steps}
}
func (m *spotifyVolumeMemory) available() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.last.Volume > 0
}
func (m *spotifyVolumeMemory) restore(steps int) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.last.Volume <= 0 || m.last.Steps <= 0 {
		return 0
	}
	return max(1, min(steps, int(math.Round(float64(m.last.Volume)*float64(steps)/float64(m.last.Steps)))))
}
func (m *spotifyVolumeMemory) save() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dir == "" {
		return nil
	}
	data, _ := json.Marshal(m.last)
	temp, err := os.CreateTemp(m.dir, ".volume-")
	if err != nil {
		return err
	}
	path := temp.Name()
	defer os.Remove(path)
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	return os.Rename(path, filepath.Join(m.dir, "spotify-volume.json"))
}
