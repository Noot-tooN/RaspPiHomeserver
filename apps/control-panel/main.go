package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func interfaceIPv4(name string) (string, error) {
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return "", err
	}
	addresses, err := iface.Addrs()
	if err != nil {
		return "", err
	}
	for _, address := range addresses {
		ip, _, err := net.ParseCIDR(address.String())
		if err == nil && ip.To4() != nil {
			return ip.String(), nil
		}
	}
	return "", fmt.Errorf("interface %s has no IPv4 address; enroll Tailscale first", name)
}

func main() {
	listen := flag.String("listen", "127.0.0.1:8090", "HTTP listen address")
	iface := flag.String("interface", "", "Bind only to this interface's IPv4 address instead of the listen host")
	names := flag.String("allowed-hosts", "localhost", "Comma-separated additional HTTP hostnames (without port)")
	publicOrigin := flag.String("public-origin", "", "Exact public origin when served behind a reverse proxy")
	sink := flag.String("sink", "rasppi-dac", "PipeWire/PulseAudio sink name")
	pactl := flag.String("pactl", "pactl", "Path to pactl")
	systemctl := flag.String("systemctl", "systemctl", "Path to systemctl")
	pairing := flag.String("youtube-pairing", "", "Path to the YouTube TV-code helper")
	youtubeControl := flag.String("youtube-control", "", "YouTube player helper")
	parec := flag.String("parec", "", "Path to per-stream audio capture tool")
	stateDir := flag.String("state-dir", os.Getenv("STATE_DIRECTORY"), "Private state directory for volume restoration")
	flag.Parse()
	host, port, err := net.SplitHostPort(*listen)
	if err != nil {
		log.Fatal(err)
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		log.Fatal("invalid port")
	}
	if *iface != "" {
		host, err = interfaceIPv4(*iface)
		if err != nil {
			log.Fatal(err)
		}
	}
	authorities := []string{net.JoinHostPort(host, port)}
	for _, name := range strings.Split(*names, ",") {
		if name = strings.TrimSpace(name); name != "" {
			authorities = append(authorities, net.JoinHostPort(name, port))
		}
	}
	control := &systemController{pactl: *pactl, systemctl: *systemctl, sink: *sink, pairingCommand: *pairing, youtubeCommand: *youtubeControl, spotifyURL: "http://127.0.0.1:3678", run: runCommand}
	control.spotifyRestore.load(*stateDir)
	p := newPanel(control, authorities)
	if *stateDir != "" {
		p.eq = &equalizer{file: filepath.Join(*stateDir, "equalizer.json"), run: runCommand}
	}
	if *parec != "" {
		p.spectra = &spectrumHub{run: func(ctx context.Context, publish func(spectrumFrame)) { runSpectrum(ctx, *pactl, *parec, publish) }}
	}
	if *publicOrigin != "" {
		if err := p.allowPublicOrigin(*publicOrigin); err != nil {
			log.Fatal(err)
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go p.monitor(ctx)
	server := &http.Server{
		Addr: net.JoinHostPort(host, port), Handler: p.handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 8192, BaseContext: func(net.Listener) context.Context { return ctx },
	}
	go func() {
		// Rebind after a Tailscale logout/address change via systemd restart.
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				shutdown, done := context.WithTimeout(context.Background(), 3*time.Second)
				_ = server.Shutdown(shutdown)
				done()
				return
			case <-ticker.C:
				if *iface != "" {
					current, err := interfaceIPv4(*iface)
					if err != nil || current != host {
						cancel()
					}
				}
			}
		}
	}()
	log.Printf("Control panel listening on http://%s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
