"""Publish the small, signed control-panel output as a flat GitHub release cache.

The upstream caches keep providing the large runtime packages. Upload archives
before their narinfo indexes; existing content-addressed assets are immutable.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit

TAG = "nix-cache"
REPOSITORY = "Noot-tooN/RaspPiHomeserver"
CACHE = f"https://github.com/{REPOSITORY}/releases/download/{TAG}"


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def flatten_narinfo(text):
    lines = text.splitlines()
    urls = [line[5:] for line in lines if line.startswith("URL: ")]
    if len(urls) != 1 or not urls[0].startswith("nar/") or ".." in urls[0]:
        raise ValueError("Unexpected archive URL")
    name = Path(urlsplit(urls[0]).path).name
    if not name.endswith((".nar.xz", ".nar.zst", ".nar")):
        raise ValueError("Unexpected archive name")
    # Nix signs the store path, NAR hash/size and references, not the transport URL.
    return "\n".join("URL: " + name if line.startswith("URL: ") else line for line in lines) + "\n", name


def main():
    key = os.environ.pop("NIX_CACHE_SIGNING_KEY")
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise RuntimeError("Unexpected repository")
    output = run("nix", "build", ".#control-panel", "--no-link", "--print-out-paths")
    closure = run("nix-store", "--query", "--requisites", output).splitlines()
    # A pure-Go static application should not pull a toolchain/runtime closure
    # into release assets. Fail rather than accidentally publishing gigabytes.
    if closure != [output]:
        raise RuntimeError("Control panel unexpectedly acquired runtime references")
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        secret = root / "signing-key"
        secret.touch(mode=0o600)
        secret.write_text(key)
        del key
        cache = root / "cache"
        run("nix", "copy", "--to", f"file://{cache}?secret-key={secret}", output)
        secret.unlink()
        metadata = list(cache.glob("*.narinfo"))
        if len(metadata) != 1:
            raise RuntimeError("Expected exactly one application archive")
        info, archive_name = flatten_narinfo(metadata[0].read_text())
        metadata[0].write_text(info)
        archive = cache / "nar" / archive_name
        archive.rename(cache / archive_name)
        if (cache / archive_name).stat().st_size > 32 * 1024 * 1024:
            raise RuntimeError("Application archive exceeds 32 MiB budget")
        release = json.loads(run("gh", "release", "view", TAG, "--repo", REPOSITORY, "--json", "assets"))
        existing = {asset['name'] for asset in release['assets']}
        for path in (cache / "nix-cache-info", cache / archive_name, metadata[0]):
            if path.name not in existing:
                run("gh", "release", "upload", TAG, str(path), "--repo", REPOSITORY)
        # Validate both the downloaded archive and its signature from the public
        # endpoint, not just that GitHub accepted the upload.
        run("nix", "store", "verify", "--store", CACHE, "--sigs-needed", "1",
            "--option", "trusted-public-keys", Path("keys/cache.pub").read_text().strip(),
            "--option", "narinfo-cache-negative-ttl", "0", output)
        print(f"Verified signed application cache: {output}")


if __name__ == "__main__":
    main()
