"""Wire records for the run and project routes.

Required keys match `runRecordSchema` / `projectListEntrySchema`. Optional keys
are omitted when this port has nothing to say, which is what an absent field
means on those schemas.
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

from stario.json import JsonValue

from app.engine.gitwork import forge_kind, head_branch, is_git_repo
from app.engine.model import Run
from app.engine.proc_usage import current_usage

# Fields the response carries only when the run has them.
_OPTIONAL = (
    ("model", "model"),
    ("startedAt", "started_at"),
    ("finishedAt", "finished_at"),
    ("error", "error"),
    ("branch", "branch"),
    ("worktreePath", "worktree_path"),
    ("baseBranch", "base_branch"),
    ("costUsd", "cost_usd"),
    ("archivedAt", "archived_at"),
    ("pinnedAt", "pinned_at"),
    ("groupId", "group_id"),
    ("accountId", "account_id"),
    ("variant", "variant"),
    ("seenAt", "seen_at"),
    ("autoResumeAt", "auto_resume_at"),
    ("autoResumeAttempts", "auto_resume_attempts"),
    ("pullRequestUrl", "pull_request_url"),
)


def public_run(run: Run, *, full: bool) -> dict[str, JsonValue]:
    body: dict[str, JsonValue] = {
        "id": run.id,
        "title": run.title,
        "workflow": run.workflow,
        "task": run.task,
        "status": run.status,
        "runner": run.runner,
        "createdAt": run.created_at,
        "tokensUsed": run.tokens_used,
        "archived": run.archived,
        "steps": _steps(run),
    }
    flags = {"autonomous": run.autonomous, "pinned": run.pinned}
    body.update({key: True for key, on in flags.items() if on})
    if run.in_place:
        body["worktree"] = False
    for key, attr in _OPTIONAL:
        if value := getattr(run, attr):
            body[key] = value
    usage = current_usage(run.id)
    if usage is not None:
        body["usage"] = cast(JsonValue, usage)
    if run.parent_id or run.root_id or run.dispatch_report:
        dispatch: dict[str, JsonValue] = {"rootRunId": run.root_id or run.id}
        if run.parent_id:
            dispatch["parentRunId"] = run.parent_id
            dispatch["kind"] = run.kind or "implement"
        if run.dispatch_report:
            dispatch["report"] = cast(JsonValue, run.dispatch_report)
        body["dispatch"] = dispatch
    if run.queued_messages:
        body["queuedMessages"] = [
            {
                "id": str(message.get("id", "")),
                "text": str(message.get("text", "")),
                "createdAt": str(message.get("createdAt", "")),
            }
            for message in run.queued_messages
        ]
    if full:
        body["workflowDef"] = cast(JsonValue, _workflow(run.workflow_def))
    return body


def public_project(
    project_id: str,
    name: str,
    root: str,
    added_at: str,
    tags: tuple[str, ...] = (),
) -> dict[str, JsonValue]:
    path = Path(root)
    if not path.exists():
        status = "missing"
    elif is_git_repo(path):
        status = "ok"
    else:
        status = "not-git"
    body: dict[str, JsonValue] = {
        "id": project_id,
        "name": name,
        "root": root,
        "addedAt": added_at,
        "lastOpenedAt": added_at,
        "source": "local",
        "status": status,
        "tags": list(tags),
    }
    if status == "ok":
        body["branch"] = head_branch(path)
    forge = forge_kind(path)
    if forge is not None:
        body["forge"] = cast(JsonValue, forge)
    return body


def _steps(run: Run) -> list[JsonValue]:
    steps = run.definition().steps
    total = len(steps)
    out: list[JsonValue] = []
    for index, step in enumerate(steps):
        status = _step_status(run.status, index, run.step_index, total)
        item: dict[str, JsonValue] = {
            "id": step.id,
            "name": step.name or step.id,
            "kind": step.kind,
            "status": status,
            "iterations": 0 if status in ("pending", "skipped") else 1,
            "tokensUsed": 0,
        }
        used = run.retries.get(step.id, 0)
        if used:
            item["retriesUsed"] = used
        out.append(item)
    return out


def _step_status(run_status: str, index: int, cursor: int, total: int) -> str:
    if run_status == "queued":
        return "pending"
    if index < cursor:
        return "done"
    if index > cursor:
        return "skipped" if run_status in ("done", "failed", "cancelled", "review") else "pending"
    if run_status == "running":
        return "running"
    if run_status == "waiting":
        return "waiting"
    if run_status == "failed":
        return "failed"
    if run_status == "cancelled":
        return "cancelled"
    if run_status in ("review", "done"):
        return "done"
    if index == total:
        return "pending"
    return "pending"


def _workflow(raw: dict[str, object]) -> dict[str, object]:
    source = raw.get("source")
    steps = raw.get("steps")
    body: dict[str, object] = {
        "name": raw.get("name") if isinstance(raw.get("name"), str) else "",
        "source": source if source in ("built-in", "file") else "built-in",
        "steps": steps if isinstance(steps, list) else [],
    }
    description = raw.get("description")
    if isinstance(description, str) and description:
        body["description"] = description
    path = raw.get("path")
    if isinstance(path, str) and path:
        body["path"] = path
    return body
