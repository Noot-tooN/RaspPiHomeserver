# RaspPiHomeserver

NixOS configuration for a **Raspberry Pi 4 Model B, 2 GB**, with a **Raspberry Pi DAC Pro** HAT. It provides Spotify Connect and a hidden YouTube TV browser receiver, both named **RaspPi**, and uses Comin to update from this repository's `master` branch.

This is a migration from an audited Raspberry Pi OS installation. Software builds and hardware acceptance are different: see [validation status](docs/validation.md) before installing. Prepare a spare SD card and keep the existing card as the recovery path.

## What is configured

- A matched Pi kernel/firmware bundle from [nixos-raspberrypi](https://github.com/nvmd/nixos-raspberrypi), pinned in `flake.lock`, with its binary cache.
- The `rpi-dacpro` firmware overlay and the audited DAC mixer state, including de-emphasis.
- PipeWire and WirePlumber in the persistent `pita` user session. Both receivers use the named `rasppi-dac` sink; boot volume is explicitly 40%.
- Librespot with PulseAudio output, normalization enabled, audio/credential caching disabled, and a fixed discovery port.
- Brave under Xvfb, with the existing TV user agent, a persistent profile, the verified receiver-name hook, and recovery from an empty/crashed page.
- SSH using the existing public key in `keys/pita.pub`; password login is disabled. `pita` has passwordless sudo for key-based administration. No password is embedded in the image.
- Wi-Fi provisioning after flashing, or Ethernet DHCP. Credentials never enter Git or the Nix store.
- Comin automatically follows `https://github.com/Noot-tooN/RaspPiHomeserver.git`, branch `master`, configuration `rasppi`.

Mopidy/Iris, Xpra, a desktop login, and the separate standalone PulseAudio daemon are intentionally omitted. [Migration decisions](docs/migration.md) describe the differences from the old installation.

## Build

Use Nix with flakes on an **aarch64-linux** builder. An ARM Linux VM/container on an Apple Silicon Mac also works. macOS itself cannot directly execute Linux build steps. Cross-compilation produces different derivations and can lose the expected cache hits.

```sh
python3 scripts/check_cache.py
nix --accept-flake-config flake check --print-build-logs
nix --accept-flake-config build .#system
nix --accept-flake-config build .#sd-image --out-link result-image
```

The first cache-check invocation may need `accept-flake-config = true` in your Nix configuration, or explicit trust of the cache declared in `flake.nix`. The script itself passes `--accept-flake-config` when evaluating the flake.

The image is under `result-image/sd-image/*.img.zst`. Decompress it with `zstd -d`, then flash the resulting `.img` to a **spare** SD card using an imaging tool. A normal Comin update rebuilds the system generation, not the SD image.

The GitHub Actions workflow runs on a native ARM64 runner and checks the cache, tests, and complete system build. Its manual `build_image` input additionally uploads a flashable image artifact, retained for seven days. No CI job deploys to the running Pi.

### Build times and caches

The cache check verifies the exact pinned kernel, kernel modules, firmware, Brave, librespot, PipeWire, WirePlumber and Xvfb outputs against `cache.nixos.org` and the Pi project's Cachix cache. It fails if a target is absent or the caches cannot be reached. It does not certify every transitive dependency.

Comin is built from its pinned source. It is included in the image, so ordinary configuration changes reuse it; changing its version or dependencies can require another Go build. Generated units, scripts, initrds, and image assembly still run locally. The receiver-name change does not rebuild Brave. We avoid the Pi project's global multimedia overrides, which would cause additional rebuilds.

Update inputs deliberately, then rerun the cache check and CI. A passing build is not a replacement for a boot/audio test after kernel or firmware changes.

## First boot

1. Confirm `keys/pita.pub` is a key you control before flashing. The supplied key is the existing Pi's public SSH key.
2. For Wi-Fi, mount the flashed FAT firmware partition on your computer and run:

   ```sh
   python3 scripts/prepare_wifi.py /path/to/mounted/firmware
   ```

   The helper prompts for the SSID and password without printing the password. It writes `rasppi-wifi.nmconnection` to the card, refuses to overwrite an existing file, and supports WPA-Personal networks. On boot, a root service imports the file into NetworkManager's persistent configuration and removes the boot-partition copy. The password still exists in the private NetworkManager profile; the card must be treated accordingly. No Wi-Fi file is needed for Ethernet.

3. Boot the spare card and connect with `ssh pita@rasppi.local` (or its DHCP address). The current `raspPi` SSH alias may point at the old IP; it is not changed by this repository.
4. Check the DAC and receivers using the commands below. Test at a controlled listening volume when ready.
5. Sign in/pair YouTube. The browser profile lives in `/home/pita/.config/brave-youtube-tv` and survives system updates. A fresh image requires setup again unless you separately restore that private state. Existing phone pairings may retain the old name; a fresh TV-code pairing displayed `RaspPi` in the original-system test.

For the hidden browser's first-time UI, create an SSH tunnel:

```sh
ssh -N -L 9222:127.0.0.1:9222 pita@rasppi.local
```

In a local Chromium/Brave browser, open `chrome://inspect/#devices` (or `brave://inspect/#devices`), configure `localhost:9222`, and inspect the receiver tab. DevTools' screencast lets you operate its account and pairing screens. The debugging endpoint is bound to loopback and is not opened in the firewall. Do not expose it to the LAN: it controls the logged-in browser.

## Updates and recovery

Comin follows `master` immediately; it does **not** wait for GitHub Actions. Merge changes only after the ARM64 checks pass. Before this initial configuration is merged, a candidate image cannot update from the license-only `master` branch.

```sh
sudo journalctl -u comin -b
systemctl --user status spotify youtube-tv rasppi-audio-ready
sudo systemctl status rasppi-dac-mixer
pactl get-default-sink
pactl list short sinks
amixer -c Pro
journalctl --user -u youtube-tv -b
```

To investigate a bad update, stop Comin before rolling back so it does not immediately reapply the same commit:

```sh
sudo systemctl stop comin
sudo nixos-rebuild switch --rollback
```

Revert/fix the Git commit and restart Comin when ready. Kernel/firmware activation needs a reboot to fully take effect. The image keeps up to five boot generations, but the original SD card is the dependable recovery path until physical rollback has been tested.

The YouTube monitor detects empty documents, browser errors and a missing name hook. It does not prove playback works or that YouTube's remote casting service is healthy. YouTube's website is fetched at runtime and can change independently of the pinned OS.
