# Validation status

Validated on 2026-11-03 in an isolated native ARM64 Linux container on the development Mac. The complete system and compressed SD image built successfully. No NixOS image has been booted on the physical Pi yet.

## Completed checks

- `nix flake check`: Python receiver/CDP tests, JavaScript naming-hook tests, and Wi-Fi keyfile roundtrips through the real NetworkManager parser passed.
- `nix fmt -- --ci`: passed without changes.
- Exact heavy-package cache checks: passed, with the packages below actually downloaded during the build.
- Complete system and SD image builds: passed. The image is approximately 1.91 GiB compressed and 6.14 GiB uncompressed, with a 1 GiB FAT firmware partition and an ext4 root partition.
- Read back `config.txt` from the finished image: ARM64 boot, explicit `rpi-dacpro`, `force_eeprom_read=0`, and onboard audio disabled. The cached kernel includes the IQaudio DAC driver; the firmware includes the DAC Pro overlay.
- Real Brave/Xvfb smoke test: YouTube loaded, the document reported the `RaspPi` label, and the supervisor accepted it as healthy. Deliberately navigating to a blank page caused an error exit after three failed checks. Media playback was blocked for this test.

The container build disabled Nix sandboxing. The browser smoke test used a fresh disposable profile and a test-only `--no-sandbox` wrapper because of container restrictions; the deployed browser does not have that flag. Browser sandboxing and systemd restart behavior still need verification on the Pi.

## Cache evidence

The completed build uses these pinned versions:

| Component | Version | Source |
|---|---|---|
| Pi 4 kernel | 6.18.34, vendor snapshot 20260604 | `nixos-raspberrypi.cachix.org` |
| Pi firmware | 1.20260521 | `nixos-raspberrypi.cachix.org` |
| Brave | 1.97.59 | `cache.nixos.org` |
| Librespot | 0.8.0 | `cache.nixos.org` |
| PipeWire | 1.6.6 | `cache.nixos.org` |
| WirePlumber | 0.5.14 | `cache.nixos.org` |
| Xvfb | 21.1.24 | `cache.nixos.org` |
| Comin | 0.14.0 | Pinned source build |

The kernel and firmware were actually downloaded from the Pi cache during local validation. The configuration does not compile a kernel or browser. Store paths depend on `flake.lock`; run `python3 scripts/check_cache.py` after changing it.

## Control panel

Local Go race tests and `go vet` pass. A statically linked Linux ARM64 executable
builds from macOS without a cross C toolchain. Desktop and phone-size browser
checks use a fake backend: volume, mute and restart feedback are verified
without touching the Pi or playing sound. Nix packages run the Go tests in ARM64
CI as part of `nix flake check`. Live PipeWire access, user-service hardening and
Tailscale binding still require a physical NixOS boot.

## Outstanding

Physical DAC detection, sound output, phone discovery, cold-boot ordering, Wi-Fi provisioning, and rollback must be tested on a spare card. The existing Pi OS test confirmed the naming hook's behavior and fresh-phone pairing, not this NixOS image's runtime behavior.
