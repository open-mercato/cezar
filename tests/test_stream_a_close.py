"""The stream A rows that were still open: landing, clock resets, skills, catalog."""

from __future__ import annotations

import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from tests.conftest import init_repo
from tests.test_runners import install
from tests.test_stream_a import _engine, _project, _workflow

from app.engine.graph_edit import add_node, blank, connect, move_node
from app.engine.handoff import handoff_path
from app.engine.landing import land_in_place, read_policy
from app.engine.providers import model_catalog, parse_cursor_models
from app.engine.skills_banner import print_skills_banner, should_show_skills_banner
from app.engine.team_skills import org_skill, refresh_team_skills
from app.engine.usage_limit import parse_usage_limit
from app.features.settings.store import SkillRepo, write_skill_repos
from app.store.db import get_run, list_events


def test_a_clock_reset_uses_the_named_zone():
    moment = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)
    hit = parse_usage_limit(
        "session limit reached. resets 8:10pm (Europe/Warsaw)",
        moment,
    )
    assert hit is not None and hit.evidence == "clock"
    local = hit.reset_at.astimezone(ZoneInfo("Europe/Warsaw"))
    assert (local.hour, local.minute) == (20, 10)
    assert hit.reset_at > moment
    dated = parse_usage_limit(
        "weekly limit resets Oct 31, 9am (Europe/Warsaw)",
        moment,
    )
    assert dated is not None and dated.evidence == "clock"
    placed = dated.reset_at.astimezone(ZoneInfo("Europe/Warsaw"))
    assert (placed.month, placed.day, placed.hour) == (10, 31, 9)


def test_cursor_model_lines_skip_auto_and_tips():
    parsed = parse_cursor_models(
        "Available models\nTip: pick one\nauto - Auto\ncomposer-2.5 - Composer 2.5\n"
    )
    assert parsed == [{"id": "composer-2.5", "label": "Composer 2.5", "description": ""}]


def test_skills_banner_respects_the_two_off_switches(tmp_path: Path, monkeypatch):
    lines: list[str] = []
    assert should_show_skills_banner(tmp_path) is True
    print_skills_banner(tmp_path, lines.append)
    assert any("open-mercato/skills" in line for line in lines)
    monkeypatch.setenv("CEZ_NO_BANNER", "1")
    assert should_show_skills_banner(tmp_path) is False
    monkeypatch.delenv("CEZ_NO_BANNER")
    state = tmp_path / ".ai" / "cezar"
    state.mkdir(parents=True)
    (state / "ui-state.json").write_text(
        json.dumps({"dismissedSkillsBanner": True}), encoding="utf-8"
    )
    assert should_show_skills_banner(tmp_path) is False


def test_team_skill_refresh_fetches_a_local_repo(tmp_path: Path):
    source = tmp_path / "skills-repo"
    init_repo(source)
    skill = source / "skills" / "review.md"
    skill.parent.mkdir()
    skill.write_text("# Review\n\nFirst body.\n", encoding="utf-8")
    subprocess.run(["git", "add", "skills"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-m", "skill"], cwd=source, check=True, capture_output=True)
    data = tmp_path / "data"
    write_skill_repos(data, [SkillRepo(str(source), "main")])
    found = refresh_team_skills(data)
    assert found and found[0].name == "review" and "First body" in found[0].body
    skill.write_text("# Review\n\nSecond body.\n", encoding="utf-8")
    subprocess.run(["git", "add", "skills"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-m", "update"], cwd=source, check=True, capture_output=True)
    again = refresh_team_skills(data)
    assert "Second body" in again[0].body
    loaded = org_skill(data, "review")
    assert loaded is not None and "Second body" in loaded.body


def test_a_claude_probe_uses_the_account_home(tmp_path: Path):
    binary = tmp_path / "claude"
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "home = os.environ.get('CLAUDE_CONFIG_DIR', '')\n"
        "if 'auth' in sys.argv:\n"
        "    print(json.dumps({'loggedIn': True}))\n"
        "    raise SystemExit(0)\n"
        "sys.stdin.readline()\n"
        "print(json.dumps({'type':'control_response','response':{'subtype':'success',"
        "'request_id':'cez-list-models-1','response':{'models':[{'value':'sonnet',"
        "'displayName':'Sonnet','description':home}]}}}))\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    home = tmp_path / "home"
    home.mkdir()
    env = os.environ.copy()
    env["CLAUDE_CONFIG_DIR"] = str(home)
    catalog = model_catalog("claude", {"claude": str(binary)}, cwd=str(tmp_path), env=env)
    assert catalog["source"] == "live"
    assert catalog["loggedIn"] is True
    models = catalog["models"]
    assert isinstance(models, list) and isinstance(models[0], dict)
    assert models[0]["description"] == str(home)


def test_graph_edit_adds_moves_and_connects():
    doc = blank("review-graph")
    assert add_node(doc, "review", "agent") is None
    assert move_node(doc, "review", 300, 200) is None
    assert connect(doc, "review", "ok") is None
    assert doc["layout"]["review"] == {"x": 300, "y": 200}
    assert {"from": "review", "to": "ok"} in doc["edges"]


async def test_the_node_editor_saves_yaml(client, repo: Path):
    started = await client.post("/workflows/review-graph/editor/start", json={"tab": "t1"})
    assert started.status_code in (200, 204)
    added = await client.post(
        "/workflows/review-graph/editor/node",
        json={"tab": "t1", "node_id": "review", "node_type": "agent"},
    )
    assert added.status_code in (200, 204), added.text
    moved = await client.post(
        "/workflows/review-graph/editor/move",
        json={"tab": "t1", "move_id": "review", "x": 300, "y": 200},
    )
    assert moved.status_code in (200, 204), moved.text
    connected = await client.post(
        "/workflows/review-graph/editor/connect",
        json={"tab": "t1", "from_id": "review", "to_id": "ok"},
    )
    assert connected.status_code in (200, 204), connected.text
    saved = await client.post("/workflows/review-graph/editor/save", json={"tab": "t1"})
    assert saved.status_code in (200, 204)
    text = (repo / ".ai" / "cezar" / "workflows" / "review-graph.yaml").read_text(encoding="utf-8")
    assert "version: 2" in text
    assert "id: review" in text
    assert "x: 300" in text
    page = await client.get("/workflows/review-graph/editor")
    assert 'id="node-review"' in page.text


async def test_interactive_auto_land_parks_then_finish_commits(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    _landing(repo, {})
    (repo / "person.md").write_text("Bjorn\n", encoding="utf-8")
    engine, db = await _engine(tmp_path, repo)
    try:
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project,
            task="file it mock:done",
            workflow_name="quick-task",
            runner="claude",
            in_place=True,
            workflow=_workflow(),
        )
        assert run is not None, reason
        await engine.enqueue(run)
        await engine.execute(run.id)
        parked = get_run(db, run.id)
        assert parked is not None and parked.status == "waiting"
        assert _notes(db, run.id, "changes ready for review")
        await engine.finish(run.id)
        done = get_run(db, run.id)
        assert done is not None and done.status == "done"
        assert done.landing.get("status") == "landed"
        subject = subprocess.run(
            ["git", "log", "-1", "--format=%s"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert "person.md" in subject
        handoff = handoff_path(engine.config.data_dir, run.id).read_text(encoding="utf-8")
        assert "file it mock:done" in handoff
        assert "turn complete" in handoff
    finally:
        await db.__aexit__(None, None, None)


async def test_a_failing_required_check_is_sent_back_instead_of_landing(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    _landing(repo, {"requiredChecks": ["false"]})
    (repo / "person.md").write_text("broken\n", encoding="utf-8")
    engine, db = await _engine(tmp_path, repo)
    try:
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project,
            task="file it mock:done",
            workflow_name="quick-task",
            runner="claude",
            in_place=True,
            workflow=_workflow(),
        )
        assert run is not None, reason
        await engine.enqueue(run)
        await engine.execute(run.id)
        await engine.finish(run.id)
        queued = get_run(db, run.id)
        assert queued is not None and queued.status == "queued"
        assert queued.landing.get("stage") == "checks"
        await engine.execute(run.id)
        parked = get_run(db, run.id)
        assert parked is not None and parked.status == "waiting"
        assert _notes(db, run.id, "auto-land failed at checks")
        head = subprocess.run(
            ["git", "log", "-1", "--format=%s"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert head.strip() == "init"
    finally:
        await db.__aexit__(None, None, None)


async def test_a_tracked_config_cannot_grant_auto_land(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    path = _landing(repo, {})
    subprocess.run(["git", "add", "-f", str(path)], cwd=repo, check=True)
    subprocess.run(
        ["git", "commit", "-m", "track config"],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    (repo / "person.md").write_text("x\n", encoding="utf-8")
    policy = read_policy(repo)
    assert policy is not None and policy.refusal
    engine, db = await _engine(tmp_path, repo)
    try:
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project,
            task="file it mock:done",
            workflow_name="quick-task",
            runner="claude",
            in_place=True,
            workflow=_workflow(),
        )
        assert run is not None, reason
        await engine.enqueue(run)
        await engine.execute(run.id)
        done = get_run(db, run.id)
        assert done is not None and done.status == "done"
        assert done.landing == {}
        assert _notes(db, run.id, "auto-land is off")
    finally:
        await db.__aexit__(None, None, None)


async def test_autonomous_auto_land_commits_without_review(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    _landing(repo, {})
    (repo / "person.md").write_text("Bjorn\n", encoding="utf-8")
    engine, db = await _engine(tmp_path, repo)
    try:
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project,
            task="file it mock:done",
            workflow_name="quick-task",
            runner="claude",
            autonomous=True,
            in_place=True,
            workflow=_workflow(),
        )
        assert run is not None, reason
        await engine.enqueue(run)
        await engine.execute(run.id)
        done = get_run(db, run.id)
        assert done is not None and done.status == "done"
        assert done.landing.get("status") == "landed"
    finally:
        await db.__aexit__(None, None, None)


async def test_codex_compaction_is_a_real_process(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    binary = tmp_path / "codex"
    install("codex_compact", binary)
    engine, db = await _engine(
        tmp_path,
        repo,
        dry_run=False,
        runner_bins={
            "claude": "claude",
            "codex": str(binary),
            "opencode": "opencode",
            "cursor": "cursor",
            "pi": "pi",
            "junie": "junie",
            "copilot": "copilot",
        },
    )
    try:
        project = _project(engine)
        run, reason = engine.plan_run(
            project=project,
            task="compact this",
            workflow_name="quick-task",
            runner="codex",
            workflow=_workflow(),
        )
        assert run is not None, reason
        await engine.enqueue(run)
        await engine.execute(run.id)
        done = get_run(db, run.id)
        assert done is not None and done.status == "done"
        assert _notes(db, run.id, "context was compacted")
    finally:
        await db.__aexit__(None, None, None)


def test_land_in_place_runs_checks_before_the_commit_when_there_is_no_upstream(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    (repo / "person.md").write_text("x\n", encoding="utf-8")
    failed = land_in_place(repo, checks=("false",), base_branch="main")
    assert failed.result == "failed" and failed.stage == "checks"
    head = subprocess.run(
        ["git", "log", "-1", "--format=%s"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout
    assert head.strip() == "init"


def _landing(repo: Path, extra: dict[str, object]) -> Path:
    directory = repo / ".ai" / "cezar"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "config.json"
    path.write_text(json.dumps({"landing": "auto", **extra}), encoding="utf-8")
    return path


def _notes(db, run_id: str, prefix: str) -> bool:
    return any(
        event.type == "note" and event.text.startswith(prefix) for event in list_events(db, run_id)
    )
