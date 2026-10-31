"""Slack mrkdwn for a webhook event.

This is the TypeScript `renderSlackMessage` shape: labels, escaped text,
question and link blocks, and a 40_000-byte fallback that drops blocks.
It does not load task state.
"""

from __future__ import annotations

import json
from urllib.parse import quote

_LABELS = {
    "task.attention_required": "Needs your input",
    "task.review_ready": "Ready for review",
    "task.finished": "Task finished",
    "task.failed": "Task failed",
    "task.cancelled": "Task cancelled",
    "webhook.test": "Test message",
}
_LINK_LABELS = {"pullRequest": "Pull request", "issue": "Issue", "cockpit": "Open in cezar"}


def render_slack(event_json: str, *, receiver_name: str = "") -> str:
    event = json.loads(event_json)
    if not isinstance(event, dict) or event.get("type") not in _LABELS:
        raise ValueError("unsupported webhook event")
    kind = str(event["type"])
    label = _LABELS[kind]
    if kind == "webhook.test":
        text = _clip(
            f"{label} · cezar is connected to this channel"
            + (f" · {_escape(receiver_name)}" if receiver_name else "")
        )
        return json.dumps(_body(text, [_section(text)]))
    task = _object(event.get("task"))
    source = _object(event.get("source"))
    title = _escape(str(task.get("title") or str(task.get("id", ""))[:8]))
    project = _escape(str(source.get("projectId", "")))
    text = _clip(f"{label} · {title} · {project}")
    blocks: list[dict[str, object]] = [
        _section(
            f"*{label}*\n{title}\n{_escape(str(task.get('previousStatus', '')))} → "
            f"{_escape(str(task.get('status', '')))}"
        ),
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "verbatim": True,
                    "text": _clip(
                        f"{project} · {_escape(str(task.get('id', '')))} · "
                        f"{_escape(str(event.get('occurredAt', '')))}"
                    ),
                }
            ],
        },
    ]
    data = _object(event.get("data"))
    if kind == "task.attention_required":
        questions = _questions(data.get("questions"))
        if questions:
            blocks.append(_section(questions))
    message = data.get("message")
    if kind == "task.failed" and isinstance(message, str) and message:
        blocks.append(_section(_escape(message)))
    links = _links(event.get("links"), str(source.get("mode", "")))
    if links:
        blocks.append(_section(links))
    encoded = json.dumps(_body(text, blocks))
    if len(encoded.encode()) <= 40_000:
        return encoded
    return json.dumps(
        {"text": text, "link_names": False, "unfurl_links": False, "unfurl_media": False}
    )


def _questions(value: object) -> str:
    if not isinstance(value, list):
        return ""
    questions = ""
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            continue
        raw_options = item.get("options")
        options = raw_options if isinstance(raw_options, list) else []
        extra = ""
        for option in options:
            if not isinstance(option, dict):
                continue
            label = _escape(str(option.get("label", "")))
            description = option.get("description")
            suffix = ""
            if isinstance(description, str) and description:
                suffix = f" — {_escape(description)}"
            extra += f"\n• {label}{suffix}"
        line = f"{index + 1}. {_escape(str(item.get('question', '')))}{extra}"
        if questions and len(questions) + len(line) + 1 > 2900:
            break
        separator = "\n" if questions else ""
        questions += f"{separator}{_clip(line)}"
    return questions


def _links(value: object, mode: str) -> str:
    if not isinstance(value, dict):
        return ""
    parts: list[str] = []
    for kind, url in value.items():
        if not isinstance(kind, str) or not isinstance(url, str):
            continue
        if kind == "cockpit" and mode != "hosted":
            continue
        label = _LINK_LABELS.get(kind)
        if label is None:
            continue
        safe = _escape(
            "".join(quote(char, safe="") if char in "<>| \t\r\n" else char for char in url)
        )
        parts.append(f"<{safe}|{label}>")
    return " · ".join(parts)


def _object(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return value
    return {}


def _body(text: str, blocks: list[dict[str, object]]) -> dict[str, object]:
    return {
        "text": text,
        "blocks": blocks,
        "link_names": False,
        "unfurl_links": False,
        "unfurl_media": False,
    }


def _section(text: str) -> dict[str, object]:
    return {"type": "section", "text": {"type": "mrkdwn", "text": _clip(text), "verbatim": True}}


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _clip(text: str, limit: int = 2900) -> str:
    if len(text) <= limit:
        return text
    clipped = text[: limit - 1]
    # Drop a trailing high surrogate and an unfinished `&...` entity.
    if clipped and 0xD800 <= ord(clipped[-1]) <= 0xDBFF:
        clipped = clipped[:-1]
    amp = clipped.rfind("&")
    if amp != -1 and ";" not in clipped[amp:]:
        clipped = clipped[:amp]
    return clipped + "…"
