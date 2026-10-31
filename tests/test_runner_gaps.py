import asyncio
import json
from pathlib import Path

from tests.test_runners import collect, install, spec

import app.engine.runners.protocol as protocol
from app.engine.deltas import DeltaCoalescer
from app.engine.runners.protocol import (
    ProtocolRunner,
    TurnState,
    parse_claude_line,
    parse_codex_line,
)


def test_stream_event_deltas_are_display_only_and_todowrite_is_a_plan():
    state = TurnState()
    deltas = parse_claude_line(
        json.dumps(
            {
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "he"},
                },
            }
        ),
        state,
    )
    assert [event.type for event in deltas] == ["delta"]
    assert deltas[0].text == "he"
    assert state.saw_text is False
    plan = parse_claude_line(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "t",
                            "name": "TodoWrite",
                            "input": {
                                "todos": [
                                    {
                                        "content": "Fix",
                                        "status": "in_progress",
                                        "activeForm": "Fixing",
                                    }
                                ]
                            },
                        }
                    ]
                },
            }
        ),
        state,
    )
    assert plan[-1].type == "plan"
    assert json.loads(plan[-1].text)["entries"][0]["status"] == "in_progress"


def test_codex_plan_updates_are_a_full_snapshot():
    state = TurnState()
    events = parse_codex_line(
        json.dumps(
            {
                "method": "turn/plan/updated",
                "params": {"plan": [{"step": "Ship", "status": "inProgress"}]},
            }
        ),
        state,
    )
    assert events[0].type == "plan"
    assert json.loads(events[0].text)["entries"][0]["content"] == "Ship"


async def test_deltas_coalesce_into_one_live_event():
    seen: list[tuple[str, str, str, str]] = []
    sink = DeltaCoalescer(flush_s=0.02)
    sink.push("run", "message", "text", "ab", lambda *args: seen.append(args))
    sink.push("run", "message", "text", "c", lambda *args: seen.append(args))
    await asyncio.sleep(0.05)
    assert seen == [("run", "message", "text", "abc")]
    assert sink.take_full("run", "message") == "abc"


async def test_a_process_that_ignores_sigterm_is_killed(tmp_path: Path):
    binary = tmp_path / "claude"
    install("claude_ignore_term", binary)
    protocol.KILL_GRACE_S = 0.05
    cancel = asyncio.Event()
    runner = ProtocolRunner("claude", str(binary))
    events = []
    async for event in runner.stream(spec(tmp_path, "claude", cancel=cancel, session_id="s1")):
        events.append(event)
        cancel.set()
    assert any(event.type == "error" and event.text == "cancelled" for event in events)


async def test_codex_retries_a_writer_lock_then_resumes(tmp_path: Path):
    binary = tmp_path / "codex"
    install("codex_lock", binary)
    runner = ProtocolRunner("codex", str(binary))
    runner.resume_lock_retry_s = (0.0,)
    events = await collect(
        runner,
        spec(tmp_path, "codex", resume=True, codex_thread="th_saved"),
    )
    assert any(event.text == "codex ship it" for event in events)
    assert any(event.type == "session" and event.text == "th_saved" for event in events)
    assert not any("fork" in event.text for event in events)


async def test_a_live_claude_process_accepts_the_next_turn(tmp_path: Path):
    binary = tmp_path / "claude"
    install("claude_persist", binary)
    runner = ProtocolRunner("claude", str(binary))
    try:
        first = await collect(runner, spec(tmp_path, "claude", "one", session_id="sess"))
        assert any(event.text == "did one" for event in first)
        second = await collect(
            runner,
            spec(tmp_path, "claude", "two", session_id="sess", resume=True),
        )
        assert any(event.text == "did two" for event in second)
    finally:
        await runner.aclose()
