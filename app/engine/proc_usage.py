"""Live process sample for `GET /runs`.

One `ps` row set, aggregated over the root pid and its descendants. A missing
`ps` or a dead pid leaves the usage field off the record.
"""

from __future__ import annotations

import subprocess

_roots: dict[str, int] = {}


def watch(run_id: str, pid: int) -> None:
    _roots[run_id] = pid


def unwatch(run_id: str) -> None:
    _roots.pop(run_id, None)


def current_usage(run_id: str) -> dict[str, float | int] | None:
    pid = _roots.get(run_id)
    if pid is None:
        return None
    return usage_for(pid, _ps_rows())


def usage_for(root: int, rows: list[tuple[int, int, int, float]]) -> dict[str, float | int] | None:
    by_pid = {pid: (ppid, rss, cpu) for pid, ppid, rss, cpu in rows}
    if root not in by_pid:
        return None
    children: dict[int, list[int]] = {}
    for pid, ppid, _rss, _cpu in rows:
        children.setdefault(ppid, []).append(pid)
    seen: list[int] = []
    stack = [root]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.append(pid)
        stack.extend(children.get(pid, []))
    rss = 0
    cpu = 0.0
    for pid in seen:
        _ppid, rss_kb, cpu_pct = by_pid[pid]
        rss += rss_kb * 1024
        cpu += cpu_pct
    return {"cpuPct": round(cpu, 1), "rssBytes": rss, "procCount": len(seen)}


def _ps_rows() -> list[tuple[int, int, int, float]]:
    try:
        result = subprocess.run(
            ["ps", "-ax", "-o", "pid=,ppid=,rss=,%cpu="],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except OSError, subprocess.TimeoutExpired:
        return []
    rows: list[tuple[int, int, int, float]] = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        try:
            rows.append((int(parts[0]), int(parts[1]), int(parts[2]), float(parts[3])))
        except ValueError:
            continue
    return rows
