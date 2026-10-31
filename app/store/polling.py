"""Poller state: what each automation has seen, where it stopped, and its execution log.

`automation_seen` is the dedupe set, one row per (automation, event key). `automation_state` is
the poll cursor. `automation_log` is the execution log: every poll that found something, every
manual check, every run-now and schedule launch. A log entry is a JSON document, so the check
detail screen and the retry command read one row.
"""

from __future__ import annotations

from dataclasses import dataclass

from litewriter import LiteWriter, Tx
from stario.json import dumps, loads

LOG_COLUMNS = {
    "automation_id": "TEXT AS (data->>'automationId')",
    "at": "TEXT AS (data->>'at')",
}
LOG_KEEP = 200


@dataclass(frozen=True, slots=True)
class IdData:
    id: str
    data: str


@dataclass(frozen=True, slots=True)
class Key:
    key: str


def schema(tx: Tx) -> None:
    from app.store.db import _columns

    tx.execute(
        "CREATE TABLE IF NOT EXISTS automation_seen ("
        " automation_id TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL,"
        " PRIMARY KEY (automation_id, key)) WITHOUT ROWID"
    )
    tx.execute(
        "CREATE TABLE IF NOT EXISTS automation_state ("
        " id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK (json_valid(data)))"
    )
    tx.execute(
        "CREATE TABLE IF NOT EXISTS automation_log ("
        " id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK (json_valid(data)))"
    )
    _columns(tx, "automation_log", LOG_COLUMNS)
    tx.execute("CREATE INDEX IF NOT EXISTS automation_log_at ON automation_log(automation_id, at)")


def mark_seen(tx: Tx, automation_id: str, keys: list[str], at: str) -> None:
    for key in keys:
        tx.execute(
            "INSERT OR IGNORE INTO automation_seen (automation_id, key, at)"
            " VALUES (:automation_id, :key, :at)",
            automation_id=automation_id,
            key=key,
            at=at,
        )


def seen_keys(db: LiteWriter, automation_id: str) -> set[str]:
    rows = db.query(
        "SELECT key FROM automation_seen WHERE automation_id = :id", Key, id=automation_id
    )
    return {row.key for row in rows}


def get_state(db: LiteWriter, automation_id: str) -> dict[str, object] | None:
    row = db.one("SELECT id, data FROM automation_state WHERE id = :id", IdData, id=automation_id)
    return _loads(row.data) if row else None


def put_state(tx: Tx, automation_id: str, state: dict[str, object]) -> None:
    tx.execute(
        "INSERT INTO automation_state (id, data) VALUES (:id, :data)"
        " ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        id=automation_id,
        data=dumps(state),
    )


def reset_state(tx: Tx, automation_id: str) -> None:
    tx.execute("DELETE FROM automation_state WHERE id = :id", id=automation_id)


def clear_seen(tx: Tx, automation_id: str) -> None:
    tx.execute("DELETE FROM automation_seen WHERE automation_id = :id", id=automation_id)


def forget(tx: Tx, automation_id: str) -> None:
    """Drop everything the poller kept for a deleted automation."""
    for table, column in (
        ("automation_seen", "automation_id"),
        ("automation_state", "id"),
        ("automation_log", "automation_id"),
    ):
        tx.execute(f"DELETE FROM {table} WHERE {column} = :id", id=automation_id)  # noqa: S608


def append_log(tx: Tx, entry: dict[str, object]) -> None:
    tx.execute(
        "INSERT OR REPLACE INTO automation_log (id, data) VALUES (:id, :data)",
        id=str(entry["id"]),
        data=dumps(entry),
    )
    tx.execute(
        "DELETE FROM automation_log WHERE automation_id = :automation_id AND id NOT IN ("
        " SELECT id FROM automation_log WHERE automation_id = :automation_id"
        " ORDER BY at DESC LIMIT :keep)",
        automation_id=str(entry["automationId"]),
        keep=LOG_KEEP,
    )


def get_log(db: LiteWriter, entry_id: str) -> dict[str, object] | None:
    row = db.one("SELECT id, data FROM automation_log WHERE id = :id", IdData, id=entry_id)
    return _loads(row.data) if row else None


def list_log(
    db: LiteWriter, automation_id: str | None = None, limit: int = 50
) -> list[dict[str, object]]:
    if automation_id:
        rows = db.query(
            "SELECT id, data FROM automation_log WHERE automation_id = :a"
            " ORDER BY at DESC LIMIT :n",
            IdData,
            a=automation_id,
            n=limit,
        )
    else:
        rows = db.query(
            "SELECT id, data FROM automation_log ORDER BY at DESC LIMIT :n", IdData, n=limit
        )
    return [item for row in rows if (item := _loads(row.data)) is not None]


def _loads(text: str) -> dict[str, object] | None:
    try:
        loaded = loads(text)
    except ValueError:
        return None
    return loaded if isinstance(loaded, dict) else None
