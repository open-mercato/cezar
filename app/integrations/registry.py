"""Webhook receiver registry — port of `packages/cezar/src/webhooks/endpoints.ts`.

State lives in `<data_dir>/webhooks/endpoints.json`: receivers, deleted-receiver
history, a `changeSequence`, and the latest `notice`. Receivers move through
`inactive → active → paused/suspended → disabled`; only `active` and
`suspended` receivers capture events. A legacy `webhook-receivers.json` (the
pre-formats file) migrates on first open: those receivers were always live and
Slack-rendered, so they land `active` with `slack.v1`.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from app.clock import stamp
from app.integrations.webhook_schema import TASK_EVENTS, destination_issue

_ENDPOINTS = "endpoints.json"
_LEGACY = "webhook-receivers.json"
_PROBE_MS = 900_000
_RETIRE_MS = 86_400_000
_HISTORY_CAP = 100


def new_secret() -> str:
    return "whsec_" + base64.b64encode(secrets.token_bytes(32)).decode()


def mask_destination(url: str) -> str:
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    host = parts.hostname or ""
    return f"{parts.scheme}://{host}/…" if host else ""


class WebhookStateError(Exception):
    """`WebhookStateError` from endpoints.ts: status + Retry-After on conflicts."""

    def __init__(self, status: int, code: str, message: str, retry_after: int = 0) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after


def _receiver_id() -> str:
    return "wr_" + uuid.uuid4().hex


def _event_match(receiver: dict, event_type: str) -> bool:
    """Capture filter: preset, custom events, scheduled-failure opt-in."""
    preset = receiver.get("preset", "attention")
    allowed: set[str]
    if preset == "all":
        allowed = set(TASK_EVENTS)
    elif preset == "custom":
        allowed = set(receiver.get("events") or [])
    else:
        allowed = {
            "task.attention_required",
            "task.review_ready",
            "task.finished",
            "task.failed",
        }
    if receiver.get("includeScheduledFailures"):
        allowed.add("task.failed")
    return event_type in allowed


class EndpointRegistry:
    """Receiver state machine plus history and change notifications."""

    def __init__(self, data_dir: Path, changed=None) -> None:
        self.directory = data_dir / "webhooks"
        self.path = self.directory / _ENDPOINTS
        self.state: dict = {
            "version": 1,
            "receivers": [],
            "history": [],
            "changeSequence": 0,
        }
        self._changed = changed

    @classmethod
    def open(cls, data_dir: Path, changed=None) -> EndpointRegistry:
        registry = cls(data_dir, changed)
        try:
            loaded = json.loads(registry.path.read_text(encoding="utf-8"))
        except OSError, json.JSONDecodeError:
            loaded = None
        if isinstance(loaded, dict) and loaded.get("version") == 1:
            registry.state = loaded
        else:
            registry._migrate(data_dir)
        return registry

    def _migrate(self, data_dir: Path) -> None:
        legacy = data_dir / _LEGACY
        try:
            rows = json.loads(legacy.read_text(encoding="utf-8"))
        except OSError, json.JSONDecodeError:
            rows = []
        receivers = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict) or not row.get("id"):
                continue
            receivers.append(
                {
                    **_defaults(str(row.get("name", "")), str(row.get("url", ""))),
                    "id": str(row["id"]),
                    "format": "slack.v1",
                    "secret": str(row.get("secret", "")),
                    "revision": int(row.get("revision", 1) or 1),
                    "deliveryRevision": int(row.get("deliveryRevision", 1) or 1),
                    "state": str(row.get("state", "active")),
                    "activation": {
                        "installationId": "",
                        "sequence": 0,
                        "revision": 1,
                        "mode": "migrated",
                    },
                }
            )
        self.state["receivers"] = receivers
        self._write()

    def _write(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)

    def _commit(
        self,
        action: str,
        receiver: dict | None = None,
        *,
        source: str = "cockpit/api",
    ) -> None:
        self.state["changeSequence"] = int(self.state.get("changeSequence", 0)) + 1
        notice: dict[str, object] = {
            "changeSequence": self.state["changeSequence"],
            "at": stamp(),
            "action": action,
            "source": source,
        }
        if receiver is not None:
            notice["receiverName"] = receiver.get("name", "")
            notice["receiverId"] = receiver.get("id", "")
            notice["destination"] = mask_destination(str(receiver.get("url", "")))
        self.state["notice"] = notice
        self._write()
        if self._changed is not None:
            self._changed(action, receiver, self.state["changeSequence"])

    # ---- views -------------------------------------------------------------

    def _public(self, receiver: dict) -> dict:
        row = {
            "kind": "live",
            "id": receiver["id"],
            "name": receiver["name"],
            "destination": mask_destination(str(receiver.get("url", ""))),
            **{
                key: receiver[key]
                for key in (*SETTING_KEYS[1:], "revision", "deliveryRevision", "state")
            },
            "consecutiveFailures": receiver.get("consecutiveFailures", 0),
            "activationBlocked": bool(receiver.get("activationBlocked")),
            "lastTest": receiver.get("lastTest", "none"),
        }
        if receiver.get("pauseReason"):
            row["pauseReason"] = receiver["pauseReason"]
        if receiver.get("nextProbeAt"):
            row["nextProbeAt"] = receiver["nextProbeAt"]
        retired = receiver.get("retired")
        if isinstance(retired, dict) and retired.get("expiresAt"):
            row["retiredKeyExpiresAt"] = retired["expiresAt"]
        return row

    def list(self) -> list[dict]:
        return [self._public(row) for row in self.state["receivers"]]

    def history(self) -> list[dict]:
        return list(self.state.get("history", []))

    def private(self, receiver_id: str) -> dict | None:
        return next(
            (row for row in self.state["receivers"] if row.get("id") == receiver_id),
            None,
        )

    def notice(self) -> dict | None:
        notice = self.state.get("notice")
        return dict(notice) if isinstance(notice, dict) else None

    def change_sequence(self) -> int:
        return int(self.state.get("changeSequence", 0))

    def acknowledge(self, expected: int) -> bool:
        notice = self.state.get("notice")
        if not isinstance(notice, dict) or int(notice.get("changeSequence", -1)) != expected:
            return False
        del self.state["notice"]
        self._write()
        return True

    # ---- capture -----------------------------------------------------------

    def capturing(self, event_type: str) -> list[dict]:
        """Receivers that take `event_type` deliveries right now."""
        return [
            row
            for row in self.state["receivers"]
            if row.get("state") in ("active", "suspended") and _event_match(row, event_type)
        ]

    def signing_keys(self, receiver: dict) -> list[str]:
        """`signingKeys`: current plus an unexpired retired key, chat never signs."""
        if receiver.get("format", "cezar.json.v1") != "cezar.json.v1":
            return []
        keys = [receiver["secret"]] if receiver.get("secret") else []
        retired = receiver.get("retired")
        if (
            isinstance(retired, dict)
            and retired.get("secret")
            and int(retired.get("expiresAt", 0)) > int(time.time() * 1000)
        ):
            keys.append(str(retired["secret"]))
        return keys

    # ---- transitions -------------------------------------------------------

    def _find(self, receiver_id: str) -> dict:
        row = self.private(receiver_id)
        if row is None:
            raise WebhookStateError(404, "not_found", "Receiver not found")
        return row

    def _check_revision(self, row: dict, expected: int) -> None:
        if int(row.get("revision", 0)) != expected:
            raise WebhookStateError(409, "revision", "Receiver revision mismatch", retry_after=0)

    def create(self, settings: dict, *, source: str = "cockpit/api") -> dict:
        receiver = {
            **_defaults(str(settings["name"]), str(settings["url"])),
            "id": _receiver_id(),
            "format": settings["format"],
            "profile": settings["profile"],
            "preset": settings["preset"],
            "events": list(settings["events"]),
            "includeScheduledFailures": settings["includeScheduledFailures"],
            "scope": settings["scope"],
            "graceSeconds": settings["graceSeconds"],
            "allowLocalNetwork": settings["allowLocalNetwork"],
            "secret": new_secret() if settings["format"] == "cezar.json.v1" else "",
        }
        self.state["receivers"].append(receiver)
        self._commit("created", receiver, source=source)
        return receiver

    def update(self, receiver_id: str, settings: dict, expected_revision: int) -> dict:
        row = self._find(receiver_id)
        self._check_revision(row, expected_revision)
        changed = [key for key in SETTING_KEYS if key in settings and settings[key] != row.get(key)]
        if "url" in changed:
            issue = destination_issue(settings["url"])
            if issue:
                raise WebhookStateError(400, "url", issue)
        name_changed = settings["name"] != row["name"]
        row["name"] = settings["name"]
        for key in changed:
            row[key] = list(settings[key]) if key == "events" else settings[key]
        row["revision"] = int(row.get("revision", 0)) + 1
        if changed:
            row["deliveryRevision"] = int(row.get("deliveryRevision", 0)) + 1
            row["state"] = "inactive"
            row.pop("activation", None)
            row["activationBlocked"] = False
        self._commit("renamed" if name_changed and not changed else "updated", row)
        return row

    def rename(self, receiver_id: str, name: str) -> dict:
        """Name-only edit: no revision bump, no state change (legacy helper)."""
        row = self._find(receiver_id)
        row["name"] = name
        self._commit("renamed", row)
        return row

    def _op(self, row: dict, operation: dict) -> str:
        """Fence: revision + deliveryRevision must match; operationId replays."""
        self._check_revision(row, int(operation["expectedRevision"]))
        if int(row.get("deliveryRevision", 0)) != int(operation["deliveryRevision"]):
            raise WebhookStateError(409, "revision", "Delivery revision mismatch")
        applied = row.get("appliedOperation")
        if isinstance(applied, dict) and applied.get("operationId") == operation["operationId"]:
            return "applied"
        row["appliedOperation"] = dict(operation)
        return "ok"

    def activate(
        self,
        receiver_id: str,
        expected_revision: int,
        *,
        high_water: int,
        installation_id: str,
    ) -> dict:
        row = self._find(receiver_id)
        self._check_revision(row, expected_revision)
        if row.get("state") not in ("inactive", "disabled"):
            raise WebhookStateError(409, "state", "Receiver is already active")
        if row.get("activationBlocked"):
            raise WebhookStateError(409, "blocked", "Activation is blocked")
        if row.get("state") == "disabled" and row.get("lastTest") != "success":
            raise WebhookStateError(
                409, "test_required", "A disabled receiver needs a passing test"
            )
        row["state"] = "active"
        row.pop("pauseReason", None)
        row["activation"] = {
            "installationId": installation_id,
            "sequence": high_water,
            "revision": int(row.get("deliveryRevision", 0)),
            "mode": "manual",
        }
        row["revision"] = int(row.get("revision", 0)) + 1
        self._commit("activated", row)
        return row

    def mark_active(self, receiver_id: str) -> dict:
        """Settings-page path: a new receiver starts active at revision 1."""
        row = self._find(receiver_id)
        if row.get("state") != "active":
            row["state"] = "active"
            self._commit("activated", row)
        return row

    def pause(self, receiver_id: str, operation: dict, *, reason: str = "user") -> dict:
        row = self._find(receiver_id)
        if self._op(row, operation) == "applied":
            return row
        if row.get("state") not in ("active", "suspended"):
            raise WebhookStateError(409, "state", "Only an active receiver can pause")
        row["state"] = "paused"
        row["pauseReason"] = reason
        row["revision"] = int(row.get("revision", 0)) + 1
        self._commit("paused", row)
        return row

    def resume(self, receiver_id: str, operation: dict) -> dict:
        row = self._find(receiver_id)
        if self._op(row, operation) == "applied":
            return row
        if row.get("state") != "paused":
            raise WebhookStateError(409, "state", "Only a paused receiver can resume")
        row["state"] = "active"
        row.pop("pauseReason", None)
        row["revision"] = int(row.get("revision", 0)) + 1
        self._commit("resumed", row)
        return row

    def rotate(self, receiver_id: str, expected_revision: int, mode: str) -> dict:
        row = self._find(receiver_id)
        self._check_revision(row, expected_revision)
        if row.get("format", "cezar.json.v1") != "cezar.json.v1":
            raise WebhookStateError(409, "format", "Chat receivers do not sign")
        retired = row.get("retired")
        if (
            mode == "graceful"
            and isinstance(retired, dict)
            and int(retired.get("expiresAt", 0)) > int(time.time() * 1000)
        ):
            raise WebhookStateError(409, "rotation", "A graceful rotation is in flight")
        if mode == "graceful" and row.get("secret"):
            row["retired"] = {
                "secret": row["secret"],
                "expiresAt": int(time.time() * 1000) + _RETIRE_MS,
            }
        else:
            row.pop("retired", None)
        row["secret"] = new_secret()
        row["revision"] = int(row.get("revision", 0)) + 1
        self._commit("rotated", row)
        return row

    def delete(self, receiver_id: str) -> dict:
        row = self._find(receiver_id)
        self.state["receivers"] = [
            item for item in self.state["receivers"] if item.get("id") != receiver_id
        ]
        entry = {
            "kind": "history",
            "id": row["id"],
            "name": row["name"],
            "deletedAt": stamp(),
        }
        history = self.state.setdefault("history", [])
        history.insert(0, entry)
        del history[_HISTORY_CAP:]
        self._commit("deleted", row)
        return entry

    def delivery_result(self, receiver_id: str, outcome: str, *, test: bool) -> None:
        """Fold a send outcome into the receiver (consecutiveFailures, suspend)."""
        row = self.private(receiver_id)
        if row is None:
            return
        if outcome == "success":
            row["consecutiveFailures"] = 0
            row.pop("nextProbeAt", None)
            if row.get("state") == "suspended":
                row["state"] = "active"
            if test:
                row["lastTest"] = "success"
        elif outcome == "gone":
            if row.get("state") in ("active", "suspended"):
                row["state"] = "disabled"
            if test:
                row["lastTest"] = "permanent_failure"
        else:
            failures = int(row.get("consecutiveFailures", 0)) + 1
            row["consecutiveFailures"] = failures
            if test:
                row["lastTest"] = (
                    "transient_failure" if outcome == "transient" else "permanent_failure"
                )
            if outcome == "transient" and failures >= 10 and row.get("state") == "active":
                row["state"] = "suspended"
                row["nextProbeAt"] = stamp()
        self._commit("delivery_result", row, source="system")


SETTING_KEYS = (
    "url",
    "format",
    "profile",
    "preset",
    "events",
    "includeScheduledFailures",
    "scope",
    "graceSeconds",
    "allowLocalNetwork",
)


def _defaults(name: str, url: str) -> dict:
    return {
        "name": name,
        "url": url,
        "format": "cezar.json.v1",
        "profile": "minimal",
        "preset": "attention",
        "events": [],
        "includeScheduledFailures": False,
        "scope": "main_and_questions",
        "graceSeconds": 180,
        "allowLocalNetwork": False,
        "revision": 1,
        "deliveryRevision": 1,
        "state": "inactive",
        "secret": "",
        "consecutiveFailures": 0,
        "activationBlocked": False,
        "lastTest": "none",
    }
