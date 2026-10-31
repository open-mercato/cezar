"""Routes a session hits after the run exists: config, continue, files, reclaim."""

import asyncio
from pathlib import Path

import pytest


async def _done_run(client) -> str:
    created = await client.post(
        "/api/v1/runs",
        json={"task": "write a note", "workflow": "quick-task"},
    )
    assert created.status_code == 201
    run_id = created.json()["id"]
    status = ""
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status in ("done", "review", "failed"):
            break
        await asyncio.sleep(0.05)
    assert status == "done"
    return run_id


async def test_launch_key_config_files_and_reclaim(client, repo: Path, tmp_path: Path):
    first = await client.get("/api/v1/launch-key")
    assert first.status_code == 200
    key = first.json()["key"]
    assert key and (await client.get("/api/v1/launch-key")).json()["key"] == key
    assert (tmp_path / "data" / "launch-key").stat().st_mode & 0o777 == 0o600

    saved = await client.put(
        "/api/v1/config",
        json={
            "systemPrompt": "be brief",
            "branchNaming": "start with feature/",
            "reviewGate": False,
        },
    )
    assert saved.status_code == 200
    assert saved.json()["systemPrompt"] == "be brief"
    assert saved.json()["reviewGate"] is False
    assert "be brief" in (repo / ".ai" / "cezar" / "config.json").read_text(encoding="utf-8")

    run_id = await _done_run(client)
    files = await client.get(f"/api/v1/runs/{run_id}/files")
    assert "CEZAR_DRY_RUN.txt" in files.json()["files"]
    commits = await client.get(f"/api/v1/runs/{run_id}/commits")
    assert any("init" in line for line in commits.json()["commits"])
    removed = await client.post(f"/api/v1/runs/{run_id}/remove-worktree")
    assert removed.status_code == 200
    assert removed.json()["removed"] is True
    record = (await client.get(f"/api/v1/runs/{run_id}")).json()
    assert not Path(record["worktreePath"]).exists()
    reclaimed = await client.post("/api/v1/worktrees/reclaim")
    assert reclaimed.status_code == 200
    assert isinstance(reclaimed.json()["reclaimed"], list)


async def test_continue_requeues_a_review_and_the_terminal_can_be_disabled(
    client, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("CEZ_REVIEW_GATE", "1")
    created = await client.post(
        "/api/v1/runs",
        json={"task": "park this", "workflow": "quick-task"},
    )
    run_id = created.json()["id"]
    status = ""
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status in ("review", "done", "failed"):
            break
        await asyncio.sleep(0.05)
    assert status == "review"
    continued = await client.post(
        f"/api/v1/runs/{run_id}/continue",
        json={"message": "one more pass"},
    )
    assert continued.status_code == 200
    record = (await client.get(f"/api/v1/runs/{run_id}")).json()
    path = Path(record["worktreePath"]) / "CEZAR_DRY_RUN.txt"
    text = ""
    for _ in range(40):
        if path.is_file():
            text = path.read_text(encoding="utf-8")
            if "one more pass" in text:
                break
        await asyncio.sleep(0.05)
    assert "one more pass" in text
    monkeypatch.setenv("CEZ_TERMINAL", "0")
    refused = await client.post(f"/api/v1/runs/{run_id}/terminal")
    assert refused.status_code == 409
    assert refused.json()["error"] == "terminal is disabled"
