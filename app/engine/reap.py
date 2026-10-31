"""Stop processes a settled task left behind.

A check or agent that exports `CEZ_TASK_ID` is signalled when the task
settles. `CEZ_TASK_PROCESS_REAP=0` turns it off. Linux only: other platforms
have no `/proc` environ to read, and the call returns nothing.
"""

from __future__ import annotations

import os
import signal
from pathlib import Path


def reap_task_processes(run_id: str, *, enabled: bool) -> list[int]:
    if not enabled or not run_id or not Path("/proc").is_dir():
        return []
    needle = f"CEZ_TASK_ID={run_id}".encode()
    mine = {os.getpid(), os.getppid()}
    killed: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in mine:
            continue
        try:
            raw = (entry / "environ").read_bytes()
        except OSError:
            continue
        if needle not in raw.split(b"\0"):
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            continue
        killed.append(pid)
    return killed
