"""Stream A: the walk, the runners' missing edges, and the workspace event stream."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import threading
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast

from litewriter import LiteWriter
from stario import Relay
from tests.conftest import init_repo
from tests.test_engine import config_for

from app.clock import now, stamp
from app.engine.agents import AgentEvent, AgentSpec
from app.engine.engine import Engine
from app.engine.model import Run, Workflow
from app.engine.prompts import AUTONOMOUS_NUDGE, COMPACTION_NUDGE, MONITORING_WAKE_NUDGE
from app.engine.skills import load_skills
from app.engine.terminal_hub import TerminalHub
from app.engine.usage_limit import parse_usage_limit
from app.engine.workflows import parse_workflow
from app.features.api.surface import _event_visible
from app.store.db import (
    get_project,
    get_run,
    insert_run,
    list_events,
    list_runs,
    save_run,
    schema,
)

MOMENT = datetime(2026, 8, 3, 12, 0, tzinfo=UTC)


class Capture:
    def __init__(self) -> None:
        self.specs: list[AgentSpec] = []

    async def stream(self, spec: AgentSpec):
        self.specs.append(spec)
        yield AgentEvent("text", "done")
        yield AgentEvent("turn-end")


class Script:
    def __init__(self, lines: list[str]) -> None:
        self.lines = lines
        self.prompts: list[str] = []

    async def stream(self, spec: AgentSpec):
        self.prompts.append(spec.user_prompt)
        text = self.lines.pop(0) if self.lines else "CEZ:DONE"
        if text:
            yield AgentEvent("text", text)
        yield AgentEvent("turn-end")


def _workflow() -> Workflow:
    parsed, issue = parse_workflow(
        {"name": "quick-task", "steps": [{"id": "task", "prompt": "{{task}}"}]},
        source="built-in",
    )
    assert parsed is not None, issue
    return parsed


async def _engine(tmp_path: Path, repo: Path, **overrides: object) -> tuple[Engine, LiteWriter]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    cfg = config_for(tmp_path, repo, **overrides)
    db = LiteWriter(cfg.db_path, schema=schema, claim=5)
    await db.__aenter__()
    engine = Engine(db, Relay(), cfg)
    await engine.startup()
    return engine, db


def _got(db: LiteWriter, run_id: str) -> Run:
    stored = get_run(db, run_id)
    assert stored is not None
    return stored


def _project(engine: Engine):
    project = get_project(engine.db, engine.boot_project_id)
    assert project is not None
    return project


def _graph(body: dict[str, object]) -> Workflow:
    parsed, issue = parse_workflow(body, source="file")
    assert parsed is not None, issue
    return parsed


def test_usage_limit_shapes():
    target = MOMENT + timedelta(hours=6)
    epoch = int(target.timestamp())
    marker = parse_usage_limit(f"Claude AI usage limit reached|{epoch}", MOMENT)
    assert marker is not None and marker.evidence == "claude-marker"
    assert marker.reset_at == target
    millis = parse_usage_limit(f"Claude AI usage limit reached|{epoch * 1000}", MOMENT)
    assert millis is not None and millis.reset_at == marker.reset_at
    later = parse_usage_limit("rate limit — try again at 2026-08-03T18:00:00Z", MOMENT)
    assert later is not None and later.evidence == "timestamp"
    delay = parse_usage_limit("quota exceeded, try again in 42 minutes", MOMENT)
    assert delay is not None and delay.reset_at == MOMENT + timedelta(minutes=42)
    header = parse_usage_limit("usage limit retry-after: 3600", MOMENT)
    assert header is not None and header.reset_at == MOMENT + timedelta(hours=1)
    assert parse_usage_limit("try again at 2026-08-03T18:00:00Z", MOMENT) is None
    assert parse_usage_limit("usage limit reached|1900000000", MOMENT) is None
    stale = parse_usage_limit("usage limit, try again at 2020-01-01T00:00:00Z", MOMENT)
    assert stale is not None and stale.reset_at == MOMENT


def test_local_skill_wins_and_global_and_cache_are_read(tmp_path: Path):
    repo = tmp_path / "repo"
    home = tmp_path / "home"
    cache = tmp_path / "cache"
    local = repo / ".ai" / "cezar" / "skills"
    local.mkdir(parents=True)
    (local / "shared.md").write_text("---\nname: shared\n---\nlocal body\n", encoding="utf-8")
    global_dir = home / ".claude" / "skills"
    global_dir.mkdir(parents=True)
    (global_dir / "shared.md").write_text("---\nname: shared\n---\nglobal body\n", encoding="utf-8")
    (global_dir / "only-global.md").write_text(
        "---\nname: only-global\n---\nglobal\n", encoding="utf-8"
    )
    team = cache / "team-skills"
    team.mkdir(parents=True)
    (team / "from-team.md").write_text("---\nname: from-team\n---\nteam\n", encoding="utf-8")
    found = {item.name: item.body for item in load_skills(repo, home=home, cache=cache)}
    assert found["shared"] == "local body"
    assert found["only-global"] == "global"
    assert found["from-team"] == "team"


def test_a_project_stream_ignores_another_projects_run():
    class Row:
        project_id = "boot"

    assert _event_visible("run", Row(), "boot") is True
    assert _event_visible("run", Row(), "other") is False
    assert _event_visible("run-deleted", {"id": "1", "projectId": "boot"}, "boot") is True
    assert _event_visible("run-deleted", {"id": "1", "projectId": "other"}, "boot") is False
    assert _event_visible("run", Row(), None) is True


async def test_retain_removes_old_directories_and_index_rows(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo, worktree_keep=1, runs_keep=1)
    try:
        project = _project(engine)
        kept: Run | None = None
        for index, status in enumerate(("queued", "done", "done", "done")):
            run, reason = engine.plan_run(
                project=project,
                task=f"row {index}",
                workflow_name="quick-task",
                runner="claude",
                workflow=_workflow(),
            )
            assert run is not None, reason
            run.status = status
            run.created_at = f"2026-01-0{index + 1}T00:00:00+00:00"
            run.finished_at = "" if status == "queued" else f"2026-02-0{index + 1}T00:00:00+00:00"
            directory = repo / ".ai" / "cezar" / "worktrees" / run.id
            directory.mkdir(parents=True)
            (directory / "note.txt").write_text("x", encoding="utf-8")
            run.worktree_path = str(directory)
            await db.write(insert_run, run)
            if index == 3:
                kept = run
        paths = {
            item.id: Path(item.worktree_path)
            for item in list_runs(db, project.id, None, limit=20)
            if item.worktree_path
        }
        reclaimed = await engine.retain()
        assert kept is not None
        assert kept.id not in reclaimed
        assert len(reclaimed) == 2
        for run_id in reclaimed:
            assert not paths[run_id].exists()
            assert get_run(db, run_id) is None
        assert paths[kept.id].exists()
        ids = {item.id for item in list_runs(db, project.id, None, limit=20)}
        assert kept.id in ids
        rows = list_runs(db, project.id, None, limit=20)
        queued = next(item for item in rows if item.status == "queued")
        assert queued.id in ids
        assert len(ids) == 2
    finally:
        await db.__aexit__(None, None, None)


async def test_queued_messages_can_be_edited_and_a_restart_says_they_were_lost(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        capture = Capture()
        engine.agent = capture
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="the task", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        await engine.enqueue(run)
        created, err = await engine.queue_message(run.id, "first draft")
        assert err is None and created is not None
        edited, err = await engine.edit_queued_message(run.id, str(created["id"]), "final draft")
        assert err is None and edited is not None
        dropped, err = await engine.queue_message(run.id, "drop me")
        assert dropped is not None
        assert await engine.remove_queued_message(run.id, str(dropped["id"])) is None
        assert _got(db, run.id).task == "the task"
        await engine.execute(run.id)
        prompt = capture.specs[0].user_prompt
        assert "final draft" in prompt
        assert "first draft" not in prompt
        assert "drop me" not in prompt
        marker = engine.config.data_dir / "runs" / f"{run.id}.deferred"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("2", encoding="utf-8")
    finally:
        await db.__aexit__(None, None, None)
    async with LiteWriter(engine.config.db_path, schema=schema, claim=5) as restarted:
        again = Engine(restarted, Relay(), engine.config)
        await again.startup()
        texts = [event.text for event in list_events(restarted, run.id)]
    assert any("2 messages" in text and "cezar restarted" in text for text in texts)


async def test_the_prompt_names_attachments(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        capture = Capture()
        engine.agent = capture
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="look", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.worktree_path = str(repo)
        run.attachment_paths = ["shots/board.png"]
        await engine.enqueue(run)
        await engine.execute(run.id)
        assert "The user attached:\nshots/board.png" in capture.specs[0].user_prompt
    finally:
        await db.__aexit__(None, None, None)


async def test_a_review_follow_up_is_one_resumed_turn(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CEZ_REVIEW_GATE", "1")
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        capture = Capture()

        async def stream(spec: AgentSpec):
            capture.specs.append(spec)
            Path(spec.cwd, "change.txt").write_text("x\n", encoding="utf-8")
            yield AgentEvent("text", "done")
            yield AgentEvent("turn-end")

        capture.stream = stream  # type: ignore[method-assign]
        engine.agent = capture
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="change it", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        await engine.enqueue(run)
        await engine.execute(run.id)
        assert _got(db, run.id).status == "review"
        assert await engine.deliver(run.id, "please rename the file") is None
        await engine.execute(run.id)
        assert capture.specs[-1].resume is True
        assert "please rename the file" in capture.specs[-1].user_prompt
        assert _got(db, run.id).status == "review"
    finally:
        await db.__aexit__(None, None, None)


async def test_an_interrupted_run_resumes_the_cli_session(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="keep going", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.status = "running"
        run.worktree_path = str(repo)
        run.started_at = stamp()
        # A graph run with no session is failed, not re-queued: there is no persisted cursor.
        run.workflow_def = {"name": "g", "graph": {"nodes": [], "edges": []}}
        await db.write(insert_run, run)
        await engine.recover()
        assert _got(db, run.id).error == "interrupted by restart"
        capture = Capture()
        engine.agent = capture
        assert await engine.deliver(run.id, "continue please") is None
        await engine.execute(run.id)
        assert capture.specs[0].resume is True
        assert capture.specs[0].session_id == run.id
        assert "continue please" in capture.specs[0].user_prompt
    finally:
        await db.__aexit__(None, None, None)


async def test_a_delta_turn_persists_item_completed_and_the_other_v2_events(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:

        class Speaker:
            async def stream(self, spec: AgentSpec):
                yield AgentEvent("delta", "hello")
                yield AgentEvent("turn-end")

        engine.agent = Speaker()
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="speak", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.worktree_path = str(repo)
        await engine.enqueue(run)
        await engine.execute(run.id)
        completed = [event for event in list_events(db, run.id) if event.type == "item.completed"]
        assert completed and "hello" in completed[-1].text

        class Rich:
            async def stream(self, spec: AgentSpec):
                yield AgentEvent("plan", '{"type":"plan.updated","entries":[]}')
                yield AgentEvent("permission.requested", "perm-9")
                yield AgentEvent("item.updated", '{"type":"item.updated","item":{"id":"t"}}')
                yield AgentEvent("text", "hi", input_tokens=2, output_tokens=3)
                yield AgentEvent("turn-end")

        engine.agent = Rich()
        second, reason = engine.plan_run(
            project=project, task="rich", workflow_name="quick-task", runner="claude"
        )
        assert second is not None, reason
        second.worktree_path = str(repo)
        await engine.enqueue(second)
        await engine.execute(second.id)
        kinds = {event.type for event in list_events(db, second.id)}
        assert {"plan.updated", "permission.requested", "item.updated", "usage.updated"} <= kinds
    finally:
        await db.__aexit__(None, None, None)


async def test_a_settled_child_is_steered_into_the_live_parent(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        steered: list[str] = []

        class Parent:
            async def stream(self, spec: AgentSpec):
                yield AgentEvent("text", "ok")
                yield AgentEvent("turn-end")

            async def steer(self, session_id: str, text: str) -> bool:
                steered.append(text)
                return True

        engine.agent = Parent()
        project = _project(engine)
        parent, reason = engine.plan_run(
            project=project, task="parent", workflow_name="quick-task", runner="claude"
        )
        assert parent is not None, reason
        parent.status = "running"
        parent.worktree_path = str(repo)
        await db.write(insert_run, parent)
        child, reason = engine.plan_run(
            project=project,
            task="child",
            workflow_name="quick-task",
            runner="claude",
            parent=parent,
        )
        assert child is not None, reason
        child.status = "done"
        child.finished_at = stamp()
        await db.write(insert_run, child)
        await engine._report_child(child.id)
        assert steered and "Report from task" in steered[0]
        assert _got(db, parent.id).pending_reports == []
        assert any(
            event.text == "report delivered into the live session"
            for event in list_events(db, parent.id)
        )
    finally:
        await db.__aexit__(None, None, None)


async def test_a_usage_limit_failure_resumes_when_the_window_opens(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        epoch = int(now().timestamp()) + 120

        class Limited:
            async def stream(self, spec: AgentSpec):
                yield AgentEvent("error", f"Claude AI usage limit reached|{epoch}")

        engine.agent = Limited()
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="limited", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.worktree_path = str(repo)
        await engine.enqueue(run)
        await engine.execute(run.id)
        failed = get_run(db, run.id)
        assert failed is not None and failed.status == "failed" and failed.auto_resume_at
        failed.auto_resume_at = stamp(now() - timedelta(seconds=5))
        await db.write(save_run, failed)
        await engine.tick()
        resumed = get_run(db, run.id)
        assert resumed is not None
        assert resumed.status == "queued" and resumed.mode == "followup"
        assert resumed.auto_resume_attempts == 1
        assert await engine.clear_auto_resume(run.id) is None
        capped, reason = engine.plan_run(
            project=project, task="capped", workflow_name="quick-task", runner="claude"
        )
        assert capped is not None, reason
        capped.status = "failed"
        capped.error = f"Claude AI usage limit reached|{epoch}"
        capped.auto_resume_attempts = 12
        capped.worktree_path = str(repo)
        await db.write(insert_run, capped)
        await engine._schedule_auto_resume(get_run(db, capped.id) or capped)
        assert _got(db, capped.id).auto_resume_at == ""
        assert any("cap reached" in event.text for event in list_events(db, capped.id))
    finally:
        await db.__aexit__(None, None, None)


async def test_monitoring_parks_and_the_tick_wakes_it(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo, monitoring_wake_seconds=0)
    try:
        script = Script(["still going\nCEZ:MONITORING", "CEZ:DONE"])
        engine.agent = script
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="watch", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.worktree_path = str(repo)
        await engine.enqueue(run)
        await engine.execute(run.id)
        assert _got(db, run.id).status == "monitoring"
        await engine.tick()
        assert _got(db, run.id).status == "queued"
        await engine.execute(run.id)
        assert MONITORING_WAKE_NUDGE in script.prompts[-1]
        assert _got(db, run.id).status == "done"
        parked, reason = engine.plan_run(
            project=project, task="capped", workflow_name="quick-task", runner="claude"
        )
        assert parked is not None, reason
        parked.status = "monitoring"
        parked.monitoring_wakes = 40
        parked.monitoring_wake_at = stamp(now() - timedelta(seconds=1))
        parked.worktree_path = str(repo)
        await db.write(insert_run, parked)
        await engine.tick()
        assert _got(db, parked.id).status == "waiting"
    finally:
        await db.__aexit__(None, None, None)


async def test_an_autonomous_turn_without_done_is_nudged(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        script = Script(["working", "CEZ:DONE"])
        engine.agent = script
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project,
            task="finish it",
            workflow_name="quick-task",
            runner="claude",
            autonomous=True,
        )
        assert run is not None, reason
        run.worktree_path = str(repo)
        await engine.enqueue(run)
        await engine.execute(run.id)
        assert AUTONOMOUS_NUDGE in script.prompts[1]
        assert _got(db, run.id).status == "done"
    finally:
        await db.__aexit__(None, None, None)


async def test_compaction_continues_the_same_thread(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        prompts: list[str] = []

        class Compact:
            async def stream(self, spec: AgentSpec):
                prompts.append(spec.user_prompt)
                if len(prompts) == 1:
                    yield AgentEvent("turn-end", name="context-compaction")
                    return
                yield AgentEvent("text", "CEZ:DONE")
                yield AgentEvent("turn-end")

        engine.agent = Compact()
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="compact", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.worktree_path = str(repo)
        await engine.enqueue(run)
        await engine.execute(run.id)
        assert COMPACTION_NUDGE in prompts[1]
        assert _got(db, run.id).status == "done"
    finally:
        await db.__aexit__(None, None, None)


def _comment_graph() -> dict[str, object]:
    return {
        "name": "g",
        "version": 2,
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "prep", "type": "agent", "prompt": "{{task}}"},
            {"id": "comment", "type": "github.pr-comment", "body": "shipped {{task}}"},
            {"id": "ok", "type": "end", "status": "success"},
            {"id": "bad", "type": "end", "status": "failed"},
        ],
        "edges": [
            {"from": "start", "to": "prep"},
            {"from": "prep.done", "to": "comment"},
            {"from": "comment.done", "to": "ok"},
            {"from": "comment.failed", "to": "bad"},
        ],
    }


async def test_a_pr_comment_calls_gh_and_a_missing_pr_fails(tmp_path: Path, monkeypatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    log = tmp_path / "gh.log"
    binary = tmp_path / "bin" / "gh"
    binary.parent.mkdir()
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        f"pathlib.Path({str(log)!r}).open('a').write(' '.join(sys.argv[1:]) + '\\n')\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    monkeypatch.setenv("PATH", f"{binary.parent}{os.pathsep}{os.environ.get('PATH', '')}")
    engine, db = await _engine(tmp_path, repo, dry_run=False)
    try:
        engine.agent = Capture()
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project,
            task="ship",
            workflow_name="g",
            runner="claude",
            workflow=_graph(_comment_graph()),
        )
        assert run is not None, reason
        run.pull_request_url = "https://github.com/acme/demo/pull/4"
        run.worktree_path = str(repo)
        await engine.enqueue(run)
        await engine.execute(run.id)
        assert "pr comment 4 --body shipped ship" in log.read_text(encoding="utf-8")
        assert _got(db, run.id).status == "done"
        update = _comment_graph()
        nodes = update["nodes"]
        assert isinstance(nodes, list)
        nodes[2] = {
            "id": "comment",
            "type": "github.pr-update",
            "ready": True,
            "addLabels": ["cezar"],
            "reviewers": ["octocat"],
        }
        updated, reason = engine.plan_run(
            project=project,
            task="ship",
            workflow_name="g",
            runner="claude",
            workflow=_graph(update),
        )
        assert updated is not None, reason
        updated.pull_request_url = "https://github.com/acme/demo/pull/9"
        updated.worktree_path = str(repo)
        await engine.enqueue(updated)
        await engine.execute(updated.id)
        commands = log.read_text(encoding="utf-8")
        assert "pr ready 9" in commands
        assert "pr edit 9 --add-label cezar --add-reviewer octocat" in commands
        issue = _comment_graph()
        issue_nodes = issue["nodes"]
        assert isinstance(issue_nodes, list)
        issue_nodes[2] = {
            "id": "comment",
            "type": "github.issue-comment",
            "issue": 7,
            "body": "fixed {{task}}",
        }
        commented, reason = engine.plan_run(
            project=project,
            task="ship",
            workflow_name="g",
            runner="claude",
            workflow=_graph(issue),
        )
        assert commented is not None, reason
        commented.worktree_path = str(repo)
        await engine.enqueue(commented)
        await engine.execute(commented.id)
        assert "issue comment 7 --body fixed ship" in log.read_text(encoding="utf-8")
        missing, reason = engine.plan_run(
            project=project,
            task="ship",
            workflow_name="g",
            runner="claude",
            workflow=_graph(_comment_graph()),
        )
        assert missing is not None, reason
        missing.worktree_path = str(repo)
        await engine.enqueue(missing)
        await engine.execute(missing.id)
        assert _got(db, missing.id).status == "failed"
        assert any("no PR" in event.text for event in list_events(db, missing.id))
    finally:
        await db.__aexit__(None, None, None)


def _hook_graph(url: str) -> dict[str, object]:
    return {
        "name": "g",
        "version": 2,
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "prep", "type": "agent", "prompt": "{{task}}"},
            {"id": "hook", "type": "notify.webhook", "url": url, "body": "hello {{task}}"},
            {"id": "ok", "type": "end", "status": "success"},
            {"id": "bad", "type": "end", "status": "failed"},
        ],
        "edges": [
            {"from": "start", "to": "prep"},
            {"from": "prep.done", "to": "hook"},
            {"from": "hook.done", "to": "ok"},
            {"from": "hook.failed", "to": "bad"},
        ],
    }


async def test_a_webhook_node_is_off_until_the_flag_and_then_posts(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        engine.agent = Capture()
        project = _project(engine)
        blocked, reason = engine.plan_run(
            project=project,
            task="ping",
            workflow_name="g",
            runner="claude",
            workflow=_graph(_hook_graph("https://example.test/hook")),
        )
        assert blocked is not None, reason
        blocked.worktree_path = str(repo)
        await engine.enqueue(blocked)
        await engine.execute(blocked.id)
        assert _got(db, blocked.id).status == "failed"
        assert any("CEZ_WORKFLOW_WEBHOOKS=1" in event.text for event in list_events(db, blocked.id))
    finally:
        await db.__aexit__(None, None, None)

    received: list[bytes] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            received.append(self.rfile.read(length))
            self.send_response(204)
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        live, db = await _engine(tmp_path / "live", repo, dry_run=False, workflow_webhooks=True)
        try:
            live.agent = Capture()
            project = _project(live)
            run, reason = live.plan_run(
                project=project,
                task="ping",
                workflow_name="g",
                runner="claude",
                workflow=_graph(_hook_graph(f"http://127.0.0.1:{port}/hook")),
            )
            assert run is not None, reason
            run.worktree_path = str(repo)
            await live.enqueue(run)
            await live.execute(run.id)
            assert _got(db, run.id).status == "done"
            assert json.loads(received[0])["text"] == "hello ping"
        finally:
            await db.__aexit__(None, None, None)
    finally:
        server.shutdown()
        thread.join(timeout=2)


async def test_turn_end_autosave_always_runs_and_periodic_is_the_flag(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="save", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        await engine.enqueue(run)
        await engine.execute(run.id)
        stored = get_run(db, run.id)
        assert stored is not None and stored.worktree_path
        log = subprocess.run(
            ["git", "log", "--format=%s"],
            cwd=stored.worktree_path,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert "cezar autosave (turn end)" in log
        assert "cezar autosave (periodic)" not in log
    finally:
        await db.__aexit__(None, None, None)

    other = tmp_path / "other"
    init_repo(other)
    (other / "dirty.txt").write_text("x\n", encoding="utf-8")
    periodic, db = await _engine(tmp_path / "periodic", repo, autosave=True, autosave_interval_s=0)
    try:
        project = _project(periodic)
        run, reason = periodic.plan_run(
            project=project, task="timer", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.status = "running"
        run.worktree_path = str(other)
        await db.write(insert_run, run)
        await periodic.tick()
        log = subprocess.run(
            ["git", "log", "--format=%s"],
            cwd=other,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert "cezar autosave (periodic)" in log
    finally:
        await db.__aexit__(None, None, None)


async def test_live_titles_follow_the_flag(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CEZ_AUTONAME", "1")
    repo = tmp_path / "repo"
    init_repo(repo)
    calls: list[str] = []

    async def _title(task: str, turn: str, **kwargs: object) -> str:
        calls.append(turn)
        return "naming the work"

    monkeypatch.setattr("app.engine.engine.propose_title", _title)
    engine, db = await _engine(tmp_path, repo, title_updates=False)
    try:
        engine.agent = Capture()
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="name me", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.worktree_path = str(repo)
        await engine.enqueue(run)
        await engine.execute(run.id)
        assert calls == []
    finally:
        await db.__aexit__(None, None, None)
    engine, db = await _engine(tmp_path / "on", repo, title_updates=True)
    try:
        engine.agent = Capture()
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="name me", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.worktree_path = str(repo)
        await engine.enqueue(run)
        await engine.execute(run.id)
        assert calls
        assert _got(db, run.id).title == "naming the work"
    finally:
        await db.__aexit__(None, None, None)


async def test_composer_defaults_apply_when_the_caller_does_not_choose(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo, autonomous_default=True, worktree_default=False)
    try:
        project = _project(engine)
        inherited, reason = engine.plan_run(
            project=project, task="seeded", workflow_name="quick-task", runner="claude"
        )
        assert inherited is not None, reason
        assert inherited.autonomous is True
        assert inherited.in_place is True
        chosen, reason = engine.plan_run(
            project=project,
            task="chosen",
            workflow_name="quick-task",
            runner="claude",
            autonomous=False,
            in_place=False,
        )
        assert chosen is not None, reason
        assert chosen.autonomous is False
        assert chosen.in_place is False
        engine.agent = Script(["CEZ:DONE"])
        await engine.enqueue(inherited)
        await engine.execute(inherited.id)
        stored = get_run(db, inherited.id)
        assert stored is not None and stored.in_place is True
        assert stored.worktree_path == str(repo)
        notes = [event.text for event in list_events(db, inherited.id)]
        assert any("running in the checkout" in text for text in notes)
    finally:
        await db.__aexit__(None, None, None)


async def test_in_place_runs_take_the_repo_lock_unless_it_is_disabled(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)

    class Gate:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.second = asyncio.Event()
            self.count = 0

        async def stream(self, spec: AgentSpec):
            self.count += 1
            if self.count == 1:
                self.started.set()
                await self.release.wait()
            else:
                self.second.set()
            yield AgentEvent("text", "ok")
            yield AgentEvent("turn-end")

    engine, db = await _engine(tmp_path, repo, worktree_default=False)
    try:
        gate = Gate()
        engine.agent = gate
        project = _project(engine)
        first, reason = engine.plan_run(
            project=project, task="one", workflow_name="quick-task", runner="claude"
        )
        second, reason = engine.plan_run(
            project=project, task="two", workflow_name="quick-task", runner="claude"
        )
        assert first is not None and second is not None, reason
        await engine.enqueue(first)
        await engine.enqueue(second)
        left = asyncio.create_task(engine.execute(first.id))
        right: asyncio.Task[None] | None = None
        try:
            await asyncio.wait_for(gate.started.wait(), 2)
            right = asyncio.create_task(engine.execute(second.id))
            await asyncio.sleep(0.05)
            assert gate.second.is_set() is False
            gate.release.set()
            await left
            await right
        finally:
            gate.release.set()
            if right is not None and not right.done():
                right.cancel()
        assert gate.second.is_set() is True
    finally:
        await db.__aexit__(None, None, None)

    engine, db = await _engine(tmp_path / "open", repo, worktree_default=False, repo_lock=False)
    try:
        gate = Gate()
        engine.agent = gate
        project = _project(engine)
        first, _reason = engine.plan_run(
            project=project, task="one", workflow_name="quick-task", runner="claude"
        )
        second, _reason = engine.plan_run(
            project=project, task="two", workflow_name="quick-task", runner="claude"
        )
        assert first is not None and second is not None
        await engine.enqueue(first)
        await engine.enqueue(second)
        left = asyncio.create_task(engine.execute(first.id))
        right: asyncio.Task[None] | None = None
        try:
            await asyncio.wait_for(gate.started.wait(), 2)
            right = asyncio.create_task(engine.execute(second.id))
            await asyncio.wait_for(gate.second.wait(), 2)
            gate.release.set()
            await left
            await right
        finally:
            gate.release.set()
            if right is not None and not right.done():
                right.cancel()
        assert any("CEZ_DISABLE_REPO_LOCK=1" in event.text for event in list_events(db, first.id))
    finally:
        await db.__aexit__(None, None, None)


async def test_a_settled_task_reaps_its_processes(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    sleeper: subprocess.Popen[bytes] | None = None
    try:
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="reap", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.worktree_path = str(repo)
        await engine.enqueue(run)
        sleeper = subprocess.Popen(
            ["sleep", "30"],
            env={**os.environ, "CEZ_TASK_ID": run.id},
        )
        await engine.execute(run.id)
        assert sleeper.wait(timeout=2) is not None
    finally:
        if sleeper is not None and sleeper.poll() is None:
            sleeper.kill()
        await db.__aexit__(None, None, None)

    engine, db = await _engine(tmp_path / "off", repo, task_process_reap=False)
    sleeper = None
    try:
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project, task="keep", workflow_name="quick-task", runner="claude"
        )
        assert run is not None, reason
        run.worktree_path = str(repo)
        await engine.enqueue(run)
        sleeper = subprocess.Popen(
            ["sleep", "30"],
            env={**os.environ, "CEZ_TASK_ID": run.id},
        )
        await engine.execute(run.id)
        assert sleeper.poll() is None
    finally:
        if sleeper is not None and sleeper.poll() is None:
            sleeper.kill()
            sleeper.wait(timeout=2)
        await db.__aexit__(None, None, None)


async def test_the_server_path_schedules_work_on_the_app(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    engine, db = await _engine(tmp_path, repo)
    try:
        names: list[str | None] = []

        class FakeApp:
            shutting_down = False

            def create_task(self, coro, name=None):  # type: ignore[no-untyped-def]
                names.append(name)
                return asyncio.create_task(coro, name=name)

        engine.app = cast(object, FakeApp())  # type: ignore[assignment]
        task = engine._spawn("abc")
        await task
        assert names == ["run-abc"]
        engine._coalescer.push("run", "message", "text", "hi", lambda *_args: None)
        assert engine._coalescer._timer is not None
        engine._coalescer.flush()
        hub = TerminalHub()
        hub.bind(engine._schedule)
        session = await hub.open(repo)
        assert any(item and item.startswith("term-") for item in names)
        await hub.close(session)
    finally:
        await db.__aexit__(None, None, None)


async def test_workspace_events_carry_the_run(client):
    async with client.stream("GET", "/api/v1/workspace/events", timeout=5) as live:
        incoming = live.iter_events()
        posted = asyncio.create_task(
            client.post(
                "/api/v1/runs",
                json={"task": "watch me", "workflow": "quick-task", "runner": "claude"},
            )
        )
        found = ""
        for _ in range(40):
            event = await anext(incoming)
            if event["event"] != "run":
                continue
            if "watch me" in event["data"] and "projectId" in event["data"]:
                found = event["data"]
                break
        created = await posted
    assert created.status_code == 201
    assert "watch me" in found
