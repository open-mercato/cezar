"""Backend presence for `GET /api/v1/health`.

`shutil.which` decides `available`. A found binary is asked `--version` once
per process; a timeout or a non-zero exit leaves the version off the document.
"""

from __future__ import annotations

import shutil
import subprocess

from app.config import Config

_NAMES = (
    "claude",
    "codex",
    "opencode",
    "cursor",
    "pi",
    "junie",
    "copilot",
    "gh",
    "git",
)
_VERSIONS: dict[str, str] = {}


def backend_checks(config: Config) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for name in _NAMES:
        binary = config.runner_bins.get(name, name)
        found = shutil.which(binary)
        row: dict[str, object] = {"name": name, "available": found is not None}
        if found:
            version = _version(found)
            if version:
                row["version"] = version
        rows.append(row)
    return rows


def _version(binary: str) -> str:
    cached = _VERSIONS.get(binary)
    if cached is not None:
        return cached
    try:
        result = subprocess.run(
            [binary, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=1.5,
        )
    except OSError, subprocess.TimeoutExpired:
        _VERSIONS[binary] = ""
        return ""
    text = (result.stdout or result.stderr).strip().splitlines()
    version = text[0][:80] if text and result.returncode == 0 else ""
    _VERSIONS[binary] = version
    return version
