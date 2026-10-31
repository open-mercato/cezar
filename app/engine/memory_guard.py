"""RSS of the agent process tree for one task's worktree.

The agent is spawned with that directory as its cwd. The cockpit is not, so a
process whose cwd is the worktree is the root of the tree. Descendants count
even after they change directory. `ps` is not required; Linux exposes `VmRSS`
and `PPid` under `/proc`.
"""

from __future__ import annotations

import os
from pathlib import Path


def rss_bytes_in(cwd: Path) -> int | None:
    tree = _tree(cwd)
    if not tree:
        return None
    total = 0
    found = False
    for pid in tree:
        rss = _vm_rss(Path("/proc") / str(pid) / "status")
        if rss is None:
            continue
        found = True
        total += rss
    return total if found else None


def pids_in(cwd: Path) -> list[int]:
    return [pid for pid in _tree(cwd) if pid not in (os.getpid(), 1)]


def _tree(cwd: Path) -> list[int]:
    try:
        root = cwd.resolve()
    except OSError:
        return []
    proc = Path("/proc")
    if not proc.is_dir():
        return []
    ppid_of: dict[int, int] = {}
    seeds: list[int] = []
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        ppid_of[pid] = _ppid(entry / "status")
        try:
            link = Path(os.readlink(entry / "cwd")).resolve()
        except OSError:
            continue
        if link == root:
            seeds.append(pid)
    if not seeds:
        return []
    children: dict[int, list[int]] = {}
    for pid, parent in ppid_of.items():
        children.setdefault(parent, []).append(pid)
    seen: set[int] = set()
    stack = list(seeds)
    ordered: list[int] = []
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        ordered.append(pid)
        stack.extend(children.get(pid, ()))
    return ordered


def _ppid(status: Path) -> int:
    for line in _lines(status):
        if line.startswith("PPid:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1])
    return 0


def _vm_rss(status: Path) -> int | None:
    for line in _lines(status):
        if not line.startswith("VmRSS:"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            return int(parts[1]) * 1024
    return None


def _lines(status: Path) -> list[str]:
    try:
        return status.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
