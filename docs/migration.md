# Migration decisions

Baseline: read-only audit on 2026-11-03 of Raspberry Pi OS on a Pi 4 Model B Rev 1.1, 2 GB, aarch64, with a Raspberry Pi DAC Pro. The original system remains unchanged by this repository.

| Audited behavior | NixOS treatment |
|---|---|
| Raspotify wraps librespot 0.8.0 | Use cached `go-librespot` as a `pita` user service for native local volume/transport controls. Preserve the PulseAudio DAC route, normalization, discovery port and disabled credential persistence. Keep its API on loopback. |
| Raspotify runs as `pita`, reaches UID 1000's Pulse socket | Both receivers run in `pita`'s lingering systemd user manager and use PipeWire's Pulse socket. No desktop or autologin is needed. |
| Browser startup sets the default sink and can race DAC discovery | A shared readiness service waits for the restored DAC and actual sink. WirePlumber gives the platform sound device a fixed node name. |
| PipeWire at 48 kHz; observed software volume 40% | Pin the clock rate and let WirePlumber restore the last-used software volume and mute state. The observed 40% is not imposed at every startup; WirePlumber's standard 40% fallback is used only without saved route volume. Source volume remains separately adjustable. |
| Hardware mixer at 0 dB, de-emphasis on, custom ramps/mutes | Restore only the audited `state.Pro` block from `hardware/dac-pro.state`. Select by ALSA card ID, never numeric index. Use software volume rather than changing DAC gain. |
| HAT EEPROM supplies the DAC device tree | Explicit `rpi-dacpro` vendor overlay, with EEPROM auto-read disabled to avoid applying two descriptions. Use the matching cached vendor kernel/firmware bundle. Requires physical validation. |
| `/etc/asound.conf` bypasses PipeWire and opens the DAC directly | ALSA clients use PipeWire's compatibility layer. The old direct-hardware default is intentionally not carried over; it could contend with the shared sound server. |
| Brave + Xvfb, Tizen user agent, basic password store | Preserve these launch settings and the profile path. Launch a blank page, attach the naming hook, then navigate to YouTube. |
| Live receiver renamed successfully using a temporary CDP hook | Package the same name-only JavaScript and apply it on every document load through the receiver supervisor. No browser rebuild or extension marketplace dependency. |
| Browser process alive but document blank | Three failed page checks, 30 seconds apart, cause the service to restart. No playback is triggered by the check. |
| Old phone entry retained `YouTube on TV` | Fresh pairing after phone app data reset displayed `RaspPi`; the exact cache location was not isolated. |
| Mopidy/Iris and old Xpra experiments | Omitted by the owner's explicit choice. Their broken YouTube plugin and idle socket are not dependencies of the active receiver. |
| Wi-Fi in mutable Raspberry Pi OS state | Supply a NetworkManager keyfile on the flashed card; import before NetworkManager starts. No network password is in the flake. |

Persistent state is separate from the reproducible system: browser account sessions/pairings, NetworkManager credentials, SSH host keys, WirePlumber's saved state, and Comin's checkout are not recreated from Git. Keep private backups outside this public repository. A copied browser profile should be copied only while its browser is stopped and must retain ownership by UID 1000.

## Hardware acceptance on a spare card

- Cold boot reaches SSH over the intended network without a graphical login.
- `amixer -c Pro` reports the intended mixer settings, especially de-emphasis and 0 dB hardware gain.
- `pactl get-default-sink` returns `rasppi-eq`; both services wait for it.
- Spotify discovers `RaspPi`, plays through the DAC, and controls volume correctly.
- YouTube pairs as `RaspPi` and plays through the DAC. No display is required.
- Switching sources, reconnecting Wi-Fi, and restarting either receiver do not lose sound routing.
- A reboot preserves browser state and the name override.
- Changing the master volume or mute state, then restarting the audio session or rebooting, restores that state without forcing 40% or unmuting. Verify this separately from each application's own volume control.
- One small Git update is activated by Comin; recovery and reboot behavior are checked.

These are acceptance steps, not claims of completed hardware tests.
