"""Recover the always-on receivers after dependency failures or a NixOS switch."""

import subprocess
import time
from pathlib import Path

BACKENDS = ("pipewire", "pipewire-pulse", "wireplumber", "rasppi-equalizer")
PLAYERS = ("rasppi-audio-ready", "spotify", "youtube-tv")
TRANSITIONAL = {"activating", "deactivating", "reloading"}


def run(*args):
    return subprocess.check_output(args, text=True, timeout=5, stderr=subprocess.DEVNULL)


def recover():
    # The mixer may be stopped during activation. Never start playback on a
    # fresh boot before it has initialized the physical DAC at least once.
    if not Path("/run/rasppi-dac/ready").exists():
        return
    output = run("systemctl", "--user", "show",
                 "--property=Id,ActiveState,ActiveEnterTimestampMonotonic",
                 *(f"{name}.service" for name in BACKENDS + PLAYERS))
    states = {}
    for block in output.strip().split("\n\n"):
        props = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        states[props["Id"].removesuffix(".service")] = props
    # Let backends finish restarting. The readiness service may be waiting for
    # a missing sink, so its activating state must not prevent repairing it.
    if any(states[name]["ActiveState"] in TRANSITIONAL for name in BACKENDS):
        return

    def start_missing(names):
        missing = [f"{name}.service" for name in names
                   if states[name]["ActiveState"] in {"inactive", "failed"}]
        if missing:
            run("systemctl", "--user", "--no-block", "start", *missing)
        return bool(missing)

    if start_missing(BACKENDS):
        return
    sinks = {line.split()[1] for line in run("pactl", "list", "short", "sinks").splitlines()
             if len(line.split()) >= 2}
    if "rasppi-dac" not in sinks:
        return
    if "rasppi-eq" not in sinks:
        # A live filter process can have no registered sink after PipeWire
        # restarts. Restart=always cannot detect that. Allow startup 30 seconds.
        started = int(states["rasppi-equalizer"]["ActiveEnterTimestampMonotonic"]) / 1e6
        if time.monotonic() - started >= 30:
            print("Recovering equalizer: playback sink is missing", flush=True)
            run("systemctl", "--user", "--no-block", "restart", "rasppi-equalizer.service")
        return
    # Do not replace a user-requested player restart once audio is healthy.
    if any(states[name]["ActiveState"] in TRANSITIONAL for name in PLAYERS):
        return
    if start_missing(PLAYERS):
        print("Recovering audio readiness and stopped receivers", flush=True)


if __name__ == "__main__":
    try:
        recover()
    except (OSError, subprocess.SubprocessError, KeyError, ValueError) as error:
        # A bounded failed probe is retried by the timer, not a reason to restart
        # healthy receivers. Avoid printing command output or account data.
        raise SystemExit(f"Audio recovery probe failed: {type(error).__name__}")
