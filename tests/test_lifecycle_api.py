"""Removal operations: scripts run, a failure keeps the directory, keep releases it."""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

from app.features.api.urls import API_RUNS_CREATE


def _revision(operation: dict[str, object]) -> int:
    raw = operation["revision"]
    assert type(raw) is int
    return raw


def _script(command: str) -> dict[str, str]:
    return {"id": str(uuid.uuid4()), "command": command}


def _write_hooks(repo: Path, *commands: str) -> None:
    path = repo / ".ai" / "cezar" / "config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "worktreeLifecycle": {
                    "afterCreate": [],
                    "beforeRemove": [_script(command) for command in commands],
                }
            }
        ),
        encoding="utf-8",
    )


async def _done_run(client) -> str:
    created = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "leave a worktree", "workflow": "quick-task"},
    )
    assert created.status_code == 201
    run_id = created.json()["id"]
    status = ""
    for _ in range(40):
        body = (await client.get(f"/api/v1/runs/{run_id}")).json()
        status = body["status"]
        if status in ("done", "review", "failed"):
            assert body["worktreePath"]
            break
        await asyncio.sleep(0.05)
    assert status == "done"
    return run_id


async def _operation(client, operation_id: str, states: set[str]) -> dict[str, object]:
    last: dict[str, object] = {}
    for _ in range(50):
        response = await client.get(f"/api/v1/worktree-lifecycle/operations/{operation_id}")
        assert response.status_code == 200
        last = response.json()["operation"]
        if last["state"] in states:
            return last
        await asyncio.sleep(0.05)
    raise AssertionError(last)


async def test_a_failing_hook_keeps_the_directory_until_keep(client, repo, monkeypatch):
    monkeypatch.setenv("CEZ_DRY_RUN", "0")
    run_id = await _done_run(client)
    record = (await client.get(f"/api/v1/runs/{run_id}")).json()
    worktree = Path(record["worktreePath"])
    _write_hooks(repo, "printf fixture-output; exit 2")
    refused = await client.post(f"/api/v1/runs/{run_id}/remove-worktree")
    assert refused.status_code == 409
    assert "/worktree-lifecycle/operations" in refused.json()["error"]
    assert worktree.is_dir()
    request_id = str(uuid.uuid4())
    body = {"requestId": request_id, "runId": run_id, "intent": "remove-worktree"}
    started = await client.post("/api/v1/worktree-lifecycle/operations", json=body)
    assert started.status_code == 202
    operation_id = started.json()["operation"]["id"]
    operation = await _operation(client, operation_id, {"needs_attention"})
    assert operation["failureStage"] == "command"
    blocked = await client.post(
        f"/api/v1/runs/{run_id}/git/commit",
        json={"message": "must not commit"},
    )
    assert blocked.status_code == 409
    assert "lifecycle" in blocked.json()["error"]
    output = await client.get(
        f"/api/v1/worktree-lifecycle/operations/{operation_id}/output",
        params={"afterSeq": "0", "limit": "20"},
    )
    assert output.status_code == 200
    assert "fixture-output" in "".join(item["text"] for item in output.json()["items"])
    stale = await client.post(
        f"/api/v1/worktree-lifecycle/operations/{operation_id}/actions",
        json={
            "requestId": str(uuid.uuid4()),
            "expectedRevision": _revision(operation) - 1,
            "action": "force-delete",
        },
    )
    assert stale.status_code == 409
    duplicate = await client.post("/api/v1/worktree-lifecycle/operations", json=body)
    assert duplicate.status_code == 202
    assert duplicate.json()["operation"]["id"] == operation_id
    clash = await client.post(
        "/api/v1/worktree-lifecycle/operations",
        json={**body, "intent": "delete-task"},
    )
    assert clash.status_code == 409
    kept = await client.post(
        f"/api/v1/worktree-lifecycle/operations/{operation_id}/actions",
        json={
            "requestId": str(uuid.uuid4()),
            "expectedRevision": _revision(operation),
            "action": "keep-worktree",
        },
    )
    assert kept.status_code == 202
    assert kept.json()["operation"]["state"] == "kept"
    assert worktree.is_dir()


async def test_force_delete_removes_the_directory_and_preview_does_not_run(
    client, repo, monkeypatch
):
    monkeypatch.setenv("CEZ_DRY_RUN", "0")
    run_id = await _done_run(client)
    worktree = Path((await client.get(f"/api/v1/runs/{run_id}")).json()["worktreePath"])
    _write_hooks(repo, "exit 2")
    started = await client.post(
        "/api/v1/worktree-lifecycle/operations",
        json={"requestId": str(uuid.uuid4()), "runId": run_id, "intent": "remove-worktree"},
    )
    operation_id = started.json()["operation"]["id"]
    assert isinstance(operation_id, str)
    operation = await _operation(client, operation_id, {"needs_attention"})
    removed = await client.post(
        f"/api/v1/worktree-lifecycle/operations/{operation_id}/actions",
        json={
            "requestId": str(uuid.uuid4()),
            "expectedRevision": _revision(operation),
            "action": "force-delete",
        },
    )
    assert removed.status_code == 202
    settled = await _operation(client, operation_id, {"completed", "needs_attention"})
    assert settled["state"] == "completed"
    assert not worktree.exists()
    preview = await client.post(
        "/api/v1/worktree-lifecycle/preview",
        json={"command": "printf %s {{ root_path }}/test"},
    )
    assert preview.status_code == 200
    shown = preview.json()
    assert shown["illustrative"] is True
    assert shown["cwd"] == "/example/project/.ai/cezar/worktrees/example-task"
    assert "/example/project" in shown["renderedCommand"]
    quoted = await client.post(
        "/api/v1/worktree-lifecycle/preview",
        json={"command": 'echo "{{ root_path }}"'},
    )
    assert quoted.status_code == 400
    unknown = await client.post(
        "/api/v1/worktree-lifecycle/preview",
        json={"command": "echo {{ unknown }}"},
    )
    assert unknown.status_code == 400
    missing = await client.get(f"/api/v1/worktree-lifecycle/operations/{uuid.uuid4()}")
    assert missing.status_code == 404
    missing_id = uuid.uuid4()
    missing_output = await client.get(f"/api/v1/worktree-lifecycle/operations/{missing_id}/output")
    assert missing_output.status_code == 404
    bad = await client.post(
        "/api/v1/worktree-lifecycle/operations",
        json={"requestId": str(uuid.uuid4()), "runId": run_id, "intent": "orphan", "path": "/tmp"},
    )
    assert bad.status_code == 400


async def test_hook_free_remove_still_deletes_the_worktree(client, repo):
    run_id = await _done_run(client)
    worktree = Path((await client.get(f"/api/v1/runs/{run_id}")).json()["worktreePath"])
    assert not (repo / ".ai" / "cezar" / "config.json").exists()
    removed = await client.post(f"/api/v1/runs/{run_id}/remove-worktree")
    assert removed.status_code == 200
    assert removed.json() == {"removed": True}
    assert not worktree.exists()
