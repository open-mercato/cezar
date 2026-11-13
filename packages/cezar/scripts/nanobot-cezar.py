#!/usr/bin/env python3
"""Cezar JSONL adapter for Nanobot's native AgentLoop API (nanobot-ai 0.4.1).

Run with the Python environment that provides nanobot-ai. Stdout is exclusively
protocol JSON; provider credentials and MCP configuration stay in memory.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import sys
from uuid import UUID, uuid4

BRIDGE_VERSION = "1"
MAX_LINE_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
_PROTOCOL_STDOUT = sys.stdout


class BridgeError(Exception):
    """Safe-to-display protocol or configuration error (never a provider exception)."""


def emit(event: dict) -> None:
    _PROTOCOL_STDOUT.write(json.dumps(event, ensure_ascii=True) + "\n")
    _PROTOCOL_STDOUT.flush()


def load_native_config():
    from nanobot.config.loader import (
        get_config_path,
        load_config,
        resolve_config_env_vars,
    )

    path = Path(
        os.environ.get("CEZ_NANOBOT_CONFIG", str(get_config_path()))
    ).expanduser()
    if not path.is_file():
        raise BridgeError("Nanobot config is missing; configure Nanobot first")
    return resolve_config_env_vars(load_config(path), config_path=path)


def describe(config) -> dict:
    # IDs are native preset names, not provider/model guesses. No credential fields
    # or endpoints are serialized into discovery output.
    models = [
        {"id": name, "label": name, "description": preset.model}
        for name, preset in config.model_presets.items()
    ]
    if not models:
        raise BridgeError("Configure at least one named Nanobot model preset")
    return {
        "version": f"{BRIDGE_VERSION} (nanobot-ai {importlib.metadata.version('nanobot-ai')})",
        "ready": True,
        "models": models,
    }


def session_location(init: dict) -> tuple[str, Path, Path]:
    raw_id = init.get("sessionId") or str(uuid4())
    try:
        session_id = str(UUID(raw_id))
    except (ValueError, TypeError, AttributeError):
        raise BridgeError("sessionId must be a UUID") from None
    raw_cwd = init.get("cwd")
    if not isinstance(raw_cwd, str) or not Path(raw_cwd).is_absolute():
        raise BridgeError("cwd must be an absolute directory")
    cwd = Path(raw_cwd).resolve(strict=True)
    if not cwd.is_dir():
        raise BridgeError("cwd must be a directory")
    state_root = Path(
        os.environ.get(
            "CEZ_NANOBOT_STATE_DIR",
            str(
                Path(
                    os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))
                )
                / "cezar/nanobot"
            ),
        )
    ).expanduser()
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    state = state_root / session_id
    marker = state / "session.json"
    if init.get("resume"):
        if not marker.is_file():
            raise BridgeError("Nanobot session does not exist; cannot resume")
        saved = json.loads(marker.read_text())
        if saved.get("cwd") != str(cwd):
            raise BridgeError("Nanobot session belongs to a different worktree")
    else:
        try:
            state.mkdir(mode=0o700)
        except FileExistsError:
            raise BridgeError("Nanobot session already exists; use resume") from None
        marker.write_text(json.dumps({"cwd": str(cwd)}))
        marker.chmod(0o600)
    return session_id, cwd, state


def configure(config, init: dict, cwd: Path, state: Path):
    from nanobot.config.schema import MCPServerConfig

    allowed = init.get("allowedTools")
    if allowed is not None and set(allowed) != {
        "Read",
        "Edit",
        "Write",
        "Grep",
        "Glob",
        "Bash",
    }:
        raise BridgeError(
            "Nanobot supports full-access tasks only; tool restrictions are unsupported"
        )
    if init.get("enforceReadOnly") or init.get("bashAllowlist"):
        raise BridgeError(
            "Nanobot does not enforce read-only or shell-prefix restrictions"
        )
    # Cezar always supplies runs/attachments/artifacts as extra grants. A full
    # native workspace already permits them; they are not a confinement request.
    # Restricted Nanobot exposes one allowed_root, not an additional-root API:
    # preserve that boundary and fail if a required grant lies outside it.
    for directory in init.get("additionalDirectories") or []:
        if not isinstance(directory, str) or not Path(directory).is_absolute():
            raise BridgeError("Additional directories must be absolute paths")
        if config.tools.restrict_to_workspace and not Path(
            directory
        ).resolve().is_relative_to(cwd.resolve()):
            raise BridgeError(
                "Restricted Nanobot cannot grant directories outside its workspace"
            )
    if init.get("reasoningEffort"):
        raise BridgeError("Select reasoning effort through a native Nanobot preset")
    model = init.get("model") or config.agents.defaults.model_preset
    if model not in config.model_presets:
        raise BridgeError("Unknown Nanobot model preset; choose a discovered model")
    config = config.model_copy(deep=True)
    config.agents.defaults.workspace = str(cwd)
    config.agents.defaults.model_preset = model
    config.agents.defaults.unified_session = False
    config.bind_source_path(state / "config.json")
    requested = set()
    for server in init.get("mcpServers") or []:
        name = server["name"]
        transport = server["transport"]
        if transport not in ("stdio", "http", "sse"):
            raise BridgeError("Unsupported MCP transport")
        config.tools.mcp_servers[name] = MCPServerConfig(
            type={"http": "streamableHttp", "stdio": "stdio", "sse": "sse"}[transport],
            command=server.get("command") or "",
            args=server.get("args") or [],
            env=server.get("env") or {},
            url=server.get("url") or "",
            headers=server.get("headers") or {},
            cwd=str(cwd),
        )
        requested.add(name)
    return config, requested


def map_tool_events(events: list[dict]) -> list[dict]:
    output = []
    for item in events:
        if not isinstance(item, dict) or not item.get("call_id"):
            continue
        if item.get("phase") == "start" and isinstance(item.get("name"), str):
            output.append(
                {
                    "type": "tool-call",
                    "id": str(item["call_id"]),
                    "tool": item["name"],
                    "input": item.get("arguments", {}),
                }
            )
        elif item.get("phase") in ("end", "error"):
            failed = item["phase"] == "error"
            value = item.get("error" if failed else "result")
            result = (
                value
                if isinstance(value, str)
                else json.dumps(value, ensure_ascii=True)
            )
            output.append(
                {
                    "type": "tool-result",
                    "id": str(item["call_id"]),
                    "result": result,
                    "isError": failed,
                }
            )
    return output


def save_images(images: list[dict], state: Path) -> list[str]:
    paths = []
    for image in images:
        extension = IMAGE_EXTENSIONS.get(image.get("mediaType"))
        if not extension:
            raise BridgeError("Unsupported image format")
        try:
            data = base64.b64decode(image["data"], validate=True)
        except (ValueError, KeyError, TypeError):
            raise BridgeError("Invalid base64 image") from None
        if len(data) > MAX_IMAGE_BYTES:
            raise BridgeError("Image exceeds 10 MiB")
        media = state / "media"
        media.mkdir(exist_ok=True, mode=0o700)
        path = media / (str(uuid4()) + extension)
        path.write_bytes(data)
        path.chmod(0o600)
        paths.append(str(path))
    return paths


class NativeSession:
    def __init__(self, init: dict):
        from nanobot.agent.hook import AgentHook
        from nanobot.agent.hooks import create_file_edit_activity_hook
        from nanobot.agent.loop import AgentLoop
        from nanobot.agent.tools.mcp import MCPProvider
        from nanobot.agent.tools.registry import ToolRegistry
        from nanobot.config.home import set_home_path
        from nanobot.config.loader import set_config_path
        from nanobot.data_access import data_access, profile_data_paths
        from nanobot.session.manager import SessionManager

        config = load_native_config()
        self.session_id, cwd, self.state = session_location(init)
        config, self.requested_mcp = configure(config, init, cwd, self.state)
        self.model = config.agents.defaults.model_preset
        self.cwd = cwd
        # Isolate auxiliary native stores as well as conversation history. The
        # synthetic config path is NEVER written: it must not persist secrets.
        set_home_path(self.state)
        set_config_path(self.state / "config.json")
        self.lease = data_access(
            profile_data_paths(
                home=self.state,
                data_dir=self.state,
                config=self.state / "config.json",
                workspace=cwd,
            )
        )
        self.lease.__enter__()
        self.agent = None
        self.mcp = None
        self.usage = None
        self.tokens = 0
        self.input_tokens = 0
        self.output_tokens = 0
        owner = self

        class UsageHook(AgentHook):
            async def after_run(self, context):
                owner.usage = context.usage
                if context.error:
                    emit(
                        {
                            "type": "error",
                            "message": "Nanobot reported an unsuccessful run",
                        }
                    )

        self.usage_hook = UsageHook()
        try:
            tools = ToolRegistry()
            self.mcp = MCPProvider.from_config(
                config,
                tools,
                server_loader=lambda: (config.tools.mcp_servers, config.network),
            )
            sessions = SessionManager(cwd, sessions_root=self.state / "sessions")
            self.key = "cezar:" + self.session_id
            if init.get("resume") and sessions.get_existing(self.key) is None:
                raise BridgeError("Nanobot conversation is missing; cannot resume")
            self.agent = AgentLoop.from_config(
                config,
                tool_registry=tools,
                session_manager=sessions,
                hook_factories=[create_file_edit_activity_hook],
            )
        except BaseException:
            self.lease.__exit__(*sys.exc_info())
            raise

    async def start(self):
        await self.mcp.connect()
        if self.requested_mcp - self.mcp.connected_server_names:
            raise BridgeError("A requested project MCP server failed to connect")
        # A resumed conversation can carry its own preset. Apply the explicit
        # Cezar selection through Nanobot's native session API, never silently
        # resume the previous model instead.
        await self.agent.set_session_model_preset(self.key, self.model)
        emit({"type": "ready", "sessionId": self.session_id, "cwd": str(self.cwd)})

    async def prompt(self, command: dict):
        text = command.get("text")
        if not isinstance(text, str):
            raise BridgeError("Prompt text must be a string")
        emit({"type": "turn-start"})
        media = save_images(command.get("images") or [], self.state)
        self.usage = None

        async def progress(
            content,
            *,
            tool_events=None,
            file_edit_events=None,
            reasoning=False,
            tool_hint=False,
            **kwargs,
        ):
            # Native non-streaming progress contains complete pre-tool assistant
            # messages. The final answer is returned separately by process_direct.
            if content and not tool_hint:
                emit({"type": "reasoning" if reasoning else "text", "text": content})
            for event in map_tool_events(tool_events or []):
                emit(event)
            for event in file_edit_events or []:
                emit({"type": "file-edit", "event": event})

        async def admitted(runtime):
            emit(
                {
                    "type": "model",
                    "model": runtime.model,
                    "preset": runtime.model_preset,
                    "reasoningEffort": runtime.generation.reasoning_effort,
                }
            )

        result = await self.agent.process_direct(
            text,
            session_key=self.key,
            channel="cli",
            chat_id=self.session_id,
            media=media,
            on_progress=progress,
            hooks=[self.usage_hook],
            on_runtime_admitted=admitted,
        )
        if result is not None and result.content:
            emit({"type": "text", "text": result.content})
        if self.usage is not None:
            self.tokens += self.usage.total_tokens
            self.input_tokens += self.usage.input_tokens
            self.output_tokens += self.usage.output_tokens
            emit(
                {
                    "type": "usage",
                    "tokens": self.tokens,
                    "input": self.input_tokens,
                    "output": self.output_tokens,
                }
            )
            return {
                "tokens": self.usage.total_tokens,
                "input": self.usage.input_tokens,
                "output": self.usage.output_tokens,
            }
        return {}

    async def close(self):
        try:
            if self.agent:
                await self.agent.aclose()
        finally:
            try:
                if self.mcp:
                    await self.mcp.aclose()
            finally:
                self.lease.__exit__(None, None, None)


async def serve(reader, session_factory=NativeSession):
    session = None
    active = None
    pending = asyncio.Queue(maxsize=64)

    async def worker():
        while True:
            command = await pending.get()
            usage = {}
            try:
                usage = await session.prompt(command) or {}
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Provider errors can contain credentials, URLs and request bodies.
                # Report only controlled bridge messages, never repr/str(exc).
                emit(
                    {
                        "type": "error",
                        "message": (
                            str(exc)
                            if isinstance(exc, BridgeError)
                            else f"Nanobot turn failed ({type(exc).__name__})"
                        ),
                    }
                )
            finally:
                pending.task_done()
            emit({"type": "turn-end", **usage})

    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            if len(line) > MAX_LINE_BYTES:
                raise BridgeError("Protocol command is too large")
            try:
                command = json.loads(line)
            except (ValueError, UnicodeError):
                raise BridgeError("Invalid JSON command") from None
            if not isinstance(command, dict):
                raise BridgeError("Command must be an object")
            kind = command.get("type")
            if kind == "init" and session is None:
                session = session_factory(command)
                await session.start()
                active = asyncio.create_task(worker())
            elif kind == "prompt" and session is not None:
                try:
                    pending.put_nowait(command)
                except asyncio.QueueFull:
                    raise BridgeError("Too many queued follow-up messages") from None
            elif kind in ("abort", "end"):
                if kind == "end":
                    await pending.join()
                break
            else:
                raise BridgeError("Expected init, prompt, abort or end")
    finally:
        if active:
            active.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await active
        if session:
            await session.close()


async def rpc():
    reader = asyncio.StreamReader(limit=MAX_LINE_BYTES)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer
    )
    task = asyncio.current_task()
    for signum in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(signum, task.cancel)
    try:
        await serve(reader)
    except asyncio.CancelledError:
        pass
    finally:
        transport.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    command = parser.add_mutually_exclusive_group(required=True)
    command.add_argument("--describe", action="store_true")
    command.add_argument("--version", action="store_true")
    command.add_argument("--rpc", action="store_true")
    args = parser.parse_args()
    # Native libraries occasionally print. Keep protocol output on the saved
    # stream and discard unsolicited prints/logs (which may contain private data).
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink):
        try:
            from loguru import logger

            logger.remove()
            if args.version:
                _PROTOCOL_STDOUT.write(f"nanobot-cezar {BRIDGE_VERSION}\n")
            elif args.describe:
                emit(describe(load_native_config()))
            else:
                asyncio.run(rpc())
        except Exception as exc:
            message = (
                str(exc)
                if isinstance(exc, BridgeError)
                else f"Nanobot bridge failed ({type(exc).__name__})"
            )
            emit({"type": "error", "message": message})
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
