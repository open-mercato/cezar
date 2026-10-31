"""Pieces of a turn the TypeScript runners attach beside the prompt.

Queued messages are composed into the prompt and never written back onto
`task`. Images are Claude content blocks. Private MCP servers go to a
`0600` file (`--mcp-config`) or Codex `config` overrides. The inactivity
wording matches `inactivityTimeoutMessage`.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from app.engine.model import Run

HARD_CEILING_FACTOR = 8
type Servers = tuple[dict[str, object], ...] | list[dict[str, object]]
type Images = tuple[dict[str, str], ...] | list[dict[str, str]]


def prompt_task(run: Run) -> str:
    parts = [run.task]
    for message in run.queued_messages:
        text = message.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    joined = "\n\n".join(part.strip() for part in parts if part.strip())
    if joined:
        return joined
    if run.images:
        return "(see attachments)"
    return run.task


def inactivity_message(agent: str, limit_ms: int, *, ceiling: bool = False) -> str:
    window = limit_ms * HARD_CEILING_FACTOR if ceiling else limit_ms
    span = _span(window)
    if ceiling:
        return f"{agent} timed out after {span} and was killed — Continue picks the task up again"
    return (
        f"{agent} timed out after {span} without any output and was killed — "
        "Continue picks the task up again"
    )


def claude_content(prompt: str, images: Images) -> list[dict[str, object]]:
    blocks: list[dict[str, object]] = []
    for image in images:
        data = image.get("data", "")
        if not data:
            continue
        media = image.get("mediaType") or image.get("media_type") or "image/png"
        blocks.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": media, "data": data},
            }
        )
    blocks.append({"type": "text", "text": prompt})
    return blocks


def write_mcp_config(servers: Servers) -> Path | None:
    """`--mcp-config` file. Argv is world-readable, so tokens stay off it."""
    if not servers:
        return None
    directory = Path(tempfile.mkdtemp(prefix="cez-mcp-"))
    path = directory / "mcp.json"
    mcp_servers: dict[str, object] = {}
    for server in servers:
        name = server.get("name")
        if not isinstance(name, str) or not name:
            continue
        command = server.get("command")
        if isinstance(command, str) and command:
            entry: dict[str, object] = {
                "type": "stdio",
                "command": command,
                "args": server.get("args") if isinstance(server.get("args"), list) else [],
            }
            env = server.get("env")
            if isinstance(env, dict) and env:
                entry["env"] = env
            mcp_servers[name] = entry
            continue
        url = server.get("url")
        if isinstance(url, str) and url:
            remote: dict[str, object] = {"type": server.get("transport") or "http", "url": url}
            headers = server.get("headers")
            if isinstance(headers, dict) and headers:
                remote["headers"] = headers
            mcp_servers[name] = remote
    if not mcp_servers:
        return None
    path.write_text(json.dumps({"mcpServers": mcp_servers}), encoding="utf-8")
    path.chmod(0o600)
    return path


def mcp_allow_rules(servers: Servers) -> list[str]:
    rules: list[str] = []
    for server in servers:
        name = server.get("name")
        if isinstance(name, str) and name:
            rules.append(f"mcp__{name}")
    return rules


def codex_mcp_config(servers: Servers) -> dict[str, object]:
    config: dict[str, object] = {}
    for server in servers:
        name = server.get("name")
        command = server.get("command")
        if not isinstance(name, str) or not name or not isinstance(command, str) or not command:
            continue
        entry: dict[str, object] = {
            "command": command,
            "args": server.get("args") if isinstance(server.get("args"), list) else [],
        }
        env = server.get("env")
        if isinstance(env, dict) and env:
            entry["env"] = env
        config[f"mcp_servers.{name}"] = entry
    return config


def load_project_mcp(root: Path) -> tuple[dict[str, object], ...]:
    path = root / ".ai" / "cezar" / "mcp.json"
    if not path.is_file():
        return ()
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return ()
    if not isinstance(loaded, dict):
        return ()
    servers = loaded.get("mcpServers")
    if not isinstance(servers, dict):
        return ()
    out: list[dict[str, object]] = []
    for name, spec in servers.items():
        if not isinstance(name, str) or not isinstance(spec, dict):
            continue
        entry: dict[str, object] = {"name": name}
        entry.update(spec)
        out.append(entry)
    return tuple(out)


def v2_snapshots(event_type: str, text: str, name: str, step_id: str) -> list[tuple[str, str]]:
    """Persisted v2 snapshots. `item.delta` stays live-only and is not here."""
    if event_type == "text" and text:
        item = {"id": "message", "type": "message", "text": text}
        return [("item.completed", _dump({"type": "item.completed", "item": item}))]
    if event_type == "tool-call":
        item = {"id": text or name, "type": "tool", "title": name or text, "status": "running"}
        return [("item.started", _dump({"type": "item.started", "item": item}))]
    if event_type == "tool-result":
        item = {"id": name or "tool", "type": "tool", "status": "completed", "output": text}
        return [("item.completed", _dump({"type": "item.completed", "item": item}))]
    if event_type == "turn-end":
        body = {"type": "turn.completed", "turnId": step_id or "turn", "stopReason": "end_turn"}
        return [("turn.completed", _dump(body))]
    return []


def _dump(body: object) -> str:
    return json.dumps(body, separators=(",", ":"))


def _span(ms: int) -> str:
    if ms < 60_000:
        return f"{round(ms / 1000)}s"
    if ms < 2 * 3_600_000:
        minutes = round((ms / 60_000) * 10) / 10
        return f"{minutes}m"
    hours = round((ms / 3_600_000) * 10) / 10
    return f"{hours}h"
