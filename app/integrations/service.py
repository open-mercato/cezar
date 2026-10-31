"""Webhook delivery service — the contract surface of `service.ts`.

Owns the receiver registry, the outbox, and the delivery/activity logs, and
drives the send loop: render per format, sign `cezar.json.v1` bodies, post,
classify the outcome, and fold it back into the receiver. Control-plane
routes in `app/features/api/surface.py` are thin wrappers over this service.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPHandler, HTTPSHandler, Request, build_opener

from app.clock import stamp
from app.integrations.discord_render import render_discord
from app.integrations.history import WebhookHistory, page_rows
from app.integrations.hooks import _policy_issue, delivery_url_issue, sign_webhook
from app.integrations.outbox import Delivery, Outbox
from app.integrations.registry import (
    EndpointRegistry,
    WebhookStateError,
    mask_destination,
)
from app.integrations.slack_render import render_slack
from app.integrations.webhook_schema import DISCORD_HOSTS

_OPENER = build_opener(HTTPHandler, HTTPSHandler)

# Registry commits anywhere in this process fan out to SSE subscribers.
_LISTENERS: list = []


def subscribe(listener) -> None:
    _LISTENERS.append(listener)


def unsubscribe(listener) -> None:
    try:
        _LISTENERS.remove(listener)
    except ValueError:
        pass


def broadcast_change(sequence: int) -> None:
    for listener in list(_LISTENERS):
        listener(sequence)


_EXPIRY_MS = 72 * 3_600_000
_REPLAY_MS = 7 * 24 * 3_600_000
_PROBE_MS = 900_000
_GONE_CODES = frozenset({410})


def webhooks_enabled() -> bool:
    return os.environ.get("CEZ_WEBHOOKS") == "1"


def installation_id(directory: Path) -> str:
    path = directory / "installation"
    try:
        current = path.read_text(encoding="utf-8").strip()
    except OSError:
        current = ""
    if current:
        return current
    directory.mkdir(parents=True, exist_ok=True)
    path.write_text("install-local\n", encoding="utf-8")
    return "install-local"


def _event_id() -> str:
    return "evt_" + str(uuid.uuid4())


def _iso(ms: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + ".000Z"


def _ms_of(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        return 0


def _render(fmt: str, event_json: str, receiver_name: str) -> str:
    if fmt == "slack.v1":
        return render_slack(event_json, receiver_name=receiver_name)
    if fmt == "discord.v1":
        return render_discord(event_json, receiver_name=receiver_name)
    return event_json


def _post(url: str, body: str, headers: dict[str, str]) -> int | None:
    try:
        request = Request(url, data=body.encode(), headers=headers, method="POST")
        with _OPENER.open(request, timeout=10) as response:
            return int(response.status)
    except URLError, TimeoutError, OSError, ValueError:
        return None


class WebhookService:
    """One data dir's webhook control plane and delivery loop."""

    def __init__(
        self,
        data_dir: Path,
        *,
        dry_run: bool,
        installation: str,
        project_id: str = "",
        mode: str = "local",
    ) -> None:
        self.data_dir = data_dir
        self.dry_run = dry_run
        self.installation = installation
        self.project_id = project_id
        self.mode = mode
        self.registry = EndpointRegistry.open(data_dir, changed=self._emit)
        self.history = WebhookHistory(data_dir)
        self.outbox = Outbox(data_dir / "webhook-outbox", installation)

    @classmethod
    def open(
        cls,
        data_dir: Path,
        *,
        dry_run: bool,
        project_id: str = "",
        mode: str = "local",
    ) -> WebhookService:
        directory = data_dir / "webhook-outbox"
        service = cls(
            data_dir,
            dry_run=dry_run,
            installation=installation_id(directory),
            project_id=project_id,
            mode=mode,
        )
        if not service.outbox.path.exists():
            return service
        try:
            service.outbox.open()
        except OSError:
            pass
        return service

    # ---- change stream -----------------------------------------------------

    def _emit(self, action: str, receiver: dict | None, sequence: int) -> None:
        if receiver is not None:
            self.history.record_activity(action, receiver)
        broadcast_change(sequence)

    # ---- control plane -----------------------------------------------------

    def list(self) -> dict:
        receivers = self.registry.list()
        pending = sum(
            1
            for row in self.outbox.rows()
            if row.status in ("pending", "retrying", "blocked_policy", "in_flight")
        )
        health: dict[str, object] = {"status": "disabled"}
        if webhooks_enabled():
            health = {"status": "ready"}
            if pending > 100:
                health = {
                    "status": "degraded",
                    "reason": "delivery backlog is saturated",
                    "saturation": {
                        "pending": True,
                        "retained": False,
                        "control": False,
                        "dropped": 0,
                    },
                }
        history = self.registry.history()
        body: dict[str, object] = {
            "receivers": receivers,
            "webhookHealth": health,
            "changeSequence": self.registry.change_sequence(),
            "history": history[:100],
            "historyCount": len(history),
        }
        notice = self.registry.notice()
        if notice is not None:
            body["notice"] = notice
        return body

    def create(self, settings: dict) -> dict:
        issue = delivery_url_issue(str(settings.get("url", "")), allow_loopback=True)
        if issue:
            raise WebhookStateError(400, "destination", issue)
        receiver = self.registry.create(settings)
        return {"receiver": self.registry._public(receiver), "secret": receiver.get("secret", "")}

    def update(self, receiver_id: str, settings: dict, expected: int) -> dict:
        issue = delivery_url_issue(str(settings.get("url", "")), allow_loopback=True)
        if issue:
            raise WebhookStateError(400, "destination", issue)
        before = self.registry.private(receiver_id)
        row = self.registry.update(receiver_id, settings, expected)
        if before is not None and int(before.get("deliveryRevision", 0)) != int(
            row.get("deliveryRevision", 0)
        ):
            self._cancel_unsent(receiver_id, "receiver_changed")
        return {"receiver": self.registry._public(row)}

    def activate(self, receiver_id: str, expected_revision: int) -> dict:
        row = self.registry.activate(
            receiver_id,
            expected_revision,
            high_water=self.outbox.high_water,
            installation_id=self.installation,
        )
        return {"receiver": self.registry._public(row)}

    def pause(self, receiver_id: str, operation: dict) -> dict:
        row = self.registry.pause(receiver_id, operation)
        self._cancel_unsent(receiver_id, "receiver_changed")
        return {"receiver": self.registry._public(row)}

    def resume(self, receiver_id: str, operation: dict) -> dict:
        row = self.registry.resume(receiver_id, operation)
        return {"receiver": self.registry._public(row)}

    def rotate(self, receiver_id: str, expected_revision: int, mode: str) -> dict:
        row = self.registry.rotate(receiver_id, expected_revision, mode)
        return {
            "receiver": self.registry._public(row),
            "secret": row.get("secret", ""),
        }

    def delete(self, receiver_id: str) -> dict:
        self._cancel_unsent(receiver_id, "receiver_deleted")
        self.registry.delete(receiver_id)
        return {"ok": True}

    def acknowledge(self, expected: int) -> dict:
        return {"ok": self.registry.acknowledge(expected)}

    # ---- deliveries --------------------------------------------------------

    def _receiver_for(self, row: Delivery) -> dict | None:
        return self.registry.private(row.receiver_id) if row.receiver_id else None

    def _cancel_unsent(self, receiver_id: str, reason: str) -> None:
        now = int(time.time() * 1000)
        for row in self.outbox.rows():
            if row.receiver_id != receiver_id:
                continue
            if row.status in ("pending", "retrying", "blocked_policy", "in_flight"):
                row.status = "cancelled"
                row.reason = reason
                row.completed_at = now
                self.history.record_delivery(self._display(row))
        self.outbox.save()

    def capture(self, event: dict) -> int:
        """One outbox delivery per capturing receiver; returns rows written."""
        kind = str(event.get("type", ""))
        event_json = json.dumps(event)
        task_id = str((event.get("task") or {}).get("id", ""))
        now = int(time.time() * 1000)
        written = 0
        for receiver in self.registry.capturing(kind):
            fmt = str(receiver.get("format", "cezar.json.v1"))
            body = _render(fmt, event_json, str(receiver.get("name", "")))
            self.outbox.append(
                body,
                event_type=kind,
                expires_at=now + _EXPIRY_MS,
                delivery_id="del_" + uuid.uuid4().hex,
                receiver_id=str(receiver.get("id", "")),
                event_id=str(event.get("id", "")),
                url=str(receiver.get("url", "")),
                format=fmt,
                receiver_name=str(receiver.get("name", "")),
                delivery_revision=int(receiver.get("deliveryRevision", 0)),
                task_id=task_id,
                created_at=now,
            )
            written += 1
        return written

    def _send_row(self, row: Delivery, receiver: dict | None) -> str:
        """Send one delivery; classify like `service.ts` outcome mapping."""
        url = row.url or (str(receiver.get("url", "")) if receiver else "")
        fmt = row.format or "cezar.json.v1"
        if self.dry_run:
            return "delivered"
        host = (urlsplit(url).hostname or "").lower()
        if fmt == "discord.v1" and host in DISCORD_HOSTS:
            parts = urlsplit(url)
            query = dict(parse_qsl(parts.query))
            query["wait"] = "true"
            url = urlunsplit(parts._replace(query=urlencode(query)))
        issue = _policy_issue(url)
        if issue:
            return "policy"
        headers = {
            "content-type": "application/json",
            "user-agent": "cezar-webhooks/1",
            "webhook-id": row.event_id or row.delivery_id,
        }
        if fmt == "cezar.json.v1" and receiver is not None:
            timestamp = int(time.time())
            keys = self.registry.signing_keys(receiver)
            if keys:
                headers["webhook-timestamp"] = str(timestamp)
                headers["webhook-signature"] = " ".join(
                    sign_webhook(key, headers["webhook-id"], timestamp, row.body) for key in keys
                )
        status = _post(url, row.body, headers)
        if status is None:
            return "transient"
        row.http_status = status
        if 200 <= status < 300:
            return "delivered"
        if status in _GONE_CODES or (status == 404 and host in DISCORD_HOSTS):
            return "gone"
        if status == 429 or status == 408 or status >= 500:
            return "rate_limited" if status == 429 else "transient"
        return "permanent"

    def _finish(self, row: Delivery, outcome: str, now: int) -> None:
        """Terminal or deferred mark + history + receiver fold."""
        test = row.event_type == "webhook.test"
        if outcome == "delivered":
            row.status = "delivered"
            row.attempts += 1
            row.completed_at = now
            row.reason = "dry-run" if self.dry_run else ""
            if self.dry_run:
                row.http_status = 204
            fold = "success"
        elif outcome == "gone":
            row.status = "failed"
            row.attempts += 1
            row.completed_at = now
            row.reason = "gone"
            fold = "gone"
        elif outcome in ("transient", "rate_limited", "policy") and not test:
            row.attempts += 1
            expires = row.expires_at or now + _EXPIRY_MS
            delay = 5_000 * 2 ** min(row.attempts - 1, 20)
            deadline = min(now + min(3_600_000, delay), expires)
            if outcome == "policy":
                row.status = "blocked_policy"
                deadline = min(now + _PROBE_MS, expires)
            else:
                row.status = "retrying"
            if deadline >= expires:
                row.status = "failed"
                row.completed_at = now
                row.reason = "expired"
                fold = "transient"
            else:
                row.next_attempt_at = str(deadline)
                fold = ""
        else:
            row.status = "failed"
            row.attempts += 1
            row.completed_at = now
            row.reason = outcome
            fold = "transient" if outcome in ("transient", "rate_limited") else "permanent"
        if row.status in ("delivered", "failed"):
            row.next_attempt_at = ""
            self.history.record_delivery(self._display(row))
        if fold:
            self.registry.delivery_result(row.receiver_id, fold, test=test)
        self.outbox.save()

    def deliver_due(self) -> int:
        """Send every due outbox row. Returns how many were attempted."""
        now = int(time.time() * 1000)
        sent = 0
        while True:
            row = self.outbox.due(now)
            if row is None:
                return sent
            receiver = self._receiver_for(row)
            if row.receiver_id and receiver is None:
                row.status = "dropped"
                row.reason = "receiver_deleted"
                row.completed_at = now
                self.history.record_delivery(self._display(row))
                self.outbox.save()
                continue
            if (
                receiver is not None
                and row.delivery_revision
                and int(receiver.get("deliveryRevision", 0)) != row.delivery_revision
            ):
                row.status = "superseded"
                row.reason = "receiver_changed"
                row.completed_at = now
                self.history.record_delivery(self._display(row))
                self.outbox.save()
                continue
            row.status = "in_flight"
            self.outbox.save()
            outcome = self._send_row(row, receiver)
            self._finish(row, outcome, int(time.time() * 1000))
            sent += 1

    def test(self, receiver_id: str) -> dict:
        receiver = self.registry.private(receiver_id)
        if receiver is None:
            raise WebhookStateError(404, "not_found", "Receiver not found")
        event = {
            "id": _event_id(),
            "type": "webhook.test",
            "schemaVersion": 1,
            "occurredAt": stamp(),
            "data": {"test": True, "format": "cezar.json.v1"},
        }
        now = int(time.time() * 1000)
        fmt = str(receiver.get("format", "cezar.json.v1"))
        row = self.outbox.append(
            _render(fmt, json.dumps(event), str(receiver.get("name", ""))),
            event_type="webhook.test",
            expires_at=now + _EXPIRY_MS,
            delivery_id="del_" + uuid.uuid4().hex,
            receiver_id=receiver_id,
            event_id=event["id"],
            url=str(receiver.get("url", "")),
            format=fmt,
            receiver_name=str(receiver.get("name", "")),
            delivery_revision=int(receiver.get("deliveryRevision", 0)),
            created_at=now,
        )
        row.status = "in_flight"
        self.outbox.save()
        outcome = self._send_row(row, receiver)
        self._finish(row, outcome, int(time.time() * 1000))
        return self._display(row)

    def retry(self, delivery_id: str) -> dict:
        row = self.outbox.find_delivery(delivery_id)
        if row is None:
            raise WebhookStateError(404, "not_found", "Delivery not found")
        if row.status in ("delivered", "failed", "cancelled", "superseded", "dropped"):
            raise WebhookStateError(409, "state", "Delivery is terminal")
        row.next_attempt_at = ""
        self.outbox.save()
        self.deliver_due()
        return {"receiver": self._display(row)}

    def replay(self, delivery_id: str, operation: dict) -> dict:
        row = self.outbox.find_delivery(delivery_id)
        record = row if row is not None else self.history.find_delivery(delivery_id)
        if record is None:
            raise WebhookStateError(404, "not_found", "Delivery not found")
        display = self._display(record) if isinstance(record, Delivery) else record
        reason = display.get("replayUnavailableReason")
        if not display.get("replayAllowed"):
            raise WebhookStateError(409, "replay", f"Replay unavailable: {reason or 'not_fresh'}")
        receiver = self.registry.private(display["receiverId"])
        if receiver is None:
            raise WebhookStateError(409, "replay", "Replay unavailable: receiver_deleted")
        body = record.body if isinstance(record, Delivery) else ""
        if not body:
            raise WebhookStateError(409, "replay", "Replay unavailable: payload_unavailable")
        now = int(time.time() * 1000)
        fresh = self.outbox.append(
            body,
            event_type=str(display.get("eventType", "")),
            expires_at=now + _EXPIRY_MS,
            delivery_id="del_" + uuid.uuid4().hex,
            receiver_id=str(display.get("receiverId", "")),
            event_id=str(display.get("eventId", "")),
            url=str(receiver.get("url", "")),
            format=str(receiver.get("format", "cezar.json.v1")),
            receiver_name=str(receiver.get("name", "")),
            delivery_revision=int(receiver.get("deliveryRevision", 0)),
            task_id=str(display.get("taskId", "")),
            created_at=now,
        )
        self.deliver_due()
        return {"receiver": self._display(fresh)}

    # ---- views -------------------------------------------------------------

    def _display(self, row: Delivery | dict) -> dict:
        if isinstance(row, dict):
            return row
        receiver = self._receiver_for(row)
        out: dict[str, object] = {
            "deliveryId": row.delivery_id or f"seq-{row.sequence}",
            "eventId": row.event_id,
            "receiverId": row.receiver_id,
            "deliveryRevision": row.delivery_revision,
            "eventType": row.event_type,
            "status": row.status,
            "createdAt": _iso(row.created_at or row.completed_at),
            "expiresAt": _iso(row.expires_at),
            "attempts": row.attempts,
            "destination": mask_destination(row.url),
            "retryAllowed": row.status in ("pending", "retrying", "blocked_policy"),
            "replayAllowed": False,
            "payloadAvailability": "retained" if row.body else "not_created",
        }
        if row.task_id:
            out["taskId"] = row.task_id
        if row.next_attempt_at:
            out["nextAttemptAt"] = _iso(_ms_of(row.next_attempt_at))
        if row.completed_at:
            out["completedAt"] = _iso(row.completed_at)
        if row.http_status:
            out["httpStatus"] = row.http_status
        if row.reason:
            out["reason"] = row.reason
        if row.response:
            out["response"] = row.response
        out["payloadRetainedUntil"] = _iso(row.completed_at + _REPLAY_MS)
        out["historyRetainedUntil"] = _iso(row.completed_at + 30 * 24 * 3_600_000)
        terminal = row.status in ("delivered", "failed")
        reason = self._replay_reason(row, receiver, terminal)
        if reason is None:
            out["replayAllowed"] = True
        else:
            out["replayUnavailableReason"] = reason
        out["taskAvailability"] = "unknown" if row.task_id else "not_applicable"
        return out

    def _replay_reason(self, row: Delivery, receiver: dict | None, terminal: bool) -> str | None:
        if row.event_type == "webhook.test":
            return "synthetic_test"
        if not terminal:
            return "not_terminal"
        if not row.body:
            return "payload_unavailable"
        if receiver is None:
            return "receiver_deleted"
        if receiver.get("state") not in ("active", "suspended"):
            return "receiver_inactive"
        if row.delivery_revision and int(receiver.get("deliveryRevision", 0)) != (
            row.delivery_revision
        ):
            return "configuration_changed"
        now = int(time.time() * 1000)
        if row.completed_at and now - row.completed_at > _REPLAY_MS:
            return "not_fresh"
        return None

    def delivery_page(
        self, receiver_id: str, *, limit: int, cursor: str | None, task_id: str = ""
    ) -> dict:
        live = [
            self._display(row)
            for row in self.outbox.rows()
            if row.receiver_id == receiver_id and (not task_id or row.task_id == task_id)
        ]
        past = [
            row
            for row in self.history.deliveries(receiver_id=receiver_id, task_id=task_id or None)
            if row.get("deliveryId") not in {item["deliveryId"] for item in live}
        ]
        return page_rows(live + past, limit=limit, cursor=cursor)

    def activity_page(self, receiver_id: str, *, limit: int, cursor: str | None) -> dict:
        return page_rows(self.history.activity(receiver_id), limit=limit, cursor=cursor)

    def history_page(self, *, limit: int, cursor: str | None) -> dict:
        return page_rows(self.registry.history(), limit=limit, cursor=cursor)
