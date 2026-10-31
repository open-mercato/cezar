import asyncio
from pathlib import Path

import pytest
from litewriter import LiteWriter
from stario import Relay
from tests.conftest import init_repo
from tests.test_engine import config_for

from app.clock import stamp
from app.engine.engine import Engine
from app.engine.graph import fork_shape
from app.engine.model import Settings
from app.engine.workflows import parse_workflow
from app.store.db import get_project, get_run, list_children, save_run, schema


@pytest.fixture
async def world(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        yield engine


def _graph(body: dict[str, object]):
    workflow, issue = parse_workflow(body, source="file")
    assert workflow is not None, issue
    return workflow


async def _go(engine: Engine, body: dict[str, object]):
    project = get_project(engine.db, engine.boot_project_id)
    assert project is not None
    run, reason = engine.plan_run(
        project=project, task="graph", workflow_name="g", runner="claude", workflow=_graph(body)
    )
    assert run is not None, reason
    await engine.enqueue(run)
    await engine.execute(run.id)
    stored = get_run(engine.db, run.id)
    assert stored is not None
    return stored


def test_a_fork_that_does_not_meet_at_one_join_is_rejected():
    graph = {
        "nodes": [
            {"id": "split", "type": "fork", "branches": 2},
            {"id": "a", "type": "agent", "prompt": "a"},
        ],
        "edges": [{"from": "split.1", "to": "a"}],
    }
    assert "wire its done port" in str(fork_shape(graph, "split"))


async def test_a_fork_waits_for_both_branches_and_reviews(world: Engine):
    await world.save_workspace(Settings(max_parallel=1))
    stored = await _go(
        world,
        {
            "name": "g",
            "version": 2,
            "nodes": [
                {"id": "start", "type": "start"},
                {"id": "split", "type": "fork", "branches": 2},
                {"id": "a", "type": "agent", "prompt": "{{task}} a"},
                {"id": "b", "type": "agent", "prompt": "{{task}} b"},
                {"id": "meet", "type": "join", "wait": "all"},
                {"id": "ok", "type": "end", "status": "success"},
            ],
            "edges": [
                {"from": "start", "to": "split"},
                {"from": "split.1", "to": "a"},
                {"from": "split.2", "to": "b"},
                {"from": "a.done", "to": "meet"},
                {"from": "a.failed", "to": "meet"},
                {"from": "b.done", "to": "meet"},
                {"from": "b.failed", "to": "meet"},
                {"from": "meet.done", "to": "ok"},
            ],
        },
    )
    assert stored.status == "done"
    children = list_children(world.db, stored.id)
    assert len(children) == 2
    assert {child.status for child in children} == {"done"}


async def test_dispatch_and_git_and_a_dry_run_draft_pr(world: Engine):
    dispatched = await _go(
        world,
        {
            "name": "g",
            "version": 2,
            "nodes": [
                {"id": "start", "type": "start"},
                {"id": "prep", "type": "agent", "prompt": "{{task}}"},
                {"id": "sub", "type": "dispatch", "prompt": "look at {{task}}"},
                {"id": "ok", "type": "end", "status": "success"},
            ],
            "edges": [
                {"from": "start", "to": "prep"},
                {"from": "prep.done", "to": "sub"},
                {"from": "sub.done", "to": "ok"},
            ],
        },
    )
    assert dispatched.status == "done"

    committed = await _go(
        world,
        {
            "name": "g",
            "version": 2,
            "nodes": [
                {"id": "start", "type": "start"},
                {"id": "touch", "type": "check", "command": "printf hi > note.txt"},
                {"id": "save", "type": "git.commit", "message": "save the note"},
                {"id": "ok", "type": "end", "status": "success"},
            ],
            "edges": [
                {"from": "start", "to": "touch"},
                {"from": "touch.pass", "to": "save"},
                {"from": "save.done", "to": "ok"},
            ],
        },
    )
    assert committed.status == "done"

    opened = await _go(
        world,
        {
            "name": "g",
            "version": 2,
            "nodes": [
                {"id": "start", "type": "start"},
                {"id": "ready", "type": "check", "command": "true"},
                {"id": "pr", "type": "github.draft-pr", "title": "Draft"},
                {"id": "ok", "type": "end", "status": "success"},
            ],
            "edges": [
                {"from": "start", "to": "ready"},
                {"from": "ready.pass", "to": "pr"},
                {"from": "pr.created", "to": "ok"},
            ],
        },
    )
    assert opened.status == "done"
    assert opened.pull_request_url == "https://github.com/open-mercato/demo/pull/777"


async def test_a_message_during_the_turn_is_delivered_when_it_ends(world: Engine):
    from tests.test_engine import GateAgent

    gate = GateAgent()
    world.agent = gate
    project = get_project(world.db, world.boot_project_id)
    assert project is not None
    run, reason = world.plan_run(
        project=project, task="hold", workflow_name="quick-task", runner="claude"
    )
    assert run is not None, reason
    await world.enqueue(run)
    task = asyncio.create_task(world.execute(run.id))
    await asyncio.wait_for(gate.started.wait(), timeout=2)
    assert world.defer_message(run.id, "while it ran")
    gate.release.set()
    await asyncio.wait_for(task, timeout=2)
    stored = get_run(world.db, run.id)
    assert stored is not None
    assert stored.status == "queued"
    assert stored.continuation == "while it ran"


def _ci_graph() -> dict[str, object]:
    return {
        "name": "g",
        "version": 2,
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "ready", "type": "check", "command": "true"},
            {"id": "ci", "type": "github.wait-ci", "timeoutMs": 1000},
            {"id": "ok", "type": "end", "status": "success"},
        ],
        "edges": [
            {"from": "start", "to": "ready"},
            {"from": "ready.pass", "to": "ci"},
            {"from": "ci.green", "to": "ok"},
        ],
    }


async def test_wait_ci_fails_without_a_pr_and_is_green_in_a_dry_run(world: Engine):
    failed = await _go(world, _ci_graph())
    assert failed.status == "failed"
    project = get_project(world.db, world.boot_project_id)
    assert project is not None
    run, reason = world.plan_run(
        project=project,
        task="ci",
        workflow_name="g",
        runner="claude",
        workflow=_graph(_ci_graph()),
    )
    assert run is not None, reason
    run.pull_request_url = "https://github.com/acme/demo/pull/4"
    await world.enqueue(run)
    from app.store.db import save_run

    await world.db.write(save_run, run)
    await world.execute(run.id)
    stored = get_run(world.db, run.id)
    assert stored is not None and stored.status == "done"


async def test_archive_leaves_a_waiting_run_and_stamps_read_on_done(world: Engine):
    from tests.test_engine import _start

    run = await _start(world, "settle me")
    await world.execute(run.id)
    stored = get_run(world.db, run.id)
    assert stored is not None and stored.status == "done"
    stored.status = "done"
    stored.finished_at = stamp()
    await world.db.write(save_run, stored)
    waiting = await _start(world, "mock:ask the name")
    await world.execute(waiting.id)
    assert (get_run(world.db, waiting.id) or waiting).status == "waiting"
    assert await world.mark_all_read(world.boot_project_id) == 1
    assert (get_run(world.db, run.id) or run).seen_at
    assert await world.archive_finished(world.boot_project_id) == 1
    assert (get_run(world.db, run.id) or run).archived is True
    assert (get_run(world.db, waiting.id) or waiting).archived is False
