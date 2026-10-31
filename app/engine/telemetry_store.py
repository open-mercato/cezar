"""Opt-in telemetry consent.

Nothing is sent. A `yes` only lets the cockpit record that an event was
accepted. The default is off, and `CEZ_TELEMETRY=0` or `DO_NOT_TRACK=1` keeps
it off even after a yes. There is no install id and no outbound request.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def blocked() -> bool:
    return os.environ.get("CEZ_TELEMETRY") == "0" or os.environ.get("DO_NOT_TRACK") == "1"


def read_consent(path: Path) -> dict[str, object]:
    enabled = False
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, UnicodeError, json.JSONDecodeError:
        loaded = None
    if isinstance(loaded, dict) and loaded.get("enabled") is True and not blocked():
        enabled = True
    return {"enabled": enabled, "transmits": False}


def write_consent(path: Path, enabled: bool) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"enabled": enabled and not blocked()}
    path.write_text(json.dumps(body) + "\n", encoding="utf-8")
    return {"enabled": body["enabled"], "transmits": False}
