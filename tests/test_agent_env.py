"""Child environment, transcript redaction, and account homes."""

import json
from pathlib import Path

import pytest
from litewriter import LiteWriter
from stario import Relay
from stario.testing import TestClient
from tests.conftest import init_repo
from tests.test_engine import config_for

from app.config import Config, agent_accounts_enabled
from app.engine.agent_env import (
    REDACTED,
    build_child_env,
    collect_secret_values,
    profile_env,
    redact_secrets,
    scrub,
)
from app.engine.agents import AgentSpec
from app.engine.engine import Engine
from app.engine.runners.protocol import ProtocolRunner
from app.integrations.accounts import add_account, list_accounts, profile_home_for
from app.main import bootstrap
from app.store.db import list_events, schema


def test_the_default_child_env_drops_secrets_and_keeps_path():
    source = {
        "PATH": "/usr/bin",
        "HOME": "/home/ada",
        "AWS_SECRET_ACCESS_KEY": "w" * 20,
        "NODE_AUTH_TOKEN": "n" * 20,
        "GITHUB_TOKEN": "g" * 20,
        "MY_TOOLCHAIN_DIR": "/opt/tc",
        "CEZ_DRY_RUN": "1",
    }
    env = build_child_env("claude", source=source)
    assert env["PATH"] == "/usr/bin"
    assert "AWS_SECRET_ACCESS_KEY" not in env
    assert "NODE_AUTH_TOKEN" not in env
    assert env["GITHUB_TOKEN"] == "g" * 20
    assert "MY_TOOLCHAIN_DIR" not in env
    assert env["CEZ_DRY_RUN"] == "1"

    forwarded = build_child_env(
        "claude", source={**source, "CEZ_ENV_PASSTHROUGH": "MY_TOOLCHAIN_DIR"}
    )
    assert forwarded["MY_TOOLCHAIN_DIR"] == "/opt/tc"
    assert "AWS_SECRET_ACCESS_KEY" not in forwarded

    for value in ("1", "true", "yes"):
        full = build_child_env("claude", source={**source, "CEZ_AGENT_ENV_FULL": value})
        assert full["AWS_SECRET_ACCESS_KEY"] == "w" * 20
    for value in ("0", "false", ""):
        hardened = build_child_env("claude", source={**source, "CEZ_AGENT_ENV_FULL": value})
        assert "AWS_SECRET_ACCESS_KEY" not in hardened


def test_profile_env_is_only_claude_and_codex():
    assert profile_env("claude", "/tmp/home") == {"CLAUDE_CONFIG_DIR": "/tmp/home"}
    assert profile_env("codex", "/tmp/home") == {"CODEX_HOME": "/tmp/home"}
    assert profile_env("opencode", "/tmp/home") == {}
    assert profile_env("claude", "") == {}


def test_redaction_covers_token_shapes_and_can_be_turned_off():
    token = "sk-" + "a" * 24
    assert redact_secrets(f"use {token} please", []) == f"use {REDACTED} please"
    assert redact_secrets("task-scheduling-notes", []) == "task-scheduling-notes"
    short = {"POSTGRES_PASSWORD": "postgres", "GH_TOKEN": "ghp_" + "b" * 24}
    assert collect_secret_values(short) == ["ghp_" + "b" * 24]
    assert scrub(f"leak {token}", {**short, "CEZ_REDACT_SECRETS": "0"}) == f"leak {token}"
    host = {"CEZ_REDACT_SECRETS": "1", "GH_TOKEN": "ghp_" + "b" * 24}
    assert REDACTED in scrub(f"leak {token}", host)


def test_a_stored_event_is_scrubbed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CEZ_REDACT_SECRETS", "1")
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo)
    token = "ghp_" + "c" * 24

    async def run() -> str:
        async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
            engine = Engine(db, Relay(), cfg)
            await engine._note("run-1", "text", f"token {token}")
            return list_events(db, "run-1")[0].text

    import asyncio

    stored = asyncio.run(run())
    assert token not in stored
    assert REDACTED in stored


async def test_the_spawned_agent_does_not_see_a_host_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "w" * 24)
    monkeypatch.setenv("MY_TOOLCHAIN_DIR", "/opt/tc")
    monkeypatch.setenv("CEZ_ENV_PASSTHROUGH", "MY_TOOLCHAIN_DIR")
    monkeypatch.delenv("CEZ_AGENT_ENV_FULL", raising=False)
    binary = tmp_path / "claude"
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "Path(sys.argv[0] + '.env').write_text(json.dumps(dict(os.environ)))\n"
        "json.loads(sys.stdin.readline())\n"
        "print(json.dumps({'type':'result','result':'ok',"
        "'usage':{'input_tokens':1,'output_tokens':1}}), flush=True)\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    spec = AgentSpec(
        user_prompt="ship it",
        system_prompt="",
        cwd=str(tmp_path),
        runner="claude",
        model="",
        cancel=__import__("asyncio").Event(),
        profile_home=str(tmp_path / "profile"),
    )
    events = [event async for event in ProtocolRunner("claude", str(binary)).stream(spec)]
    assert any(event.type == "turn-end" or event.text == "ok" for event in events)
    dumped = json.loads((tmp_path / "claude.env").read_text(encoding="utf-8"))
    assert "AWS_SECRET_ACCESS_KEY" not in dumped
    assert dumped["MY_TOOLCHAIN_DIR"] == "/opt/tc"
    assert dumped["CLAUDE_CONFIG_DIR"] == str(tmp_path / "profile")


def test_hosted_accounts_need_the_flag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo)
    monkeypatch.setenv("CEZ_REMOTE", "1")
    assert agent_accounts_enabled(cfg) is False
    assert add_account(cfg, "Work", "claude") is not None
    monkeypatch.setenv("CEZ_REMOTE_AGENT_ACCOUNTS", "1")
    assert agent_accounts_enabled(cfg) is True
    assert add_account(cfg, "Work", "claude") is None
    row = list_accounts(cfg)[0]
    assert row["runner"] == "claude"
    assert row["home"]
    assert Path(row["home"]).is_dir()
    assert profile_home_for(cfg, row["id"], "claude") == row["home"]
    assert profile_home_for(cfg, row["id"], "opencode") == ""
    assert add_account(cfg, "Other", "opencode") is None
    other = [item for item in list_accounts(cfg) if item["runner"] == "opencode"][0]
    assert other["home"] == ""


async def test_a_turn_is_spawned_in_the_account_home(tmp_path: Path):
    from app.engine.agents import AgentEvent
    from app.store.db import get_project

    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo)
    assert add_account(cfg, "Work", "claude") is None
    account = list_accounts(cfg)[0]

    class Spy:
        def __init__(self) -> None:
            self.home = ""

        async def stream(self, spec: AgentSpec):
            self.home = spec.profile_home
            yield AgentEvent("text", "CEZ:DONE")
            yield AgentEvent("turn-end")

    spy = Spy()
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        engine.agent = spy
        await engine.startup()
        project = get_project(db, engine.boot_project_id)
        assert project is not None
        run, reason = engine.plan_run(
            project=project, task="use the work login", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.account_id = account["id"]
        await engine.enqueue(run)
        await engine.execute(run.id)
    assert spy.home == account["home"]


async def test_a_run_names_its_account(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("CEZ_DRY_RUN", "1")
    async with TestClient(
        bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321"
    ) as client:
        saved = await client.post(
            "/settings/accounts",
            json={"name": "Work", "runner": "claude", "tab": "t1"},
            follow_redirects=False,
        )
        assert saved.status_code == 303
        data = Config.from_env()
        account = list_accounts(data)[0]
        created = await client.post(
            "/api/v1/runs",
            json={
                "task": "use the work login",
                "workflow": "quick-task",
                "accountId": account["id"],
            },
        )
        assert created.status_code == 201
        assert created.json()["accountId"] == account["id"]
        missing = await client.post(
            "/api/v1/runs",
            json={"task": "missing", "workflow": "quick-task", "accountId": "nope"},
        )
        assert missing.status_code == 400
