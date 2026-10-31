"""`discord.v1` wire renderer — port of `packages/cezar/src/webhooks/discord.ts`.

Builds the Discord webhook message: a mention-safe `content` line plus one
embed carrying the event. Over the 6000-char embed cap the message degrades
to content-only, matching the TypeScript fallback.
"""

from __future__ import annotations

import json

from app.integrations.slack_render import _LABELS

_COLORS = {
    "task.attention_required": 15105570,
    "task.review_ready": 3447003,
    "webhook.test": 3447003,
    "task.finished": 3066993,
    "task.failed": 15158332,
    "task.cancelled": 9807270,
}
_CONTENT_LIMIT = 2000
_TITLE_LIMIT = 256
_EMBED_LIMIT = 6000


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _escape(text: str) -> str:
    """Neutralize mentions and markdown, like `escapeDiscord` upstream."""
    out = []
    for char in text:
        if char == "@":
            out.append("@​")
        elif char in "\\`*_|~>":
            out.append("\\" + char)
        else:
            out.append(char)
    text = "".join(out)
    lines = []
    for line in text.split("\n"):
        if line.startswith("#"):
            line = "\\" + line
        elif line.startswith("-"):
            line = "\\" + line
        lines.append(line)
    return "\n".join(lines)


def _fields(event: dict) -> list[dict]:
    """Inline Project/Status/Task fields plus an optional Error field."""
    fields: list[dict] = []
    task = event.get("task") or {}
    source = event.get("source") or {}
    fields.append(
        {
            "name": "Project",
            "value": _escape(str(source.get("projectId", "default"))),
            "inline": True,
        }
    )
    status = task.get("status", "")
    fields.append({"name": "Status", "value": _escape(str(status)), "inline": True})
    title = task.get("title") or task.get("id", "")
    fields.append({"name": "Task", "value": _clip(_escape(str(title)), 1024), "inline": True})
    data = event.get("data") or {}
    message = data.get("message") or data.get("error") or ""
    if message:
        fields.append({"name": "Error", "value": _clip(_escape(str(message)), 1024)})
    return fields


def render_discord(event_json: str, *, receiver_name: str = "") -> str:
    """Render one webhook event as a Discord webhook POST body."""
    try:
        event = json.loads(event_json)
    except ValueError:
        event = {}
    if not isinstance(event, dict):
        event = {}
    event_type = str(event.get("type", ""))
    label = _LABELS.get(event_type, event_type or "event")
    task = event.get("task") or {}
    title = str(task.get("title") or task.get("id") or "")
    content = f"**{_escape(label)}** — {_escape(title)}" if title else f"**{_escape(label)}**"
    if receiver_name:
        content += f" · {_escape(receiver_name)}"
    # `<url>` tokens must survive un-escaped so Discord does not unfurl links.
    content = content.replace("\\<", "<")
    embed: dict = {
        "title": _clip(_escape(f"{label} · {title}" if title else label), _TITLE_LIMIT),
        "color": _COLORS.get(event_type, 9807270),
        "timestamp": str(event.get("occurredAt", "")),
        "fields": _fields(event),
        "footer": {"text": "cezar"},
    }
    data = event.get("data") or {}
    questions = data.get("questions")
    if isinstance(questions, list) and questions:
        lines = [f"- {_escape(str(q.get('question', q)))}" for q in questions[:5] if q]
        embed["description"] = _clip("\n".join(lines), 4096)
    links = event.get("links") or {}
    cockpit = links.get("cockpit")
    if isinstance(cockpit, str) and cockpit:
        embed["url"] = cockpit
    payload = {
        "content": _clip(content, _CONTENT_LIMIT),
        "allowed_mentions": {"parse": []},
        "embeds": [embed],
    }
    if len(json.dumps(payload)) > _EMBED_LIMIT:
        return json.dumps(
            {"content": _clip(content, _CONTENT_LIMIT), "allowed_mentions": {"parse": []}}
        )
    return json.dumps(payload)
