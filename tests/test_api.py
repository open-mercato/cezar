import asyncio
import base64

from stario.testing import TestClient

from app.features.api.urls import API_CANCEL, API_RUNS, API_RUNS_CREATE
from app.http.loopback import is_loopback_host, is_loopback_host_header
from app.main import bootstrap

_REQUIRED = (
    "id",
    "title",
    "workflow",
    "task",
    "status",
    "createdAt",
    "tokensUsed",
    "archived",
    "steps",
)


def test_loopback_host_matches_the_typescript_allowlist():
    assert is_loopback_host(None) is True
    assert is_loopback_host_header(None) is False
    assert is_loopback_host_header("") is False
    for host in ("127.0.0.1", "127.1.2.3", "localhost", "localhost.", "[::1]", "[::1]:4321"):
        assert is_loopback_host_header(host) is True
    for host in ("evil.com", "127.0.0.1.evil.com", "[::1]@evil.com", "8.8.8.8", "0.0.0.0"):
        assert is_loopback_host_header(host) is False


async def test_health_is_the_discovery_document_and_cors_open(client):
    health = await client.get("/api/v1/health")
    assert health.status_code == 200
    body = health.json()
    for key in (
        "version",
        "repoRoot",
        "repo",
        "checks",
        "defaultRunner",
        "forge",
        "capabilities",
        "projects",
        "bootProject",
    ):
        assert key in body
    assert "root" not in body["projects"][0]
    assert body["repo"]["root"]
    assert {row["name"] for row in body["checks"]} >= {"claude", "git", "gh"}
    assert health.headers.get("access-control-allow-origin") == "*"
    runs = await client.get(API_RUNS.href())
    assert "access-control-allow-origin" not in runs.headers


async def test_a_foreign_host_is_forbidden(client):
    denied = await client.get(API_RUNS.href(), headers={"host": "evil.com"})
    assert denied.status_code == 403
    assert "Host" in denied.json()["error"]
    assert (await client.get("/api/v1/health", headers={"host": "evil.com"})).status_code == 403


def _basic(user: str, password: str) -> str:
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    return f"Basic {token}"


async def test_hosted_mode_requires_basic_auth(repo, monkeypatch):
    monkeypatch.setenv("CEZ_REMOTE", "1")
    monkeypatch.setenv("CEZ_AUTH_USER", "ada")
    monkeypatch.setenv("CEZ_AUTH_PASSWORD", "secret-token")
    async with TestClient(bootstrap, request_timeout=15, base_url="http://evil.example") as hosted:
        assert (await hosted.get("/health")).status_code == 200
        denied = await hosted.get("/api/v1/health")
        assert denied.status_code == 401
        assert denied.json()["error"] == "authentication required"
        assert "basic" in (denied.headers.get("www-authenticate") or "").lower()
        wrong = await hosted.get("/api/v1/health", headers={"authorization": _basic("ada", "nope")})
        assert wrong.status_code == 401
        allowed = await hosted.get(
            "/api/v1/health", headers={"authorization": _basic("ada", "secret-token")}
        )
        assert allowed.status_code == 200
        page = await hosted.get("/tasks", headers={"authorization": _basic("ada", "secret-token")})
        assert page.status_code == 200


async def test_hosted_mode_writes_a_password_when_none_is_configured(repo, monkeypatch):
    monkeypatch.setenv("CEZ_REMOTE", "1")
    monkeypatch.delenv("CEZ_AUTH_PASSWORD", raising=False)
    async with TestClient(bootstrap, request_timeout=15, base_url="http://evil.example") as hosted:
        path = repo.parent / "data" / "auth-password"
        password = path.read_text(encoding="utf-8").strip()
        assert password
        assert path.stat().st_mode & 0o777 == 0o600
        allowed = await hosted.get(
            "/api/v1/runs", headers={"authorization": _basic("cezar", password)}
        )
        assert allowed.status_code == 200


async def test_post_runs_rejects_the_same_bodies_the_contract_rejects(client):
    missing = await client.post(API_RUNS_CREATE.href(), json={"runner": "claude"})
    assert missing.status_code == 400
    assert missing.json()["error"] == 'provide either "workflow" or "steps", not both'
    both = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "x", "workflow": "quick-task", "steps": [{"id": "a", "prompt": "p"}]},
    )
    assert both.status_code == 400
    empty = await client.post(
        API_RUNS_CREATE.href(), json={"task": "   ", "workflow": "quick-task"}
    )
    assert empty.status_code == 400
    assert empty.json()["error"] == "describe the task or attach a file"
    unknown_runner = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "x", "workflow": "quick-task", "runner": "nope"},
    )
    assert unknown_runner.status_code == 400
    unknown_workflow = await client.post(
        API_RUNS_CREATE.href(), json={"task": "x", "workflow": "no-such-workflow"}
    )
    assert unknown_workflow.status_code == 404
    assert unknown_workflow.json()["error"].startswith("unknown workflow:")
    account = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "x", "workflow": "quick-task", "agentProfile": "nope"},
    )
    assert account.status_code == 400
    assert "nope" in account.json()["error"]
    variants = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "two ways", "workflow": "quick-task", "variants": 2},
    )
    assert variants.status_code == 201
    group = variants.json()["runs"]
    assert [item["variant"] for item in group] == ["A", "B"]
    assert group[0]["groupId"] == group[1]["groupId"]
    pending = {item["id"] for item in group}
    for _ in range(40):
        rows = (await client.get(API_RUNS.href())).json()
        settled = ("review", "done", "failed")
        if all(row["status"] in settled for row in rows if row["id"] in pending):
            break
        await asyncio.sleep(0.05)


async def test_a_created_run_round_trips_with_the_record_shape(client):
    created = await client.post(
        API_RUNS_CREATE.href(),
        json={
            "task": "ship the note",
            "workflow": "quick-task",
            "runner": "claude",
            "agentProfile": "default",
        },
    )
    assert created.status_code == 201
    record = created.json()
    for key in _REQUIRED:
        assert key in record
    assert record["archived"] is False
    assert record["tokensUsed"] == 0
    assert record["workflowDef"]["name"] == "quick-task"
    assert record["steps"][0]["kind"] == "agent"
    assert record["steps"][0]["status"] == "pending"
    listed = (await client.get(API_RUNS.href())).json()
    assert isinstance(listed, list)
    assert "workflowDef" not in listed[0]
    full = (await client.get(API_RUNS.href(), params={"full": "1"})).json()
    assert full[0]["workflowDef"]["source"] == "built-in"
    one = await client.get(f"/api/v1/runs/{record['id']}")
    assert one.status_code == 200
    assert one.json()["task"] == "ship the note"
    scoped = await client.get(f"/api/v1/p/default/runs/{record['id']}")
    assert scoped.status_code == 200
    assert scoped.json() == one.json()
    missing_project = await client.get(f"/api/v1/p/not-a-project/runs/{record['id']}")
    assert missing_project.status_code == 404
    inline = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "inline", "steps": [{"id": "only", "prompt": "do it"}]},
    )
    assert inline.status_code == 201
    assert inline.json()["workflow"] == "(planned)"
    assert inline.json()["workflowDef"]["source"] == "built-in"


async def test_cancel_finish_delete_and_messages_use_the_contract_statuses(client, monkeypatch):
    monkeypatch.setenv("CEZ_REVIEW_GATE", "1")
    created = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "mock:ask hold", "workflow": "quick-task"},
    )
    run_id = created.json()["id"]
    queued_delete = await client.delete(f"/api/v1/runs/{run_id}")
    assert queued_delete.status_code == 409
    status = ""
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status == "waiting":
            break
        await asyncio.sleep(0.05)
    assert status == "waiting"
    sent = await client.post(f"/api/v1/runs/{run_id}/messages", json={"text": "the short one"})
    assert sent.status_code == 200
    assert sent.json() == {"delivered": True}
    empty = await client.post(f"/api/v1/runs/{run_id}/messages", json={"text": "  "})
    assert empty.status_code == 400
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status == "review":
            break
        await asyncio.sleep(0.05)
    assert status == "review"
    finished = await client.post(f"/api/v1/runs/{run_id}/finish")
    assert finished.status_code == 200
    assert finished.json() == {"finished": True}
    again_finish = await client.post(f"/api/v1/runs/{run_id}/finish")
    assert again_finish.status_code == 409
    assert again_finish.json()["error"] == "no open session"
    again = await client.post(API_CANCEL.href(run_id))
    assert again.status_code == 200
    assert again.json()["cancelled"] is False
    removed = await client.delete(f"/api/v1/runs/{run_id}")
    assert removed.status_code == 200
    assert removed.json() == {"deleted": True}
    assert (await client.get(f"/api/v1/runs/{run_id}")).status_code == 404
    resume = await client.delete(f"/api/v1/runs/{created.json()['id']}/auto-resume")
    assert resume.status_code == 404


async def test_waiting_can_be_finished_and_a_settled_run_can_be_pinned(client):
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
    finished = await client.post(f"/api/v1/runs/{run_id}/finish")
    assert finished.status_code == 200
    assert (await client.get(f"/api/v1/runs/{run_id}")).json()["status"] == "done"
    pinned = await client.post(f"/api/v1/runs/{run_id}/pin")
    assert pinned.status_code == 200
    assert pinned.json()["pinned"] is True
    archived = await client.post(f"/api/v1/runs/{run_id}/archive", json={"archived": True})
    assert archived.status_code == 200
    assert archived.json()["archived"] is True
    assert archived.json().get("pinned") is not True


async def test_the_event_stream_replays_sse(client):
    created = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "write a note", "workflow": "quick-task"},
    )
    run_id = created.json()["id"]
    status = ""
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status == "done":
            break
        await asyncio.sleep(0.05)
    assert status == "done"
    names: list[str] = []
    async with client.stream("GET", f"/api/v1/runs/{run_id}/events") as stream:
        assert stream.status_code == 200
        assert "text/event-stream" in (stream.headers.get("content-type") or "")
        async for event in stream.iter_events():
            names.append(event.get("event", ""))
            if "ui-event" in names and "run" in names:
                break
    assert "run-event" in names
    assert "ui-event" in names
    assert "run" in names


async def test_projects_list_has_the_registry_keys(client):
    body = (await client.get("/api/v1/projects")).json()
    assert body["bootProject"]
    assert "projectsDir" in body
    project = body["projects"][0]
    for key in ("id", "name", "root", "addedAt", "lastOpenedAt", "source", "status", "branch"):
        assert key in project
    assert project["status"] == "ok"
    assert project["source"] == "local"


async def test_unset_parallel_default_is_two(client):
    body = (await client.get("/api/v1/workspace/config")).json()
    assert body["maxParallel"] == 2
    page = await client.get("/settings")
    assert "defaults to 2" in page.text


async def test_cancel_a_live_run_and_an_unknown_id(client):
    missing = await client.post(f"/api/v1/runs/{'ab' * 16}/cancel")
    assert missing.status_code == 404
    assert missing.json()["error"] == "not found"
    created = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "hold", "steps": [{"id": "wait", "command": "sleep 30"}]},
    )
    assert created.status_code == 201
    run_id = created.json()["id"]
    status = ""
    for _ in range(50):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status == "running":
            break
        await asyncio.sleep(0.05)
    assert status == "running"
    cancelled = await client.post(f"/api/v1/runs/{run_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json() == {"cancelled": True}
