"""GitHub and tracker pollers, the check, and the automation screens.

`gh` is `tests/fakes/gh_poll.py` first on PATH, so nothing here reaches the real one.
"""

import asyncio
import dataclasses
import json
import os
import re
import shutil
import subprocess
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from litewriter import LiteWriter
from stario import Relay
from stario.testing import TestClient
from tests.conftest import TAB, init_repo
from tests.test_engine import SpecCapture, config_for

from app.clock import now, stamp
from app.engine.engine import Engine
from app.engine.model import Automation, Run
from app.engine.poller import automation_env
from app.integrations.github_poll import Candidate, GhError, matches_filters, poll
from app.main import bootstrap
from app.store import polling
from app.store.db import (
    get_automation,
    get_run,
    list_events,
    list_runs,
    save_automation,
    schema,
)

FAKES = Path(__file__).parent / "fakes"
FUTURE = "2099-01-01T00:00:00Z"
REPO_URL = "https://api.github.com/repos/acme/shop"


def item(number: int, *, pr: bool, author: str = "alice", labels=("bug",), **extra) -> dict:
    row = {
        "node_id": f"N{number}",
        "number": number,
        "title": f"Thing {number}",
        "html_url": f"https://github.com/acme/shop/{'pull' if pr else 'issues'}/{number}",
        "created_at": FUTURE,
        "updated_at": FUTURE,
        "user": {"login": author},
        "assignees": [],
        "labels": [{"name": name} for name in labels],
        "repository_url": REPO_URL,
    }
    if pr:
        row["pull_request"] = {}
    return row | extra


def canned(items: list[dict]):
    def gh(args: list[str]) -> str:
        if "/search/issues" in args:
            return json.dumps({"items": items if "page=2" not in args else []})
        return "[]"

    return gh


@pytest.fixture
def fake_gh(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    binary = tmp_path / "bin"
    binary.mkdir()
    shutil.copy(FAKES / "gh_poll.py", binary / "gh")
    state = tmp_path / "ghstate"
    state.mkdir()
    monkeypatch.setenv("FAKE_GH_DIR", str(state))
    monkeypatch.setenv("PATH", f"{binary}{os.pathsep}{os.environ.get('PATH', '')}")
    return state


def calls(state: Path) -> str:
    log = state / "calls.log"
    return log.read_text(encoding="utf-8") if log.exists() else ""


def serve(state: Path, items: list[dict], **files: object) -> None:
    (state / "search.json").write_text(json.dumps({"items": items}), encoding="utf-8")
    for name, body in files.items():
        (state / name.replace("_", "-", 1).replace("_", ".")).write_text(
            json.dumps(body), encoding="utf-8"
        )


@pytest.fixture
async def world(tmp_path: Path, fake_gh: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo, dry_run=False)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        yield engine


def automation(engine: Engine, **fields) -> Automation:
    values = dict(
        id=uuid.uuid4().hex,
        project_id=engine.boot_project_id,
        name="watch",
        task="Review {{github.repo}}#{{github.number}} at {{github.url}}",
        workflow="quick-task",
        runner="claude",
        every_minutes=5,
        enabled=False,
        next_at=stamp(),
        created_at=stamp(),
        kind="github",
        events=("pull_request.opened",),
        filters={},
    )
    return Automation(**(values | fields))  # type: ignore[arg-type]


# ---- the interval -----------------------------------------------------------------------------


async def test_only_a_schedule_fires_on_the_interval(world: Engine, fake_gh: Path):
    due = (now() - timedelta(minutes=1)).isoformat()
    for kind in ("schedule", "github", "tracker"):
        await world.create_automation(
            automation(
                world,
                kind=kind,
                name=kind,
                task=f"task for {kind}",
                enabled=True,
                next_at=due,
                events=("pull_request.opened",) if kind == "github" else (),
            )
        )
    await world._launch_due()
    tasks = [run.task for run in list_runs(world.db, None, None)]
    assert tasks == ["task for schedule"]
    assert calls(fake_gh) == ""


# ---- the poller -------------------------------------------------------------------------------


def test_opened_events_and_filters_pick_the_matching_items():
    items = [
        item(7, pr=True),
        item(8, pr=True, author="bob"),
        item(9, pr=False),
        item(10, pr=True, labels=("bug", "wip")),
    ]
    result = poll(
        "acme/shop",
        ("pull_request.opened",),
        {"authors": ["Alice"], "excludeLabels": ["wip"]},
        since="2026-01-01",
        gh=canned(items),
    )
    assert [c.number for c in result.candidates] == [7]
    assert result.candidates[0].event_id == f"acme/shop:N7:pull_request.opened:{FUTURE}"
    both = poll(
        "acme/shop",
        ("pull_request.opened", "issue.opened"),
        {},
        since="2026-01-01",
        gh=canned(items),
    )
    assert {c.number for c in both.candidates} == {7, 8, 9, 10}
    other_repo = item(11, pr=True, repository_url="https://api.github.com/repos/acme/other")
    assert (
        poll(
            "acme/shop", ("pull_request.opened",), {}, since="", gh=canned([other_repo])
        ).candidates
        == []
    )


def test_closed_merged_label_and_review_events_come_from_the_search_and_timeline():
    merged = item(
        20,
        pr=True,
        closed_at="2099-01-02T00:00:00Z",
        pull_request={"merged_at": "2099-01-02T00:00:00Z"},
    )
    closed = item(21, pr=True, closed_at="2099-01-03T00:00:00Z")
    out = poll(
        "acme/shop",
        ("pull_request.merged", "pull_request.closed"),
        {},
        since="2026-01-01",
        gh=canned([merged, closed]),
    )
    assert {(c.number, c.event) for c in out.candidates} == {
        (20, "pull_request.merged"),
        (21, "pull_request.closed"),
    }
    only_merged = poll(
        "acme/shop", ("pull_request.merged",), {}, since="", gh=canned([merged, closed])
    )
    assert [c.number for c in only_merged.candidates] == [20]

    timeline = [
        {"event": "commented", "id": 1},
        {
            "event": "labeled",
            "id": 2,
            "created_at": "2099-01-01T01:00:00Z",
            "label": {"name": "go"},
        },
        {
            "event": "labeled",
            "id": 3,
            "created_at": "2099-01-01T02:00:00Z",
            "label": {"name": "other"},
        },
    ]

    def labels_gh(args: list[str]) -> str:
        if any(a.endswith("/timeline") for a in args):
            return json.dumps(timeline)
        return canned([item(30, pr=False, labels=("go", "other"))])(args)

    labeled = poll(
        "acme/shop",
        ("issue.labeled",),
        {"changedLabels": ["go"]},
        since="2026-01-01",
        gh=labels_gh,
    )
    assert [(c.number, c.changed_label) for c in labeled.candidates] == [(30, "go")]
    assert labeled.candidates[0].labels == ("go",)

    reviews = [
        {
            "event": "reviewed",
            "id": 11,
            "submitted_at": "2099-01-01T01:00:00Z",
            "user": {"login": "rev"},
        },
        {
            "event": "review_requested",
            "id": 12,
            "created_at": "2099-01-01T02:00:00Z",
            "requested_reviewer": {"login": "Rev"},
        },
    ]

    def review_gh(args: list[str]) -> str:
        if any(a.endswith("/timeline") for a in args):
            return json.dumps(reviews)
        return canned([item(40, pr=True)])(args)

    got = poll(
        "acme/shop",
        ("pull_request.review_requested", "pull_request.rereview_requested"),
        {"reviewers": ["rev"]},
        since="2026-01-01",
        gh=review_gh,
    )
    assert [c.event for c in got.candidates] == ["pull_request.rereview_requested"]


def test_a_failing_gh_is_an_error_not_a_crash():
    def broken(args: list[str]) -> str:
        raise GhError("rate limited")

    with pytest.raises(GhError, match="rate limited"):
        poll("acme/shop", ("issue.opened",), {}, since="", gh=broken)
    assert matches_filters(
        Candidate("e", "issue.opened", "t", "b", "r", "n", 1, "t", "u", "a"), {"authors": ["a"]}
    )


async def test_a_poll_baselines_then_launches_each_match_once(world: Engine, fake_gh: Path):
    serve(
        fake_gh,
        [item(7, pr=True)],
        pull_7_json={
            "head": {"sha": "a" * 40, "ref": "feature"},
            "base": {"ref": "main"},
        },
    )
    watch = automation(world, filters={"authors": ["alice"]})
    await world.create_automation(watch)
    assert await world.set_automation_enabled(watch.id, True) is None
    stored = get_automation(world.db, watch.id)
    assert stored is not None
    first = await world.poller.check(stored, "poll")
    assert first["launched"] == 1
    runs = list_runs(world.db, None, None)
    assert len(runs) == 1
    run = runs[0]
    assert "acme/shop#7 at https://github.com/acme/shop/pull/7" in run.task
    assert run.autonomous is True
    env = automation_env(run)
    assert env == {
        "CEZ_GITHUB_REPO": "acme/shop",
        "CEZ_GITHUB_NUMBER": "7",
        "CEZ_GITHUB_EVENT": "pull_request.opened",
        "CEZ_PR_HEAD_SHA": "a" * 40,
        "CEZ_PR_HEAD_REF": "feature",
        "CEZ_PR_BASE_REF": "main",
    }
    again = await world.poller.check(stored, "poll")
    assert again["launched"] == 0
    assert len(list_runs(world.db, None, None)) == 1
    assert polling.seen_keys(world.db, watch.id) == {f"acme/shop:N7:pull_request.opened:{FUTURE}"}
    reloaded = get_automation(world.db, watch.id)
    assert reloaded is not None and reloaded.last_run_id == run.id
    entries = polling.list_log(world.db, watch.id)
    assert [e["mode"] for e in entries] == ["poll"]


async def test_an_unseeded_poll_baselines_and_launches_nothing(world: Engine, fake_gh: Path):
    serve(fake_gh, [item(7, pr=True)])
    watch = automation(world, enabled=True)
    await world.create_automation(watch)
    entry = await world.poller.check(watch, "poll")
    assert entry["launched"] == 0 and "baselined" in str(entry["message"])
    assert list_runs(world.db, None, None) == []
    assert polling.get_state(world.db, watch.id) is not None


async def test_the_agent_gets_the_matched_item_in_its_environment(world: Engine, fake_gh: Path):
    serve(
        fake_gh,
        [item(7, pr=True)],
        pull_7_json={"head": {"sha": "b" * 40, "ref": "r"}, "base": {"ref": "main"}},
    )
    watch = automation(world)
    await world.create_automation(watch)
    entry = await world.poller.check(watch, "execute")
    run_id = entry["candidates"][0]["runId"]  # type: ignore[index]
    capture = SpecCapture()
    world.agent = capture
    await world.execute(run_id)
    spec = capture.specs[0]
    assert dict(spec.env)["CEZ_GITHUB_NUMBER"] == "7"
    assert dict(spec.env)["CEZ_PR_HEAD_SHA"] == "b" * 40
    assert (get_run(world.db, run_id) or pytest.fail()).automation["automationId"] == watch.id


async def test_the_tick_polls_a_due_row_and_is_off_in_dry_run(world: Engine, fake_gh: Path):
    serve(fake_gh, [item(7, pr=True)])
    watch = automation(world, enabled=True, next_at=(now() - timedelta(minutes=1)).isoformat())
    await world.create_automation(watch)
    await world.db.write(polling.put_state, watch.id, {"since": "2026-01-01T00:00:00Z"})
    world.config = dataclasses.replace(world.config, dry_run=True)
    await world.poller.tick()
    assert calls(fake_gh) == ""
    world.config = dataclasses.replace(world.config, dry_run=False)
    await world.poller.tick()
    for _ in range(100):
        if list_runs(world.db, None, None):
            break
        await asyncio.sleep(0.05)
    assert len(list_runs(world.db, None, None)) == 1
    moved = get_automation(world.db, watch.id)
    assert moved is not None and moved.next_at > stamp()


async def test_a_poll_error_is_logged_and_a_failed_launch_can_be_retried(
    world: Engine, fake_gh: Path, monkeypatch: pytest.MonkeyPatch
):
    watch = automation(world, workflow="quick-task")
    await world.create_automation(watch)
    serve(fake_gh, [item(7, pr=True)])
    broken = dataclasses.replace(watch, workflow="no-such-workflow")
    await world.db.write(save_automation, broken)
    entry = await world.poller.check(broken, "execute")
    row = entry["candidates"][0]  # type: ignore[index]
    assert row["status"] == "launch-error" and "no-such-workflow" in row["error"]
    assert list_runs(world.db, None, None) == []
    # fix the workflow, then retry the same entry
    await world.db.write(save_automation, watch)
    retried, reason, status = await world.retry_automation_log(watch.id, str(entry["id"]))
    assert reason is None and status == 200 and retried is not None
    assert retried["candidates"][0]["status"] == "launched"  # type: ignore[index]
    assert len(list_runs(world.db, None, None)) == 1
    nothing = await world.retry_automation_log(watch.id, str(entry["id"]))
    assert nothing[1] and nothing[2] == 409
    assert (await world.retry_automation_log(watch.id, "0" * 32))[2] == 404

    monkeypatch.setenv("PATH", str(fake_gh.parent / "nowhere"))
    failed = await world.poller.check(watch, "preview")
    assert failed["status"] == "error"


# ---- the API and the screens ------------------------------------------------------------------


@pytest.fixture
async def live(tmp_path: Path, fake_gh: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "repo"
    init_repo(root)
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_REPO", str(root))
    monkeypatch.setenv("CEZ_DRY_RUN", "0")
    async with TestClient(bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321") as c:
        yield c


GITHUB_FORM = {
    "tab": "t1",
    "name": "Review PRs",
    "task": "Review {{github.url}}",
    "every": 5,
    "workflow": "quick-task",
    "kind": "github",
    "events": ["pull_request.opened"],
    "f_authors": "alice, bob",
    "f_maxRecords": "10",
}


async def make(live, **over) -> str:
    created = await live.post("/automations", json=GITHUB_FORM | over)
    assert created.status_code == 200, created.text
    page = await live.get("/automations")
    return re.findall(r"/automations/([0-9a-f]{32})\"", page.text)[-1]


async def test_check_reports_real_matches_and_never_launches_a_preview(live, fake_gh: Path):
    serve(fake_gh, [item(7, pr=True), item(8, pr=True, author="mallory")])
    created = await live.post(
        "/api/v1/automations",
        json={
            "name": "prs",
            "task": "review",
            "everyMinutes": 5,
            "kind": "github",
            "events": ["pull_request.opened"],
            "filters": {"authors": ["alice"]},
        },
    )
    assert created.status_code == 201
    ident = created.json()["id"]
    checked = await live.post(f"/api/v1/automations/{ident}/check", json={})
    body = checked.json()
    assert body["matches"] == 1 and body["launched"] is False and body["mode"] == "preview"
    assert body["candidates"][0]["status"] == "new"
    log = (await live.get("/api/v1/automation-log")).json()["entries"]
    assert log[0]["id"] == body["id"]
    bad = await live.post(
        "/api/v1/automations",
        json={"name": "x", "task": "y", "kind": "github", "events": []},
    )
    assert bad.status_code == 400
    labels = await live.post(
        "/api/v1/automations",
        json={"name": "x", "task": "y", "kind": "github", "events": ["issue.labeled"]},
    )
    assert labels.status_code == 400


async def test_the_new_detail_and_log_screens_load(live, fake_gh: Path):
    new = await live.get("/automations/new")
    assert new.status_code == 200
    assert "GitHub events" in new.text and "Pull request opened" in new.text
    assert "Target status" in new.text
    ident = await make(live)
    detail = await live.get(f"/automations/{ident}")
    assert detail.status_code == 200
    assert "Review PRs" in detail.text and "pull_request.opened" in detail.text
    log = await live.get(f"/automations/{ident}/log")
    assert log.status_code == 200 and "Nothing has run yet." in log.text
    assert (await live.get("/automations/" + "0" * 32)).status_code == 404
    assert (await live.get("/automations/nope/log")).status_code == 404
    assert (await live.get("/automations")).status_code == 200


async def test_create_and_edit_commands_validate_and_repaint(live, fake_gh: Path):
    for bad in (
        {"events": []},
        {"events": ["issue.labeled"]},
        {"events": ["nope.event"]},
        {"every": 0},
        {"kind": "carrier-pigeon"},
        {"name": ""},
        {"f_maxRecords": "500"},
        {"workflow": "ghost"},
    ):
        assert (await live.post("/automations", json=GITHUB_FORM | bad)).status_code == 400, bad
    ident = await make(live)
    stored = (await live.get(f"/api/v1/automations/{ident}")).json()
    assert stored["kind"] == "github" and stored["filters"]["authors"] == ["alice", "bob"]
    assert stored["filters"]["maxRecords"] == 10 and stored["enabled"] is False
    async with live.stream("GET", f"/automations/{ident}/live", params=TAB, timeout=5) as stream:
        data = ""
        events = stream.iter_events()
        assert "Review PRs" in (await asyncio.wait_for(anext(events), 5))["data"]
        update = await live.post(
            f"/automations/{ident}/update",
            json=GITHUB_FORM | {"name": "Renamed", "events": ["issue.opened"], "f_authors": ""},
        )
        assert update.status_code == 200
        for _ in range(20):
            data = (await asyncio.wait_for(anext(events), 5))["data"]
            if "Renamed" in data:
                break
        assert "Renamed" in data
    after = (await live.get(f"/api/v1/automations/{ident}")).json()
    assert after["revision"] == 2 and after["events"] == ["issue.opened"]
    assert after["filters"].get("authors") is None
    rejected = await live.post(f"/automations/{ident}/update", json=GITHUB_FORM | {"events": []})
    assert rejected.status_code == 400
    assert (
        await live.post("/automations/" + "0" * 32 + "/update", json=GITHUB_FORM)
    ).status_code == 404
    tracker = await live.post(
        "/automations",
        json=GITHUB_FORM | {"kind": "tracker", "t_status": "To Do", "name": "jira"},
    )
    assert tracker.status_code == 200
    no_status = await live.post("/automations", json=GITHUB_FORM | {"kind": "tracker"})
    assert no_status.status_code == 400


async def test_check_and_retry_commands_repaint_the_log_stream(live, fake_gh: Path):
    serve(fake_gh, [item(7, pr=True, author="alice")])
    ident = await make(live)
    async with live.stream(
        "GET", f"/automations/{ident}/log/live", params=TAB, timeout=5
    ) as stream:
        data = ""
        events = stream.iter_events()
        assert "Nothing has run yet." in (await asyncio.wait_for(anext(events), 5))["data"]
        sent = await live.post(f"/automations/{ident}/check?mode=preview", json={"tab": "t1"})
        assert sent.status_code == 204
        for _ in range(20):
            data = (await asyncio.wait_for(anext(events), 5))["data"]
            if "1 match(es)" in data:
                break
        assert "1 match(es)" in data and "preview" in data
        assert "acme/shop#7" in data
    entries = (await live.get("/api/v1/automation-log")).json()["entries"]
    detail = await live.get(f"/automations/{ident}/log?entry={entries[0]['id']}")
    assert "open" in detail.text and "acme/shop#7" in detail.text
    assert (
        await live.post(f"/automations/{ident}/check?mode=bogus", json={"tab": "t1"})
    ).status_code == 400
    assert (await live.post(f"/automations/{ident}/check", json={})).status_code == 400
    assert (
        await live.post(f"/automations/{ident}/log/{'0' * 32}/retry", json={"tab": "t1"})
    ).status_code == 404
    assert (
        await live.post(f"/automations/{ident}/log/{entries[0]['id']}/retry", json={"tab": "t1"})
    ).status_code == 409


async def test_a_schedule_cannot_be_checked_from_the_screen(live):
    created = await live.post(
        "/automations",
        json={"tab": "t1", "name": "n", "task": "t", "every": 60, "workflow": "quick-task"},
    )
    assert created.status_code == 200
    ident = re.findall(r"/automations/([0-9a-f]{32})\"", (await live.get("/automations")).text)[-1]
    assert (await live.post(f"/automations/{ident}/check", json={"tab": "t1"})).status_code == 409
    api = await live.post(f"/api/v1/automations/{ident}/check", json={})
    assert api.json()["matches"] == 0 and "no event filter" in api.json()["message"]


# ---- GitHub Enterprise and checkout: pr-head ---------------------------------------------------


def git_run(cwd: Path, *args: str) -> str:
    done = subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)
    return done.stdout.strip()


def pull_request(sha: str, *, state: str = "open", head_repo: str | None = "acme/shop") -> dict:
    return {
        "state": state,
        "html_url": "https://github.com/acme/shop/pull/7",
        "head": {
            "sha": sha,
            "ref": "feature",
            "repo": {"full_name": head_repo} if head_repo else None,
        },
        "base": {"ref": "main"},
    }


@pytest.fixture
def pr_origin(world: Engine, tmp_path: Path) -> str:
    """`origin` is a bare repo that serves `refs/pull/7/head`. Returns that head's sha."""
    repo = world.config.repo_root
    bare = tmp_path / "origin.git"
    git_run(tmp_path, "init", "--bare", "-b", "main", str(bare))
    git_run(repo, "remote", "add", "origin", str(bare))
    git_run(repo, "push", "origin", "main")
    author = tmp_path / "author"
    git_run(tmp_path, "clone", str(bare), str(author))
    git_run(author, "config", "user.email", "t@example.com")
    git_run(author, "config", "user.name", "Test")
    (author / "pr.txt").write_text("the pull request\n", encoding="utf-8")
    git_run(author, "add", "pr.txt")
    git_run(author, "-c", "commit.gpgsign=false", "commit", "-m", "pr work")
    sha = git_run(author, "rev-parse", "HEAD")
    git_run(author, "push", "origin", "HEAD:refs/pull/7/head")
    return sha


async def launch_pr(world: Engine, fake_gh: Path, sha: str, **filters: object):
    serve(fake_gh, [item(7, pr=True)], pull_7_json=pull_request(sha))
    watch = automation(world, filters={"checkout": "pr-head"} | filters)
    await world.create_automation(watch)
    return watch, await world.poller.check(watch, "execute")


async def test_pr_head_forks_the_worktree_from_the_pull_request(
    world: Engine, fake_gh: Path, pr_origin: str
):
    watch, entry = await launch_pr(world, fake_gh, pr_origin)
    assert entry["launched"] == 1, entry
    run = get_run(world.db, str(entry["candidates"][0]["runId"]))  # type: ignore[index]
    assert run is not None and run.base_branch == pr_origin and run.in_place is False
    assert run.automation["prHead"] == {
        "number": 7,
        "repo": "acme/shop",
        "headRepo": "acme/shop",
        "headRef": "feature",
        "headSha": pr_origin,
        "baseRef": "main",
        "ref": "refs/cezar/pr/7",
        "url": "https://github.com/acme/shop/pull/7",
        "untrusted": False,
    }
    assert "untrustedHead" not in run.automation
    assert automation_env(run)["CEZ_PR_HEAD_SHA"] == pr_origin
    repo = world.config.repo_root
    assert git_run(repo, "rev-parse", "refs/cezar/pr/7") == pr_origin
    prepared = await world._prepare(run)
    worktree = Path(prepared.worktree_path)
    assert git_run(worktree, "rev-parse", "HEAD") == pr_origin
    assert (worktree / "pr.txt").is_file()
    assert prepared.base_sha == pr_origin
    # The PR's commit is the fork point, so the run's diff is its own work, not the PR.
    published, reason = await world.open_draft_pr(run.id)
    assert published is None and reason is not None
    assert reason == "run is still active — wait for the review gate"
    finished = get_run(world.db, run.id) or run
    finished.status = "done"
    await world._save(finished)
    _published, reason = await world.open_draft_pr(run.id)
    assert reason == (
        "this run verified pull request #7; publishing its changes is not supported yet"
    )


async def test_pr_head_skips_a_closed_pull_request_and_an_unadmitted_fork(
    world: Engine, fake_gh: Path, pr_origin: str
):
    serve(fake_gh, [item(7, pr=True)], pull_7_json=pull_request(pr_origin, state="closed"))
    watch = automation(world, filters={"checkout": "pr-head"})
    await world.create_automation(watch)
    entry = await world.poller.check(watch, "execute")
    row = entry["candidates"][0]  # type: ignore[index]
    assert (entry["launched"], row["status"], row["error"]) == (
        0,
        "skipped",
        "skipped: pr-not-open",
    )
    assert list_runs(world.db, None, None) == []

    serve(fake_gh, [item(7, pr=True)], pull_7_json=pull_request(pr_origin, head_repo="evil/shop"))
    other = automation(world, filters={"checkout": "pr-head"}, name="fork")
    await world.create_automation(other)
    entry = await world.poller.check(other, "execute")
    assert entry["candidates"][0]["error"] == "skipped: fork-head"  # type: ignore[index]
    assert list_runs(world.db, None, None) == []

    admitted = automation(
        world, filters={"checkout": "pr-head", "allowForkHeads": True}, name="admit"
    )
    await world.create_automation(admitted)
    entry = await world.poller.check(admitted, "execute")
    assert entry["launched"] == 1, entry
    run = list_runs(world.db, None, None)[0]
    assert run.automation["untrustedHead"] is True
    assert run.automation["prHead"]["untrusted"] is True  # type: ignore[index]


async def test_pr_head_fails_the_launch_when_the_head_cannot_be_reached(
    world: Engine, fake_gh: Path, pr_origin: str
):
    serve(fake_gh, [item(7, pr=True)])  # no pull-7.json: the fake `gh api` exits 1
    watch = automation(world, filters={"checkout": "pr-head"})
    await world.create_automation(watch)
    entry = await world.poller.check(watch, "execute")
    row = entry["candidates"][0]  # type: ignore[index]
    assert row["status"] == "launch-error"
    assert row["error"].startswith("pr-head-unavailable: could not read the pull request")
    assert list_runs(world.db, None, None) == []

    wrong = "c" * 40
    serve(fake_gh, [item(7, pr=True)], pull_7_json=pull_request(wrong))
    moved = automation(world, filters={"checkout": "pr-head"}, name="moved")
    await world.create_automation(moved)
    entry = await world.poller.check(moved, "execute")
    assert entry["launched"] == 1
    run = list_runs(world.db, None, None)[0]
    assert run.base_branch == pr_origin  # the fetched head wins over the API's
    notes = [e for e in list_events(world.db, run.id) if "moved while launching" in str(e)]
    assert notes


async def test_an_untrusted_head_runs_its_checks_without_credentials(world: Engine):
    from app.engine.model import Step
    from app.secrets.store import SecretStore

    SecretStore(world.config.data_dir / "secrets").set(
        world.boot_project_id, "TOKEN_X", "s3cret-value-123", root=str(world.config.repo_root)
    )
    run = Run(
        id=uuid.uuid4().hex,
        project_id=world.boot_project_id,
        title="t",
        task="t",
        workflow="quick-task",
        status="running",
        runner="claude",
        created_at=stamp(),
        worktree_path=str(world.config.repo_root),
        workflow_def={},
        automation={"untrustedHead": True},
    )
    step = Step(id="c", name="c", command='printf %s "${TOKEN_X:-none}"')
    _code, output = await world._run_check(run, step, asyncio.Event())
    trusted = dataclasses.replace(run, automation={})
    _code, trusted_output = await world._run_check(trusted, step, asyncio.Event())
    assert output.strip() == "none"
    assert trusted_output.strip() not in ("none", "")  # the value was bound, then masked


def test_pr_head_definitions_are_validated():
    from app.integrations.github_poll import definition_issue

    opened = ("pull_request.opened",)
    assert definition_issue("github", opened, {"checkout": "pr-head"}) is None
    assert definition_issue("github", opened, {"checkout": "base"}) is None
    assert definition_issue("github", opened, {"checkout": "tag"})
    assert definition_issue("github", ("issue.opened",), {"checkout": "pr-head"})
    assert definition_issue("github", ("pull_request.merged",), {"checkout": "pr-head"})
    assert definition_issue("github", opened, {"allowForkHeads": True})
    assert definition_issue("github", opened, {"checkout": "pr-head", "allowForkHeads": "y"})
    assert (
        definition_issue("github", opened, {"checkout": "pr-head", "allowForkHeads": True}) is None
    )


async def test_the_automation_form_saves_the_pr_head_options(world: Engine):
    from app.features.automations.data import parse_form
    from app.store.db import get_project

    project = get_project(world.db, world.boot_project_id)
    assert project is not None
    base = GITHUB_FORM | {"kind": "github", "events": ["pull_request.opened"]}
    form, issue = parse_form(base | {"f_prHead": True, "f_allowForkHeads": True}, project, "claude")
    assert form is not None, issue
    assert form.filters["checkout"] == "pr-head" and form.filters["allowForkHeads"] is True
    plain, _ = parse_form(base, project, "claude")
    assert plain is not None and "checkout" not in plain.filters
    closed = base | {"events": ["pull_request.closed"], "f_prHead": True}
    assert parse_form(closed, project, "claude")[0] is None


async def test_a_github_enterprise_remote_passes_its_host_to_gh_api(world: Engine, fake_gh: Path):
    repo = world.config.repo_root
    git_run(repo, "remote", "add", "origin", "git@acme.ghe.com:acme/shop.git")
    serve(fake_gh, [item(7, pr=True)], pull_7_json=pull_request("a" * 40))
    watch = automation(world, filters={"repo": "acme/shop"})
    await world.create_automation(watch)
    entry = await world.poller.check(watch, "execute")
    log = calls(fake_gh)
    api_calls = [line for line in log.splitlines() if line.startswith("api ")]
    assert api_calls and all(line.startswith("api --hostname acme.ghe.com ") for line in api_calls)
    assert any("/search/issues" in line for line in api_calls)
    # Enterprise repository URLs are `https://api.<sub>.ghe.com/repos/...`: they still match.
    assert entry["matches"] == 1 and entry["launched"] == 1
    assert any("pulls/7" in line for line in api_calls)


async def test_a_github_dot_com_remote_adds_no_hostname(world: Engine, fake_gh: Path):
    git_run(world.config.repo_root, "remote", "add", "origin", "git@github.com:acme/shop.git")
    serve(fake_gh, [item(7, pr=True)])
    watch = automation(world, filters={"repo": "acme/shop"})
    await world.create_automation(watch)
    await world.poller.check(watch, "execute")
    assert "--hostname" not in calls(fake_gh)
