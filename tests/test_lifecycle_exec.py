"""The lifecycle command executor: its own process group, a 1 MiB cap, redaction."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from app.engine.lifecycle_exec import (
    FRAME_LIMIT,
    OUTPUT_LIMIT,
    LifecycleOutput,
    execute_lifecycle_command,
    probe_lifecycle_process,
)


@pytest.fixture
def cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("CEZ_DRY_RUN", "0")
    return tmp_path


async def test_runs_in_its_own_group_and_emits_both_streams(cwd: Path) -> None:
    seen: dict[str, int] = {}
    frames: list[LifecycleOutput] = []

    async def on_start(identity) -> None:
        seen["pid"] = identity.pid
        seen["pgid"] = os.getpgid(identity.pid)

    result = await execute_lifecycle_command(
        command="pwd; echo err >&2; read ignored || echo closed",
        cwd=str(cwd),
        on_start=on_start,
        on_output=lambda frame: frames.append(frame),
    )
    assert result.state == "succeeded"
    assert result.exit_code == 0
    assert result.quiescent is True
    assert seen["pgid"] == seen["pid"]
    text = "".join(frame.text for frame in frames)
    assert str(cwd) in text
    assert LifecycleOutput("stderr", "err\n") in frames
    assert "closed" in text
    assert result.identity is not None
    assert await probe_lifecycle_process(result.identity) == "quiescent"


async def test_a_failed_start_checkpoint_does_not_run_the_command(cwd: Path) -> None:
    async def on_start(_identity) -> None:
        raise RuntimeError("read-only state")

    result = await execute_lifecycle_command(
        command="echo unsafe > marker",
        cwd=str(cwd),
        on_start=on_start,
    )
    assert result.state == "failed"
    assert result.quiescent is True
    assert not (cwd / "marker").exists()


async def test_nonzero_exit_and_a_missing_bash_do_not_raise(cwd: Path) -> None:
    failed = await execute_lifecycle_command(command="exit 7", cwd=str(cwd))
    assert failed.state == "failed"
    assert failed.exit_code == 7
    missing = await execute_lifecycle_command(
        command="true",
        cwd=str(cwd),
        bash_path="/missing/cezar-bash",
    )
    assert missing.state == "failed"
    assert missing.quiescent is True


async def test_a_timeout_reaps_the_process_group(cwd: Path) -> None:
    result = await execute_lifecycle_command(
        command="sleep 30 & wait",
        cwd=str(cwd),
        timeout_seconds=1,
    )
    assert result.state == "interrupted"
    assert result.quiescent is True
    assert "timeout" in result.reason


async def test_abort_stops_the_group_and_dry_run_does_not_launch(cwd: Path) -> None:
    abort = asyncio.Event()

    async def on_start(_identity) -> None:
        asyncio.get_running_loop().call_later(0.1, abort.set)

    stopped = await execute_lifecycle_command(
        command="sleep 30",
        cwd=str(cwd),
        abort=abort,
        on_start=on_start,
    )
    assert stopped.state == "interrupted"
    assert stopped.quiescent is True
    dry = await execute_lifecycle_command(command="touch marker", cwd=str(cwd), dry_run=True)
    assert dry.state == "succeeded"
    assert not (cwd / "marker").exists()


async def test_secrets_and_token_shapes_split_across_chunks_are_redacted(
    cwd: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = "a-very-private-secret-value"
    monkeypatch.setenv("LIFECYCLE_TEST_TOKEN", secret)
    frames: list[LifecycleOutput] = []
    command = (
        "printf a-very-private-; sleep 0.15; printf 'secret-value\\n'; "
        "printf ghp_abcdefghijk; sleep 0.15; printf 'lmnopqrstuvwxyz\\n'"
    )
    result = await execute_lifecycle_command(
        command=command,
        cwd=str(cwd),
        on_output=lambda frame: frames.append(frame),
    )
    assert result.state == "succeeded"
    output = "".join(frame.text for frame in frames)
    assert secret not in output
    assert "ghp_" not in output
    assert "[REDACTED]" in output


async def test_an_output_callback_failure_is_the_result(cwd: Path) -> None:
    async def on_output(_frame: LifecycleOutput) -> None:
        raise RuntimeError("disk full")

    result = await execute_lifecycle_command(
        command="echo output",
        cwd=str(cwd),
        on_output=on_output,
    )
    assert result.state == "failed"
    assert result.quiescent is True
    assert result.reason == "Could not persist lifecycle output"


async def test_output_is_capped_at_one_mebibyte_and_frames_stay_bounded(cwd: Path) -> None:
    frames: list[LifecycleOutput] = []
    result = await execute_lifecycle_command(
        command="head -c 1800000 /dev/zero | tr '\\0' x; echo; yes short | head -n 200000",
        cwd=str(cwd),
        on_output=lambda frame: frames.append(frame),
    )
    assert result.state == "succeeded"
    assert result.truncated is True
    assert result.quiescent is True
    assert frames
    assert all(len(frame.text.encode()) <= FRAME_LIMIT for frame in frames)
    total = sum(len(frame.text.encode()) for frame in frames)
    assert total <= OUTPUT_LIMIT + 124


def _taskkill(cwd: Path, monkeypatch: pytest.MonkeyPatch, *, fail: bool) -> None:
    path = cwd / "taskkill"
    body = '#!/bin/bash\nprintf "%s\\n" "$@" > "$(dirname "$0")/taskkill-args"\n'
    body += "exit 1\n" if fail else 'kill -KILL -- "-$2"\n'
    path.write_text(body, encoding="utf-8")
    path.chmod(0o700)
    monkeypatch.setenv("PATH", f"{cwd}:{os.environ.get('PATH', '')}")


async def test_windows_supervision_keeps_the_command_exit_code(
    cwd: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _taskkill(cwd, monkeypatch, fail=False)
    frames: list[LifecycleOutput] = []
    result = await execute_lifecycle_command(
        command="echo command; exit 7",
        cwd=str(cwd),
        platform="win32",
        on_output=lambda frame: frames.append(frame),
    )
    assert result.state == "failed"
    assert result.exit_code == 7
    assert result.quiescent is True
    assert result.identity is not None
    logged = (cwd / "taskkill-args").read_text(encoding="utf-8").strip().split("\n")
    assert logged == ["/PID", str(result.identity.pid), "/T", "/F"]
    text = "".join(frame.text for frame in frames)
    assert "command" in text
    assert "__cezar_" not in text


async def test_a_failed_taskkill_keeps_the_directory(
    cwd: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _taskkill(cwd, monkeypatch, fail=True)
    result = await execute_lifecycle_command(command="true", cwd=str(cwd), platform="win32")
    assert result.state == "failed"
    assert result.quiescent is False
    assert "directory retained" in result.reason


async def test_windows_stop_uses_the_tree_kill(cwd: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _taskkill(cwd, monkeypatch, fail=False)
    abort = asyncio.Event()

    async def on_start(_identity) -> None:
        asyncio.get_running_loop().call_later(0.1, abort.set)

    result = await execute_lifecycle_command(
        command="sleep 30",
        cwd=str(cwd),
        platform="win32",
        abort=abort,
        on_start=on_start,
    )
    assert result.state == "interrupted"
    assert result.quiescent is True
