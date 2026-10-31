"""The `disk` field of `GET /api/v1/health`.

One `statvfs` via `shutil.disk_usage`. Free space is reported in steps so the
open health document is not an exact volume fingerprint.
"""

from __future__ import annotations

import shutil
from pathlib import Path

_GIB = 1024**3
_SOFT = 5 * _GIB


def disk_health(path: Path) -> dict[str, object] | None:
    probe = path if path.exists() else path.parent
    if not probe.exists():
        probe = Path("/")
    try:
        usage = shutil.disk_usage(probe)
    except OSError:
        return None
    level = _level(usage.free, usage.total)
    step = _GIB if level == "ok" else 100 * 1024**2
    return {
        "freeBytes": (usage.free // step) * step,
        "totalBytes": (usage.total // _GIB) * _GIB,
        "level": level,
    }


def _level(free: int, total: int) -> str:
    floor = min(_GIB, int(total * 0.02))
    if free < floor:
        return "critical"
    if free < _SOFT:
        return "low"
    return "ok"
