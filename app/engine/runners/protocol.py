"""One turn against a real backend process.

Each runner uses the argv and the wire format the TypeScript runner uses:
Claude and Cursor speak stream-json, Codex speaks app-server JSON-RPC, Pi speaks
`pi --mode rpc`, OpenCode is `opencode serve` plus `POST /session/:id/message`,
and Junie and Copilot speak ACP JSON-RPC. A turn ends on that protocol's
completion frame, not on a timeout guess. An exit cezar caused (130/137/143
after we signalled) is a cancel, not an agent failure.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

from app.engine.agents import AgentEvent, AgentSpec
from app.engine.runners.argv import (
    build_claude_args,
    build_codex_args,
    build_copilot_args,
    build_cursor_args,
    build_junie_args,
    build_opencode_args,
    build_pi_args,
    codex_sandbox,
)
from app.engine.session_extras import (
    claude_content,
    codex_mcp_config,
    inactivity_message,
    mcp_allow_rules,
    write_mcp_config,
)

SIGNAL_EXITS = frozenset({130, 137, 143})
# Same grace as the TypeScript CLI runners: SIGTERM, then SIGKILL.
KILL_GRACE_S = 4.0
EOF_TERM_GRACE_S = 8.0
RESUME_LOCK_RETRY_S = (0.25, 0.5, 1.0, 2.0, 4.0, 4.0, 4.0)


_CODEX_NON_TOOL = frozenset({"agentMessage", "userMessage", "reasoning", "plan"})


@dataclass
class TurnState:
    saw_text: bool = False
    done: bool = False
    failed: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    thread_id: str = ""
    compacted: bool = False


def parse_claude_line(line: str, state: TurnState) -> list[AgentEvent]:
    """Assistant frames and the terminal `result`. `stream_event` deltas are display-only in TS."""
    message = _json_object(line)
    if message is None:
        return []
    kind = message.get("type")
    if kind == "stream_event":
        return _stream_event(message)
    events: list[AgentEvent] = []
    if kind == "assistant":
        content = _nested(message, "message", "content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    state.saw_text = True
                    events.append(AgentEvent("text", block["text"]))
                elif block.get("type") == "thinking" and isinstance(block.get("thinking"), str):
                    events.append(AgentEvent("reasoning", block["thinking"]))
                elif block.get("type") == "tool_use" and block.get("name"):
                    events.append(
                        AgentEvent("tool-call", str(block.get("id", "")), str(block["name"]))
                    )
                    if str(block["name"]).lower() == "todowrite":
                        plan = _todo_plan(block.get("input"))
                        if plan:
                            events.append(AgentEvent("plan", plan))
    elif kind == "user":
        content = _nested(message, "message", "content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    text = _tool_result_text(block.get("content"))
                    if block.get("is_error") is True:
                        text = f"error: {text}" if text else "error"
                    events.append(
                        AgentEvent(
                            "tool-result",
                            text,
                            str(block.get("tool_use_id", "")),
                        )
                    )
    elif kind == "system" and message.get("subtype") == "init":
        session = message.get("session_id")
        if isinstance(session, str) and session:
            state.thread_id = session
            events.append(AgentEvent("session", session))
    elif kind == "result":
        if isinstance(message.get("result"), str) and not state.saw_text and message["result"]:
            state.saw_text = True
            events.append(AgentEvent("text", message["result"]))
        usage = _as_dict(message.get("usage"))
        state.input_tokens += _int(usage.get("input_tokens"))
        state.output_tokens += _int(usage.get("output_tokens"))
        if message.get("is_error") is True:
            detail = message.get("result") if isinstance(message.get("result"), str) else ""
            state.failed = detail or "claude reported result error"
        state.done = True
    return events


def parse_codex_line(line: str, state: TurnState) -> list[AgentEvent]:
    message = _json_object(line)
    if message is None:
        return []
    if message.get("id") is not None and isinstance(message.get("result"), dict):
        thread = message["result"].get("thread")
        if isinstance(thread, dict) and isinstance(thread.get("id"), str) and not state.thread_id:
            state.thread_id = thread["id"]
        if isinstance(message["result"].get("error"), dict):
            state.failed = str(message["result"]["error"].get("message", "codex error"))
            state.done = True
    if isinstance(message.get("error"), dict) and message.get("id") is not None:
        state.failed = str(message["error"].get("message", "codex error"))
        state.done = True
        return [AgentEvent("error", state.failed)]
    method = message.get("method")
    params = _as_dict(message.get("params"))
    thread_id = str(params.get("threadId", ""))
    # Only a child thread's turn lifecycle is dropped. Its item events still map.
    if (
        method in ("turn/started", "turn/completed", "turn/failed")
        and thread_id
        and state.thread_id
        and thread_id != state.thread_id
    ):
        return []
    events: list[AgentEvent] = []
    if method == "turn/started":
        state.compacted = False
    elif method == "item/agentMessage/delta" and isinstance(params.get("delta"), str):
        state.saw_text = True
        events.append(AgentEvent("delta", params["delta"]))
    elif method == "turn/plan/updated":
        plan = _codex_plan(params.get("plan"))
        if plan is not None:
            events.append(AgentEvent("plan", plan))
    elif method == "item/started":
        events.extend(_codex_item(params, state, started=True))
    elif method == "item/completed":
        events.extend(_codex_item(params, state, started=False))
    elif method == "item/updated":
        item = _as_dict(params.get("item"))
        events.append(
            AgentEvent(
                "item.updated",
                json.dumps({"type": "item.updated", "item": item}, separators=(",", ":")),
            )
        )
    elif method == "thread/tokenUsage/updated":
        usage = _as_dict(_as_dict(params.get("tokenUsage")).get("total"))
        total = usage.get("totalTokens")
        if isinstance(total, int) and total > 0:
            events.append(AgentEvent("usage.updated", str(total)))
    elif method == "turn/completed":
        turn = _as_dict(params.get("turn"))
        if str(turn.get("status")) == "failed":
            error = _as_dict(turn.get("error"))
            state.failed = str(error.get("message", "codex turn failed"))
        usage = _as_dict(turn.get("usage"))
        state.input_tokens += _int(usage.get("input_tokens"))
        state.output_tokens += _int(usage.get("output_tokens"))
        state.done = True
    return events


def parse_pi_line(line: str, state: TurnState) -> list[AgentEvent]:
    message = _json_object(line)
    if message is None:
        return []
    kind = message.get("type")
    events: list[AgentEvent] = []
    if kind == "message_update" and isinstance(message.get("assistantMessageEvent"), dict):
        update = message["assistantMessageEvent"]
        if update.get("type") == "text_delta" and isinstance(update.get("delta"), str):
            state.saw_text = True
            events.append(AgentEvent("text", update["delta"]))
    elif kind == "tool_execution_start":
        events.append(
            AgentEvent(
                "tool-call", str(message.get("toolCallId", "")), str(message.get("toolName", ""))
            )
        )
    elif kind == "tool_execution_end":
        result = message.get("result")
        text = _pi_text(result.get("content")) if isinstance(result, dict) else str(result or "")
        if message.get("isError") is True:
            text = f"error: {text}" if text else "error"
        events.append(AgentEvent("tool-result", text, str(message.get("toolCallId", ""))))
    elif kind == "message_end" and isinstance(message.get("message"), dict):
        body = message["message"]
        if body.get("role") == "assistant":
            text = _pi_text(body.get("content"))
            if text:
                state.saw_text = True
                events.append(AgentEvent("text", text))
            usage = _as_dict(body.get("usage"))
            state.input_tokens += _int(usage.get("input"))
            state.output_tokens += _int(usage.get("output"))
    elif (
        kind == "response"
        and message.get("command") == "get_state"
        and message.get("success") is True
    ):
        data = _as_dict(message.get("data"))
        session = data.get("sessionId")
        if isinstance(session, str) and session:
            state.thread_id = session
            events.append(AgentEvent("session", session))
    elif kind == "agent_settled":
        state.done = True
    elif kind == "response" and message.get("success") is False:
        state.failed = str(message.get("error", "pi rejected the command"))
        state.done = True
    elif kind == "extension_error":
        events.append(AgentEvent("note", str(message.get("error", "pi extension error"))))
    return events


def parse_acp_line(line: str, state: TurnState, prompt_id: int) -> list[AgentEvent]:
    message = _json_object(line)
    if message is None:
        return []
    events: list[AgentEvent] = []
    if message.get("method") == "session/update":
        params = _as_dict(message.get("params"))
        update = _as_dict(params.get("update"))
        session_update = update.get("sessionUpdate")
        content = _as_dict(update.get("content"))
        if session_update == "agent_message_chunk" and isinstance(content.get("text"), str):
            state.saw_text = True
            events.append(AgentEvent("text", content["text"]))
        elif session_update == "agent_thought_chunk" and isinstance(content.get("text"), str):
            events.append(AgentEvent("reasoning", content["text"]))
        elif session_update == "plan":
            plan = update.get("entries")
            if isinstance(plan, list):
                events.append(AgentEvent("plan", json.dumps(plan, separators=(",", ":"))))
        elif session_update == "tool_call":
            tool_id = str(update.get("toolCallId", ""))
            if tool_id:
                name = str(update.get("title") or update.get("kind") or "tool")
                events.append(AgentEvent("tool-call", tool_id, name))
        elif session_update == "tool_call_update":
            status = update.get("status")
            if status in ("completed", "failed"):
                events.append(
                    AgentEvent(
                        "tool-result",
                        str(update.get("rawOutput", "")),
                        str(update.get("toolCallId", "")),
                    )
                )
    if message.get("id") == 2 and isinstance(message.get("result"), dict):
        session = message["result"].get("sessionId")
        if isinstance(session, str) and session:
            state.thread_id = session
            events.append(AgentEvent("session", session))
    if message.get("id") == prompt_id and "result" in message:
        result = _as_dict(message.get("result"))
        if result.get("stopReason") == "refusal":
            state.failed = "the agent refused the turn"
        usage = _as_dict(result.get("usage"))
        state.input_tokens += _int(usage.get("input_tokens"))
        state.output_tokens += _int(usage.get("output_tokens"))
        state.done = True
    if message.get("id") == prompt_id and isinstance(message.get("error"), dict):
        state.failed = str(message["error"].get("message", "acp error"))
        state.done = True
    return events


class ProtocolRunner:
    def __init__(
        self,
        runner: str,
        binary: str,
        *,
        approval_gate: bool = False,
        codex_network_off: bool = False,
        codex_reasoning: str = "auto",
    ) -> None:
        self.runner = runner
        self.binary = binary
        self.approval_gate = approval_gate
        self.codex_network_off = codex_network_off
        self.codex_reasoning = codex_reasoning
        self.resume_lock_retry_s: tuple[float, ...] = RESUME_LOCK_RETRY_S
        self._open: dict[str, tuple[asyncio.subprocess.Process, Path | None]] = {}
        self._opencode: dict[str, tuple[asyncio.subprocess.Process, int]] = {}

    async def stream(self, spec: AgentSpec) -> AsyncIterator[AgentEvent]:
        try:
            if self.runner == "opencode":
                async for event in self._opencode_stream(spec):
                    yield event
                return
            parked = (
                self._open.pop(spec.session_id, None) if spec.resume and spec.session_id else None
            )
            if parked is not None and parked[0].returncode is None:
                proc, mcp_path = parked
                async for event in _continue_parked(
                    proc, spec, self.runner, codex_reasoning=self.codex_reasoning
                ):
                    yield event
                if proc.returncode is None and not spec.cancel.is_set():
                    self._open[spec.session_id] = (proc, mcp_path)
                else:
                    await _finish_proc(proc, mcp_path)
                return
            hold: list[asyncio.subprocess.Process | None] = [None]
            mcp_hold: list[Path | None] = [None]
            async for event in _process_turn(
                self.runner,
                self.binary,
                spec,
                approval_gate=self.approval_gate,
                codex_network_off=self.codex_network_off,
                codex_reasoning=self.codex_reasoning,
                hold=hold,
                mcp_hold=mcp_hold,
                lock_retries=self.resume_lock_retry_s,
            ):
                yield event
            proc = hold[0]
            if proc is not None and spec.session_id:
                self._open[spec.session_id] = (proc, mcp_hold[0])
        except FileNotFoundError:
            yield AgentEvent("error", f"`{self.binary}` not found on PATH")

    async def steer(self, session_id: str, text: str) -> bool:
        """Write a user message into a process that is still on its stdin session."""
        parked = self._open.get(session_id)
        if parked is None or parked[0].stdin is None or parked[0].returncode is not None:
            return False
        await _write(
            parked[0],
            [
                {
                    "type": "user",
                    "message": {"role": "user", "content": [{"type": "text", "text": text}]},
                }
            ],
        )
        return True

    async def _opencode_stream(self, spec: AgentSpec) -> AsyncIterator[AgentEvent]:
        parked: tuple[asyncio.subprocess.Process, int] | None = None
        if spec.resume and spec.codex_thread:
            current = self._opencode.get(spec.codex_thread)
            if current is not None and current[0].returncode is None:
                parked = current
        hold: dict[str, object] = {}
        async for event in _opencode_turn(self.binary, spec, parked=parked, hold=hold):
            yield event
        proc = hold.get("proc")
        port = hold.get("port")
        session_id = hold.get("session")
        if (
            isinstance(proc, asyncio.subprocess.Process)
            and isinstance(port, int)
            and isinstance(session_id, str)
            and session_id
            and proc.returncode is None
            and not spec.cancel.is_set()
        ):
            self._opencode[session_id] = (proc, port)
            return
        if isinstance(proc, asyncio.subprocess.Process):
            await _escalate(proc)

    async def aclose(self) -> None:
        parked = list(self._open.values())
        self._open.clear()
        for proc, mcp_path in parked:
            await _finish_proc(proc, mcp_path)
        servers = list(self._opencode.values())
        self._opencode.clear()
        for proc, _port in servers:
            await _escalate(proc)


def _child_env(spec: AgentSpec) -> dict[str, str]:
    from app.engine.agent_env import build_child_env, profile_env

    env = build_child_env(spec.runner, extra=profile_env(spec.runner, spec.profile_home))
    if spec.session_id:
        env["CEZ_TASK_ID"] = spec.session_id
    if spec.handoff_file:
        env["CEZ_HANDOFF_FILE"] = spec.handoff_file
    env.update(dict(spec.env))
    return env


async def _process_turn(
    runner: str,
    binary: str,
    spec: AgentSpec,
    *,
    approval_gate: bool,
    codex_network_off: bool,
    codex_reasoning: str = "auto",
    hold: list[asyncio.subprocess.Process | None] | None = None,
    mcp_hold: list[Path | None] | None = None,
    lock_retries: tuple[float, ...] = (),
) -> AsyncIterator[AgentEvent]:
    mcp_path = write_mcp_config(spec.mcp_servers) if runner == "claude" else None
    args = _args(runner, spec, approval_gate=approval_gate, mcp_path=str(mcp_path or ""))
    proc = await asyncio.create_subprocess_exec(
        binary,
        *args,
        cwd=spec.cwd,
        env=_child_env(spec),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    state = TurnState()
    prompt = _with_system(spec) if runner == "codex" else spec.user_prompt
    try:
        if runner == "codex":
            frames = _codex_frames(
                prompt,
                codex_network_off,
                reasoning=codex_reasoning,
                thread_id=spec.codex_thread,
                resume=spec.resume,
                mcp_config=codex_mcp_config(spec.mcp_servers),
            )
            async for event in _rpc_turn(
                proc,
                spec,
                state,
                runner,
                frames,
                idle_ms=spec.timeout_ms,
                lock_retries=lock_retries,
            ):
                yield event
        elif runner in ("junie", "copilot"):
            async for event in _rpc_turn(
                proc, spec, state, runner, _acp_frames(spec), idle_ms=spec.timeout_ms
            ):
                yield event
        else:
            await _write(
                proc,
                _opening_lines(
                    runner,
                    spec,
                    codex_network_off=codex_network_off,
                    codex_reasoning=codex_reasoning,
                ),
            )
            async for event in _read_until_done(
                proc, spec, state, runner, 0, idle_ms=spec.timeout_ms
            ):
                yield event
    finally:
        if proc.returncode is None:
            try:
                await asyncio.wait_for(proc.wait(), 0.05)
            except TimeoutError:
                pass
        keep = (
            hold is not None
            and proc.returncode is None
            and not spec.cancel.is_set()
            and not state.failed
            and runner in ("claude", "pi")
            and bool(spec.session_id)
        )
        if keep and hold is not None:
            hold[0] = proc
            if mcp_hold is not None:
                mcp_hold[0] = mcp_path
        else:
            await _finish_proc(proc, mcp_path)
    async for event in _turn_end(proc, spec, state, runner, hold):
        yield event


async def _turn_end(
    proc: asyncio.subprocess.Process,
    spec: AgentSpec,
    state: TurnState,
    runner: str,
    hold: list[asyncio.subprocess.Process | None] | None,
) -> AsyncIterator[AgentEvent]:
    if spec.cancel.is_set():
        return
    if state.thread_id:
        yield AgentEvent("session", state.thread_id)
    if state.input_tokens or state.output_tokens:
        yield AgentEvent(
            "text", "", input_tokens=state.input_tokens, output_tokens=state.output_tokens
        )
    if state.failed:
        yield AgentEvent("error", state.failed)
        return
    code = proc.returncode
    if code is None and (hold is None or hold[0] is None):
        code = await proc.wait()
    if code not in (0, None) and code not in SIGNAL_EXITS:
        err = b""
        if proc.stderr is not None:
            err = await proc.stderr.read()
        detail = err.decode(errors="replace").strip()
        yield AgentEvent("error", detail or f"{runner} exited {code}")
        return
    if not state.done and code in SIGNAL_EXITS:
        yield AgentEvent("error", "cancelled")
        return
    yield AgentEvent("turn-end", name="context-compaction" if state.compacted else "")


def _with_system(spec: AgentSpec) -> str:
    if not spec.system_prompt:
        return spec.user_prompt
    return f"{spec.system_prompt}\n\n---\n\n{spec.user_prompt}"


def _codex_item(params: dict[str, Any], state: TurnState, *, started: bool) -> list[AgentEvent]:
    item = _as_dict(params.get("item"))
    kind = str(item.get("type", ""))
    if started:
        if kind == "commandExecution":
            return [AgentEvent("tool-call", str(item.get("command", "")), "Bash")]
        if not kind or kind in _CODEX_NON_TOOL:
            return []
        return [AgentEvent("tool-call", str(item.get("id", "")), kind)]
    if kind == "contextCompaction":
        state.compacted = True
    if kind == "reasoning":
        summary = item.get("summary")
        text = item.get("text") if isinstance(item.get("text"), str) else ""
        if not text and isinstance(summary, list):
            text = " ".join(part for part in summary if isinstance(part, str))
        return [AgentEvent("reasoning", text)] if text else []
    if kind == "plan":
        plan = _codex_plan(item.get("plan") or item.get("entries"))
        return [AgentEvent("plan", plan)] if plan else []
    if kind == "agentMessage":
        state.compacted = False
        if isinstance(item.get("text"), str) and not state.saw_text:
            state.saw_text = True
            return [AgentEvent("text", item["text"])]
        return []
    if kind == "commandExecution":
        return [AgentEvent("tool-result", str(item.get("aggregatedOutput", "")), "Bash")]
    if not kind or kind in _CODEX_NON_TOOL:
        return []
    return [AgentEvent("tool-result", json.dumps(item, separators=(",", ":")), kind)]


def _codex_frames(
    prompt: str,
    network_off: bool,
    *,
    reasoning: str = "auto",
    thread_id: str,
    resume: bool,
    mcp_config: dict[str, Any],
) -> list[dict[str, Any]]:
    params: dict[str, Any] = {
        "sandbox": codex_sandbox(network_off=network_off),
        "approvalPolicy": "never",
    }
    if mcp_config:
        params["config"] = mcp_config
    if resume and thread_id:
        params["threadId"] = thread_id
        method = "thread/resume"
    else:
        method = "thread/start"
    return [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": method, "params": params},
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "turn/start",
            "params": {"input": [{"type": "text", "text": prompt}], "summary": reasoning},
        },
    ]


def _acp_frames(spec: AgentSpec) -> list[dict[str, Any]]:
    prompt = spec.user_prompt
    if spec.system_prompt:
        prompt = f"{spec.system_prompt}\n\n---\n\n{spec.user_prompt}"
    return [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": 1, "clientCapabilities": {}},
        },
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {"cwd": spec.cwd, "mcpServers": []},
        },
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {"sessionId": "pending", "prompt": [{"type": "text", "text": prompt}]},
        },
    ]


async def _rpc_turn(
    proc: asyncio.subprocess.Process,
    spec: AgentSpec,
    state: TurnState,
    runner: str,
    frames: list[dict[str, Any]],
    *,
    idle_ms: int = 0,
    lock_retries: tuple[float, ...] = (),
) -> AsyncIterator[AgentEvent]:
    """Send each handshake frame, then the prompt, and stop on the prompt's completion.

    Handshake replies share the parser with the prompt, so the completion id is
    always the last frame. Treating a handshake id as completion ends the turn
    before the prompt is sent.
    """
    prompt_id = int(frames[-1]["id"])
    index = 0
    retries = lock_retries
    while index < len(frames):
        frame = frames[index]
        await _write(proc, [frame])
        is_prompt = index == len(frames) - 1
        async for event in _read_until_done(
            proc,
            spec,
            state,
            runner,
            prompt_id,
            stop_id=None if is_prompt else int(frame["id"]),
            idle_ms=idle_ms,
        ):
            yield event
        if frame.get("method") == "thread/resume" and _writer_lock(state.failed):
            state.failed = ""
            state.done = False
            if retries:
                await asyncio.sleep(retries[0])
                retries = retries[1:]
                continue
            forked = dict(frame)
            forked["method"] = "thread/fork"
            await _write(proc, [forked])
            async for event in _read_until_done(
                proc,
                spec,
                state,
                runner,
                prompt_id,
                stop_id=int(frame["id"]),
                idle_ms=idle_ms,
            ):
                yield event
            if state.thread_id:
                yield AgentEvent(
                    "note",
                    f"codex: thread {spec.codex_thread} is still open in another Codex process "
                    f"— continuing in a fork of it ({state.thread_id})",
                )
            if state.failed or spec.cancel.is_set():
                return
            index += 1
            continue
        if state.failed or state.done or spec.cancel.is_set():
            return
        index += 1


def _agent_dirs(spec: AgentSpec) -> tuple[str, ...]:
    """The run's own temp directory: the file tools must reach what `TMPDIR` names."""
    named = dict(spec.env).get("TMPDIR", "")
    return (named,) if named and os.path.isdir(named) else ()


def _args(runner: str, spec: AgentSpec, *, approval_gate: bool, mcp_path: str = "") -> list[str]:
    tools = spec.allowed_tools or ("Read", "Edit", "Write", "Grep", "Glob", "Bash")
    if runner == "claude":
        args = build_claude_args(
            system_prompt=spec.system_prompt,
            model=spec.model,
            allowed_tools=tools,
            bash_allowlist=spec.bash_allowlist,
            session_id=spec.session_id,
            resume=spec.resume,
            approval_gate=approval_gate,
            extra_dirs=_agent_dirs(spec),
        )
        if mcp_path:
            args.extend(["--mcp-config", mcp_path])
            rules = mcp_allow_rules(spec.mcp_servers)
            if rules and "--allowedTools" in args:
                slot = args.index("--allowedTools") + 1
                args[slot] = args[slot] + "," + ",".join(rules)
            elif rules:
                args.extend(["--allowedTools", ",".join(rules)])
        return args
    if runner == "cursor":
        return build_cursor_args(
            user_prompt=spec.user_prompt, system_prompt=spec.system_prompt, model=spec.model
        )
    if runner == "pi":
        return build_pi_args(
            system_prompt=spec.system_prompt,
            model=spec.model,
            allowed_tools=tools,
            bash_allowlist=spec.bash_allowlist,
            session_id=spec.session_id,
            resume=spec.resume,
        )
    if runner == "codex":
        return build_codex_args()
    if runner == "junie":
        return build_junie_args(spec.cwd)
    if runner == "copilot":
        return build_copilot_args(model=spec.model, extra_dirs=_agent_dirs(spec))
    return []


def _opening_lines(
    runner: str, spec: AgentSpec, *, codex_network_off: bool, codex_reasoning: str = "auto"
) -> list[dict[str, Any]]:
    prompt = spec.user_prompt
    if runner in ("codex", "opencode") and spec.system_prompt:
        prompt = f"{spec.system_prompt}\n\n---\n\n{spec.user_prompt}"
    if runner == "claude":
        return [
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": claude_content(prompt, spec.images),
                },
            }
        ]
    if runner == "cursor":
        return []
    if runner == "pi":
        return [
            {"id": "cezar-state", "type": "get_state"},
            {"type": "prompt", "message": prompt, "streamingBehavior": "steer"},
        ]
    if runner == "codex":
        return [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "thread/start",
                "params": {
                    "sandbox": codex_sandbox(network_off=codex_network_off),
                    "approvalPolicy": "never",
                },
            },
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "turn/start",
                "params": {
                    "input": [{"type": "text", "text": prompt}],
                    "summary": codex_reasoning,
                },
            },
        ]
    if runner in ("junie", "copilot"):
        return [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": 1, "clientCapabilities": {}},
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/new",
                "params": {"cwd": spec.cwd, "mcpServers": []},
            },
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {"prompt": [{"type": "text", "text": prompt}]},
            },
        ]
    return []


def _parse(runner: str, line: str, state: TurnState, prompt_id: int) -> list[AgentEvent]:
    if runner in ("claude", "cursor"):
        return parse_claude_line(line, state)
    if runner == "codex":
        return parse_codex_line(line, state)
    if runner == "pi":
        return parse_pi_line(line, state)
    if runner in ("junie", "copilot"):
        return parse_acp_line(line, state, prompt_id)
    return []


async def _read_until_done(
    proc: asyncio.subprocess.Process,
    spec: AgentSpec,
    state: TurnState,
    runner: str,
    prompt_id: int,
    *,
    done: bool = False,
    stop_id: int | None = None,
    idle_ms: int = 0,
) -> AsyncIterator[AgentEvent]:
    assert proc.stdout is not None
    seen_stop = False
    started = time.monotonic()
    last = started
    while not (state.done or done or seen_stop):
        if spec.cancel.is_set():
            await _escalate(proc)
            yield AgentEvent("error", "cancelled")
            return
        expired = _idle_expired(started, last, idle_ms)
        if expired:
            await _escalate(proc)
            state.failed = inactivity_message(runner, idle_ms, ceiling=expired == "ceiling")
            state.done = True
            return
        try:
            raw = await asyncio.wait_for(proc.stdout.readline(), timeout=0.2)
        except TimeoutError:
            if proc.returncode is not None:
                break
            continue
        last = time.monotonic()
        if not raw:
            break
        line = raw.decode(errors="replace").rstrip("\n")
        if stop_id is not None and _response_id(line) == stop_id:
            seen_stop = True
        for event in _parse(runner, line, state, prompt_id):
            if event.type == "error":
                state.failed = event.text
            elif not seen_stop or event.type != "turn-end":
                yield event


async def _opencode_turn(
    binary: str,
    spec: AgentSpec,
    *,
    parked: tuple[asyncio.subprocess.Process, int] | None,
    hold: dict[str, object],
) -> AsyncIterator[AgentEvent]:
    owns_proc = parked is None
    if parked is None:
        port = _free_port()
        proc = await asyncio.create_subprocess_exec(
            binary,
            *build_opencode_args(port),
            cwd=spec.cwd,
            env=_child_env(spec),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
    else:
        proc, port = parked
    hold["proc"] = proc
    hold["port"] = port
    try:
        if owns_proc:
            await _wait_port(port, spec.cancel)
        if spec.cancel.is_set():
            yield AgentEvent("error", "cancelled")
            return
        session_id = spec.codex_thread if spec.resume and spec.codex_thread else ""
        if not session_id:
            created = await asyncio.to_thread(
                _post, f"http://127.0.0.1:{port}/session", {"title": "cezar task"}
            )
            session_id = str(created.get("id", ""))
            if not session_id:
                yield AgentEvent("error", "opencode did not return a session id")
                return
            yield AgentEvent("session", session_id)
        hold["session"] = session_id
        ctype, raw = await asyncio.to_thread(
            _exchange,
            f"http://127.0.0.1:{port}/session/{session_id}/message",
            {"parts": [{"type": "text", "text": _with_system(spec)}]},
        )
        if "text/event-stream" in ctype or raw.lstrip().startswith(b"data:"):
            for event in opencode_events(raw.decode(errors="replace")):
                if event.type == "permission.requested" and event.text:
                    await asyncio.to_thread(_reply_permission, port, event.text)
                yield event
            return
        for event in _opencode_json_events(raw):
            yield event
    except (URLError, TimeoutError, OSError) as exc:
        yield AgentEvent("error", f"opencode serve failed: {exc}")


def _opencode_json_events(raw: bytes) -> list[AgentEvent]:
    try:
        loaded = json.loads(raw.decode())
    except json.JSONDecodeError:
        return [AgentEvent("error", "opencode returned a body that is not json")]
    body = loaded if isinstance(loaded, dict) else {}
    events: list[AgentEvent] = []
    for part in _as_list(body.get("parts")):
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            events.append(AgentEvent("text", part["text"]))
        elif part.get("type") == "tool":
            events.append(
                AgentEvent("tool-call", str(part.get("id", "")), str(part.get("tool", "tool")))
            )
    if body.get("error"):
        return [*events, AgentEvent("error", str(body["error"]))]
    if isinstance(body.get("text"), str) and not any(e.type == "text" for e in events):
        events.append(AgentEvent("text", body["text"]))
    return [*events, AgentEvent("turn-end")]


def opencode_events(raw: str) -> list[AgentEvent]:
    """Assistant parts from an OpenCode SSE body. The user's own parts are skipped."""
    roles: dict[str, str] = {}
    seen: dict[str, str] = {}
    events: list[AgentEvent] = []
    idle = False
    for payload in _sse_payloads(raw):
        kind = payload.get("type")
        props = _as_dict(payload.get("properties") or payload)
        if kind == "message.updated":
            info = _as_dict(props.get("info") or props)
            message_id = info.get("id")
            role = info.get("role")
            if isinstance(message_id, str) and isinstance(role, str):
                roles[message_id] = role
            continue
        if kind in ("message.part.updated", "message.part.created"):
            part = _as_dict(props.get("part") or props)
            message_id = part.get("messageID")
            # An unknown role is not assistant yet: the user's echo shares this feed.
            if isinstance(message_id, str) and roles.get(message_id) != "assistant":
                continue
            part_type = part.get("type")
            part_id = str(part.get("id") or message_id or "")
            if part_type == "text" and isinstance(part.get("text"), str):
                if seen.get(part_id) == part["text"]:
                    continue
                seen[part_id] = part["text"]
                events.append(AgentEvent("text", part["text"]))
            elif part_type == "tool":
                state = _as_dict(part.get("state"))
                status = state.get("status")
                name = str(part.get("tool") or part.get("name") or "tool")
                if status in ("completed", "error"):
                    events.append(AgentEvent("tool-result", str(state.get("output", "")), name))
                elif part_id not in seen:
                    seen[part_id] = name
                    events.append(AgentEvent("tool-call", part_id, name))
                else:
                    events.append(
                        AgentEvent(
                            "item.updated",
                            json.dumps(
                                {"type": "item.updated", "item": {"id": part_id, "status": status}},
                                separators=(",", ":"),
                            ),
                        )
                    )
            continue
        if kind in ("permission.asked", "permission.updated"):
            events.append(AgentEvent("permission.requested", str(props.get("id", ""))))
            continue
        if kind == "session.idle":
            idle = True
            events.append(AgentEvent("turn-end"))
    if not idle:
        events.append(AgentEvent("turn-end"))
    return events


def _sse_payloads(raw: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for block in raw.split("\n\n"):
        data = "".join(
            line[5:].lstrip() if line.startswith("data:") else ""
            for line in block.splitlines()
            if line.startswith("data:")
        )
        if not data:
            continue
        try:
            loaded = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(loaded, dict):
            found.append(loaded)
    return found


def _reply_permission(port: int, permission_id: str) -> None:
    try:
        _exchange(
            f"http://127.0.0.1:{port}/permission/{permission_id}/reply",
            {"reply": "once"},
        )
    except URLError, TimeoutError, OSError:
        return


async def _write(proc: asyncio.subprocess.Process, messages: list[dict[str, Any]]) -> None:
    assert proc.stdin is not None
    if not messages:
        return
    payload = "".join(json.dumps(message) + "\n" for message in messages)
    proc.stdin.write(payload.encode())
    await proc.stdin.drain()


def _close(proc: asyncio.subprocess.Process) -> None:
    if proc.stdin is not None and not proc.stdin.is_closing():
        proc.stdin.close()


async def _escalate(proc: asyncio.subprocess.Process) -> None:
    """SIGTERM, then SIGKILL if the process is still alive after the grace."""
    if proc.returncode is not None:
        return
    proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), KILL_GRACE_S)
    except TimeoutError:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def _reap(proc: asyncio.subprocess.Process) -> None:
    """After stdin closes, wait, then escalate. An already-exited process returns at once."""
    if proc.returncode is not None:
        return
    try:
        await asyncio.wait_for(proc.wait(), EOF_TERM_GRACE_S)
    except TimeoutError:
        await _escalate(proc)


async def _finish_proc(proc: asyncio.subprocess.Process, mcp_path: Path | None) -> None:
    _close(proc)
    await _reap(proc)
    if mcp_path is not None:
        shutil.rmtree(mcp_path.parent, ignore_errors=True)


async def _continue_parked(
    proc: asyncio.subprocess.Process,
    spec: AgentSpec,
    runner: str,
    *,
    codex_reasoning: str = "auto",
) -> AsyncIterator[AgentEvent]:
    """A follow-up on the process that stayed open after the previous turn."""
    state = TurnState()
    await _write(
        proc,
        _opening_lines(runner, spec, codex_network_off=False, codex_reasoning=codex_reasoning),
    )
    async for event in _read_until_done(proc, spec, state, runner, 0, idle_ms=spec.timeout_ms):
        yield event
    if state.input_tokens or state.output_tokens:
        yield AgentEvent(
            "text", "", input_tokens=state.input_tokens, output_tokens=state.output_tokens
        )
    if state.failed:
        yield AgentEvent("error", state.failed)
        return
    yield AgentEvent("turn-end")


def _writer_lock(message: str) -> bool:
    return "already has an active writer" in message


def _stream_event(message: dict[str, Any]) -> list[AgentEvent]:
    event = _as_dict(message.get("event"))
    if event.get("type") != "content_block_delta":
        return []
    delta = _as_dict(event.get("delta"))
    if delta.get("type") == "text_delta" and isinstance(delta.get("text"), str):
        return [AgentEvent("delta", delta["text"])]
    return []


def _todo_plan(raw: Any) -> str:
    todos = raw.get("todos") if isinstance(raw, dict) else None
    if not isinstance(todos, list):
        return ""
    entries = []
    for item in todos:
        if not isinstance(item, dict) or not isinstance(item.get("content"), str):
            continue
        status = item.get("status")
        if status not in ("pending", "in_progress", "completed"):
            status = "pending"
        active = item.get("activeForm")
        if not isinstance(active, str):
            active = item["content"]
        entries.append({"content": item["content"], "status": status, "activeForm": active})
    if not entries:
        return ""
    return json.dumps({"type": "plan.updated", "entries": entries}, separators=(",", ":"))


def _codex_plan(raw: Any) -> str | None:
    if not isinstance(raw, list):
        return None
    entries = []
    for step in raw:
        if not isinstance(step, dict) or not isinstance(step.get("step"), str):
            continue
        status = step.get("status")
        if status in ("inProgress", "in_progress"):
            mapped = "in_progress"
        elif status == "completed":
            mapped = "completed"
        else:
            mapped = "pending"
        entries.append({"content": step["step"], "status": mapped, "activeForm": step["step"]})
    if raw and not entries:
        return None
    return json.dumps({"type": "plan.updated", "entries": entries}, separators=(",", ":"))


def _post(url: str, body: dict[str, Any]) -> dict[str, Any]:
    _ctype, raw = _exchange(url, body)
    try:
        loaded = json.loads(raw.decode())
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _exchange(url: str, body: dict[str, Any]) -> tuple[str, bytes]:
    request = Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    with urlopen(request, timeout=20) as response:
        return response.headers.get("content-type", ""), response.read()


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _wait_port(port: int, cancel: asyncio.Event) -> None:
    for _ in range(50):
        if cancel.is_set():
            return
        try:
            _reader, writer = await asyncio.open_connection("127.0.0.1", port)
        except OSError:
            await asyncio.sleep(0.05)
            continue
        writer.close()
        await writer.wait_closed()
        return
    raise TimeoutError(f"opencode did not listen on {port}")


def _idle_expired(started: float, last: float, idle_ms: int) -> str:
    if idle_ms <= 0:
        return ""
    now = time.monotonic()
    if now - started >= (idle_ms / 1000) * 8:
        return "ceiling"
    if now - last >= idle_ms / 1000:
        return "inactivity"
    return ""


def _response_id(line: str) -> int | None:
    message = _json_object(line)
    if message is None or not isinstance(message.get("id"), int):
        return None
    if "result" in message or "error" in message:
        return message["id"]
    return None


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _json_object(line: str) -> dict[str, Any] | None:
    if not line.startswith("{"):
        return None
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _nested(message: dict[str, Any], *keys: str) -> Any:
    current: Any = message
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _pi_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = [
        block.get("text", "")
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ]
    return "".join(parts)


def _tool_result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ]
        return "\n".join(part for part in parts if part)
    return ""


def _int(value: Any) -> int:
    return value if type(value) is int else 0
