"""Enqueue one delivery per capturing receiver when a task changes state.

`CEZ_WEBHOOKS=1` and at least one `active`/`suspended` receiver subscribed to
the event are required. The event body follows the contract envelope
(`evt_*` id, `schemaVersion`, `task`, `source`, `data`). Each receiver's
format picks the wire payload; signing happens at send time in the service.
Dry-run marks rows delivered and does not open a socket. A failure here
never fails the run.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from app.clock import stamp
from app.integrations.service import WebhookService, webhooks_enabled

_KINDS = {
    "review": "task.review_ready",
    "done": "task.finished",
    "failed": "task.failed",
    "cancelled": "task.cancelled",
    "waiting": "task.attention_required",
}


def notify_task(
    data_dir: Path,
    *,
    run_id: str,
    title: str,
    status: str,
    previous: str,
    project_id: str,
    error: str,
    dry_run: bool,
) -> None:
    if not webhooks_enabled():
        return
    kind = _KINDS.get(status)
    if kind is None:
        return
    event = {
        "id": "evt_" + str(uuid.uuid4()),
        "schemaVersion": 1,
        "type": kind,
        "occurredAt": stamp(),
        "task": {
            "id": run_id,
            "title": title,
            "status": status,
            "previousStatus": previous,
        },
        "source": {"projectId": project_id, "mode": "local"},
        "data": {"message": error} if error else {},
    }
    try:
        service = WebhookService.open(
            data_dir, dry_run=dry_run, project_id=project_id, mode="local"
        )
        if service.capture(event):
            service.deliver_due()
    except OSError, ValueError:
        return
