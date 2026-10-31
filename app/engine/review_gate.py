"""Diff-first review gate. Off unless Settings or `CEZ_REVIEW_GATE=1` says otherwise.

`reviewGate` in `.ai/cezar/config.json` wins when the key is a boolean.
Otherwise only the exact string `1` enables the gate. `true` and `yes` do not.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def review_gate_enabled(root: Path) -> bool:
    configured = _config_flag(root / ".ai" / "cezar" / "config.json")
    if configured is not None:
        return configured
    return os.environ.get("CEZ_REVIEW_GATE") == "1"


def _config_flag(path: Path) -> bool | None:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return None
    if not isinstance(loaded, dict) or "reviewGate" not in loaded:
        return None
    flag = loaded.get("reviewGate")
    if isinstance(flag, bool):
        return flag
    return None
