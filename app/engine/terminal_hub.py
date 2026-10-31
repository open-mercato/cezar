"""A PTY in the task worktree.

The session is an interactive bash on a pseudo-terminal, so a full-screen
program sees a tty. Resize uses `TIOCSWINSZ` and `SIGWINCH`. Output is read
from the master and served as SSE.
"""

from __future__ import annotations

import asyncio
import fcntl
import os
import pty
import signal
import struct
import termios
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

Spawn = Callable[..., asyncio.Task[object]]


@dataclass
class ShellSession:
    proc: asyncio.subprocess.Process
    master: int
    chunks: list[str] = field(default_factory=list)
    changed: asyncio.Event = field(default_factory=asyncio.Event)


class TerminalHub:
    def __init__(self) -> None:
        self.sessions: dict[str, ShellSession] = {}
        self.spawn: Spawn = asyncio.create_task

    def bind(self, spawn: Spawn) -> None:
        self.spawn = spawn

    async def open(self, cwd: Path) -> str:
        master, slave = pty.openpty()
        _winsize(master, 24, 80)
        proc = await asyncio.create_subprocess_exec(
            "bash",
            "--noprofile",
            "--norc",
            "-i",
            cwd=cwd,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        os.set_blocking(master, False)
        session_id = uuid.uuid4().hex[:16]
        session = ShellSession(proc, master)
        self.sessions[session_id] = session
        self.spawn(self._read(session), name=f"term-{session_id}")
        return session_id

    async def write(self, session_id: str, data: str) -> bool:
        session = self.sessions.get(session_id)
        if session is None or session.proc.returncode is not None:
            return False
        try:
            os.write(session.master, data.encode())
        except OSError:
            return False
        return True

    def resize(self, session_id: str, rows: int, cols: int) -> bool:
        session = self.sessions.get(session_id)
        if session is None or session.proc.returncode is not None:
            return False
        if not 1 <= rows <= 500 or not 1 <= cols <= 500:
            return False
        _winsize(session.master, rows, cols)
        if session.proc.pid:
            try:
                os.killpg(session.proc.pid, signal.SIGWINCH)
            except OSError:
                os.kill(session.proc.pid, signal.SIGWINCH)
        return True

    def output(self, session_id: str) -> str | None:
        session = self.sessions.get(session_id)
        if session is None:
            return None
        return "".join(session.chunks)

    async def close(self, session_id: str) -> bool:
        session = self.sessions.pop(session_id, None)
        if session is None:
            return False
        if session.proc.returncode is None:
            session.proc.terminate()
            try:
                await asyncio.wait_for(session.proc.wait(), 1)
            except TimeoutError:
                session.proc.kill()
                await session.proc.wait()
        os.close(session.master)
        return True

    async def _read(self, session: ShellSession) -> None:
        while True:
            try:
                raw = os.read(session.master, 4096)
            except BlockingIOError:
                if session.proc.returncode is not None:
                    session.changed.set()
                    return
                await asyncio.sleep(0.02)
                continue
            except OSError:
                session.changed.set()
                return
            if not raw:
                session.changed.set()
                return
            session.chunks.append(raw.decode(errors="replace"))
            session.changed.set()


def _winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
