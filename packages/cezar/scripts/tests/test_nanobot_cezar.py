"""Offline bridge tests. Native integration tests use Nanobot's own Python, no inference."""

import asyncio
import base64
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

spec = importlib.util.spec_from_file_location(
    "bridge", Path(__file__).resolve().parents[1] / "nanobot-cezar.py"
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def test_tool_payload_preserves_ids_and_failure(self):
        self.assertEqual(
            bridge.map_tool_events(
                [
                    {
                        "phase": "start",
                        "call_id": "real-id",
                        "name": "read_file",
                        "arguments": {"path": "x"},
                    },
                    {"phase": "error", "call_id": "real-id", "error": "denied"},
                    {},
                    None,
                ]
            ),
            [
                {
                    "type": "tool-call",
                    "id": "real-id",
                    "tool": "read_file",
                    "input": {"path": "x"},
                },
                {
                    "type": "tool-result",
                    "id": "real-id",
                    "result": "denied",
                    "isError": True,
                },
            ],
        )

    def test_resume_is_bound_to_workspace_and_existing_state(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(
            os.environ, {"CEZ_NANOBOT_STATE_DIR": root + "/state"}
        ):
            init = {"cwd": root, "sessionId": str(uuid4())}
            sid, cwd, state = bridge.session_location(init)
            self.assertEqual(
                bridge.session_location({**init, "resume": True}), (sid, cwd, state)
            )
            with self.assertRaisesRegex(bridge.BridgeError, "already exists"):
                bridge.session_location(init)
            with self.assertRaisesRegex(bridge.BridgeError, "does not exist"):
                bridge.session_location(
                    {**init, "sessionId": str(uuid4()), "resume": True}
                )
            with self.assertRaisesRegex(bridge.BridgeError, "different worktree"):
                bridge.session_location({**init, "cwd": str(state), "resume": True})
            with self.assertRaisesRegex(bridge.BridgeError, "UUID"):
                bridge.session_location({**init, "sessionId": "../../escape"})

    def test_images_are_private_outside_checkout_and_reject_bad_input(self):
        with tempfile.TemporaryDirectory() as root:
            paths = bridge.save_images(
                [
                    {
                        "mediaType": "image/png",
                        "data": base64.b64encode(b"fake-png").decode(),
                    }
                ],
                Path(root),
            )
            self.assertEqual(Path(paths[0]).read_bytes(), b"fake-png")
            self.assertEqual(Path(paths[0]).stat().st_mode & 0o777, 0o600)
            with self.assertRaises(bridge.BridgeError):
                bridge.save_images([{"mediaType": "text/html", "data": ""}], Path(root))
            with self.assertRaises(bridge.BridgeError):
                bridge.save_images(
                    [{"mediaType": "image/png", "data": "!"}], Path(root)
                )


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_queued_followups_are_serial_and_end_drains(self):
        calls = []

        class Session:
            def __init__(self, command):
                calls.append("init")

            async def start(self):
                calls.append("ready")

            async def prompt(self, command):
                calls.append(command["text"])
                await asyncio.sleep(0)

            async def close(self):
                calls.append("closed")

        reader = asyncio.StreamReader()
        reader.feed_data(
            b'{"type":"init"}\n{"type":"prompt","text":"one"}\n{"type":"prompt","text":"two"}\n{"type":"end"}\n'
        )
        reader.feed_eof()
        events = []
        with patch.object(bridge, "emit", events.append):
            await bridge.serve(reader, Session)
        self.assertEqual(calls, ["init", "ready", "one", "two", "closed"])
        self.assertEqual(events, [{"type": "turn-end"}, {"type": "turn-end"}])

    async def test_abort_cancels_active_native_turn_and_closes(self):
        started, cancelled, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()

        class Session:
            def __init__(self, command):
                pass

            async def start(self):
                pass

            async def prompt(self, command):
                started.set()
                try:
                    await asyncio.Future()
                finally:
                    cancelled.set()

            async def close(self):
                closed.set()

        reader = asyncio.StreamReader()
        reader.feed_data(b'{"type":"init"}\n{"type":"prompt","text":"one"}\n')
        task = asyncio.create_task(bridge.serve(reader, Session))
        await started.wait()
        reader.feed_data(b'{"type":"abort"}\n')
        await task
        self.assertTrue(cancelled.is_set())
        self.assertTrue(closed.is_set())

    async def test_provider_exception_never_prints_secret_and_session_continues(self):
        class Session:
            def __init__(self, command):
                pass

            async def start(self):
                pass

            async def prompt(self, command):
                raise RuntimeError("Bearer secret")

            async def close(self):
                pass

        reader = asyncio.StreamReader()
        reader.feed_data(
            b'{"type":"init"}\n{"type":"prompt","text":"one"}\n{"type":"end"}\n'
        )
        events = []
        with patch.object(bridge, "emit", events.append):
            await bridge.serve(reader, Session)
        self.assertEqual(
            events,
            [
                {"type": "error", "message": "Nanobot turn failed (RuntimeError)"},
                {"type": "turn-end"},
            ],
        )


try:
    from nanobot.config.schema import Config, ModelPresetConfig
except ImportError:
    Config = None


@unittest.skipIf(
    Config is None, "Run with nanobot-ai Python to check native API compatibility"
)
class NativeTests(unittest.IsolatedAsyncioTestCase):
    def config(self):
        config = Config()
        config.model_presets = {
            "glm-local": ModelPresetConfig(model="glm-test", provider="vllm"),
            "qwen-local": ModelPresetConfig(
                model="qwen-test", provider="vllm", reasoning_effort="medium"
            ),
        }
        config.agents.defaults.model_preset = "glm-local"
        config.providers.vllm.api_base = "http://127.0.0.1:1/v1"
        config.providers.vllm.api_key = "offline-test"
        return config

    async def test_native_config_and_mcp_conversion_no_persisted_secret(self):
        with tempfile.TemporaryDirectory() as root:
            config, requested = bridge.configure(
                self.config(),
                {
                    "model": "qwen-local",
                    "mcpServers": [
                        {
                            "name": "gitlab",
                            "transport": "http",
                            "url": "https://example.test/mcp",
                            "headers": {"Authorization": "private"},
                        }
                    ],
                },
                Path(root),
                Path(root) / "state",
            )
            self.assertEqual(config.resolve_preset().model, "qwen-test")
            self.assertEqual(config.resolve_preset().reasoning_effort, "medium")
            self.assertEqual(config.tools.mcp_servers["gitlab"].type, "streamableHttp")
            self.assertEqual(requested, {"gitlab"})
            self.assertEqual(list(Path(root).iterdir()), [])
            for init in [
                {"model": "missing"},
                {"allowedTools": ["Read"]},
                {"enforceReadOnly": True},
            ]:
                with self.assertRaises(bridge.BridgeError):
                    bridge.configure(self.config(), init, Path(root), Path(root))

    async def test_workflow_extra_directory_grants_preserve_native_confinement(self):
        with tempfile.TemporaryDirectory() as root:
            cwd = Path(root) / "worktree"
            # workflows/run.ts agentDirectories: runs, library, TMPDIR, tree, artifacts.
            directories = [
                str(Path(root) / name)
                for name in ("runs", "library", "tmp", "tree", "artifacts")
            ]
            init = {
                "allowedTools": ["Read", "Edit", "Write", "Grep", "Glob", "Bash"],
                "additionalDirectories": directories,
            }
            original = self.config()
            config, _ = bridge.configure(original, init, cwd, Path(root) / "state")
            self.assertFalse(config.tools.restrict_to_workspace)
            original.tools.restrict_to_workspace = True
            with self.assertRaisesRegex(bridge.BridgeError, "outside its workspace"):
                bridge.configure(original, init, cwd, Path(root) / "state")
            self.assertTrue(original.tools.restrict_to_workspace)
            inside, _ = bridge.configure(
                original,
                {**init, "additionalDirectories": [str(cwd / "artifacts")]},
                cwd,
                Path(root) / "state",
            )
            self.assertTrue(inside.tools.restrict_to_workspace)

    async def test_real_native_turn_tools_text_and_usage_without_inference(self):
        from nanobot.config.home import get_selected_home_path, set_home_path
        from nanobot.config.loader import get_config_path, set_config_path
        from nanobot.providers.base import LLMResponse, LLMUsage, ToolCallRequest
        from nanobot.providers.openai_compat_provider import OpenAICompatProvider

        previous_home, previous_config = get_selected_home_path(), get_config_path()
        count = 0
        try:
            with tempfile.TemporaryDirectory() as root, patch.dict(
                os.environ, {"CEZ_NANOBOT_STATE_DIR": root + "/state"}
            ), patch.object(bridge, "load_native_config", self.config):
                cwd = Path(root) / "repo"
                cwd.mkdir()

                async def offline_response(provider, **kwargs):
                    nonlocal count
                    count += 1
                    if count == 1:
                        return LLMResponse(
                            content="Writing test file",
                            tool_calls=[
                                ToolCallRequest(
                                    id="native-call",
                                    name="write_file",
                                    arguments={
                                        "path": str(cwd / "offline.txt"),
                                        "content": "verified\n",
                                    },
                                )
                            ],
                            usage=LLMUsage.reported(input_tokens=3, output_tokens=2),
                        )
                    return LLMResponse(
                        content="Complete",
                        usage=LLMUsage.reported(input_tokens=6, output_tokens=2),
                    )

                session = bridge.NativeSession(
                    {
                        "cwd": str(cwd),
                        "sessionId": str(uuid4()),
                        "model": "glm-local",
                        "allowedTools": [
                            "Read",
                            "Edit",
                            "Write",
                            "Grep",
                            "Glob",
                            "Bash",
                        ],
                        "additionalDirectories": [
                            str(Path(root) / name)
                            for name in ("runs", "library", "tmp", "tree", "artifacts")
                        ],
                    }
                )
                events = []
                try:
                    with patch.object(
                        OpenAICompatProvider, "chat", offline_response
                    ), patch.object(
                        OpenAICompatProvider, "chat_stream", offline_response
                    ), patch.object(
                        bridge, "emit", events.append
                    ):
                        await session.start()
                        usage = await session.prompt({"text": "Offline test"})
                    self.assertEqual(usage, {"tokens": 13, "input": 9, "output": 4})
                    self.assertEqual((cwd / "offline.txt").read_text(), "verified\n")
                    self.assertEqual(
                        [event["text"] for event in events if event["type"] == "text"],
                        ["Writing test file", "Complete"],
                    )
                    self.assertTrue(
                        any(
                            event["type"] == "tool-call"
                            and event["id"] == "native-call"
                            for event in events
                        )
                    )
                    self.assertTrue(
                        any(
                            event["type"] == "file-edit"
                            and event["event"]["phase"] == "end"
                            for event in events
                        )
                    )
                finally:
                    await session.close()
        finally:
            set_home_path(previous_home)
            set_config_path(previous_config)

    async def test_actual_agent_loop_constructor_and_persisted_resume_without_model_calls(
        self,
    ):
        from nanobot.config.home import get_selected_home_path, set_home_path
        from nanobot.config.loader import get_config_path, set_config_path
        from nanobot.providers.base import LLMUsage

        previous_home, previous_config = get_selected_home_path(), get_config_path()
        try:
            with tempfile.TemporaryDirectory() as root, patch.dict(
                os.environ, {"CEZ_NANOBOT_STATE_DIR": root + "/state"}
            ), patch.object(bridge, "load_native_config", self.config):
                cwd = Path(root) / "repo"
                cwd.mkdir()
                init = {
                    "cwd": str(cwd),
                    "sessionId": str(uuid4()),
                    "model": "qwen-local",
                }
                session = bridge.NativeSession(init)
                try:
                    events = []
                    with patch.object(bridge, "emit", events.append):
                        await session.start()
                    self.assertEqual(
                        events,
                        [
                            {
                                "type": "ready",
                                "sessionId": init["sessionId"],
                                "cwd": str(cwd),
                            }
                        ],
                    )
                    self.assertEqual(session.agent.model, "qwen-test")

                    async def fake_direct(text, **kwargs):
                        await kwargs["on_runtime_admitted"](
                            SimpleNamespace(
                                model="qwen-test",
                                model_preset="qwen-local",
                                generation=SimpleNamespace(reasoning_effort="medium"),
                            )
                        )
                        await kwargs["on_progress"]("I will read the file")
                        await kwargs["hooks"][0].after_run(
                            SimpleNamespace(
                                usage=LLMUsage.reported(
                                    input_tokens=3, output_tokens=2
                                ),
                                error=None,
                            )
                        )
                        return SimpleNamespace(content="Finished")

                    with patch.object(
                        session.agent, "process_direct", fake_direct
                    ), patch.object(bridge, "emit", events.append):
                        self.assertEqual(
                            await session.prompt({"text": "offline"}),
                            {"tokens": 5, "input": 3, "output": 2},
                        )
                        await session.prompt({"text": "second"})
                    self.assertIn(
                        {
                            "type": "model",
                            "model": "qwen-test",
                            "preset": "qwen-local",
                            "reasoningEffort": "medium",
                        },
                        events,
                    )
                    self.assertEqual(
                        [event["text"] for event in events if event["type"] == "text"],
                        [
                            "I will read the file",
                            "Finished",
                            "I will read the file",
                            "Finished",
                        ],
                    )
                    self.assertEqual(
                        [
                            event["tokens"]
                            for event in events
                            if event["type"] == "usage"
                        ],
                        [5, 10],
                    )
                    saved = await session.agent.sessions.state.get(session.key)
                    saved.add_message("user", "saved")
                    await session.agent.sessions.state.finish_turn(saved)
                finally:
                    await session.close()
                resumed = bridge.NativeSession(
                    {**init, "resume": True, "model": "glm-local"}
                )
                try:
                    with patch.object(bridge, "emit"):
                        await resumed.start()
                    self.assertEqual(
                        resumed.agent.sessions.get_existing(resumed.key).metadata[
                            "_nanobot_model_preset"
                        ],
                        "glm-local",
                    )
                    self.assertEqual(
                        resumed.agent.sessions.get_existing(resumed.key).messages[0][
                            "content"
                        ],
                        "saved",
                    )
                finally:
                    await resumed.close()
                self.assertFalse((session.state / "config.json").exists())
        finally:
            set_home_path(previous_home)
            set_config_path(previous_config)


if __name__ == "__main__":
    unittest.main()
