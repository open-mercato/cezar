"""Composer deferred start: a one-shot schedule, not a usage-reset probe.

`at` becomes a UTC timestamp floored to the minute. The preview revision is the
hash of that timestamp, so create and preview agree without a stored preview.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from stario.json import JsonValue, loads
from stario.json import dumps as json_dumps

from app.clock import stamp


def local_zone_name() -> str:
    tz = datetime.now().astimezone().tzinfo
    key = getattr(tz, "key", None)
    if isinstance(key, str) and key:
        return key
    return "UTC"


def options_document() -> dict[str, object]:
    return {
        "timeZone": local_zone_name(),
        "usageReset": {
            "available": False,
            "reason": "unsupported",
            "message": "usage reset is not available in this port",
        },
    }


def preview_start(start: object) -> dict[str, object]:
    if not isinstance(start, dict):
        return _no("invalid", "start is required")
    kind = start.get("kind")
    if kind == "usage-reset":
        return _no("unsupported", "usage reset is not available in this port")
    if kind != "at":
        return _no("invalid", "start.kind must be at or usage-reset")
    date = start.get("date")
    hour = start.get("hour")
    minute = start.get("minute")
    if not isinstance(date, str) or not isinstance(hour, int) or isinstance(hour, bool):
        return _no("invalid", "at needs a date, hour, and minute")
    if not isinstance(minute, int) or isinstance(minute, bool):
        return _no("invalid", "at needs a date, hour, and minute")
    if not 0 <= hour <= 23 or not 0 <= minute <= 59:
        return _no("invalid", "hour and minute are out of range")
    try:
        day = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return _no("invalid", "date must be YYYY-MM-DD")
    tz = datetime.now().astimezone().tzinfo or UTC
    when = day.replace(hour=hour, minute=minute, second=0, microsecond=0, tzinfo=tz)
    if when <= datetime.now(tz):
        return _no("past", "that time has already passed")
    iso = stamp(when.astimezone(UTC))
    return {
        "available": True,
        "notBefore": iso,
        "timeZone": local_zone_name(),
        "previewRevision": hashlib.sha256(iso.encode()).hexdigest(),
    }


def task_text(task: object) -> str:
    if isinstance(task, str):
        return task.strip()
    if isinstance(task, dict):
        raw = task.get("task", task.get("prompt", ""))
        return raw.strip() if isinstance(raw, str) else ""
    return ""


def task_workflow(task: object) -> str:
    if isinstance(task, dict):
        raw = task.get("workflow")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return "quick-task"


def request_digest(task: str, not_before: str) -> str:
    return hashlib.sha256(f"{task}\n{not_before}".encode()).hexdigest()


def load_creations(path: Path) -> dict[str, dict[str, str]]:
    try:
        loaded = loads(path.read_text(encoding="utf-8"))
    except OSError, UnicodeError, ValueError:
        return {}
    if not isinstance(loaded, dict):
        return {}
    rows: dict[str, dict[str, str]] = {}
    for key, value in loaded.items():
        if isinstance(key, str) and isinstance(value, dict):
            rows[key] = {
                str(item): str(value[item]) for item in value if isinstance(value[item], str)
            }
    return rows


def save_creations(path: Path, rows: dict[str, dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_dumps(cast(JsonValue, rows)) + "\n", encoding="utf-8")


def _no(reason: str, message: str) -> dict[str, object]:
    return {"available": False, "reason": reason, "message": message}
