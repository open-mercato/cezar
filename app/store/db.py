"""SQLite documents. One table is an id plus a JSON document; filters are virtual columns."""

from __future__ import annotations

from dataclasses import dataclass

from litewriter import LiteWriter, Tx
from stario.json import dumps, loads

from app.clock import now, stamp
from app.engine.model import Automation, Event, Project, Run, Settings
from app.store import polling

TABLES = frozenset({"runs", "events", "projects", "settings", "automations", "automation_log"})

RUN_COLUMNS = {
    "project_id": "TEXT AS (data->>'project_id')",
    "status": "TEXT AS (data->>'status')",
    "created_at": "TEXT AS (data->>'created_at')",
    "parent_id": "TEXT AS (data->>'parent_id')",
    "workflow": "TEXT AS (data->>'workflow')",
}
EVENT_COLUMNS = {
    "run_id": "TEXT AS (data->>'run_id')",
    "seq": "INTEGER AS (data->>'seq')",
}
PROJECT_COLUMNS = {
    "root": "TEXT AS (data->>'root')",
    "created_at": "TEXT AS (data->>'created_at')",
}
AUTOMATION_COLUMNS = {
    "project_id": "TEXT AS (data->>'project_id')",
    "enabled": "INTEGER AS (data->>'enabled')",
    "next_at": "TEXT AS (data->>'next_at')",
    "created_at": "TEXT AS (data->>'created_at')",
}


@dataclass(frozen=True, slots=True)
class IdData:
    id: str
    data: str


@dataclass(frozen=True, slots=True)
class IntData:
    id: int
    data: str


def _columns(tx: Tx, table: str, columns: dict[str, str]) -> None:
    if table not in TABLES:
        raise RuntimeError(table)
    have = {str(row[0]) for row in tx.query(f"SELECT name FROM pragma_table_xinfo('{table}')")}
    for name, decl in columns.items():
        if name not in have:
            tx.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def mark_interrupted(tx: Tx) -> None:
    """Fail every `running` row: the subprocess of a restarted process is gone.

    `Engine.recover` resumes what it can first and calls this for the rest.
    """
    tx.execute(
        "UPDATE runs SET data = json_set(data, '$.status', 'failed', "
        "'$.error', 'interrupted by restart', '$.finished_at', :now) "
        "WHERE status = 'running'",
        now=stamp(now()),
    )


def schema(tx: Tx) -> None:
    tx.execute(
        "CREATE TABLE IF NOT EXISTS runs ("
        " id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK (json_valid(data)))"
    )
    _columns(tx, "runs", RUN_COLUMNS)
    tx.execute("CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, created_at)")
    tx.execute("CREATE INDEX IF NOT EXISTS runs_status ON runs(status)")
    tx.execute("CREATE INDEX IF NOT EXISTS runs_parent ON runs(parent_id)")

    tx.execute(
        "CREATE TABLE IF NOT EXISTS events ("
        " id INTEGER PRIMARY KEY, data TEXT NOT NULL CHECK (json_valid(data)))"
    )
    _columns(tx, "events", EVENT_COLUMNS)
    tx.execute("CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq)")

    tx.execute(
        "CREATE TABLE IF NOT EXISTS projects ("
        " id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK (json_valid(data)))"
    )
    _columns(tx, "projects", PROJECT_COLUMNS)
    tx.execute("CREATE UNIQUE INDEX IF NOT EXISTS projects_root ON projects(root)")

    tx.execute(
        "CREATE TABLE IF NOT EXISTS settings ("
        " id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK (json_valid(data)))"
    )

    tx.execute(
        "CREATE TABLE IF NOT EXISTS automations ("
        " id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK (json_valid(data)))"
    )
    _columns(tx, "automations", AUTOMATION_COLUMNS)
    tx.execute("CREATE INDEX IF NOT EXISTS automations_due ON automations(enabled, next_at)")
    polling.schema(tx)


def _run(row: IdData) -> Run:
    run = Run.from_json(loads(row.data))
    run.id = row.id or run.id
    return run


def _project(row: IdData) -> Project:
    project = Project.from_json(loads(row.data))
    if not project.id:
        return Project(row.id, project.name, project.root, project.base_branch, project.created_at)
    return project


def _automation(row: IdData) -> Automation:
    item = Automation.from_json(loads(row.data))
    if item.id:
        return item
    return Automation(
        row.id,
        item.project_id,
        item.name,
        item.task,
        item.workflow,
        item.runner,
        item.every_minutes,
        item.enabled,
        item.next_at,
        item.created_at,
        item.last_run_id,
    )


def _event(row: IntData) -> Event:
    data = loads(row.data)
    body = data if isinstance(data, dict) else {}
    seq = body.get("seq")
    return Event(
        id=row.id,
        run_id=str(body.get("run_id", "")),
        seq=seq if isinstance(seq, int) else 0,
        type=str(body.get("type", "")),
        text=str(body.get("text", "")),
        step_id=str(body.get("step_id", "")),
        at=str(body.get("at", "")),
    )


def insert_run(tx: Tx, run: Run) -> None:
    tx.execute(
        "INSERT INTO runs (id, data) VALUES (:id, :data)",
        id=run.id,
        data=dumps(run.to_json()),
    )


def save_run(tx: Tx, run: Run) -> None:
    tx.execute(
        "UPDATE runs SET data = :data WHERE id = :id",
        id=run.id,
        data=dumps(run.to_json()),
    )


def delete_run_row(tx: Tx, run_id: str) -> None:
    tx.execute("DELETE FROM events WHERE run_id = :id", id=run_id)
    tx.execute("DELETE FROM runs WHERE id = :id", id=run_id)


def get_run(db: LiteWriter, run_id: str) -> Run | None:
    row = db.one("SELECT id, data FROM runs WHERE id = :id", IdData, id=run_id)
    return _run(row) if row else None


def get_run_tx(tx: Tx, run_id: str) -> Run | None:
    row = tx.one("SELECT id, data FROM runs WHERE id = :id", IdData, id=run_id)
    return _run(row) if row else None


def list_runs(
    db: LiteWriter, project_id: str | None, status: str | None, *, limit: int = 200
) -> list[Run]:
    where: list[str] = []
    params: dict[str, object] = {}
    if project_id:
        where.append("project_id = :project_id")
        params["project_id"] = project_id
    if status:
        where.append("status = :status")
        params["status"] = status
    sql = "SELECT id, data FROM runs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT :limit"
    params["limit"] = limit
    return [_run(row) for row in db.query(sql, IdData, **params)]


def list_queued(db: LiteWriter) -> list[Run]:
    rows = db.query(
        "SELECT id, data FROM runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 50",
        IdData,
    )
    return [_run(row) for row in rows]


def list_children(db: LiteWriter, parent_id: str) -> list[Run]:
    rows = db.query(
        "SELECT id, data FROM runs WHERE parent_id = :parent ORDER BY created_at ASC",
        IdData,
        parent=parent_id,
    )
    return [_run(row) for row in rows]


def list_run_ids(db: LiteWriter) -> set[str]:
    rows = db.query("SELECT id, data FROM runs", IdData)
    return {row.id for row in rows}


def count_in_flight_children(db: LiteWriter, parent_id: str) -> int:
    value = db.value(
        "SELECT count(*) FROM runs WHERE parent_id = :parent "
        "AND status IN ('queued', 'running', 'waiting')",
        parent=parent_id,
    )
    return int(value)


def add_event(tx: Tx, run_id: str, type: str, text: str, step_id: str, at: str) -> int:
    seq = tx.value(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE run_id = :run_id",
        run_id=run_id,
    )
    payload = {
        "run_id": run_id,
        "seq": int(seq),
        "type": type,
        "text": text[:16_000],
        "step_id": step_id,
        "at": at,
    }
    tx.execute(
        "INSERT INTO events (data) VALUES (:data)",
        data=dumps(payload),
    )
    return int(seq)


def list_events_since(db: LiteWriter, run_id: str, after_seq: int) -> list[Event]:
    rows = db.query(
        "SELECT id, data FROM events WHERE run_id = :run_id AND seq > :after "
        "ORDER BY seq ASC LIMIT 5000",
        IntData,
        run_id=run_id,
        after=after_seq,
    )
    return [_event(row) for row in rows]


def list_events(db: LiteWriter, run_id: str) -> list[Event]:
    rows = db.query(
        "SELECT id, data FROM events WHERE run_id = :run_id ORDER BY seq DESC LIMIT 200",
        IntData,
        run_id=run_id,
    )
    return [_event(row) for row in reversed(rows)]


def insert_project(tx: Tx, project: Project) -> None:
    tx.execute(
        "INSERT INTO projects (id, data) VALUES (:id, :data)",
        id=project.id,
        data=dumps(project.to_json()),
    )


def save_project(tx: Tx, project: Project) -> None:
    tx.execute(
        "UPDATE projects SET data = :data WHERE id = :id",
        id=project.id,
        data=dumps(project.to_json()),
    )


def delete_project(tx: Tx, project_id: str) -> None:
    tx.execute("DELETE FROM projects WHERE id = :id", id=project_id)


def get_project(db: LiteWriter, project_id: str) -> Project | None:
    row = db.one("SELECT id, data FROM projects WHERE id = :id", IdData, id=project_id)
    return _project(row) if row else None


def find_project_by_root(db: LiteWriter, root: str) -> Project | None:
    row = db.one("SELECT id, data FROM projects WHERE root = :root", IdData, root=root)
    return _project(row) if row else None


def list_projects(db: LiteWriter) -> list[Project]:
    rows = db.query("SELECT id, data FROM projects ORDER BY created_at ASC", IdData)
    return [_project(row) for row in rows]


def get_settings(db: LiteWriter) -> Settings:
    row = db.one("SELECT id, data FROM settings WHERE id = 'workspace'", IdData)
    if row is None:
        return Settings()
    return Settings.from_json(loads(row.data))


def save_settings(tx: Tx, settings: Settings) -> None:
    tx.execute(
        "INSERT INTO settings (id, data) VALUES ('workspace', :data) "
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        data=dumps(settings.to_json()),
    )


def automation_from_row(row: IdData) -> Automation:
    return _automation(row)


def insert_automation(tx: Tx, item: Automation) -> None:
    tx.execute(
        "INSERT INTO automations (id, data) VALUES (:id, :data)",
        id=item.id,
        data=dumps(item.to_json()),
    )


def save_automation(tx: Tx, item: Automation) -> None:
    tx.execute(
        "UPDATE automations SET data = :data WHERE id = :id",
        id=item.id,
        data=dumps(item.to_json()),
    )


def delete_automation(tx: Tx, automation_id: str) -> None:
    tx.execute("DELETE FROM automations WHERE id = :id", id=automation_id)
    polling.forget(tx, automation_id)


def get_automation(db: LiteWriter, automation_id: str) -> Automation | None:
    row = db.one("SELECT id, data FROM automations WHERE id = :id", IdData, id=automation_id)
    return _automation(row) if row else None


def list_automations(db: LiteWriter, project_id: str | None) -> list[Automation]:
    if project_id:
        rows = db.query(
            "SELECT id, data FROM automations WHERE project_id = :project ORDER BY created_at ASC",
            IdData,
            project=project_id,
        )
    else:
        rows = db.query("SELECT id, data FROM automations ORDER BY created_at ASC", IdData)
    return [_automation(row) for row in rows]


def list_enabled_automations(db: LiteWriter) -> list[Automation]:
    rows = db.query(
        "SELECT id, data FROM automations WHERE enabled = 1 ORDER BY next_at ASC",
        IdData,
    )
    return [_automation(row) for row in rows]
