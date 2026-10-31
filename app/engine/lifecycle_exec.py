"""Worktree lifecycle command supervisor.

Matches `executeLifecycleCommand` in `packages/cezar/src/worktree-lifecycle/executor.ts`.
The child is its own session, so a timeout or abort signals the whole group.
Stdout and stderr are line-buffered, capped, and redacted before a callback sees them.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import signal
import socket
import subprocess
import sys
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.engine.agent_env import collect_secret_values, redact_secrets

OUTPUT_LIMIT = 1024 * 1024
FRAME_LIMIT = 16 * 1024
DEFAULT_TIMEOUT_SECONDS = 1_800
_TRUNCATED = "\n[Output truncated at 1 MiB]\n"
_OVERLONG = "[Overlong output line omitted]\n"

OutputCallback = Callable[["LifecycleOutput"], Awaitable[None] | None]
StartCallback = Callable[["LifecycleProcessIdentity"], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class LifecycleProcessIdentity:
    pid: int
    hostname: str
    started_at: str
    start_identity: str = ""


@dataclass(frozen=True, slots=True)
class LifecycleOutput:
    stream: str
    text: str


@dataclass(frozen=True, slots=True)
class LifecycleResult:
    state: str
    exit_code: int | None
    quiescent: bool
    truncated: bool
    signal: str = ""
    reason: str = ""
    identity: LifecycleProcessIdentity | None = None


@dataclass
class _Cap:
    secrets: list[str]
    retained: int = 0
    truncated: bool = False
    pending: list[LifecycleOutput] = field(default_factory=list)
    buffers: dict[str, str] = field(default_factory=lambda: {"stdout": "", "stderr": ""})
    discarding: dict[str, bool] = field(default_factory=lambda: {"stdout": False, "stderr": False})
    tails: dict[str, str] = field(default_factory=dict)
    stop_reason: str = ""
    output_error: bool = False
    windows_code: int | None = None
    finished: bool = False

    def enqueue(self, stream: str, text: str) -> None:
        if not text:
            return
        size = len(text.encode())
        remaining = OUTPUT_LIMIT - self.retained
        if size > remaining:
            if not self.truncated:
                self.pending.append(LifecycleOutput("system", _TRUNCATED))
                self.truncated = True
            return
        self.retained += size
        frame = ""
        used = 0
        for point in text:
            length = len(point.encode())
            if used + length > FRAME_LIMIT:
                self.pending.append(LifecycleOutput(stream, frame))
                frame = ""
                used = 0
            frame += point
            used += length
        if frame:
            self.pending.append(LifecycleOutput(stream, frame))

    def safe_line(self, stream: str, text: str) -> None:
        self.enqueue(stream, self._hold(stream, redact_secrets(text, self.secrets)))

    def drain(self) -> None:
        for stream in ("stdout", "stderr"):
            tail = self.tails.pop(stream, "")
            if tail:
                self.enqueue(stream, tail)

    def _hold(self, stream: str, text: str) -> str:
        # A known secret split across two flushed lines stays held until it completes.
        pending = self.tails.get(stream, "")
        safe = redact_secrets(pending + text, self.secrets)
        keep = 0
        for secret in self.secrets:
            limit = min(len(secret) - 1, len(safe))
            for length in range(limit, keep, -1):
                if safe.endswith(secret[:length]):
                    keep = length
                    break
        if keep > 0:
            self.tails[stream] = safe[-keep:]
            return safe[:-keep]
        self.tails.pop(stream, None)
        return safe


def _group_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(-pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _signal_group(pid: int, sig: signal.Signals) -> None:
    try:
        os.killpg(pid, sig)
    except ProcessLookupError, PermissionError:
        return


def _process_start(pid: int) -> str:
    if sys.platform == "win32":
        return ""
    try:
        out = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "lstart="],
            text=True,
            timeout=2,
        )
    except OSError, subprocess.SubprocessError:
        return ""
    return out.strip()


async def probe_lifecycle_process(identity: LifecycleProcessIdentity) -> str:
    """Read-only. A pid loaded from disk is never signaled."""
    if identity.hostname != socket.gethostname() or identity.pid <= 0:
        return "unknown"
    if sys.platform == "win32":
        return "unknown"
    if not _group_alive(identity.pid):
        return "quiescent"
    if not identity.start_identity:
        return "unknown"
    current = await asyncio.to_thread(_process_start, identity.pid)
    return "running" if current == identity.start_identity else "unknown"


async def execute_lifecycle_command(
    *,
    command: str,
    cwd: str,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    abort: asyncio.Event | None = None,
    dry_run: bool = False,
    on_start: StartCallback | None = None,
    on_output: OutputCallback | None = None,
    bash_path: str = "bash",
    platform: str | None = None,
) -> LifecycleResult:
    if not _timeout_ok(timeout_seconds):
        raise ValueError("Lifecycle timeout must be 1–86400 seconds")
    if dry_run or os.environ.get("CEZ_DRY_RUN") == "1":
        return LifecycleResult("succeeded", 0, quiescent=True, truncated=False)
    if abort is not None and abort.is_set():
        return LifecycleResult(
            "interrupted",
            None,
            quiescent=True,
            truncated=False,
            reason="Stopped before launch",
        )
    windows = (platform or sys.platform) == "win32"
    secrets = collect_secret_values()
    cap = _Cap(secrets)
    marker = f"__cezar_{uuid.uuid4().hex}"
    wrapper = _wrapper(windows)
    try:
        proc = await asyncio.create_subprocess_exec(
            bash_path,
            "-c",
            wrapper,
            bash_path,
            command,
            marker,
            cwd=cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as exc:
        return LifecycleResult(
            "failed",
            None,
            quiescent=True,
            truncated=False,
            reason=redact_secrets(str(exc), secrets),
        )
    return await _supervise(
        proc,
        cap,
        cwd_timeout=timeout_seconds,
        abort=abort,
        on_start=on_start,
        on_output=on_output,
        windows=windows,
        marker=marker,
    )


def _timeout_ok(timeout: float) -> bool:
    return timeout >= 1 and timeout <= 86400


def _wrapper(windows: bool) -> str:
    # The child blocks on this read until on_start has been persisted.
    if windows:
        return (
            "IFS= read -r _cezar_launch || exit 125; "
            '"$0" -c "$1" </dev/null; _cezar_status=$?; '
            'printf \'\\n%s:%s\\n\' "$2" "$_cezar_status" >&2; '
            "IFS= read -r _cezar_shutdown"
        )
    return 'IFS= read -r _cezar_launch || exit 125; exec "$0" -c "$1"'


async def _supervise(
    proc: asyncio.subprocess.Process,
    cap: _Cap,
    *,
    cwd_timeout: float,
    abort: asyncio.Event | None,
    on_start: StartCallback | None,
    on_output: OutputCallback | None,
    windows: bool,
    marker: str,
) -> LifecycleResult:
    assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
    assert proc.pid is not None
    pid = proc.pid
    lock = asyncio.Lock()
    windows_term: asyncio.Task[bool] | None = None
    kill_later: asyncio.Task[None] | None = None
    exit_code: int | None = None
    exit_signal = ""
    quiescent = False
    identity: LifecycleProcessIdentity | None = None

    async def flush() -> None:
        async with lock:
            frames = cap.pending
            cap.pending = []
            for frame in frames:
                if on_output is None:
                    continue
                try:
                    result = on_output(frame)
                    if inspect.isawaitable(result):
                        await result
                except Exception:
                    cap.output_error = True
                    if not cap.finished:
                        await stop("Could not persist lifecycle output")
                    return

    async def flush_loop() -> None:
        while not cap.finished:
            await asyncio.sleep(0.1)
            await flush()

    def schedule_windows_kill() -> None:
        nonlocal windows_term
        if windows_term is None:
            windows_term = asyncio.create_task(_terminate_windows(proc))

    def receive(stream: str, chunk: str) -> None:
        for piece in _pieces(chunk):
            if not cap.discarding[stream]:
                cap.buffers[stream] += piece
                if len(cap.buffers[stream].encode()) > FRAME_LIMIT:
                    cap.buffers[stream] = ""
                    cap.discarding[stream] = True
                    cap.truncated = True
                    cap.enqueue("system", _OVERLONG)
            if piece.endswith("\n"):
                line = cap.buffers[stream]
                if windows and stream == "stderr" and line.startswith(f"{marker}:"):
                    number = line[len(marker) + 1 :].strip()
                    if number.isdigit() and int(number) <= 255:
                        cap.windows_code = int(number)
                        schedule_windows_kill()
                elif not cap.discarding[stream]:
                    cap.safe_line(stream, line)
                cap.buffers[stream] = ""
                cap.discarding[stream] = False

    async def pump(stream: str, reader: asyncio.StreamReader) -> None:
        decoder = _decoder()
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                tail = decoder.decode(b"", final=True)
                if tail:
                    receive(stream, tail)
                return
            receive(stream, decoder.decode(chunk))

    async def stop(reason: str) -> None:
        nonlocal kill_later
        if cap.stop_reason:
            return
        cap.stop_reason = reason
        if windows:
            schedule_windows_kill()
            return
        _close_stdin(proc)
        _signal_group(pid, signal.SIGTERM)

        async def later() -> None:
            await asyncio.sleep(5)
            _signal_group(pid, signal.SIGKILL)

        kill_later = asyncio.create_task(later())

    pumps = [
        asyncio.create_task(pump("stdout", proc.stdout)),
        asyncio.create_task(pump("stderr", proc.stderr)),
    ]
    flusher = asyncio.create_task(flush_loop())
    try:
        identity = await _release(proc, windows, on_start, stop)
        if abort is not None and abort.is_set() and not cap.stop_reason:
            await stop("Stopped by user or shutdown")
        exit_code, exit_signal = await _wait(proc, cwd_timeout, abort, stop)
        await asyncio.wait(set(pumps), timeout=0.2)
        if not windows and _group_alive(pid):
            await stop(cap.stop_reason or "Command left background processes attached")
            deadline = asyncio.get_running_loop().time() + 5.5
            while _group_alive(pid) and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.025)
        if windows:
            quiescent = False if windows_term is None else await windows_term
        else:
            quiescent = not _group_alive(pid)
    finally:
        cap.finished = True
        flusher.cancel()
        for task in pumps:
            task.cancel()
        if kill_later is not None:
            kill_later.cancel()
        await asyncio.gather(flusher, *pumps, return_exceptions=True)
    for stream in ("stdout", "stderr"):
        if cap.buffers[stream] and not cap.discarding[stream]:
            cap.safe_line(stream, cap.buffers[stream])
            cap.buffers[stream] = ""
    cap.drain()
    await flush()
    code = cap.windows_code if cap.windows_code is not None else exit_code
    if cap.windows_code is not None:
        exit_signal = ""
    state, reason = _outcome(cap, code, quiescent)
    return LifecycleResult(
        state,
        code,
        quiescent=quiescent,
        truncated=cap.truncated,
        signal=exit_signal,
        reason=reason,
        identity=identity,
    )


def _outcome(cap: _Cap, code: int | None, quiescent: bool) -> tuple[str, str]:
    """The result state and the reason the command did not simply run to its end."""
    if cap.output_error:
        return "failed", "Could not persist lifecycle output"
    if cap.stop_reason:
        persist_failed = cap.stop_reason.startswith("Could not persist")
        return ("failed" if persist_failed else "interrupted"), cap.stop_reason
    if not quiescent:
        return "failed", "Could not verify command process-tree termination; directory retained"
    return ("succeeded" if code == 0 else "failed"), ""


async def _release(
    proc: asyncio.subprocess.Process,
    windows: bool,
    on_start: StartCallback | None,
    stop: Callable[[str], Awaitable[None]],
) -> LifecycleProcessIdentity | None:
    assert proc.pid is not None and proc.stdin is not None
    start = "" if windows else await asyncio.to_thread(_process_start, proc.pid)
    identity = LifecycleProcessIdentity(
        pid=proc.pid,
        hostname=socket.gethostname(),
        started_at=datetime.now(UTC).isoformat(),
        start_identity=start,
    )
    try:
        if on_start is not None:
            await on_start(identity)
    except Exception:
        await stop("Could not persist command start; command was not launched")
        return identity
    proc.stdin.write(b"start\n")
    try:
        await proc.stdin.drain()
    except BrokenPipeError, ConnectionResetError:
        return identity
    if not windows:
        _close_stdin(proc)
    return identity


async def _wait(
    proc: asyncio.subprocess.Process,
    timeout: float,
    abort: asyncio.Event | None,
    stop: Callable[[str], Awaitable[None]],
) -> tuple[int | None, str]:
    exit_task = asyncio.create_task(proc.wait())
    timer = asyncio.create_task(asyncio.sleep(timeout))
    aborted = asyncio.create_task(abort.wait()) if abort is not None else None
    waiting: set[asyncio.Task[object]] = {exit_task, timer}
    if aborted is not None:
        waiting.add(aborted)
    try:
        done, _pending = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
        if exit_task not in done:
            if timer in done:
                await stop("Command exceeded its wall-clock timeout")
            elif aborted is not None and aborted in done:
                await stop("Stopped by user or shutdown")
        code = await exit_task
    finally:
        timer.cancel()
        if aborted is not None:
            aborted.cancel()
    if code < 0:
        return None, signal.Signals(-code).name
    return code, ""


async def _terminate_windows(proc: asyncio.subprocess.Process) -> bool:
    if proc.pid is None or proc.returncode is not None:
        return False
    try:
        killer = await asyncio.create_subprocess_exec(
            "taskkill",
            "/PID",
            str(proc.pid),
            "/T",
            "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(killer.wait(), 5)
        if killer.returncode != 0:
            raise OSError("taskkill failed")
        await asyncio.wait_for(proc.wait(), 1)
    except OSError, TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            return False
        return False
    else:
        return proc.returncode is not None


def _close_stdin(proc: asyncio.subprocess.Process) -> None:
    if proc.stdin is None or proc.stdin.is_closing():
        return
    proc.stdin.close()


def _pieces(chunk: str) -> list[str]:
    if not chunk:
        return []
    parts = chunk.split("\n")
    if chunk.endswith("\n"):
        return [f"{part}\n" for part in parts[:-1]]
    last = parts.pop()
    pieces = [f"{part}\n" for part in parts]
    if last:
        pieces.append(last)
    return pieces


def _decoder():
    import codecs

    return codecs.getincrementaldecoder("utf-8")(errors="replace")
