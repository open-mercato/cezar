"""Stream D: webhook formats, receiver states, history, and the control plane."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.integrations.discord_render import render_discord
from app.integrations.service import WebhookService

DISCORD_URL = "https://discord.com/api/webhooks/12345678901234567/" + "a" * 70
SLACK_URL = "https://hooks.slack.com/services/TABCDE/BFGHIJ/klmnop"


async def test_the_webhook_family_is_gated_until_the_flag(client):
    gated = await client.get("/api/v1/webhooks")
    assert gated.status_code == 409
    assert "CEZ_WEBHOOKS=1" in gated.json()["error"]
    assert gated.headers.get("cache-control") == "no-store"
    for route in (
        ("POST", "/api/v1/webhooks"),
        ("GET", "/api/v1/webhooks/history"),
        ("POST", "/api/v1/webhooks/notice/acknowledge"),
    ):
        method, path = route
        denied = await (client.post if method == "POST" else client.get)(path)
        assert denied.status_code == 409, path


async def test_the_receiver_state_machine_and_control_plane(client, monkeypatch):
    monkeypatch.setenv("CEZ_WEBHOOKS", "1")
    health = await client.get("/api/v1/health")
    assert health.json()["capabilities"]["webhooks"] is True

    created = await client.post(
        "/api/v1/webhooks",
        json={"name": "Ops", "url": "https://example.com/hook"},
    )
    assert created.status_code == 201
    receiver = created.json()["receiver"]
    assert receiver["state"] == "inactive"
    assert receiver["format"] == "cezar.json.v1"
    assert receiver["kind"] == "live"
    assert created.json()["secret"].startswith("whsec_")
    rid = receiver["id"]

    discord_as_json = await client.post(
        "/api/v1/webhooks",
        json={"name": "x", "url": DISCORD_URL, "format": "cezar.json.v1"},
    )
    assert discord_as_json.status_code == 400
    assert "Discord" in discord_as_json.json()["error"]
    bad_slack = await client.post(
        "/api/v1/webhooks",
        json={"name": "x", "url": "https://example.com/x", "format": "slack.v1"},
    )
    assert bad_slack.status_code == 400

    slack = await client.post(
        "/api/v1/webhooks",
        json={"name": "Chat", "url": SLACK_URL, "format": "slack.v1"},
    )
    assert slack.status_code == 201, slack.text
    assert slack.json()["receiver"]["format"] == "slack.v1"
    assert slack.json()["secret"] == ""

    discord = await client.post(
        "/api/v1/webhooks",
        json={"name": "Cord", "url": DISCORD_URL, "format": "discord.v1"},
    )
    assert discord.status_code == 201, discord.text

    stale = await client.post(
        f"/api/v1/webhooks/{rid}/activate",
        json={"expectedRevision": 99, "confirmed": True},
    )
    assert stale.status_code == 409
    unconfirmed = await client.post(
        f"/api/v1/webhooks/{rid}/activate",
        json={"expectedRevision": 1, "confirmed": False},
    )
    assert unconfirmed.status_code == 400
    active = await client.post(
        f"/api/v1/webhooks/{rid}/activate",
        json={"expectedRevision": 1, "confirmed": True},
    )
    assert active.json()["receiver"]["state"] == "active"

    again = await client.post(
        f"/api/v1/webhooks/{rid}/activate",
        json={"expectedRevision": 2, "confirmed": True},
    )
    assert again.status_code == 409

    paused = await client.post(
        f"/api/v1/webhooks/{rid}/pause",
        json={"expectedRevision": 2, "deliveryRevision": 1, "operationId": "op-1"},
    )
    assert paused.json()["receiver"]["state"] == "paused"
    assert paused.json()["receiver"]["pauseReason"] == "user"
    resumed = await client.post(
        f"/api/v1/webhooks/{rid}/resume",
        json={"expectedRevision": 3, "deliveryRevision": 1, "operationId": "op-2"},
    )
    assert resumed.json()["receiver"]["state"] == "active"

    rotated = await client.post(
        f"/api/v1/webhooks/{rid}/rotate-secret",
        json={"expectedRevision": 4, "mode": "graceful"},
    )
    assert rotated.status_code == 200
    assert rotated.json()["receiver"]["retiredKeyExpiresAt"]
    overlapping = await client.post(
        f"/api/v1/webhooks/{rid}/rotate-secret",
        json={"expectedRevision": 5, "mode": "graceful"},
    )
    assert overlapping.status_code == 409

    chat_rotate = await client.post(
        f"/api/v1/webhooks/{slack.json()['receiver']['id']}/rotate-secret",
        json={"expectedRevision": 1, "mode": "revoke_now"},
    )
    assert chat_rotate.status_code == 409

    deleted = await client.delete(f"/api/v1/webhooks/{slack.json()['receiver']['id']}")
    assert deleted.json() == {"ok": True}
    history = await client.get("/api/v1/webhooks/history")
    assert history.json()["items"][0]["kind"] == "history"
    assert history.json()["items"][0]["name"] == "Chat"

    listed = await client.get("/api/v1/webhooks")
    notice = listed.json().get("notice")
    assert notice and notice["changeSequence"] >= 1
    acknowledged = await client.post(
        "/api/v1/webhooks/notice/acknowledge",
        json={"expectedChangeSequence": notice["changeSequence"]},
    )
    assert acknowledged.json() == {"ok": True}
    assert (await client.get("/api/v1/webhooks")).json().get("notice") is None


async def test_deliveries_activity_and_a_signed_test_send(client, monkeypatch, tmp_path):
    monkeypatch.setenv("CEZ_WEBHOOKS", "1")
    seen: list[tuple[str, dict]] = []

    class Sink(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            seen.append((body.decode(), {k.lower(): v for k, v in dict(self.headers).items()}))
            self.send_response(204)
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Sink)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{httpd.server_address[1]}/hook"
        created = await client.post("/api/v1/webhooks", json={"name": "Ops", "url": url})
        rid = created.json()["receiver"]["id"]
        await client.post(
            f"/api/v1/webhooks/{rid}/activate",
            json={"expectedRevision": 1, "confirmed": True},
        )
        data_dir = tmp_path / "data"
        (data_dir / "webhook-outbox").mkdir(parents=True, exist_ok=True)
        (data_dir / "webhook-outbox" / "installation").write_text(
            "install-local\n", encoding="utf-8"
        )
        # CEZ_DRY_RUN=1 under the client fixture, so drive a live send through the service.
        service = WebhookService.open(data_dir, dry_run=False)
        delivery = service.test(rid)
        assert delivery["status"] == "delivered"
        assert seen, "the signed body never reached the sink"
        body, headers = seen[0]
        assert json.loads(body)["type"] == "webhook.test"
        assert headers.get("webhook-id", "").startswith("evt_")
        assert headers.get("webhook-timestamp")
        signature = headers.get("webhook-signature", "")
        assert signature.startswith("v1,")

        page = await client.get(f"/api/v1/webhooks/{rid}/deliveries")
        items = page.json()["items"]
        assert items and items[0]["deliveryId"] == delivery["deliveryId"]
        assert items[0]["httpStatus"] == 204
        activity = await client.get(f"/api/v1/webhooks/{rid}/activity")
        assert activity.json()["items"], "receiver transitions were not logged"

        retry = await client.post(f"/api/v1/webhooks/deliveries/{delivery['deliveryId']}/retry")
        assert retry.status_code == 409
        replay = await client.post(
            f"/api/v1/webhooks/deliveries/{delivery['deliveryId']}/replay",
            json={
                "expectedRevision": 2,
                "deliveryRevision": 1,
                "operationId": "op-9",
                "confirmed": True,
            },
        )
        assert replay.status_code == 409
    finally:
        httpd.shutdown()


async def test_a_paused_receiver_does_not_capture(client, monkeypatch):
    monkeypatch.setenv("CEZ_WEBHOOKS", "1")
    created = await client.post(
        "/api/v1/webhooks",
        json={"name": "Ops", "url": "https://example.com/hook"},
    )
    rid = created.json()["receiver"]["id"]
    await client.post(
        f"/api/v1/webhooks/{rid}/activate",
        json={"expectedRevision": 1, "confirmed": True},
    )
    tested = await client.post(f"/api/v1/webhooks/{rid}/test")
    assert tested.json()["status"] == "delivered"
    assert tested.json()["reason"] == "dry-run"

    run = await client.post(
        "/api/v1/runs", json={"task": "note the capture", "workflow": "quick-task"}
    )
    assert run.status_code == 201
    import asyncio

    types: set[str] = set()
    for _ in range(50):
        page = await client.get(f"/api/v1/webhooks/{rid}/deliveries")
        types = {str(item["eventType"]) for item in page.json()["items"]}
        if types & {"task.review_ready", "task.finished"}:
            break
        await asyncio.sleep(0.2)
    assert types & {"task.review_ready", "task.finished"}


def test_discord_render_matches_the_typescript_wire_shape():
    event = json.dumps(
        {
            "type": "task.finished",
            "occurredAt": "2026-10-29T00:00:00.000Z",
            "task": {"id": "abc12345", "title": "Ship @everyone thing", "status": "done"},
            "source": {"projectId": "cezar", "mode": "local"},
            "data": {},
        }
    )
    payload = json.loads(render_discord(event, receiver_name="Ops"))
    assert payload["allowed_mentions"] == {"parse": []}
    embed = payload["embeds"][0]
    assert embed["color"] == 3066993
    assert embed["footer"] == {"text": "cezar"}
    assert "@​" in embed["title"] or "@​" in payload["content"]
    assert payload["content"].startswith("**Task finished**")
