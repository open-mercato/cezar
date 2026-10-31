"""A task-scoped temp directory for spawned agents, and the shared check cache.

`runs/agent-tmpdir.ts` and `sharedCheckCacheDir` in `workflows/run.ts`.

Every agent used to inherit the host's `TMPDIR`. On a box that runs agents for weeks that is one
shared tmpfs nobody reaps, and a full one fails silently: the command runs and its output reads
back empty. Each agent run gets `<data_dir>/tmp/<run id>` instead, on the disk that holds the
run's own state, write-probed before the agent spawns and removed when the run settles.
`CEZ_AGENT_TMPDIR=0` (`Config.agent_tmpdir`) turns the directory and the probe off together.
"""

from __future__ import annotations

import errno
import os
import re
import shutil
from collections.abc import Iterable
from pathlib import Path

_SAFE_ID = re.compile(r"[A-Za-z0-9._-]+")
_PROJECT_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
_REASONS = {
    "EDQUOT": "Disk quota exceeded",
    "ENOSPC": "No space left on device",
    "EACCES": "Permission denied",
    "EPERM": "Operation not permitted",
    "EROFS": "Read-only file system",
}
_probes = 0


class AgentTempDirError(Exception):
    """The per-run temp directory cannot take a write: the run fails before it spawns."""

    def __init__(self, path: Path, reason: OSError) -> None:
        why = _REASONS.get(errno.errorcode.get(reason.errno or 0, ""), "") or str(reason)
        super().__init__(
            f"agent temp directory is not writable: {path} ({why}) — free disk space, "
            "or set CEZ_AGENT_TMPDIR=0 to fall back to the host TMPDIR"
        )
        self.path = path


def safe_run_id(run_id: str) -> bool:
    """A run id is a uuid. `.` and `..` match the class and must never reach `rmtree`."""
    return _SAFE_ID.fullmatch(run_id) is not None and run_id not in (".", "..")


def agent_tmp_dir(data_dir: Path, run_id: str) -> Path:
    return data_dir / "tmp" / run_id


def agent_tmp_env(data_dir: Path, run_id: str, *, enabled: bool) -> dict[str, str]:
    """`TMPDIR`, `TEMP` and `TMP` for this run, after proving the directory takes a write.

    Empty when the opt-out is set: nothing is created and nothing is probed.
    """
    global _probes
    if not enabled or not safe_run_id(run_id):
        return {}
    path = agent_tmp_dir(data_dir, run_id)
    try:
        path.mkdir(parents=True, exist_ok=True)
        _probes += 1
        probe = path / f".cez-tmp-probe-{os.getpid()}-{_probes}"
        try:
            probe.write_text("cez", encoding="utf-8")
        finally:
            probe.unlink(missing_ok=True)
    except OSError as exc:
        raise AgentTempDirError(path, exc) from exc
    return {"TMPDIR": str(path), "TEMP": str(path), "TMP": str(path)}


def remove_agent_tmp_dir(data_dir: Path, run_id: str) -> None:
    """Scratch, not an artifact. A Continue creates it again. Never raises."""
    if safe_run_id(run_id):
        shutil.rmtree(agent_tmp_dir(data_dir, run_id), ignore_errors=True)


def sweep_agent_tmp_dirs(data_dir: Path, keep: Iterable[str]) -> list[str]:
    """Remove every per-run directory not in `keep`. Confined to `<data_dir>/tmp`."""
    root = data_dir / "tmp"
    if not root.is_dir():
        return []
    wanted = set(keep)
    reaped: list[str] = []
    try:
        names = [
            child.name for child in root.iterdir() if child.is_dir() and not child.is_symlink()
        ]
    except OSError:
        return []
    for name in names:
        if name in wanted or not safe_run_id(name):
            continue
        shutil.rmtree(root / name, ignore_errors=True)
        reaped.append(name)
    return reaped


def shared_cache_dir(data_dir: Path, project_id: str) -> Path | None:
    """`<data_dir>/cache/<project id>`, `0700`: one replay cache per project, shared by its tasks.

    `None` when it cannot be made: the check then runs with a cold cache.
    """
    if _PROJECT_ID.fullmatch(project_id) is None:
        return None
    path = data_dir / "cache" / project_id
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError:
        return None
    return path
