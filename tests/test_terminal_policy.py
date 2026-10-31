"""Hosted terminal policy: `terminalEnabled` in `packages/cezar/src/server/capabilities.ts`."""

import asyncio
import base64

import pytest
from stario.testing import TestClient

from app.config import terminal_enabled
from app.features.task.urls import TASK_SHELL
from app.main import bootstrap

AUTH = {"authorization": "Basic " + base64.b64encode(b"ada:secret-token").decode()}


def test_terminal_enabled_follows_local_handoff_unless_the_flag_says_otherwise(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("CEZ_TERMINAL", raising=False)
    assert terminal_enabled(hosted=False) is True
    assert terminal_enabled(hosted=True) is False
    monkeypatch.setenv("CEZ_TERMINAL", "1")
    assert terminal_enabled(hosted=True) is True
    assert terminal_enabled(hosted=False) is True
    monkeypatch.setenv("CEZ_TERMINAL", "0")
    assert terminal_enabled(hosted=False) is False
    assert terminal_enabled(hosted=True) is False
    monkeypatch.setenv("CEZ_TERMINAL", "true")
    assert terminal_enabled(hosted=True) is False
    assert terminal_enabled(hosted=False) is True


async def _finished_run(client: TestClient, headers: dict[str, str]) -> str:
    created = await client.post(
        "/api/v1/runs",
        json={"task": "write a note", "workflow": "quick-task"},
        headers=headers,
    )
    assert created.status_code in (200, 201), created.text
    run_id = created.json()["id"]
    status = ""
    for _ in range(80):
        status = (await client.get(f"/api/v1/runs/{run_id}", headers=headers)).json()["status"]
        if status in ("done", "failed"):
            break
        await asyncio.sleep(0.05)
    assert status == "done"
    return run_id


async def _assert_terminal(client: TestClient, headers: dict[str, str], *, on: bool) -> None:
    run_id = await _finished_run(client, headers)
    health = (await client.get("/api/v1/health", headers=headers)).json()
    assert health["capabilities"]["terminal"] is on
    opened = await client.post(f"/api/v1/runs/{run_id}/terminal", headers=headers)
    shell = await client.post(
        TASK_SHELL.href(run_id),
        json={"tab": "t1", "command": "echo cezar-policy-ok"},
        headers=headers,
    )
    if on:
        assert opened.status_code == 201
        session = opened.json()["id"]
        typed = await client.post(
            f"/api/v1/runs/{run_id}/terminal/{session}/input",
            json={"data": "printf ready\\n"},
            headers=headers,
        )
        assert typed.status_code == 200
        closed = await client.delete(f"/api/v1/runs/{run_id}/terminal/{session}", headers=headers)
        assert closed.status_code == 200
        assert shell.status_code == 200
        assert "cezar-policy-ok" in shell.text
        return
    assert opened.status_code == 409
    assert opened.json()["error"] == "terminal is disabled"
    for path, body in (("input", {"data": "id\n"}), ("resize", {"rows": 30, "cols": 100})):
        refused = await client.post(
            f"/api/v1/runs/{run_id}/terminal/any/{path}", json=body, headers=headers
        )
        assert refused.status_code == 409
    output = await client.get(f"/api/v1/runs/{run_id}/terminal/any/output", headers=headers)
    assert output.status_code == 409
    assert shell.status_code == 409
    assert "cezar-policy-ok" not in shell.text


@pytest.fixture
def hosted(repo, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CEZ_REMOTE", "1")
    monkeypatch.setenv("CEZ_AUTH_USER", "ada")
    monkeypatch.setenv("CEZ_AUTH_PASSWORD", "secret-token")
    monkeypatch.delenv("CEZ_TERMINAL", raising=False)
    return repo


async def test_hosted_terminal_is_off_when_cez_terminal_is_unset(hosted):
    async with TestClient(bootstrap, request_timeout=30, base_url="http://evil.example") as client:
        await _assert_terminal(client, AUTH, on=False)


async def test_hosted_terminal_opens_with_cez_terminal_1(hosted, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CEZ_TERMINAL", "1")
    async with TestClient(bootstrap, request_timeout=30, base_url="http://evil.example") as client:
        await _assert_terminal(client, AUTH, on=True)


async def test_local_terminal_is_on_when_cez_terminal_is_unset(
    repo, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("CEZ_TERMINAL", raising=False)
    async with TestClient(
        bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321"
    ) as client:
        await _assert_terminal(client, {}, on=True)
