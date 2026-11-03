# RaspPi control panel

One Go executable embeds the HTML, CSS and JavaScript. It uses the standard
library only and builds with `CGO_ENABLED=0`. The operating system supplies
`pactl`, `systemctl`, PipeWire and the receiver services; these are not bundled
inside the executable.
TV pairing uses a small helper with the same Python/websockets runtime already
used by the YouTube receiver. It adds no Go dependency or always-running service.

## Development

```sh
go test -race ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w' .
```

A local preview uses a fake backend, including fake restarts and volume changes:

```sh
RASPPI_PANEL_PREVIEW=1 go test -run '^TestPreview$' -timeout=0
# Open http://127.0.0.1:8098
```

The preview's test-only `POST /__test/unavailable` endpoint simulates missing
audio and a failed YouTube service. None of this fixture is in the shipped
binary. Stop the preview with Ctrl-C.

On an aarch64-linux Nix builder, `nix build .#control-panel` at the repository
root builds the package and runs its tests. `nix flake check` also includes it.

## Runtime

The NixOS module runs the panel as `pita`, with the existing user D-Bus and Pulse
socket. It passes absolute paths to `pactl` and `systemctl`. The process accepts
only the fixed Spotify and YouTube service IDs; commands never go through a
shell. Volume changes target `rasppi-dac`, not whichever sink happens to be the
default. Values above 100% from an external controller remain visible, but this
panel only sets 0–100%.

One server-sent event stream per visible page carries snapshots from a shared
monitor. Commands have time/output limits, mutations are serialized, and
restarts have a five-second cooldown. Missing audio or service state is shown
as unavailable rather than assumed healthy.

Tailscale provides the access boundary. The production service binds only to
loopback. Caddy serves it at `https://rasppi.tail0fa2e4.ts.net/audio/`, preserving
Host and Origin while stripping `/audio` from upstream paths. Relative assets
and API URLs also keep standalone loopback previews working.
The exact public-origin allowlist and same-origin JSON/custom-header checks protect against
browser-based cross-site requests and DNS rebinding. There is no general shell,
log viewer, browser remote control, or arbitrary systemd API.

`POST /api/youtube/pairing` accepts only an empty JSON object, shares the action
lock and same-origin checks, and has a 15-second cooldown. Its fixed helper can
only open the local receiver's TV-code screen. It handles guest setup and
returns a validated 12-digit TV code, never a Google account sign-in code or
browser contents. The request has a bounded 28-second execution time. Codes
are excluded from the shared event stream, logs, browser storage and caches;
the UI hides them after five minutes. A YouTube UI change can make extraction
fail, in which case the panel reports the failure without returning page data.

The standalone executable defaults to loopback port 8090. `--help` lists the
listen address, interface, allowed hostnames, public origin, sink and command-path
options. `--public-origin` explicitly trusts an HTTP or HTTPS authority for a
reverse proxy; client-supplied forwarding headers never grant access.

## Interface

The UI uses dark surfaces, system fonts, a restrained green accent, a prominent master
volume readout and plain service indicators. A polish pass removed generic
headlines, decorative glyphs and uppercase labels, aligned spacing to a 4px
scale, and increased small-text contrast. No fonts, assets or scripts load from
external services.

Design pass guided by [Unslop](https://github.com/heydamir/unslop) by
[Damir Sokolovsky](https://x.com/heydamir), licensed CC BY 4.0.

A second Unslop audit of the dark theme found excess green tint in surfaces and
text, competing green status labels, and leftover shadows. The polish uses a
near-neutral charcoal ramp, keeps green on the fader and healthy status dots,
and separates surfaces with borders instead of shadows. The audit retained
the existing spacing, copy, typography, layout, imagery-free controls and
reduced-motion behavior; no additional changes were warranted in those passes.
