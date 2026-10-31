"""Receiver settings and operation validation.

Mirrors `packages/contract/src/webhooks.ts`: the same field names, defaults,
enum sets, and the chat-destination rules for `slack.v1` / `discord.v1` /
`cezar.json.v1` URLs. Returns `(value, None)` or `(None, reason)` — never
raises on bad input.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

TASK_EVENTS = (
    "task.attention_required",
    "task.review_ready",
    "task.finished",
    "task.failed",
    "task.cancelled",
)
FORMATS = ("cezar.json.v1", "slack.v1", "discord.v1")
DISCORD_HOSTS = frozenset(
    {"discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"}
)
GRACE_SECONDS = (0, 60, 180, 600)
SCOPES = ("main_and_questions", "every_task")
PRESETS = ("attention", "all", "custom")
PROFILES = ("minimal", "standard")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SLACK_PATH = re.compile(r"^/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9_-]+$")
_DISCORD_PATH = re.compile(r"^/api/(?:v10/)?webhooks/[0-9]{17,20}/[A-Za-z0-9_-]{60,80}$")

_DEFAULTS: dict[str, object] = {
    "format": "cezar.json.v1",
    "profile": "minimal",
    "preset": "attention",
    "events": [],
    "includeScheduledFailures": False,
    "scope": "main_and_questions",
    "graceSeconds": 180,
    "allowLocalNetwork": False,
}
_KEYS = frozenset({*_DEFAULTS, "name", "url"})


def _split(url: str):
    """`[authority][path][suffix]` like the contract's regex split."""
    match = re.match(r"^https?://([^/?#]+)([^?#]*)(.*)$", url, re.IGNORECASE)
    return match.groups() if match else ("", "", "")


def destination_issue(url: object) -> str | None:
    """Syntax-only destination check: http(s), no credentials, no fragment."""
    if not isinstance(url, str) or not url or len(url) > 2048:
        return "Use an HTTP(S) URL without credentials or fragments"
    if not re.match(r"^https?://[^\s@#]+$", url, re.IGNORECASE):
        return "Use an HTTP(S) URL without credentials or fragments"
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return "Use an HTTP(S) URL without credentials or fragments"
    if not host or len(host) > 255:
        return "Use an HTTP(S) URL without credentials or fragments"
    return None


def chat_destination_issue(fmt: str, url: str, allow_local: bool) -> str | None:
    """`chatDestination` from the contract: chat URLs must be the real endpoint."""
    if fmt != "cezar.json.v1" and allow_local:
        return "Chat destinations cannot use local networks"
    authority, path, suffix = _split(url)
    host = re.sub(r":[0-9]+$", "", authority.lower())
    if fmt == "cezar.json.v1":
        if host == "hooks.slack.com":
            return "Choose Slack as the destination type"
        if host in DISCORD_HOSTS:
            return "Choose Discord as the destination type"
        return None
    if fmt == "slack.v1":
        valid = authority.lower() == "hooks.slack.com" and _SLACK_PATH.match(path)
        message = (
            "Paste the full Slack Incoming Webhook URL, like https://hooks.slack.com/services/…"
        )
    else:
        valid = authority.lower() in DISCORD_HOSTS and _DISCORD_PATH.match(path)
        message = "Paste the full Discord webhook URL, like https://discord.com/api/webhooks/…"
    if not url.lower().startswith("https://") or suffix or not valid:
        return message
    return None


def parse_settings(body: object, *, create: bool) -> tuple[dict | None, str | None]:
    """`createWebhookSchema`/`updateWebhookSchema` minus the revision check.

    `create=True` requires `url`; `create=False` keeps it optional. Unknown
    keys are rejected like `z.strictObject`.
    """
    if not isinstance(body, dict):
        return None, "Expected a JSON object"
    extra = [key for key in body if key not in _KEYS and key != "expectedRevision"]
    if extra:
        return None, f"Unrecognized key: {extra[0]}"
    name = body.get("name")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
        return None, "Invalid name"
    url = body.get("url")
    if create and not isinstance(url, str):
        return None, "Invalid url"
    if url is not None:
        if not isinstance(url, str):
            return None, "Invalid url"
        if issue := destination_issue(url):
            return None, issue
    settings = {key: body.get(key, default) for key, default in _DEFAULTS.items()}
    for key, allowed in (
        ("format", FORMATS),
        ("profile", PROFILES),
        ("preset", PRESETS),
        ("scope", SCOPES),
        ("graceSeconds", GRACE_SECONDS),
    ):
        if settings[key] not in allowed:
            return None, f"Invalid {key}"
    for key in ("includeScheduledFailures", "allowLocalNetwork"):
        if not isinstance(settings[key], bool):
            return None, f"Invalid {key}"
    events = settings["events"]
    if (
        not isinstance(events, list)
        or len(events) > 5
        or any(item not in TASK_EVENTS for item in events)
        or len(set(events)) != len(events)
    ):
        return None, "Invalid events"
    custom = settings["preset"] == "custom"
    if events and not custom:
        return None, "events require the custom preset"
    if custom and not events:
        return None, "custom preset requires events"
    issue = chat_destination_issue(
        str(settings["format"]), url or "", bool(settings["allowLocalNetwork"])
    )
    if issue:
        return None, issue
    settings["name"] = name.strip()
    if isinstance(url, str):
        settings["url"] = url
    return settings, None


def parse_revision(body: object) -> tuple[int | None, str | None]:
    """`expectedRevision` shared by update/activate/rotate bodies."""
    if not isinstance(body, dict):
        return None, "Expected a JSON object"
    value = body.get("expectedRevision")
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        return None, "Invalid expectedRevision"
    return value, None


def parse_operation(body: object) -> tuple[dict | None, str | None]:
    """`webhookOperationSchema`: fence token for state transitions."""
    if not isinstance(body, dict):
        return None, "Expected a JSON object"
    revision, issue = parse_revision(body)
    if issue:
        return None, issue
    delivery_revision = body.get("deliveryRevision")
    if (
        not isinstance(delivery_revision, int)
        or isinstance(delivery_revision, bool)
        or delivery_revision < 1
    ):
        return None, "Invalid deliveryRevision"
    operation = body.get("operationId")
    if not isinstance(operation, str) or not _ID.match(operation):
        return None, "Invalid operationId"
    return {
        "expectedRevision": revision,
        "deliveryRevision": delivery_revision,
        "operationId": operation,
    }, None


def parse_activation(body: object) -> tuple[int | None, str | None]:
    """`webhookActivationSchema`: confirmation is a literal `true`."""
    revision, issue = parse_revision(body)
    if issue:
        return None, issue
    if body.get("confirmed") is not True:  # type: ignore[union-attr]
        return None, "Activation requires confirmed: true"
    return revision, None


def parse_rotation(body: object) -> tuple[tuple[int, str] | None, str | None]:
    revision, issue = parse_revision(body)
    if issue or revision is None:
        return None, issue or "Invalid expectedRevision"
    mode = body.get("mode")  # type: ignore[union-attr]
    if mode not in ("graceful", "revoke_now"):
        return None, "Invalid mode"
    return (revision, mode), None


def parse_acknowledge(body: object) -> tuple[int | None, str | None]:
    if not isinstance(body, dict):
        return None, "Expected a JSON object"
    value = body.get("expectedChangeSequence")
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        return None, "Invalid expectedChangeSequence"
    return value, None
