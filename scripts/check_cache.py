"""Fail early if an expensive pinned ARM64 package is absent from both caches."""

import json
import subprocess
import sys

CACHES = ("https://cache.nixos.org", "https://nixos-raspberrypi.cachix.org")

paths = json.loads(subprocess.check_output([
    "nix", "--accept-flake-config", "eval", "--json", ".#lib.cachePaths",
], text=True))
missing = []
for name, path in paths.items():
    for cache in CACHES:
        result = subprocess.run([
            "nix", "path-info", "--store", cache, path,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if result.returncode == 0:
            print(f"{name}: cached at {cache}", flush=True)
            break
    else:
        missing.append(name)
        print(f"{name}: missing or cache unreachable: {path}", file=sys.stderr)
if missing:
    sys.exit("Refusing a potentially expensive build; investigate: " + ", ".join(missing))
