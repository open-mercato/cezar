"""GUI prefs. Missing or broken files read as an empty bag.

A write merges shallowly and refuses more than 200 top-level keys. Unknown keys
round-trip. The project file is `.ai/cezar/ui-state.json`. The workspace file
lives under the data directory, which is this port's stand-in for `~/.cezar`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

from stario.json import JsonValue
from stario.json import dumps as json_dumps

MAX_KEYS = 200


def read_state(path: Path) -> dict[str, object]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, UnicodeError, json.JSONDecodeError:
        return {}
    if isinstance(loaded, dict):
        return {str(key): value for key, value in loaded.items()}
    return {}


def merge_state(path: Path, patch: object) -> tuple[dict[str, object] | None, str | None]:
    if not isinstance(patch, dict):
        return None, "ui state must be an object"
    if len(patch) > MAX_KEYS:
        return None, f"ui-state has too many keys (max {MAX_KEYS})"
    merged = read_state(path)
    merged.update({str(key): value for key, value in patch.items()})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_dumps(cast(JsonValue, merged)) + "\n", encoding="utf-8")
    return merged, None
