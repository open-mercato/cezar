"""Import a TypeScript `runs.json` array into the SQLite run table.

Event NDJSON is read from `runs/<id>.ndjson` beside the data directory, which
is where the TypeScript store writes `<dataDir>/runs/<id>.ndjson`. A record
without a usable id, task, or status is skipped.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.engine.model import STATUSES, Run


def runs_from_document(raw: object, project_id: str) -> tuple[list[Run], int]:
    if not isinstance(raw, list):
        raise ValueError("runs.json must be a list")
    imported: list[Run] = []
    skipped = 0
    seen: set[str] = set()
    for item in raw:
        run = _one(item, project_id)
        if run is None or run.id in seen:
            skipped += 1
            continue
        seen.add(run.id)
        imported.append(run)
    return imported, skipped


def load_runs_file(path: Path, project_id: str) -> tuple[list[Run], int]:
    return runs_from_document(json.loads(path.read_text(encoding="utf-8")), project_id)


def events_near(runs_json: Path, run_id: str) -> list[dict[str, str]]:
    """Lines from the TypeScript event file for this run, if it is on disk.

    The stored id is compact hex. The file on disk keeps the dashed UUID.
    """
    dashed = ""
    if len(run_id) == 32:
        dashed = f"{run_id[0:8]}-{run_id[8:12]}-{run_id[12:16]}-{run_id[16:20]}-{run_id[20:]}"
    names = [run_id]
    if dashed:
        names.append(dashed)
    candidates = tuple(
        folder / f"{name}.ndjson"
        for name in names
        for folder in (runs_json.parent / "runs", runs_json.parent)
    )
    for path in candidates:
        if path.is_file():
            return _events(path)
    return []


def _events(path: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            loaded = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(loaded, dict):
            continue
        kind = loaded.get("type")
        if not isinstance(kind, str) or not kind:
            continue
        text = loaded.get("text")
        if not isinstance(text, str):
            message = loaded.get("message")
            text = message if isinstance(message, str) else ""
        step = loaded.get("stepId")
        at = loaded.get("ts")
        rows.append(
            {
                "type": kind,
                "text": text,
                "step_id": step if isinstance(step, str) else "",
                "at": at if isinstance(at, str) else "",
            }
        )
    return rows


def _one(item: object, project_id: str) -> Run | None:
    if not isinstance(item, dict):
        return None
    run_id = _id(item.get("id"))
    status = item.get("status")
    task = item.get("task")
    if run_id is None or status not in STATUSES or not isinstance(task, str) or not task.strip():
        return None
    workflow_raw = item.get("workflow")
    workflow = workflow_raw if isinstance(workflow_raw, str) and workflow_raw else "quick-task"
    runner_raw = item.get("runner")
    runner = runner_raw if isinstance(runner_raw, str) and runner_raw else "claude"
    created_raw = item.get("createdAt")
    created = created_raw if isinstance(created_raw, str) else ""
    if not created:
        return None
    definition = item.get("workflowDef")
    workflow_def: dict[str, object]
    if isinstance(definition, dict):
        workflow_def = definition
    else:
        workflow_def = {"name": workflow, "steps": []}
    title_raw = item.get("title")
    title = title_raw if isinstance(title_raw, str) and title_raw else task
    branch_raw = item.get("branch")
    base_raw = item.get("baseBranch")
    error_raw = item.get("error")
    return Run(
        id=run_id,
        project_id=project_id,
        title=title[:80],
        task=task,
        workflow=workflow,
        status=str(status),
        runner=runner,
        created_at=created,
        workflow_def=workflow_def,
        branch=branch_raw if isinstance(branch_raw, str) else "",
        base_branch=base_raw if isinstance(base_raw, str) else "",
        error=error_raw if isinstance(error_raw, str) else "",
        archived=item.get("archived") is True,
    )


def _id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    compact = value.replace("-", "").lower()
    if len(compact) == 32 and all(ch in "0123456789abcdef" for ch in compact):
        return compact
    return None
