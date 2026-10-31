import asyncio

from tests.conftest import TAB

from app.features.api.urls import API_CANCEL, API_RUNS, API_RUNS_CREATE
from app.features.dashboard.urls import DASHBOARD
from app.features.health.urls import API_HEALTH, HEALTH
from app.features.projects.urls import PROJECTS, PROJECTS_ADD
from app.features.settings.urls import SETTINGS, SETTINGS_LIVE, SETTINGS_SAVE
from app.features.skills.urls import SKILLS, SKILLS_CREATE
from app.features.task.urls import TASK, TASK_FINISH, TASK_MESSAGE
from app.features.tasks.urls import TASKS, TASKS_CREATE, TASKS_LIVE
from app.features.workflows.urls import WORKFLOWS, WORKFLOWS_CREATE


async def until(events, needle: str, limit: int = 40) -> str:
    last = ""
    for _ in range(limit):
        event = await asyncio.wait_for(anext(events), 5)
        last = event.get("data", "")
        if needle in last:
            return last
    raise AssertionError(last[:1000])


async def test_health_and_the_task_list(client):
    health = await client.get(HEALTH.href())
    assert health.status_code == 200
    assert health.text.strip() == "ok"
    api = await client.get(API_HEALTH.href())
    health_body = api.json()
    assert health_body["version"]
    assert health_body["defaultRunner"] == "claude"
    assert health_body["capabilities"]["dispatch"] is True
    assert health_body["repo"]["branch"] == "main"
    page = await client.get(TASKS.href())
    assert page.status_code == 200
    assert 'id="tasks"' in page.text
    assert "Dry run is on" in page.text
    nonsense = await client.get(TASKS.href(query={"status": "nope"}))
    assert "queued" in nonsense.text


async def test_creating_a_task_reaches_review_and_finish_does_not_merge(client, repo):
    async with client.stream("GET", TASKS_LIVE.href(), params=TAB, timeout=5) as live:
        events = live.iter_events()
        assert 'id="tasks"' in (await anext(events))["data"]
        created = await client.post(
            TASKS_CREATE.href(),
            json={
                "tab": "t1",
                "task": "write a note",
                "workflow": "quick-task",
                "runner": "claude",
            },
        )
        assert created.status_code == 200
        assert "window.location" in created.text
        assert "write a note" in await until(events, "status-done")
    runs = (await client.get(API_RUNS.href())).json()
    assert runs[0]["status"] == "done"
    run_id = runs[0]["id"]
    session = await client.get(TASK.href(run_id))
    assert "status-done" in session.text
    assert "Finish" not in session.text
    worktree = repo / ".ai" / "cezar" / "worktrees" / run_id / "CEZAR_DRY_RUN.txt"
    assert worktree.is_file()
    assert "CEZAR_DRY_RUN" not in (repo / "README.md").read_text(encoding="utf-8")
    finished = await client.post(TASK_FINISH.href(run_id), json={"tab": "t1"})
    assert finished.status_code == 409
    assert (await client.get(API_RUNS.href())).json()[0]["status"] == "done"
    log = __import__("subprocess").run(
        ["git", "rev-list", "--count", "HEAD"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    assert log.stdout.strip() == "1"
    changes = await client.get(TASK.href(run_id, query={"pane": "diff"}))
    assert "CEZAR_DRY_RUN.txt" in changes.text


async def test_the_review_gate_offers_finish(client, monkeypatch, repo):
    monkeypatch.setenv("CEZ_REVIEW_GATE", "1")
    created = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "park the diff", "workflow": "quick-task", "runner": "claude"},
    )
    assert created.status_code == 201
    run_id = created.json()["id"]
    status = ""
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status in ("review", "done", "failed"):
            break
        await asyncio.sleep(0.05)
    assert status == "review"
    session = await client.get(TASK.href(run_id))
    assert "Finish" in session.text
    finished = await client.post(TASK_FINISH.href(run_id), json={"tab": "t1"})
    assert finished.status_code == 204
    assert (await client.get(f"/api/v1/runs/{run_id}")).json()["status"] == "done"
    log = __import__("subprocess").run(
        ["git", "rev-list", "--count", "HEAD"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    assert log.stdout.strip() == "1"


async def test_an_ask_can_be_answered(client):
    created = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "mock:ask the title", "workflow": "quick-task", "runner": "claude"},
    )
    assert created.status_code == 201
    run_id = created.json()["id"]
    async with client.stream("GET", f"/tasks/{run_id}/live", params=TAB, timeout=5) as live:
        events = live.iter_events()
        await until(events, "status-waiting")
        sent = await client.post(
            TASK_MESSAGE.href(run_id),
            json={"tab": "t1", "message": "the short one"},
        )
        assert sent.status_code == 200
        await until(events, "status-done")
    empty = await client.post(TASK_MESSAGE.href(run_id), json={"tab": "t1", "message": "   "})
    assert empty.status_code == 409


async def test_cancel_and_bad_input(client):
    created = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "mock:ask hold", "workflow": "quick-task"},
    )
    run_id = created.json()["id"]
    status = ""
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status == "waiting":
            break
        await asyncio.sleep(0.05)
    assert status == "waiting"
    cancelled = await client.post(API_CANCEL.href(run_id))
    assert cancelled.status_code == 200
    assert cancelled.json()["cancelled"] is True
    assert (await client.get(f"/api/v1/runs/{run_id}")).json()["status"] == "cancelled"
    missing = await client.post(
        TASKS_CREATE.href(),
        json={"tab": "t1", "task": "   ", "runner": "claude", "workflow": "quick-task"},
    )
    assert missing.status_code == 400
    unknown = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "x", "workflow": "no-such-workflow"},
    )
    assert unknown.status_code == 404


async def test_settings_save_repaints_the_stream(client):
    async with client.stream("GET", SETTINGS_LIVE.href(), params=TAB, timeout=5) as live:
        events = live.iter_events()
        assert 'id="settings"' in (await anext(events))["data"]
        saved = await client.post(
            SETTINGS_SAVE.href(),
            json={
                "tab": "t1",
                "max_parallel": 3,
                "default_runner": "codex",
                "theme": "light",
                "accent": "violet",
            },
        )
        assert saved.status_code == 204
        body = await until(events, 'class="light"')
        assert 'data-accent="violet"' in body
    page = await client.get(SETTINGS.href())
    assert "light" in page.text
    rejected = await client.post(
        SETTINGS_SAVE.href(),
        json={
            "tab": "t1",
            "max_parallel": 0,
            "default_runner": "codex",
            "theme": "dark",
            "accent": "lime",
        },
    )
    assert rejected.status_code == 400


async def test_workflow_and_skill_files_round_trip(client, repo):
    created = await client.post(
        WORKFLOWS_CREATE.href(),
        json={"tab": "t1", "name": "ship", "template": "fix-and-verify"},
    )
    assert created.status_code == 200
    text = (repo / ".ai" / "cezar" / "workflows" / "ship.yaml").read_text(encoding="utf-8")
    assert "onFail" in text
    page = await client.get(WORKFLOWS.href())
    assert "ship" in page.text
    bad = await client.post(
        WORKFLOWS_CREATE.href(), json={"tab": "t1", "name": "../etc", "template": "agent"}
    )
    assert bad.status_code == 400
    skill = await client.post(
        SKILLS_CREATE.href(),
        json={
            "tab": "t1",
            "name": "house-style",
            "description": "Be boring",
            "body": "Prefer plain functions.",
        },
    )
    assert skill.status_code == 200
    assert "Prefer plain functions." in (await client.get(SKILLS.href())).text
    assert (repo / ".ai" / "cezar" / "skills" / "house-style.md").is_file()


async def test_projects_and_dashboard(client, tmp_path):
    extra = tmp_path / "other"
    extra.mkdir()
    added = await client.post(PROJECTS_ADD.href(), json={"tab": "t1", "path": str(extra)})
    assert added.status_code == 200
    page = await client.get(PROJECTS.href())
    assert "other" in page.text
    again = await client.post(PROJECTS_ADD.href(), json={"tab": "t1", "path": str(extra)})
    assert again.status_code == 200
    assert "already" in again.text
    home = await client.post(PROJECTS_ADD.href(), json={"tab": "t1", "path": str(Path_home())})
    assert home.status_code == 200
    assert "home" in home.text
    board = await client.get(DASHBOARD.href())
    assert 'id="dashboard"' in board.text


def Path_home():
    from pathlib import Path

    return Path.home()
