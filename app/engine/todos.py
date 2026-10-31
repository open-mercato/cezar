"""The follow-up inbox file agents append to.

`.ai/cezar/todos.json`, or `CEZ_TODOS_FILE` when that is set. A broken file
reads as an empty inbox. A row without a summary is skipped. A row without
an id is given one on read.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import cast

from stario.json import JsonValue, loads
from stario.json import dumps as json_dumps


def read_todos(path: Path) -> list[dict[str, object]]:
    try:
        loaded = loads(path.read_text(encoding="utf-8"))
    except OSError, UnicodeError, ValueError:
        return []
    if not isinstance(loaded, list):
        return []
    rows: list[dict[str, object]] = []
    for item in loaded:
        row = _row(item)
        if row is not None:
            rows.append(row)
    return rows


def write_todos(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_dumps(cast(JsonValue, rows)) + "\n", encoding="utf-8")


def remove_todo(path: Path, todo_id: str) -> bool:
    rows = read_todos(path)
    kept = [row for row in rows if row.get("id") != todo_id]
    if len(kept) == len(rows):
        return False
    write_todos(path, kept)
    return True


def mark_started(path: Path, todo_id: str, run_id: str) -> bool:
    rows = read_todos(path)
    for row in rows:
        if row.get("id") != todo_id:
            continue
        if row.get("startedTaskId"):
            return False
        row["startedTaskId"] = run_id
        write_todos(path, rows)
        return True
    return False


def _row(item: object) -> dict[str, object] | None:
    if not isinstance(item, dict):
        return None
    summary = item.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        return None
    row: dict[str, object] = {"summary": summary.strip()}
    ident = item.get("id")
    row["id"] = ident if isinstance(ident, str) and ident.strip() else uuid.uuid4().hex
    for key in (
        "ts",
        "taskId",
        "action",
        "prUrl",
        "suggestedSkill",
        "suggestedArgs",
        "suggestedPrompt",
        "startedTaskId",
    ):
        value = item.get(key)
        if isinstance(value, str) and value:
            row[key] = value
    if isinstance(item.get("runnable"), bool):
        row["runnable"] = item["runnable"]
    return row
