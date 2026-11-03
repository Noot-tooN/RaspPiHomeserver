# RaspPiHomeserver

NixOS configuration for a **Raspberry Pi 4 Model B, 2 GB**, with a **Raspberry Pi DAC Pro** HAT. It provides Spotify Connect and a hidden YouTube TV browser receiver, both named **RaspPi**, and uses Comin to update from this repository's `master` branch.

This is a migration from an audited Raspberry Pi OS installation. Software builds and hardware acceptance are different: see [validation status](docs/validation.md) before installing. Prepare a spare SD card and keep the existing card as the recovery path.

## What is configured

- A matched Pi kernel/firmware bundle from [nixos-raspberrypi](https://github.com/nvmd/nixos-raspberrypi), pinned in `flake.lock`, with its binary cache.
- The `rpi-dacpro` firmware overlay and the audited DAC mixer state, including de-emphasis.
- PipeWire and WirePlumber in the persistent `pita` user session. Both receivers use the named `rasppi-dac` sink; WirePlumber restores the last-used software volume and mute state. Its standard 40% fallback applies only when no saved device-route volume exists.
- Librespot with PulseAudio output, normalization enabled, audio/credential caching disabled, and a fixed discovery port.
- Brave under Xvfb, with the existing TV user agent, a persistent profile, the verified receiver-name hook, and recovery from an empty/crashed page.
- SSH using the existing public key in `keys/pita.pub`; password login is disabled. `pita` has passwordless sudo for key-based administration. No password is embedded in the image.
- Wi-Fi provisioning after flashing, or Ethernet DHCP. Credentials never enter Git or the Nix store.
- Comin automatically follows `https://github.com/Noot-tooN/RaspPiHomeserver.git`, branch `master`, configuration `rasppi`.
- A small Go control panel for DAC volume/mute and Spotify/YouTube service status and restart, accessible over Tailscale.
- Tailscale matches HomeServer's network-only setup: normal SSH keys, Tailscale SSH disabled, client routing support, and a trusted `tailscale0` interface. LAN SSH remains available for first boot and recovery.

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

SD images are bootstrap/recovery artifacts. Build one manually on an **aarch64-linux** PC or Linux VM when preparing a card:

```sh
nix --accept-flake-config build .#sd-image --out-link result-image
zstd -t result-image/sd-image/*.img.zst
```

Keep the verified image outside Git. Normal updates do not require another image or reflashing.

The GitHub Actions workflow runs on a native ARM64 runner and checks the cache, tests, and complete system build. It does not build or upload SD images, including on manual runs. No CI job deploys to the running Pi.

### Build times and caches

The cache check verifies the exact pinned kernel, kernel modules, firmware, Brave, librespot, PipeWire, WirePlumber, Xvfb and Tailscale outputs against `cache.nixos.org` and the Pi project's Cachix cache. It fails if a target is absent or the caches cannot be reached. It does not certify every transitive dependency.

The control panel is a small, dependency-free Go source build with embedded web assets; changes to it do not rebuild the browser or audio stack. CI validates it but does not publish a binary cache, so Comin builds changed panel versions on the Pi.

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

Volume and mute are saved in `pita`'s WirePlumber state under
`/home/pita/.local/state/wireplumber/`. They survive normal reboots and system
updates. A fresh card without restored state starts with WirePlumber's default
volume; it cannot inherit the old card's last-used volume automatically. The
readiness service selects the DAC but does not reset its software volume or
unmute it. The audited hardware mixer settings are still restored separately.

## Tailscale enrollment

Tailscale is installed and starts on boot, but the image contains no auth key or
node identity. After the first LAN SSH login, run:

```sh
sudo tailscale up --ssh=false
```

Open the printed login URL and join the same tailnet as HomeServer. Then use
`tailscale ip -4` to obtain the Pi's address and connect with
`ssh pita@<tailscale-ip>` using your existing SSH key. With MagicDNS enabled,
`rasppi` is also available as a tailnet hostname. Tailscale SSH stays disabled;
OpenSSH provides authentication over either network.

For HomeServer-style unattended enrollment instead, provision a separate auth
key for this Pi at `/etc/tailscale/authkey` (root-owned, mode `0600`, outside Git
and the Nix store), then run `sudo systemctl start tailscaled-autoconnect`.
Without that file the enrollment service is skipped. Existing node identity is
stored under `/var/lib/tailscale` and persists across reboots and Comin updates.
Do not copy HomeServer's node state to the Pi.

The Tailscale package uses the same initial `nixpkgs-unstable` lock entry as
HomeServer, independently of the cached Pi kernel package set. It will follow
this repository's future lock updates; it does not dynamically follow
HomeServer. Like HomeServer, the firewall trusts the Tailscale interface; tailnet
access rules still govern connectivity. Unlike HomeServer, this Pi also keeps
LAN SSH open for initial setup and recovery. Client routing support does not
advertise this Pi as an exit node or subnet router.

## Control panel

After Tailscale enrollment, open **https://rasppi.tail0fa2e4.ts.net/** for the
Homer dashboard, matching HomeServer. The Audio link opens **/audio/** for volume,
Spotify, YouTube, and phone pairing. HTTP redirects to HTTPS; `/audio` redirects
to `/audio/` so relative assets and API calls resolve correctly.

Caddy obtains and renews the Pi's certificate through Tailscale. The tailnet must
have HTTPS Certificates enabled in its DNS settings, as for HomeServer.
The dashboard defaults to dark mode and consists of static files served by
Caddy. The audio backend listens only on `127.0.0.1:8090`; its port is no longer
reachable from other devices. The firewall permits web access through the
trusted Tailscale interface and keeps it closed on the LAN.

There is no separate panel password: tailnet access rules authorize access,
and anyone allowed to reach the dashboard can control volume and restart the
two services. The backend validates the exact public HTTPS origin; arbitrary
Host, Origin, and forwarding headers do not bypass those checks.

- Set the DAC's master volume from 0–100% and mute/unmute it. WirePlumber saves
  these settings as usual; opening the page does not change them.
- See Spotify and YouTube service status, with live updates every five seconds.
  A running process does not prove that casting or playback is healthy.
- Restart either service. This interrupts that app's playback; the panel reports
  that a restart was requested, then shows the actual service state.
- Use **Link phone** on the YouTube card to display its current TV code. On your
  phone, open YouTube → Cast → Link with TV code and enter the numbers. Opening
  pairing settings can interrupt YouTube playback. A fresh receiver is opened
  in guest mode; no Google account sign-in is required. Codes appear only on
  request and are hidden after five minutes, on refresh, or when restarting
  YouTube from the panel. **Hide code** clears the display without unlinking devices.

The panel runs as `pita`, without sudo. It remains available when an audio or
receiver service fails, and retries startup until Tailscale has an address.
Polling is shared between viewers and stops when no page is visible.

```sh
systemctl --user status rasppi-control-panel
journalctl --user -u rasppi-control-panel -b
```

A previously built NixOS image can receive the panel through Comin after the
change reaches `master`; flashing another image is unnecessary for this addition.
See [control-panel development](apps/control-panel/README.md) for local tests
and a simulated preview that never touches the Pi.

## Updates and recovery

Comin, the Nix daemon, and garbage collection share a background resource
budget: one CPU core, 1,000 MiB memory pressure threshold, 1,100 MiB memory ceiling,
and up to 512 MiB compressed swap. Disk reads/writes are capped at 8/2 MB per
second and 1,000/250 operations per second, with lower CPU/I/O priority. Initial
updates can take longer. User services have 512 MiB of best-effort memory
reclaim protection to help audio and SSH remain responsive. Nix downloads
and unpacks one substitute at a time, and automatic store deduplication is off
to avoid an extra SD-card scan. Builds still use cached packages where available. Evaluation and builds each
have a 90-minute timeout so a cold cache can populate under these limits without
being repeatedly cancelled. Small updates reuse dependencies while cached.

The vendor kernel's memory controller is enabled with `cgroup_enable=memory`;
this requires a reboot when first added. Comin checks that the controller exists
before starting. The existing kernel's BFQ module prioritizes foreground SD-card
I/O; no kernel compilation is introduced. Limits resolve the disk backing `/`,
so the recovery USB also works.

To inspect the effective controls, use `systemctl show nixmaintenance.slice`
and `cat /sys/fs/cgroup/nixmaintenance.slice/io.max`. Comin's journal records
evaluation, build, and deployment progress: `journalctl -u comin -f`.

Comin follows `master` immediately; it does **not** wait for GitHub Actions. Merge changes only after the ARM64 checks pass.

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

## SSH shell

`pita` uses Fish with HomeServer's Starship prompt, green command highlighting,
Ctrl-H word deletion, `ls`/`ll`/`lt`/`cat`/`find` abbreviations, fzf file previews,
and `!!`/`!$`/`!*` history helpers. The prompt and helpers were copied from
HomeServer revision `7b20a1d325651937afb0b9e9e338bb678a2921f5` and are managed by
NixOS. Command history and credentials are not copied. Open a new SSH session
after deployment to use the new login shell.
