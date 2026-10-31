"""Outbound webhook receivers.

Receivers keep a `whsec_` signing key. A test delivery is recorded.
Dry-run does not open a socket. Any other delivery may only target public
https or loopback http.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from base64 import b64encode
from pathlib import Path
from secrets import token_bytes
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPHandler, HTTPSHandler, Request, build_opener

from app.clock import stamp
from app.integrations.clients import forge_base_issue

# No redirect handler: a 3xx is a failure, not a new target.
_OPENER = build_opener(HTTPHandler, HTTPSHandler)

_RECEIVERS = "webhook-receivers.json"
_DELIVERIES = "webhook-deliveries.ndjson"


def sign_webhook(secret: str, delivery_id: str, timestamp: int, body: str) -> str:
    key = _decode_key(secret)
    mac = hmac.new(key, f"{delivery_id}.{timestamp}.{body}".encode(), hashlib.sha256).digest()
    return "v1," + b64encode(mac).decode()


def new_secret() -> str:
    return "whsec_" + b64encode(token_bytes(32)).decode()


def _legacy_view(row: dict[str, object]) -> dict[str, object]:
    """The pre-formats receiver shape the settings page and tests consume."""
    return {
        "id": row.get("id", ""),
        "name": row.get("name", ""),
        "url": row.get("url", ""),
        "secret": row.get("secret", ""),
        "revision": row.get("revision", 1),
        "deliveryRevision": row.get("deliveryRevision", 1),
        "state": row.get("state", "active"),
    }


def _registry(directory: Path):
    from app.integrations.registry import EndpointRegistry

    return EndpointRegistry.open(directory)


def load_receivers(directory: Path) -> list[dict[str, object]]:
    """Receivers in the legacy shape, backed by `webhooks/endpoints.json`."""
    return [_legacy_view(row) for row in _registry(directory).state["receivers"]]


def save_receiver(
    directory: Path, name: str, url: str
) -> tuple[dict[str, object] | None, str | None]:
    """Settings-page create: active immediately, Slack-rendered as before."""
    issue = delivery_url_issue(url, allow_loopback=True)
    if issue:
        return None, issue
    clean = name.strip()
    if not clean or len(clean) > 80:
        return None, "name must be 1 to 80 characters"
    registry = _registry(directory)
    receiver = registry.create(
        {
            "name": clean,
            "url": url,
            "format": "slack.v1",
            "profile": "minimal",
            "preset": "all",
            "events": [],
            "includeScheduledFailures": True,
            "scope": "main_and_questions",
            "graceSeconds": 180,
            "allowLocalNetwork": False,
        },
        source="cockpit/settings",
    )
    registry.mark_active(str(receiver["id"]))
    return _legacy_view(registry.private(str(receiver["id"])) or receiver), None


def update_receiver(
    directory: Path,
    receiver_id: str,
    *,
    name: str,
    url: str,
    expected_revision: int,
) -> tuple[dict[str, object] | None, str | None]:
    """A rename keeps the revision. A new URL bumps it and returns the receiver to inactive."""
    registry = _registry(directory)
    row = registry.private(receiver_id)
    if row is None:
        return None, "not found"
    current = row.get("revision", 1)
    if not isinstance(current, int) or current != expected_revision:
        return None, "revision"
    clean = name.strip()
    if not clean or len(clean) > 80:
        return None, "name must be 1 to 80 characters"
    issue = delivery_url_issue(url, allow_loopback=True)
    if issue:
        return None, issue
    if url != row.get("url"):
        from app.integrations.registry import SETTING_KEYS

        settings = {key: row.get(key) for key in ("name", *SETTING_KEYS)}
        settings["name"] = clean
        settings["url"] = url
        row = registry.update(receiver_id, settings, expected_revision)
    elif clean != row.get("name"):
        row = registry.rename(receiver_id, clean)
    return _legacy_view(row), None


def record_delivery(
    directory: Path, receiver: dict[str, object], *, dry_run: bool
) -> dict[str, object]:
    body = json.dumps({"type": "cezar.test", "at": stamp()})
    delivery_id = uuid.uuid4().hex
    signature = ""
    secret = receiver.get("secret")
    if isinstance(secret, str) and secret:
        signature = sign_webhook(secret, delivery_id, 0, body)
    url = str(receiver.get("url", ""))
    if dry_run:
        result: dict[str, object] = {
            "id": delivery_id,
            "receiverId": receiver.get("id", ""),
            "status": "delivered",
            "httpStatus": 204,
            "reason": "dry-run",
            "at": stamp(),
        }
    else:
        issue = _policy_issue(url)
        if issue:
            result = {
                "id": delivery_id,
                "receiverId": receiver.get("id", ""),
                "status": "failed",
                "reason": issue,
                "at": stamp(),
            }
        else:
            status = _post(url, body, delivery_id, signature)
            result = {
                "id": delivery_id,
                "receiverId": receiver.get("id", ""),
                "status": "delivered" if status is not None and status < 400 else "failed",
                "httpStatus": status,
                "at": stamp(),
            }
    _append(directory / _DELIVERIES, result)
    return result


def _policy_issue(url: str) -> str | None:
    from urllib.parse import urlsplit

    from app.integrations.destination import (
        DestinationPolicy,
        DestinationPolicyError,
        validate_destination,
    )

    host = (urlsplit(url).hostname or "").lower()
    local = host in ("localhost", "127.0.0.1", "::1")
    try:
        validate_destination(url, DestinationPolicy(allow_local_network=local))
    except DestinationPolicyError as exc:
        return exc.code
    return None


def delivery_url_issue(url: str, *, allow_loopback: bool) -> str | None:
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return "webhook URL must be an http(s) address"
    if parsed.username or parsed.password:
        return "webhook URL must not carry credentials"
    host = parsed.hostname
    loopback = host in ("localhost", "127.0.0.1", "::1")
    if loopback:
        return None if allow_loopback and parsed.scheme == "http" else "webhook URL must be https"
    if parsed.scheme != "https":
        return "webhook URL must be https"
    return forge_base_issue(url, "jira")


def _post(url: str, body: str, delivery_id: str, signature: str) -> int | None:
    headers = {"content-type": "application/json", "webhook-id": delivery_id}
    if signature:
        headers["webhook-signature"] = signature
    try:
        request = Request(url, data=body.encode(), headers=headers, method="POST")
        with _OPENER.open(request, timeout=10) as response:
            return int(response.status)
    except URLError, TimeoutError, OSError, ValueError:
        return None


def _decode_key(secret: str) -> bytes:
    if not secret.startswith("whsec_"):
        raise ValueError("invalid signing key")
    from base64 import b64decode

    raw = b64decode(secret[6:], validate=True)
    if len(raw) != 32:
        raise ValueError("invalid signing key")
    return raw


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _append(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value) + "\n")
