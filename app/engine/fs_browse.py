"""Directory picker. Only directories, and only inside the browse root.

The lexical check runs before `realpath`, so a path that spells as outside
the root never touches the disk. A symlink is listed only when its target is
a directory that is still inside the root. Errors do not include the resolved
path.
"""

from __future__ import annotations

import os
from pathlib import Path

MAX_ENTRIES = 1000


def browse(root: Path, requested: str = "", *, show_hidden: bool = False) -> dict[str, object]:
    real_root = _real(root)
    if real_root is None or not real_root.is_dir():
        return {"ok": False, "status": 404, "error": "browse root is not available"}
    if "\0" in requested:
        return {"ok": False, "status": 400, "error": "invalid path"}
    expanded = _expand(requested) if requested.strip() else real_root
    target = expanded if expanded.is_absolute() else (real_root / expanded)
    lexical = Path(os.path.abspath(target))
    if not _contains(real_root, lexical):
        return {"ok": False, "status": 400, "error": "path is outside the browsable root"}
    real = _real(lexical)
    if real is None or not real.is_dir():
        return {"ok": False, "status": 404, "error": "no such directory"}
    if not _contains(real_root, real):
        return {"ok": False, "status": 400, "error": "path is outside the browsable root"}
    try:
        names = sorted(os.listdir(real))
    except OSError:
        return {"ok": False, "status": 404, "error": "no such directory"}
    dirs: list[dict[str, object]] = []
    truncated = False
    for name in names:
        if not show_hidden and name.startswith("."):
            continue
        child = real / name
        if child.is_symlink():
            landed = _real(child)
            if landed is None or not landed.is_dir() or not _contains(real_root, landed):
                continue
        elif not child.is_dir():
            continue
        dirs.append(
            {
                "name": name,
                "path": str(child),
                "isRepo": (child / ".git").exists(),
            }
        )
        if len(dirs) > MAX_ENTRIES:
            truncated = True
            dirs = dirs[:MAX_ENTRIES]
            break
    parent = None if real == real_root else str(real.parent)
    return {
        "ok": True,
        "path": str(real),
        "parent": parent,
        "dirs": dirs,
        "truncated": truncated,
    }


def _expand(value: str) -> Path:
    if value == "~" or value.startswith("~/"):
        return Path.home() / value[2:]
    return Path(value)


def _real(path: Path) -> Path | None:
    try:
        return Path(os.path.realpath(path))
    except OSError:
        return None


def _contains(root: Path, candidate: Path) -> bool:
    if candidate == root:
        return True
    root_text = str(root)
    if not root_text.endswith(os.sep):
        root_text += os.sep
    return str(candidate).startswith(root_text)
