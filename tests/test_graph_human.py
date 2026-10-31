import asyncio
import json
from pathlib import Path

import pytest
from litewriter import LiteWriter
from stario import Relay
from tests.conftest import init_repo
from tests.test_engine import config_for
from tests.test_graph_nodes import _go, _graph

from app.engine.engine import Engine
from app.features.api.urls import API_RUNS_CREATE
from app.features.task.urls import TASK, TASK_APPROVE, TASK_MESSAGE, TASK_REJECT
from app.store.db import get_project, get_run, list_children, schema


@pytest.fixture
async def world(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        yield engine


def _gate_graph(**extra: object) -> dict[str, object]:
    graph: dict[str, object] = {
        "name": "gate",
        "version": 2,
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "ok", "type": "end", "status": "success"},
            {"id": "no", "type": "end", "status": "failed"},
            {"id": "ready", "type": "check", "command": "true"},
            {"id": "ask", "type": "gate.human", "message": "ship {{task}}?", **extra},
        ],
        "edges": [
            {"from": "start", "to": "ready"},
            {"from": "ready.pass", "to": "ask"},
            {"from": "ask.approve", "to": "ok"},
            {"from": "ask.reject", "to": "no"},
        ],
    }
    if extra:
        edges = graph["edges"]
        assert isinstance(edges, list)
        edges.append({"from": "ask.timeout", "to": "no"})
    return graph


def _answer_graph() -> dict[str, object]:
    return {
        "name": "answer",
        "version": 2,
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "ready", "type": "check", "command": "true"},
            {"id": "q", "type": "ask-user", "question": "which name?"},
            {"id": "echo", "type": "check", "command": "test '{{nodes.q.answer}}' = blue"},
            {"id": "ok", "type": "end", "status": "success"},
        ],
        "edges": [
            {"from": "start", "to": "ready"},
            {"from": "ready.pass", "to": "q"},
            {"from": "q.answered", "to": "echo"},
            {"from": "echo.pass", "to": "ok"},
        ],
    }


async def _resume(engine: Engine, run_id: str):
    await engine.execute(run_id)
    stored = get_run(engine.db, run_id)
    assert stored is not None
    return stored


async def test_a_gate_parks_then_approve_routes_the_approve_port(world: Engine):
    parked = await _go(world, _gate_graph())
    assert parked.status == "waiting"
    assert parked.ask == "ship graph?"
    assert parked.graph_park["kind"] == "gate.human"
    assert await world.deliver(parked.id, "yes") == "approve or reject this gate"
    assert await world.resolve_park(parked.id, "ask-user", "answered") is not None
    assert await world.resolve_park(parked.id, "gate.human", "approve", "go") is None
    final = await _resume(world, parked.id)
    assert final.status == "done"
    assert not final.graph_park


async def test_a_gate_reject_routes_the_reject_port(world: Engine):
    parked = await _go(world, _gate_graph())
    assert await world.resolve_park(parked.id, "gate.human", "reject", "no") is None
    final = await _resume(world, parked.id)
    assert final.status == "failed"
    assert final.error == "the graph ended on a failure port"


async def test_a_parked_gate_survives_a_restart_and_a_timeout_routes_timeout(
    world: Engine, tmp_path: Path
):
    parked = await _go(world, _gate_graph(timeoutMs=60_000))
    assert parked.status == "waiting" and parked.graph_park["deadline"]
    fresh = Engine(world.db, Relay(), world.config)
    again = get_run(fresh.db, parked.id)
    assert again is not None and again.status == "waiting"
    again.graph_park = {**again.graph_park, "deadline": "2000-01-01T00:00:00+00:00"}
    from app.store.db import save_run

    await fresh.db.write(save_run, again)
    await fresh._expire_parks()
    queued = get_run(fresh.db, parked.id)
    assert queued is not None and queued.status == "queued"
    final = await _resume(fresh, parked.id)
    assert final.status == "failed"


async def test_ask_user_resumes_on_answered_with_the_answer_as_output(world: Engine):
    parked = await _go(world, _answer_graph())
    assert parked.status == "waiting" and parked.ask == "which name?"
    assert await world.resolve_park(parked.id, "gate.human", "approve") is not None
    assert await world.deliver(parked.id, "blue") is None
    final = await _resume(world, parked.id)
    assert final.status == "done"


async def _nested(world: Engine, prompt: str):
    return await _go(
        world,
        {
            "name": "outer",
            "version": 2,
            "nodes": [
                {"id": "start", "type": "start"},
                {"id": "prep", "type": "agent", "prompt": "{{task}}"},
                {"id": "sub", "type": "workflow", "workflow": "quick-task", "prompt": prompt},
                {"id": "ok", "type": "end", "status": "success"},
                {"id": "bad", "type": "end", "status": "failed"},
            ],
            "edges": [
                {"from": "start", "to": "prep"},
                {"from": "prep.done", "to": "sub"},
                {"from": "sub.done", "to": "ok"},
                {"from": "sub.failed", "to": "bad"},
            ],
        },
    )


async def test_a_nested_workflow_runs_as_a_child_and_routes_done(world: Engine):
    stored = await _nested(world, "look around")
    assert stored.status == "done"
    children = list_children(world.db, stored.id)
    assert len(children) == 1
    assert children[0].workflow == "quick-task" and children[0].status in ("done", "review")


async def test_a_nested_workflow_that_fails_routes_failed(world: Engine):
    stored = await _nested(world, "mock:fail")
    assert stored.status == "failed"
    assert stored.error == "the graph ended on a failure port"
    assert [child.status for child in list_children(world.db, stored.id)] == ["failed"]


async def test_an_unknown_nested_workflow_routes_failed(world: Engine):
    graph = _graph(
        {
            "name": "g",
            "version": 2,
            "nodes": [
                {"id": "start", "type": "start"},
                {"id": "prep", "type": "agent", "prompt": "{{task}}"},
                {"id": "sub", "type": "workflow", "workflow": "nope"},
                {"id": "ok", "type": "end", "status": "success"},
            ],
            "edges": [
                {"from": "start", "to": "prep"},
                {"from": "prep.done", "to": "sub"},
                {"from": "sub.done", "to": "ok"},
            ],
        }
    )
    project = get_project(world.db, world.boot_project_id)
    assert project is not None
    run, reason = world.plan_run(
        project=project, task="x", workflow_name="g", runner="claude", workflow=graph
    )
    assert run is not None, reason
    await world.enqueue(run)
    assert (await _resume(world, run.id)).status == "failed"


async def _wait(client, run_id: str, status: str) -> None:
    seen = ""
    for _ in range(200):
        seen = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if seen == status:
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"{run_id} stayed {seen}, wanted {status}")


async def _create(client, repo: Path, graph: dict[str, object]) -> str:
    folder = repo / ".ai" / "cezar" / "workflows"
    folder.mkdir(parents=True)
    (folder / f"{graph['name']}.yaml").write_text(json.dumps(graph), encoding="utf-8")
    created = await client.post(
        API_RUNS_CREATE.href(), json={"task": "x", "workflow": graph["name"], "runner": "claude"}
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


async def test_the_task_page_approves_and_rejects_a_gate(client, repo: Path):
    run_id = await _create(client, repo, _gate_graph())
    await _wait(client, run_id, "waiting")
    page = await client.get(TASK.href(run_id))
    assert TASK_APPROVE.href(run_id) in page.text and TASK_REJECT.href(run_id) in page.text
    assert TASK_MESSAGE.href(run_id) not in page.text
    stray = await client.post(TASK_MESSAGE.href(run_id), json={"tab": "t1", "message": "hi"})
    assert stray.status_code == 409
    approved = await client.post(TASK_APPROVE.href(run_id), json={"tab": "t1", "message": "ok"})
    assert approved.status_code == 200
    await _wait(client, run_id, "done")
    again = await client.post(TASK_APPROVE.href(run_id), json={"tab": "t1"})
    assert again.status_code == 409


async def test_the_task_page_rejects_a_gate_and_answers_an_ask(client, repo: Path):
    run_id = await _create(client, repo, _gate_graph())
    await _wait(client, run_id, "waiting")
    rejected = await client.post(TASK_REJECT.href(run_id), json={"tab": "t1"})
    assert rejected.status_code == 200
    await _wait(client, run_id, "failed")

    ask_id = await _create_second(client, repo, _answer_graph())
    await _wait(client, ask_id, "waiting")
    no_gate = await client.post(TASK_APPROVE.href(ask_id), json={"tab": "t1"})
    assert no_gate.status_code == 409
    sent = await client.post(TASK_MESSAGE.href(ask_id), json={"tab": "t1", "message": "blue"})
    assert sent.status_code == 200
    await _wait(client, ask_id, "done")


async def _create_second(client, repo: Path, graph: dict[str, object]) -> str:
    folder = repo / ".ai" / "cezar" / "workflows"
    (folder / f"{graph['name']}.yaml").write_text(json.dumps(graph), encoding="utf-8")
    created = await client.post(
        API_RUNS_CREATE.href(), json={"task": "x", "workflow": graph["name"], "runner": "claude"}
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]
