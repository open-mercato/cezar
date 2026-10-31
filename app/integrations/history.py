"""Webhook delivery history and activity logs — port of `history.ts`.

Two NDJSON files under `<data_dir>/webhooks/`:

- `deliveries.ndjson`: one row per delivery, latest write wins by `deliveryId`.
  Rows are pruned after 30 days on write.
- `activity.ndjson`: an append-only admin log of receiver transitions.

Paging uses the TypeScript `pageRecords` cursor: a base64url JSON token
`{"after": [at, id]}` over rows sorted by `(at, id)` descending.
"""

from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path

_RETAIN_MS = 30 * 24 * 3_600_000
_AT_MS = 86_400_000


def _iso(ms: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + ".000Z"


def _ms(value: object) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            from datetime import datetime

            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            try:
                return int(value)
            except ValueError:
                return 0
    return 0


def _cursor(after: tuple[int, str]) -> str:
    raw = json.dumps({"after": [after[0], after[1]]})
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _read_cursor(cursor: str | None) -> tuple[int, str] | None:
    if not cursor:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        loaded = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except ValueError, json.JSONDecodeError:
        return None
    if not isinstance(loaded, dict):
        return None
    after = loaded.get("after")
    if not isinstance(after, list) or len(after) != 2:
        return None
    return _ms(after[0]), str(after[1])


def _read_rows(path: Path) -> list[dict]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    rows = []
    for line in lines:
        try:
            loaded = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(loaded, dict):
            rows.append(loaded)
    return rows


def _write_rows(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    os.replace(tmp, path)


def _key(row: dict) -> tuple[int, str]:
    return _ms(row.get("at") or row.get("createdAt") or row.get("completedAt")), str(
        row.get("deliveryId") or row.get("id") or ""
    )


class WebhookHistory:
    """Upsert-on-write delivery log plus an append-only activity log."""

    def __init__(self, data_dir: Path) -> None:
        self.directory = data_dir / "webhooks"
        self.deliveries_path = self.directory / "deliveries.ndjson"
        self.activity_path = self.directory / "activity.ndjson"

    def record_delivery(self, row: dict) -> None:
        rows = _read_rows(self.deliveries_path)
        delivery_id = str(row.get("deliveryId", ""))
        rows = [item for item in rows if item.get("deliveryId") != delivery_id]
        rows.append(row)
        floor = int(time.time() * 1000) - _RETAIN_MS
        rows = [item for item in rows if _key(item)[0] >= floor]
        _write_rows(self.deliveries_path, rows)

    def deliveries(
        self, *, receiver_id: str | None = None, task_id: str | None = None
    ) -> list[dict]:
        rows = _read_rows(self.deliveries_path)
        if receiver_id is not None:
            rows = [row for row in rows if row.get("receiverId") == receiver_id]
        if task_id is not None:
            rows = [row for row in rows if row.get("taskId") == task_id]
        return rows

    def find_delivery(self, delivery_id: str) -> dict | None:
        return next(
            (
                row
                for row in _read_rows(self.deliveries_path)
                if row.get("deliveryId") == delivery_id
            ),
            None,
        )

    def record_activity(self, action: str, receiver: dict | None, detail: str = "") -> None:
        entry: dict[str, object] = {
            "id": "act_" + base64.urlsafe_b64encode(os.urandom(12)).decode().rstrip("="),
            "at": _iso(int(time.time() * 1000)),
            "action": action,
        }
        if receiver is not None:
            entry["receiverId"] = receiver.get("id", "")
            entry["receiverName"] = receiver.get("name", "")
            entry["revision"] = receiver.get("revision", 0)
        if detail:
            entry["detail"] = detail
        self.directory.mkdir(parents=True, exist_ok=True)
        with self.activity_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry) + "\n")

    def activity(self, receiver_id: str) -> list[dict]:
        return [
            row for row in _read_rows(self.activity_path) if row.get("receiverId") == receiver_id
        ]


def page_rows(rows: list[dict], *, limit: int, cursor: str | None) -> dict:
    """`pageRecords`: newest-first `(at, id)` page with a `nextCursor` token."""
    ordered = sorted(rows, key=_key, reverse=True)
    start = _read_cursor(cursor)
    if start is not None:
        ordered = [row for row in ordered if _key(row) < start]
    items = ordered[:limit]
    has_more = len(ordered) > limit
    page: dict[str, object] = {
        "items": items,
        "total": len(rows),
        "hasMore": has_more,
    }
    if has_more and items:
        at, row_id = _key(items[-1])
        page["nextCursor"] = _cursor((at, row_id))
    return page
