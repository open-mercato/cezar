import asyncio

from app.clock import stamp
from app.engine.model import Run
from app.engine.receipts import archive_finished, is_unread, mark_all_read
from app.features.secrets.urls import SECRETS
from app.integrations.hooks import save_receiver


def _run(status: str, **kwargs: object) -> Run:
    return Run(
        id="a" * 32,
        project_id="p",
        title="t",
        task="task",
        workflow="quick-task",
        status=status,
        runner="claude",
        created_at=stamp(),
        workflow_def={"name": "quick-task", "steps": []},
        finished_at=stamp() if status in ("done", "failed", "cancelled") else "",
        **kwargs,  # type: ignore[arg-type]
    )


def test_archive_and_read_receipts_follow_the_store_rules():
    waiting = _run("done", awaiting_answer_since=stamp())
    done = _run("done")
    done.id = "b" * 32
    failed = _run("failed", auto_resume_at=stamp())
    failed.id = "c" * 32
    review = _run("review")
    review.id = "d" * 32
    paused = _run("failed", auto_resume_at=stamp())
    assert is_unread(paused) is False
    changed = archive_finished([waiting, done, failed, review], stamp())
    assert [run.id for run in changed] == [done.id, failed.id]
    assert is_unread(done) is False or done.archived
    unread = _run("done")
    assert is_unread(unread) is True
    cancelled = _run("cancelled")
    assert is_unread(cancelled) is False
    assert is_unread(failed) is False
    marked = mark_all_read([unread, cancelled, failed], stamp())
    assert marked == [unread]
    assert unread.seen_at


async def test_ui_state_uploads_telemetry_and_webhook_receivers(client, tmp_path, monkeypatch):
    monkeypatch.setenv("CEZ_WEBHOOKS", "1")
    put = await client.put("/api/v1/ui-state", json={"lastAutonomous": True, "custom": 1})
    assert put.status_code == 200
    assert put.json()["custom"] == 1
    again = await client.put("/api/v1/ui-state", json={"runsView": "table"})
    assert again.json()["lastAutonomous"] is True
    assert again.json()["runsView"] == "table"
    too_many = await client.put("/api/v1/ui-state", json={f"k{i}": 1 for i in range(201)})
    assert too_many.status_code == 400

    upload = await client.post(
        "/api/v1/workspace/uploads",
        json={"mediaType": "text/plain", "data": "aGVsbG8=", "name": "note.txt"},
    )
    assert upload.status_code == 201
    upload_id = upload.json()["uploadId"]
    rejected = await client.post(
        "/api/v1/workspace/uploads",
        json={"mediaType": "text/html", "data": "aGVsbG8="},
    )
    assert rejected.status_code == 400
    assert (await client.delete(f"/api/v1/workspace/uploads/{upload_id}")).status_code == 200

    denied = await client.post("/api/v1/telemetry/event", json={"name": "page"})
    assert denied.status_code == 403
    yes = await client.put("/api/v1/telemetry/consent", json={"enabled": True})
    assert yes.json() == {"enabled": True, "transmits": False}
    accepted = await client.post("/api/v1/telemetry/event", json={"name": "page"})
    assert accepted.status_code == 204

    created = await client.post(
        "/api/v1/webhooks",
        json={"name": "Ops", "url": "https://example.com/hook"},
    )
    assert created.status_code == 201
    assert str(created.json()["secret"]).startswith("whsec_")
    private = await client.post(
        "/api/v1/webhooks",
        json={"name": "Nope", "url": "http://169.254.169.254/hook"},
    )
    assert private.status_code == 400
    receiver_id = created.json()["receiver"]["id"]
    tested = await client.post(f"/api/v1/webhooks/{receiver_id}/test")
    assert tested.json()["status"] == "delivered"
    assert tested.json()["reason"] == "dry-run"
    page = await client.get("/secrets")
    assert page.status_code == 200
    assert "Secrets" in page.text
    assert save_receiver(tmp_path, "x", "http://10.0.0.1/hook")[1]


async def test_git_actions_read_receipts_and_a_signed_github_hook(client):
    created = await client.post(
        "/api/v1/runs", json={"task": "write a note", "workflow": "quick-task"}
    )
    assert created.status_code == 201
    run_id = created.json()["id"]
    current = await client.get(f"/api/v1/runs/{run_id}")
    for _ in range(40):
        current = await client.get(f"/api/v1/runs/{run_id}")
        if current.json()["status"] in ("review", "failed", "done"):
            break
        await asyncio.sleep(0.05)
    assert current.json()["status"] == "done"
    status = await client.get(f"/api/v1/runs/{run_id}/git/status")
    assert status.status_code == 200
    # The turn-end autosave already committed the dry-run file.
    assert status.json()["uncommitted"] is False
    committed = await client.post(
        f"/api/v1/runs/{run_id}/git/commit", json={"message": "save the dry run"}
    )
    assert committed.status_code == 200
    assert committed.json()["committed"] is False
    commits = await client.get(f"/tasks/{run_id}?pane=commits")
    assert "cezar autosave (turn end)" in commits.text
    pushed = await client.post(f"/api/v1/runs/{run_id}/git/push")
    assert pushed.json()["dryRun"] is True
    opened = await client.post(f"/api/v1/runs/{run_id}/pr")
    assert opened.status_code == 201
    assert opened.json()["url"] == "https://github.com/open-mercato/demo/pull/777"
    assert opened.json()["dryRun"] is True
    done = await client.get(f"/api/v1/runs/{run_id}")
    assert done.json()["status"] == "done"
    assert done.json()["pullRequestUrl"].endswith("/777")
    box = await client.get(f"/tasks/{run_id}")
    assert "Ready to merge" in box.text
    assert "Squash and merge" in box.text
    assert 'id="review-form"' in box.text
    assert "Send review" in box.text
    reviewed = await client.post(
        f"/tasks/{run_id}/review",
        json={"tab": "t1", "review_event": "comment", "review_body": "looks good"},
    )
    assert reviewed.status_code == 204

    refused = await client.post(
        "/api/v1/preview/design-proxy",
        json={"url": "http://example.com"},
    )
    assert refused.status_code == 409
    providers = await client.get("/api/v1/providers/status")
    assert "providers" in providers.json()
    models = await client.get("/api/v1/models", params={"runner": "claude"})
    assert models.json()["available"] in (True, False)
    page = await client.get("/tasks")
    assert "Archive finished" in page.text
    assert "Mark read" in page.text
    assert SECRETS.href() == "/secrets"


async def test_a_terminal_session_echoes_in_its_directory(tmp_path):
    from app.engine.terminal_hub import TerminalHub

    hub = TerminalHub()
    session_id = await hub.open(tmp_path)
    try:
        assert await hub.write(session_id, "echo cezar-term\n")
        text = ""
        for _ in range(40):
            text = hub.output(session_id) or ""
            if "cezar-term" in text:
                break
            await asyncio.sleep(0.05)
        assert "cezar-term" in text
    finally:
        await hub.close(session_id)


async def test_the_design_proxy_injects_its_marker_on_loopback_html():
    from urllib.request import urlopen

    from app.engine.preview import start_proxy

    async def upstream(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readuntil(b"\r\n\r\n")
        body = b"<html><body>hi</body></html>"
        head = (
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\n\r\n"
        )
        writer.write(head + body)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(upstream, "127.0.0.1", 0)
    sockets = server.sockets or []
    port = sockets[0].getsockname()[1]
    proxy, close = await start_proxy(f"http://127.0.0.1:{port}/index")
    try:
        fetched = await asyncio.to_thread(lambda: urlopen(proxy + "/index", timeout=2).read())
        assert b"cezar-design" in fetched
        assert b"hi" in fetched
    finally:
        await close()
        server.close()
        await server.wait_closed()


def test_webhook_helper_rejects_a_private_url(tmp_path):
    _row, reason = save_receiver(tmp_path, "local", "http://127.0.0.1:9/hook")
    assert reason is None
    _row, reason = save_receiver(tmp_path, "meta", "http://169.254.169.254/latest")
    assert reason
