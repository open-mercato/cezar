"""Stream B route families: the HTTP commands and the documents they store."""

import asyncio
import json
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from litewriter import LiteWriter
from stario.testing import TestClient

from app.config import Config
from app.main import bootstrap
from app.store.db import get_run, list_events, schema


async def _until(client, run_id: str, statuses: set[str]) -> dict:
    last: dict = {}
    for _ in range(80):
        last = (await client.get(f"/api/v1/runs/{run_id}")).json()
        if last.get("status") in statuses:
            return last
        await asyncio.sleep(0.05)
    return last


async def test_health_reports_disk_flags_versions_and_forge(client, repo: Path, monkeypatch):
    health = (await client.get("/api/v1/health")).json()
    assert health["disk"]["level"] in ("ok", "low", "critical")
    assert health["disk"]["freeBytes"] >= 0
    assert health["capabilities"]["terminal"] is True
    assert health["capabilities"]["designMode"] is True
    assert health["capabilities"]["webhooks"] is False
    for value, expected in (("1", True), ("true", False), ("0", False)):
        monkeypatch.setenv("CEZ_WEBHOOKS", value)
        webhook_health = (await client.get("/api/v1/health")).json()
        assert webhook_health["capabilities"]["webhooks"] is expected, value
    monkeypatch.delenv("CEZ_WEBHOOKS")
    git = next(row for row in health["checks"] if row["name"] == "git")
    assert git["available"] is True
    assert git["version"]
    assert health["forge"] is None
    monkeypatch.setenv("CEZ_INSTANCE_ID", "box-1")
    monkeypatch.setenv("CEZ_TERMINAL", "0")
    flagged = (await client.get("/api/v1/health")).json()
    assert flagged["instanceId"] == "box-1"
    assert flagged["capabilities"]["terminal"] is False
    subprocess_ok = subprocess.run(
        ["git", "remote", "add", "origin", "https://github.com/acme/demo.git"],
        cwd=repo,
        check=False,
        capture_output=True,
    )
    assert subprocess_ok.returncode == 0
    forged = (await client.get("/api/v1/health")).json()
    assert forged["forge"] == {"kind": "github"}


async def test_static_icon_and_asset(client):
    icon = await client.get("/icon.svg")
    assert icon.status_code == 200
    assert "<svg" in icon.text
    asset = await client.get("/assets/mark.txt")
    assert asset.status_code == 200
    assert asset.text.strip() == "cezar-asset"
    missing = await client.get("/assets/missing.txt")
    assert missing.status_code == 404


async def test_directory_browse_route(repo: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    root = tmp_path / "browse"
    (root / "child").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "escape").symlink_to(outside, target_is_directory=True)
    monkeypatch.setenv("CEZ_BROWSE_ROOT", str(root))
    async with TestClient(
        bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321"
    ) as browsing:
        listed = await browsing.get("/api/v1/fs/browse")
        assert listed.status_code == 200
        names = [item["name"] for item in listed.json()["dirs"]]
        assert "child" in names
        assert "escape" not in names
        denied = await browsing.get("/api/v1/fs/browse", params={"path": str(outside)})
        assert denied.status_code == 400


async def test_agent_config_version_and_hosted_write(client, repo: Path, monkeypatch):
    claude_home = repo / "claude-home"
    claude_home.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude_home))
    missing = await client.get("/api/v1/agent-config/nope")
    assert missing.status_code == 404
    current = await client.get("/api/v1/agent-config/project.agents")
    assert current.status_code == 200
    assert current.json()["version"] is None
    saved = await client.put(
        "/api/v1/agent-config/project.agents",
        json={"content": "# hello\n", "version": None},
    )
    assert saved.status_code == 200
    assert (repo / "AGENTS.md").read_text(encoding="utf-8") == "# hello\n"
    stale = await client.put(
        "/api/v1/agent-config/project.agents",
        json={"content": "# other\n", "version": "deadbeef"},
    )
    assert stale.status_code == 409
    listing = (await client.get("/api/v1/agent-config")).json()
    assert listing["editable"] is True
    assert listing["userMcp"]["servers"] == []
    assert listing["userMcp"]["readable"] is True
    (claude_home / ".claude.json").write_text(
        '{"mcpServers": {"docs": {"command": "echo"}}}\n', encoding="utf-8"
    )
    named = (await client.get("/api/v1/agent-config")).json()
    assert named["userMcp"]["servers"] == ["docs"]
    ids = {row["id"] for row in listing["files"]}
    assert "project.agents" in ids
    assert "claude.project.settings" in ids
    assert "claude.user.settings" in ids
    project_settings = next(
        row for row in listing["files"] if row["id"] == "claude.project.settings"
    )
    assert "Overrides user settings" in project_settings["precedence"]
    home = await client.put(
        "/api/v1/agent-config/claude.user.settings",
        json={"content": "{}\n", "version": None},
    )
    assert home.status_code == 409
    monkeypatch.setenv("CEZ_REMOTE", "1")
    refused = await client.put(
        "/api/v1/agent-config/project.agents",
        json={"content": "# hosted\n", "version": saved.json()["version"]},
    )
    assert refused.status_code == 409
    assert "hosted" in refused.json()["error"]
    assert (await client.get("/api/v1/agent-config")).json()["userMcp"] is None
    hidden = await client.get("/api/v1/agent-config/claude.user.settings")
    assert hidden.status_code == 409


async def test_todos_follow_the_inbox_file(client, repo: Path, monkeypatch):
    monkeypatch.setenv("CEZ_FOLLOWUPS", "0")
    assert (await client.get("/api/v1/todos")).json() == []
    monkeypatch.setenv("CEZ_FOLLOWUPS", "1")
    path = repo / ".ai" / "cezar" / "todos.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            [
                {"id": "todo-1", "summary": "ship the note"},
                {"summary": ""},
                "nope",
            ]
        ),
        encoding="utf-8",
    )
    listed = (await client.get("/api/v1/todos")).json()
    assert [row["id"] for row in listed] == ["todo-1"]
    removed = await client.delete("/api/v1/todos/missing")
    assert removed.status_code == 404
    started = await client.post("/api/v1/todos/todo-1/start", json={})
    assert started.status_code == 201
    assert (
        json.loads(path.read_text(encoding="utf-8"))[0]["startedTaskId"]
        == started.json()["run"]["id"]
    )
    again = await client.post("/api/v1/todos/todo-1/start", json={})
    assert again.status_code == 409
    monkeypatch.delenv("CEZ_FOLLOWUPS", raising=False)
    blocked = await client.delete("/api/v1/todos/todo-1")
    assert blocked.status_code == 409


async def test_automations_json_log_and_check(client, monkeypatch: pytest.MonkeyPatch):
    created = await client.post(
        "/api/v1/automations",
        json={
            "name": "nightly",
            "task": "tidy the notes",
            "everyMinutes": 15,
            "workflow": "quick-task",
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["enabled"] is False
    assert body["revision"] == 1
    ident = body["id"]
    updated = await client.put(
        f"/api/v1/automations/{ident}",
        json={"expectedRevision": 1, "name": "daily"},
    )
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2
    stale = await client.put(
        f"/api/v1/automations/{ident}",
        json={"expectedRevision": 1, "name": "nope"},
    )
    assert stale.status_code == 409
    enabled = await client.post(f"/api/v1/automations/{ident}/enable")
    assert enabled.json()["enabled"] is True
    ran = await client.post(f"/api/v1/automations/{ident}/run")
    assert ran.status_code == 201
    log = (await client.get("/api/v1/automation-log")).json()
    assert log["entries"][0]["runId"] == ran.json()["runId"]
    checked = await client.post(f"/api/v1/automations/{ident}/check", json={"execute": True})
    assert checked.json()["launched"] is False
    assert checked.json()["matches"] == 0
    assert checked.json()["id"]
    deleted = await client.delete(f"/api/v1/automations/{ident}")
    assert deleted.status_code == 200
    monkeypatch.setenv("CEZ_AUTOMATIONS", "0")
    blocked = await client.get("/api/v1/automations")
    assert blocked.status_code == 409


async def test_deferred_start_preview_create_and_replay(client):
    day = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    start = {"kind": "at", "date": day, "hour": 9, "minute": 30}
    options = await client.post("/api/v1/deferred-start/options", json={"task": "later"})
    assert options.json()["usageReset"]["available"] is False
    preview = await client.post(
        "/api/v1/deferred-start/preview", json={"task": "later", "start": start}
    )
    assert preview.json()["available"] is True
    past = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    denied = await client.post(
        "/api/v1/deferred-start/preview",
        json={"task": "later", "start": {"kind": "at", "date": past, "hour": 9, "minute": 0}},
    )
    assert denied.json()["available"] is False
    key = "11111111-1111-1111-1111-111111111111"
    payload = {
        "task": {"task": "later", "workflow": "quick-task"},
        "start": start,
        "previewRevision": preview.json()["previewRevision"],
        "idempotencyKey": key,
    }
    created = await client.post("/api/v1/deferred-start", json=payload)
    assert created.status_code == 201
    stored = await client.get(f"/api/v1/automations/{created.json()['scheduled']['automationId']}")
    assert stored.json()["once"] is True
    assert stored.json()["enabled"] is True
    assert stored.json()["nextAt"] == preview.json()["notBefore"]
    replay = await client.post("/api/v1/deferred-start", json=payload)
    assert replay.status_code == 201
    assert replay.json()["scheduled"]["automationId"] == created.json()["scheduled"]["automationId"]
    payload["task"] = {"task": "different", "workflow": "quick-task"}
    clash = await client.post("/api/v1/deferred-start", json=payload)
    assert clash.status_code == 409


async def test_project_patch_delete_and_single_project(client, monkeypatch, tmp_path: Path):
    extra = tmp_path / "extra"
    extra.mkdir()
    added = await client.post("/api/v1/projects", json={"root": str(extra)})
    assert added.status_code == 200
    ident = added.json()["id"]
    renamed = await client.patch(f"/api/v1/projects/{ident}", json={"name": "renamed"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "renamed"
    boot = (await client.get("/api/v1/projects")).json()["bootProject"]
    refused = await client.delete(f"/api/v1/projects/{boot}")
    assert refused.status_code == 409
    removed = await client.delete(f"/api/v1/projects/{ident}")
    assert removed.status_code == 200
    monkeypatch.setenv("CEZ_SINGLE_PROJECT", "1")
    blocked = await client.post("/api/v1/projects", json={"root": str(extra)})
    assert blocked.status_code == 409
    assert "single-project" in blocked.json()["error"]
    health = (await client.get("/api/v1/health")).json()
    assert health["capabilities"]["singleProject"] is True


async def test_workspace_config_and_runs_index(client):
    created = await client.post("/api/v1/runs", json={"task": "index me", "workflow": "quick-task"})
    assert created.status_code == 201
    saved = await client.put("/api/v1/workspace/config", json={"maxParallel": 4})
    assert saved.status_code == 200
    assert (await client.get("/api/v1/workspace/config")).json()["maxParallel"] == 4
    rows = (await client.get("/api/v1/workspace/runs-index")).json()["runs"]
    assert created.json()["id"] in {row["id"] for row in rows}


async def test_pick_archives_the_other_variant(client):
    created = await client.post(
        "/api/v1/runs",
        json={"task": "write a note", "workflow": "quick-task", "variants": 2},
    )
    assert created.status_code == 201
    runs = created.json()["runs"]
    group = runs[0]["groupId"]
    for run in runs:
        assert (await _until(client, run["id"], {"done", "failed"}))["status"] == "done"
    listed = (await client.get(f"/api/v1/groups/{group}")).json()
    assert {row["variant"] for row in listed["runs"]} == {"A", "B"}
    picked = await client.post(f"/api/v1/groups/{group}/pick", json={"runId": runs[0]["id"]})
    assert picked.status_code == 200
    assert runs[1]["id"] in picked.json()["archived"]
    loser = (await client.get(f"/api/v1/runs/{runs[1]['id']}")).json()
    assert loser["archived"] is True
    winner = (await client.get(f"/api/v1/runs/{runs[0]['id']}")).json()
    assert winner["archived"] is False


async def test_queued_message_edit_and_delete(client):
    holders = []
    for _ in range(2):
        created = await client.post(
            "/api/v1/runs",
            json={"task": "hold the slot", "steps": [{"id": "wait", "command": "sleep 5"}]},
        )
        holders.append(created.json()["id"])
    for ident in holders:
        assert (await _until(client, ident, {"running", "failed"}))["status"] == "running"
    queued = await client.post(
        "/api/v1/runs", json={"task": "wait your turn", "workflow": "quick-task"}
    )
    run_id = queued.json()["id"]
    assert (await client.get(f"/api/v1/runs/{run_id}")).json()["status"] == "queued"
    message = await client.post(f"/api/v1/runs/{run_id}/messages", json={"text": "first"})
    assert message.status_code == 200
    msg_id = message.json()["message"]["id"]
    edited = await client.patch(
        f"/api/v1/runs/{run_id}/queued-messages/{msg_id}",
        json={"text": "second"},
    )
    assert edited.status_code == 200
    assert edited.json()["message"]["text"] == "second"
    removed = await client.delete(f"/api/v1/runs/{run_id}/queued-messages/{msg_id}")
    assert removed.status_code == 200
    for ident in holders:
        await client.post(f"/api/v1/runs/{ident}/cancel")
    started = await _until(client, run_id, {"running", "done", "failed", "review"})
    assert started["status"] != "queued"
    late = await client.patch(
        f"/api/v1/runs/{run_id}/queued-messages/{msg_id}",
        json={"text": "too late"},
    )
    assert late.status_code == 409


async def test_terminal_http_session(client):
    created = await client.post(
        "/api/v1/runs", json={"task": "write a note", "workflow": "quick-task"}
    )
    run_id = created.json()["id"]
    assert (await _until(client, run_id, {"done", "failed"}))["status"] == "done"
    opened = await client.post(f"/api/v1/runs/{run_id}/terminal")
    assert opened.status_code == 201
    session = opened.json()["id"]
    typed = await client.post(
        f"/api/v1/runs/{run_id}/terminal/{session}/input",
        json={"data": "printf ready\\n"},
    )
    assert typed.status_code == 200
    resized = await client.post(
        f"/api/v1/runs/{run_id}/terminal/{session}/resize",
        json={"rows": 30, "cols": 100},
    )
    assert resized.status_code == 200
    async with client.stream("GET", f"/api/v1/runs/{run_id}/terminal/{session}/output") as stream:
        assert stream.status_code == 200
        first = await anext(stream.iter_events())
    assert first.get("event") == "output"
    closed = await client.delete(f"/api/v1/runs/{run_id}/terminal/{session}")
    assert closed.status_code == 200
    missing = await client.delete(f"/api/v1/runs/{run_id}/terminal/{session}")
    assert missing.status_code == 404


async def test_dispatch_route_and_report(client):
    created = await client.post(
        "/api/v1/runs",
        json={"task": "parent", "steps": [{"id": "wait", "command": "sleep 5"}]},
    )
    parent = created.json()["id"]
    record = {}
    for _ in range(80):
        record = (await client.get(f"/api/v1/runs/{parent}")).json()
        if record.get("status") == "running" and record.get("branch"):
            break
        await asyncio.sleep(0.05)
    assert record.get("branch")
    dispatched = await client.post(
        f"/api/v1/runs/{parent}/dispatch",
        json={"objective": "review the note", "title": "child", "kind": "review"},
    )
    assert dispatched.status_code == 201
    child = dispatched.json()["id"]
    reported = await client.post(
        f"/api/v1/runs/{child}/report",
        json={"status": "done", "result": "looks good", "verdict": "approve"},
    )
    assert reported.status_code == 200
    body = (await client.get(f"/api/v1/runs/{child}")).json()
    assert body["dispatch"]["parentRunId"] == parent
    assert body["dispatch"]["report"]["verdict"] == "approve"
    stranger = await client.post(
        f"/api/v1/runs/{parent}/report",
        json={"status": "done", "result": "no"},
    )
    assert stranger.status_code == 404
    await client.post(f"/api/v1/runs/{parent}/cancel")


async def test_open_in_refuses_an_unknown_app_and_dry_run_does_not_spawn(client):
    listed = (await client.get("/api/v1/open-targets")).json()
    assert isinstance(listed["targets"], list)
    missing = await client.post("/api/v1/open-in", json={"target": "not-an-editor"})
    assert missing.status_code == 400
    if listed["targets"]:
        opened = await client.post("/api/v1/open-in", json={"target": listed["targets"][0]["id"]})
        assert opened.status_code == 200
        assert opened.json()["dryRun"] is True


def test_cez_home_is_the_data_directory_when_project_data_dir_is_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("PROJECT_DATA_DIR", raising=False)
    monkeypatch.setenv("CEZ_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CEZ_PROJECTS_DIR", str(tmp_path / "checkouts"))
    monkeypatch.setenv("CEZ_REPO", str(tmp_path))
    config = Config.from_env()
    assert config.data_dir == tmp_path / "home"
    assert config.db_path == tmp_path / "home" / "app.sqlite3"
    assert config.projects_dir == tmp_path / "checkouts"
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "volume"))
    pinned = Config.from_env()
    assert pinned.data_dir == tmp_path / "volume"


def test_import_command_stores_a_dashed_event_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    from tests.conftest import init_repo

    from app.cli import main

    repo = tmp_path / "repo"
    init_repo(repo)
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_DRY_RUN", "1")
    compact = "ab" * 16
    dashed = f"{compact[0:8]}-{compact[8:12]}-{compact[12:16]}-{compact[16:20]}-{compact[20:]}"
    path = tmp_path / "runs.json"
    path.write_text(
        json.dumps(
            [
                {
                    "id": dashed,
                    "task": "imported work",
                    "title": "Imported",
                    "status": "done",
                    "workflow": "quick-task",
                    "runner": "claude",
                    "createdAt": "2026-01-02T00:00:00+00:00",
                }
            ]
        ),
        encoding="utf-8",
    )
    folder = tmp_path / "runs"
    folder.mkdir()
    (folder / f"{dashed}.ndjson").write_text(
        json.dumps({"type": "note", "message": "from the file", "stepId": "s", "ts": "t"}) + "\n",
        encoding="utf-8",
    )
    assert main(["import-runs", str(path), "--repo", str(repo)]) == 0
    assert "imported 1" in capsys.readouterr().out

    async def read():
        async with LiteWriter(tmp_path / "data" / "app.sqlite3", schema=schema, claim=30) as db:
            return get_run(db, compact), list_events(db, compact)

    stored, events = asyncio.run(read())
    assert stored is not None
    assert stored.task == "imported work"
    assert any(event.text == "from the file" for event in events)
    assert main(["import-runs", str(path)]) == 0
    assert "skipped 1" in capsys.readouterr().out
