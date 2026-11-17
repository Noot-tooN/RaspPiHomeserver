"""Small, atomic diagnostic snapshots; never publish page text or raw errors."""

import json
import os
import time
from pathlib import Path


def publish(phase, code, failures=0):
    destination = os.environ.get("RASPPI_STATUS_FILE")
    if not destination:
        return
    path = Path(destination)
    now = int(time.time() * 1000)
    report = {"phase": phase, "code": code, "failures": failures,
              "updated_at": now, "invocation": os.environ.get("INVOCATION_ID", "")}
    try:
        previous = json.loads(path.read_text()) if path.exists() else {}
        last = previous.get("last_failure", {})
        if phase in ("failed", "unhealthy") and (code != "health_checks_failed" or not last):
            last = {"code": code, "at": now}
        if isinstance(last, dict) and 0 <= now - last.get("at", 0) < 86400000:
            report["last_failure"] = last
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    temporary = path.with_suffix(".tmp")
    try:
        temporary.write_text(json.dumps(report))
        temporary.replace(path)
    except OSError:
        # Diagnostics must not stop playback or automatic recovery.
        pass
