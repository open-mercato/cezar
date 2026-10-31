import asyncio
import json
import shutil
from pathlib import Path

from app.engine.agents import AgentEvent, AgentSpec
from app.engine.runners.argv import (
    build_allowed_tools,
    build_claude_args,
    build_codex_args,
    build_copilot_args,
    build_cursor_args,
    build_junie_args,
    build_opencode_args,
    build_pi_args,
    codex_sandbox,
)
from app.engine.runners.protocol import (
    ProtocolRunner,
    TurnState,
    opencode_events,
    parse_acp_line,
    parse_claude_line,
    parse_codex_line,
    parse_pi_line,
)

FAKES = Path(__file__).parent / "fakes"


def install(name: str, dest: Path) -> None:
    source = (FAKES / f"{name}.py").read_text(encoding="utf-8")
    dest.write_text("#!/usr/bin/env python3\n" + source, encoding="utf-8")
    dest.chmod(0o755)


def spec(tmp_path: Path, runner: str, prompt: str = "ship it", **kwargs: object) -> AgentSpec:
    values: dict[str, object] = {
        "user_prompt": prompt,
        "system_prompt": "",
        "cwd": str(tmp_path),
        "runner": runner,
        "model": "",
        "cancel": asyncio.Event(),
    }
    values.update(kwargs)
    return AgentSpec(**values)  # type: ignore[arg-type]


async def collect(runner: ProtocolRunner, item: AgentSpec) -> list[AgentEvent]:
    return [event async for event in runner.stream(item)]


def test_claude_allowlist_and_permission_mode_match_the_cli():
    plain = build_allowed_tools(["Read", "Bash"], [])
    assert plain == ["Read", "Bash"]
    restricted = build_allowed_tools(["Bash", "Read"], ["npm", " git"])
    assert restricted == ["Bash(npm:*)", "Bash(git:*)", "Read"]
    args = build_claude_args(
        system_prompt="be brief",
        model="opus",
        allowed_tools=["Bash"],
        bash_allowlist=["npm"],
        session_id="sess-1",
        approval_gate=False,
    )
    assert args[:6] == [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    mode = args[args.index("--permission-mode") + 1]
    assert mode == "dontAsk"
    assert "Bash(npm:*)" in args[args.index("--allowedTools") + 1]
    assert args[args.index("--session-id") + 1] == "sess-1"
    resumed = build_claude_args(
        system_prompt="",
        model="",
        allowed_tools=[],
        bash_allowlist=[],
        session_id="sess-1",
        resume=True,
    )
    assert "--resume" in resumed and "--session-id" not in resumed


def test_cursor_pi_junie_and_copilot_argv():
    cursor = build_cursor_args(user_prompt="fix it", system_prompt="sys", model="gpt")
    assert cursor[:4] == ["-p", "--force", "--trust", "--output-format"]
    assert cursor[-1].startswith("sys")
    pi = build_pi_args(
        system_prompt="",
        model="",
        allowed_tools=["Read", "Bash"],
        bash_allowlist=["npm"],
    )
    assert pi[:2] == ["--mode", "rpc"]
    assert "bash" not in pi[pi.index("--tools") + 1]
    assert build_junie_args("/work") == ["--acp=true", "-p", "/work"]
    copilot = build_copilot_args(model="gpt-4")
    assert copilot[:3] == ["--acp", "--allow-all-tools", "--no-auto-update"]
    assert codex_sandbox(network_off=False) == "danger-full-access"
    assert codex_sandbox(network_off=True) == "workspace-write"
    assert "allowedTools" not in build_codex_args()
    assert "--allowedTools" not in build_opencode_args(1)


def test_a_child_codex_turn_does_not_finish_the_parent():
    state = TurnState(thread_id="parent")
    child = json.dumps(
        {
            "method": "turn/completed",
            "params": {"threadId": "child", "turn": {"status": "completed"}},
        }
    )
    assert parse_codex_line(child, state) == []
    assert state.done is False
    parent = json.dumps(
        {
            "method": "turn/completed",
            "params": {
                "threadId": "parent",
                "turn": {"id": "t", "status": "completed"},
            },
        }
    )
    parse_codex_line(parent, state)
    assert state.done is True


def test_claude_result_usage_is_not_also_taken_from_assistant_frames():
    state = TurnState()
    events = parse_claude_line(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [{"type": "text", "text": "hello"}],
                    "usage": {"input_tokens": 99, "output_tokens": 99},
                },
            }
        ),
        state,
    )
    assert events == [AgentEvent("text", "hello")]
    assert state.input_tokens == 0
    parse_claude_line(
        json.dumps(
            {
                "type": "result",
                "result": "hello",
                "usage": {"input_tokens": 2, "output_tokens": 3},
            }
        ),
        state,
    )
    assert state.done is True
    assert (state.input_tokens, state.output_tokens) == (2, 3)


async def test_claude_fake_speaks_stream_json(tmp_path: Path):
    binary = tmp_path / "claude"
    install("claude", binary)
    events = await collect(
        ProtocolRunner("claude", str(binary)),
        spec(
            tmp_path,
            "claude",
            allowed_tools=("Bash",),
            bash_allowlist=("npm",),
            session_id="sess-9",
        ),
    )
    assert any(event.type == "text" and event.text == "did ship it" for event in events)
    assert any(event.type == "tool-call" and event.name == "Write" for event in events)
    assert any(event.type == "tool-result" and event.text == "wrote" for event in events)
    assert events[-1].type == "turn-end"
    assert sum(event.input_tokens for event in events) == 2
    argv = (tmp_path / "claude.args").read_text(encoding="utf-8")
    assert "--permission-mode\ndontAsk" in argv
    assert "Bash(npm:*)" in argv
    assert "--session-id\nsess-9" in argv


async def test_codex_fake_requires_the_sandbox_and_ignores_a_child_thread(tmp_path: Path):
    binary = tmp_path / "codex"
    install("codex", binary)
    events = await collect(
        ProtocolRunner("codex", str(binary)),
        spec(tmp_path, "codex", "refactor"),
    )
    assert any(event.text == "codex refactor" for event in events)
    assert events[-1].type == "turn-end"


async def test_pi_cursor_and_acp_fakes(tmp_path: Path):
    pi = tmp_path / "pi"
    install("pi", pi)
    events = await collect(
        ProtocolRunner("pi", str(pi)),
        spec(tmp_path, "pi", allowed_tools=("Read", "Bash"), bash_allowlist=("npm",)),
    )
    assert any(event.text == "pi ship it" for event in events)
    assert any(event.type == "tool-call" and event.name == "read" for event in events)
    assert "bash" not in (tmp_path / "pi.args").read_text(encoding="utf-8")

    cursor = tmp_path / "cursor"
    install("cursor", cursor)
    events = await collect(
        ProtocolRunner("cursor", str(cursor)),
        spec(tmp_path, "cursor", "format"),
    )
    assert any(event.text == "cursor format" for event in events)
    assert events[-1].type == "turn-end"
    argv = (tmp_path / "cursor.args").read_text(encoding="utf-8")
    assert argv.split("\n")[:3] == ["-p", "--force", "--trust"]

    acp = tmp_path / "junie"
    install("acp", acp)
    events = await collect(ProtocolRunner("junie", str(acp)), spec(tmp_path, "junie", "review"))
    assert any(event.text == "junie review" for event in events)
    assert events[-1].type == "turn-end"
    copy = tmp_path / "copilot"
    shutil.copy(acp, copy)
    copy.chmod(0o755)
    events = await collect(
        ProtocolRunner("copilot", str(copy)),
        spec(tmp_path, "copilot", "review"),
    )
    assert any(event.text == "junie review" for event in events)


async def test_opencode_fake_holds_the_message_post(tmp_path: Path):
    binary = tmp_path / "opencode"
    install("opencode", binary)
    runner = ProtocolRunner("opencode", str(binary))
    events = await collect(runner, spec(tmp_path, "opencode", "serve"))
    await runner.aclose()
    assert any(event.type == "session" and event.text == "ses_1" for event in events)
    assert any(event.text == "oc serve" for event in events)
    assert events[-1].type == "turn-end"


async def test_opencode_resume_reuses_the_session(tmp_path: Path):
    binary = tmp_path / "opencode"
    install("opencode", binary)
    runner = ProtocolRunner("opencode", str(binary))
    first = await collect(runner, spec(tmp_path, "opencode", "serve"))
    session = next(event.text for event in first if event.type == "session")
    second = await collect(
        runner,
        spec(tmp_path, "opencode", "again", resume=True, codex_thread=session),
    )
    await runner.aclose()
    assert any(event.text == "oc again" for event in second)
    log = Path(str(binary) + ".log").read_text(encoding="utf-8")
    assert log.splitlines() == ["/session", "/session/ses_1/message", "/session/ses_1/message"]


def test_opencode_sse_keeps_assistant_parts_and_permission():
    frames = [
        {"type": "message.updated", "properties": {"info": {"id": "m1", "role": "user"}}},
        {
            "type": "message.part.updated",
            "properties": {"part": {"messageID": "m1", "id": "p0", "type": "text", "text": "echo"}},
        },
        {"type": "message.updated", "properties": {"info": {"id": "m2", "role": "assistant"}}},
        {
            "type": "message.part.updated",
            "properties": {
                "part": {"messageID": "m2", "id": "p1", "type": "text", "text": "answer"}
            },
        },
        {"type": "permission.asked", "properties": {"id": "perm-1"}},
        {"type": "session.idle", "properties": {}},
    ]
    raw = "\n\n".join(f"data: {json.dumps(frame, separators=(',', ':'))}" for frame in frames)
    events = opencode_events(raw)
    assert [event.text for event in events if event.type == "text"] == ["answer"]
    assert any(event.type == "permission.requested" and event.text == "perm-1" for event in events)
    assert events[-1].type == "turn-end"


def test_codex_compaction_and_item_updated():
    state = TurnState()
    started = parse_codex_line(
        json.dumps(
            {
                "method": "item/completed",
                "params": {"item": {"id": "c1", "type": "contextCompaction"}},
            }
        ),
        state,
    )
    assert state.compacted is True
    assert any(event.name == "contextCompaction" for event in started)
    updated = parse_codex_line(
        json.dumps(
            {
                "method": "item/updated",
                "params": {"item": {"id": "c1", "type": "fileChange"}},
            }
        ),
        state,
    )
    assert updated[0].type == "item.updated"
    assert "fileChange" in updated[0].text
    file_change = parse_codex_line(
        json.dumps(
            {
                "method": "item/started",
                "params": {"item": {"id": "f1", "type": "fileChange"}},
            }
        ),
        state,
    )
    assert file_change[0].type == "tool-call"
    assert file_change[0].name == "fileChange"


async def test_inactivity_kills_a_silent_process(tmp_path: Path):
    binary = tmp_path / "claude"
    install("claude", binary)
    binary.write_text(
        "#!/usr/bin/env python3\nimport time\ntime.sleep(5)\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    events = await collect(
        ProtocolRunner("claude", str(binary)),
        spec(tmp_path, "claude", timeout_ms=200),
    )
    assert any(event.type == "error" and "without any output" in event.text for event in events)


async def test_claude_sends_images_and_mcp_config(tmp_path: Path):
    binary = tmp_path / "claude"
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "from pathlib import Path\n"
        "root = Path(sys.argv[0])\n"
        "root.with_name(root.name + '.args').write_text('\\n'.join(sys.argv[1:]))\n"
        "if '--mcp-config' in sys.argv:\n"
        "    cfg = Path(sys.argv[sys.argv.index('--mcp-config') + 1])\n"
        "    root.with_name(root.name + '.mcp').write_text(cfg.read_text())\n"
        "msg = json.loads(sys.stdin.readline())\n"
        "blocks = msg['message']['content']\n"
        "kinds = ','.join(block.get('type', '') for block in blocks)\n"
        "root.with_name(root.name + '.blocks').write_text(kinds)\n"
        "text = next(block['text'] for block in blocks if block.get('type') == 'text')\n"
        "usage = {'input_tokens': 1, 'output_tokens': 1}\n"
        "out = {'type': 'result', 'result': text, 'usage': usage}\n"
        "sys.stdout.write(json.dumps(out) + '\\n')\n"
        "sys.stdout.flush()\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    events = await collect(
        ProtocolRunner("claude", str(binary)),
        spec(
            tmp_path,
            "claude",
            images=({"mediaType": "image/png", "data": "aaaa"},),
            mcp_servers=({"name": "docs", "command": "echo", "args": ["hi"]},),
        ),
    )
    assert any(event.text == "ship it" for event in events)
    assert (tmp_path / "claude.blocks").read_text(encoding="utf-8") == "image,text"
    assert "docs" in (tmp_path / "claude.mcp").read_text(encoding="utf-8")
    assert "--mcp-config" in (tmp_path / "claude.args").read_text(encoding="utf-8")


async def test_codex_resumes_a_stored_thread(tmp_path: Path):
    binary = tmp_path / "codex"
    install("codex_resume", binary)
    events = await collect(
        ProtocolRunner("codex", str(binary)),
        spec(tmp_path, "codex", "again", resume=True, codex_thread="th_saved"),
    )
    assert any(event.text == "codex again" for event in events)
    assert any(event.type == "session" and event.text == "th_saved" for event in events)


async def test_a_missing_binary_is_an_error_not_a_crash(tmp_path: Path):
    events = await collect(
        ProtocolRunner("claude", str(tmp_path / "missing")),
        spec(tmp_path, "claude"),
    )
    assert events[-1].type == "error"
    assert "not found" in events[-1].text


def test_claude_and_cursor_map_init_thinking_and_tool_errors():
    state = TurnState()
    init = parse_claude_line(
        json.dumps({"type": "system", "subtype": "init", "session_id": "sess-9"}),
        state,
    )
    assert init[0].type == "session" and init[0].text == "sess-9"
    thought = parse_claude_line(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "thinking", "thinking": "hmm"},
                        {"type": "text", "text": "hi"},
                    ]
                },
            }
        ),
        state,
    )
    assert any(event.type == "reasoning" and event.text == "hmm" for event in thought)
    assert any(event.type == "text" and event.text == "hi" for event in thought)
    failed = parse_claude_line(
        json.dumps(
            {
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "t1",
                            "is_error": True,
                            "content": "no",
                        }
                    ]
                },
            }
        ),
        state,
    )
    assert failed[0].text == "error: no"


def test_codex_reasoning_plan_usage_and_a_foreign_turn():
    state = TurnState()
    state.thread_id = "th_parent"
    reasoning = parse_codex_line(
        json.dumps(
            {
                "method": "item/completed",
                "params": {"item": {"type": "reasoning", "text": "because"}},
            }
        ),
        state,
    )
    assert reasoning[0].type == "reasoning" and reasoning[0].text == "because"
    plan = parse_codex_line(
        json.dumps(
            {
                "method": "item/completed",
                "params": {
                    "item": {"type": "plan", "plan": [{"step": "ship", "status": "pending"}]}
                },
            }
        ),
        state,
    )
    assert plan and plan[0].type == "plan"
    usage = parse_codex_line(
        json.dumps(
            {
                "method": "thread/tokenUsage/updated",
                "params": {"tokenUsage": {"total": {"totalTokens": 12}}},
            }
        ),
        state,
    )
    assert usage[0].type == "usage.updated" and usage[0].text == "12"
    dropped = parse_codex_line(
        json.dumps(
            {
                "method": "turn/completed",
                "params": {"threadId": "th_child", "turn": {"status": "completed"}},
            }
        ),
        state,
    )
    assert dropped == []
    assert state.done is False
    child_item = parse_codex_line(
        json.dumps(
            {
                "method": "item/completed",
                "params": {
                    "threadId": "th_child",
                    "item": {"id": "f1", "type": "fileChange"},
                },
            }
        ),
        state,
    )
    assert child_item and child_item[0].type == "tool-result"


def test_pi_message_end_session_and_extension_note():
    state = TurnState()
    ended = parse_pi_line(
        json.dumps(
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "pi says"}],
                    "usage": {"input": 2, "output": 3},
                },
            }
        ),
        state,
    )
    assert ended[0].text == "pi says"
    assert state.input_tokens == 2 and state.output_tokens == 3
    session = parse_pi_line(
        json.dumps(
            {
                "type": "response",
                "command": "get_state",
                "success": True,
                "data": {"sessionId": "pi-1"},
            }
        ),
        state,
    )
    assert session[0].type == "session" and session[0].text == "pi-1"
    note = parse_pi_line(
        json.dumps({"type": "extension_error", "error": "plugin broke"}),
        state,
    )
    assert note[0].type == "note" and state.failed == ""
    result = parse_pi_line(
        json.dumps(
            {
                "type": "tool_execution_end",
                "toolCallId": "call-1",
                "isError": True,
                "result": {"content": [{"type": "text", "text": "denied"}]},
            }
        ),
        state,
    )
    assert result[0].text == "error: denied"


def test_junie_and_copilot_map_thoughts_plans_and_session_ids():
    state = TurnState()
    thought = parse_acp_line(
        json.dumps(
            {
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "agent_thought_chunk",
                        "content": {"text": "thinking"},
                    }
                },
            }
        ),
        state,
        3,
    )
    assert thought[0].type == "reasoning" and thought[0].text == "thinking"
    plan = parse_acp_line(
        json.dumps(
            {
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "plan",
                        "entries": [{"content": "ship", "status": "pending"}],
                    }
                },
            }
        ),
        state,
        3,
    )
    assert plan[0].type == "plan"
    tool = parse_acp_line(
        json.dumps(
            {
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "c1",
                        "kind": "execute",
                    }
                },
            }
        ),
        state,
        3,
    )
    assert tool[0].name == "execute"
    opened = parse_acp_line(
        json.dumps({"id": 2, "result": {"sessionId": "ses_junie"}}),
        state,
        3,
    )
    assert opened[0].type == "session" and opened[0].text == "ses_junie"
