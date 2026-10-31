"""Worktree removal operations.

`POST /api/v1/worktree-lifecycle/operations` is the TypeScript removal gate.
Scripts run through `execute_lifecycle_command`. A failing script parks at
`needs_attention` and leaves the directory in place. Hook-free projects keep
the old delete.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shlex
import uuid
from pathlib import Path
from typing import Any

from litewriter import LiteWriter

from app.clock import stamp
from app.engine.engine import Engine
from app.engine.gitwork import remove_worktree
from app.engine.lifecycle_exec import execute_lifecycle_command
from app.engine.model import Run
from app.store.db import get_run

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_RUN = re.compile(r"^[0-9a-f]{32}$")
_VAR = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")
_NAMES = ("root_path", "worktree_path", "worktree_id", "task_id")
_INTENTS = frozenset({"remove-worktree", "delete-task", "reclaim"})
_ACTIONS = frozenset(
    {"retry", "start-anyway", "cancel-task", "keep-worktree", "force-delete", "stop"}
)
_TERMINAL = frozenset({"completed", "bypassed", "cancelled", "kept"})
_HOOKS = "Resolve removal through POST /api/v1/worktree-lifecycle/operations"
_ILLUSTRATIVE = {
    "root_path": "/example/project",
    "worktree_path": "/example/project/.ai/cezar/worktrees/example-task",
    "worktree_id": "cez-00000000-0000-4000-8000-000000000000",
    "task_id": "00000000-0000-4000-8000-000000000000",
}

_gate = asyncio.Lock()
_aborts: dict[str, asyncio.Event] = {}


class LifecycleFailure(Exception):
    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


def removal_block_reason(root: Path) -> str | None:
    """Non-empty beforeRemove, or a broken lifecycle key, blocks the old delete."""
    config, broken = _config(root)
    if broken or config["beforeRemove"]:
        return _HOOKS
    return None


def pending_reason(root: Path, run_id: str) -> str | None:
    record = _read_json(_worktree_path(root, run_id))
    active = str(record.get("activeOperationId", ""))
    if not active:
        return None
    operation = _read_json(_operation_path(root, active))
    if operation and operation.get("state") not in _TERMINAL:
        return "Resolve the pending worktree lifecycle operation first"
    return None


class LifecycleDesk:
    def __init__(self, db: LiteWriter, engine: Engine) -> None:
        self.db = db
        self.engine = engine
        self._jobs: set[asyncio.Task[None]] = set()

    async def start(self, root: Path, body: dict[str, object]) -> dict[str, object]:
        async with _gate:
            view, fresh = _begin(root, self.db, body)
        if fresh:
            operation_id = str(view["id"])
            job = asyncio.create_task(self._run(root, operation_id))
            self._jobs.add(job)
            job.add_done_callback(self._jobs.discard)
        return view

    async def get(self, root: Path, operation_id: str) -> dict[str, object]:
        if not _UUID.match(operation_id):
            raise LifecycleFailure("Unknown lifecycle operation", 404)
        operation = _read_json(_operation_path(root, operation_id))
        if not operation:
            raise LifecycleFailure("Unknown lifecycle operation", 404)
        return _view(root, operation)

    async def act(
        self, root: Path, operation_id: str, body: dict[str, object]
    ) -> dict[str, object]:
        async with _gate:
            operation = _apply_action(root, operation_id, body)
            queued = operation.get("state") == "queued"
            view = _view(root, operation)
        if queued:
            job = asyncio.create_task(self._run(root, operation_id))
            self._jobs.add(job)
            job.add_done_callback(self._jobs.discard)
        return view

    def output(self, root: Path, operation_id: str, after: int, limit: int) -> dict[str, object]:
        if not _UUID.match(operation_id) or not _operation_path(root, operation_id).is_file():
            raise LifecycleFailure("Unknown lifecycle operation", 404)
        if after < 0 or not 1 <= limit <= 200:
            raise LifecycleFailure("limit must be 1–200", 400)
        frames = _frames(root, operation_id)
        chosen = [frame for frame in frames if _seq(frame) > after][:limit]
        next_seq = _seq(chosen[-1]) if chosen else after
        return {"items": chosen, "nextSeq": next_seq, "truncated": False}

    def preview(self, body: dict[str, object]) -> dict[str, object]:
        command = body.get("command")
        if set(body) - {"command", "worktreeId"} or not isinstance(command, str):
            raise LifecycleFailure("invalid preview", 400)
        variables = dict(_ILLUSTRATIVE)
        rendered = _render(command, variables)
        return {
            "renderedCommand": rendered,
            "variables": variables,
            "cwd": variables["worktree_path"],
            "illustrative": True,
        }

    async def _run(self, root: Path, operation_id: str) -> None:
        try:
            await _execute(self.db, self.engine, root, operation_id)
        except Exception as exc:
            async with _gate:
                operation = _read_json(_operation_path(root, operation_id))
                if operation and operation.get("state") not in _TERMINAL:
                    operation["state"] = "needs_attention"
                    operation["failureStage"] = "command"
                    operation["error"] = str(exc)
                    _save_operation(root, operation)


def _begin(root: Path, db: LiteWriter, body: dict[str, object]) -> tuple[dict[str, object], bool]:
    request_id, intent, run = _parse_start(root, db, body)
    digest = _digest({"requestId": request_id, "runId": run.id, "intent": intent})
    prior = _find_request(root, request_id)
    if prior is not None:
        if prior.get("bodyHash") != digest:
            raise LifecycleFailure("Request ID was already used for a different action", 409)
        found = _operation_for_request(root, request_id)
        if found is None:
            raise LifecycleFailure("Unknown lifecycle operation", 404)
        return _view(root, found), False
    if run.status in ("queued", "running", "waiting"):
        raise LifecycleFailure("Task is active; cancel it before removing its worktree", 409)
    if not run.worktree_path:
        raise LifecycleFailure("no worktree", 409)
    record = _read_json(_worktree_path(root, run.id))
    active = str(record.get("activeOperationId", ""))
    if active:
        current = _read_json(_operation_path(root, active))
        if current and current.get("state") not in _TERMINAL:
            raise LifecycleFailure("Worktree already has a pending lifecycle operation", 409)
    worktree_id = str(record.get("worktreeId") or uuid.uuid4())
    operation_id = str(uuid.uuid4())
    moment = stamp()
    operation: dict[str, Any] = {
        "id": operation_id,
        "worktreeId": worktree_id,
        "runId": run.id,
        "generation": 1,
        "phase": "teardown",
        "intent": intent,
        "state": "queued",
        "revision": 1,
        "createdAt": moment,
        "updatedAt": moment,
        "executions": [],
        "successfulEntries": [],
        "requests": [{"requestId": request_id, "bodyHash": digest}],
        "worktreePath": run.worktree_path,
        "branch": run.branch,
        "root": str(root),
    }
    _save_operation(root, operation)
    _write_json(
        _worktree_path(root, run.id),
        {
            "worktreeId": worktree_id,
            "runId": run.id,
            "activeOperationId": operation_id,
            "worktreePath": run.worktree_path,
            "branch": run.branch,
        },
    )
    return _view(root, operation), True


def _parse_start(root: Path, db: LiteWriter, body: dict[str, object]) -> tuple[str, str, Run]:
    allowed = {"requestId", "runId", "worktreeId", "intent"}
    if set(body) - allowed or "path" in body:
        raise LifecycleFailure("invalid removal", 400)
    request_id = body.get("requestId")
    intent = body.get("intent")
    if not isinstance(request_id, str) or not _UUID.match(request_id):
        raise LifecycleFailure("invalid removal", 400)
    if not isinstance(intent, str) or intent == "orphan" or "worktreeId" in body:
        raise LifecycleFailure("invalid removal", 400)
    run_id = body.get("runId")
    if not isinstance(run_id, str) or not _RUN.match(run_id) or intent not in _INTENTS:
        raise LifecycleFailure("invalid removal", 400)
    run = get_run(db, run_id)
    if run is None:
        raise LifecycleFailure("not found", 404)
    _config(root)
    return request_id, intent, run


def _apply_action(root: Path, operation_id: str, body: dict[str, object]) -> dict[str, Any]:
    if set(body) - {"requestId", "expectedRevision", "action"}:
        raise LifecycleFailure("invalid action", 400)
    request_id = body.get("requestId")
    action = body.get("action")
    revision = body.get("expectedRevision")
    if not isinstance(request_id, str) or not _UUID.match(request_id):
        raise LifecycleFailure("invalid action", 400)
    if not isinstance(action, str) or action not in _ACTIONS:
        raise LifecycleFailure("invalid action", 400)
    if type(revision) is not int or revision < 0:
        raise LifecycleFailure("invalid action", 400)
    operation = _read_json(_operation_path(root, operation_id))
    if not operation:
        raise LifecycleFailure("Unknown lifecycle operation", 404)
    digest = _digest(
        {
            "requestId": request_id,
            "expectedRevision": revision,
            "action": action,
            "operationId": operation_id,
        }
    )
    prior = _find_request(root, request_id)
    if prior is not None:
        if prior.get("bodyHash") != digest or prior.get("operationId") != operation_id:
            raise LifecycleFailure("Request ID was already used for a different action", 409)
        return operation
    if operation.get("revision") != revision:
        raise LifecycleFailure("Operation changed; refresh and try again", 409)
    view = _view(root, operation)
    allowed = view["allowedActions"]
    if not isinstance(allowed, list) or action not in allowed:
        raise LifecycleFailure("Action is not available for this operation", 409)
    requests = operation.setdefault("requests", [])
    if isinstance(requests, list):
        requests.append({"requestId": request_id, "bodyHash": digest, "operationId": operation_id})
    operation["decision"] = {"action": action, "at": stamp()}
    if action == "stop":
        event = _aborts.get(operation_id)
        if event is not None:
            event.set()
        operation["state"] = "needs_attention"
        operation["error"] = "Scripts stopped; choose Retry to continue"
    elif action in ("keep-worktree", "cancel-task"):
        operation["state"] = "kept" if action == "keep-worktree" else "cancelled"
        operation["finishedAt"] = stamp()
        _clear_active(root, str(operation.get("runId", "")), operation_id)
    else:
        operation["state"] = "queued"
        operation.pop("error", None)
        operation.pop("failureStage", None)
    _touch(operation)
    _save_operation(root, operation)
    return operation


async def _execute(db: LiteWriter, engine: Engine, root: Path, operation_id: str) -> None:
    async with _gate:
        operation = _read_json(_operation_path(root, operation_id))
        if not operation or operation.get("state") != "queued":
            return
        if _decision_action(operation) in ("force-delete", "start-anyway"):
            _commit(db, engine, root, operation)
            return
        config, broken = _config(root)
        if broken:
            operation["state"] = "needs_attention"
            operation["failureStage"] = "config"
            operation["error"] = broken
            _touch(operation)
            _save_operation(root, operation)
            return
        if operation.get("phase") == "setup":
            entries = config["afterCreate"]
        else:
            entries = config["beforeRemove"]
        pending = _next_entry(operation, entries)
        if pending is None:
            _commit(db, engine, root, operation)
            return
        execution = _open_execution(operation, pending)
        operation["state"] = "running"
        operation.pop("error", None)
        _touch(operation)
        _save_operation(root, operation)
        command = str(pending["rendered"])
        cwd = str(operation.get("worktreePath", ""))
        execution_id = str(execution["id"])
    abort = asyncio.Event()
    _aborts[operation_id] = abort
    frames: list[dict[str, object]] = []

    def on_output(frame: object) -> None:
        text = getattr(frame, "text", "")
        stream = getattr(frame, "stream", "stdout")
        frames.append({"stream": stream, "text": text, "executionId": execution_id})

    try:
        result = await execute_lifecycle_command(
            command=command,
            cwd=cwd,
            abort=abort,
            on_output=on_output,
        )
    finally:
        _aborts.pop(operation_id, None)
    async with _gate:
        operation = _read_json(_operation_path(root, operation_id))
        if not operation:
            return
        _store_frames(root, operation_id, frames)
        current = _execution(operation, execution_id)
        if current is not None:
            current["state"] = result.state
            current["finishedAt"] = stamp()
            current["exitCode"] = result.exit_code
            if result.reason:
                current["reason"] = result.reason
            current["outputTruncated"] = result.truncated
        if result.state == "succeeded" and result.quiescent:
            done = operation.setdefault("successfulEntries", [])
            if isinstance(done, list):
                done.append({"entryId": pending["id"], "fingerprint": pending["fingerprint"]})
            operation["state"] = "queued"
            _touch(operation)
            _save_operation(root, operation)
            again = True
        else:
            operation["state"] = "needs_attention" if result.quiescent else "interrupted"
            operation["failureStage"] = "command"
            operation["error"] = result.reason or "Command failed; choose a recovery action"
            _touch(operation)
            _save_operation(root, operation)
            again = False
    if again:
        await _execute(db, engine, root, operation_id)


def _commit(db: LiteWriter, engine: Engine, root: Path, operation: dict[str, Any]) -> None:
    run_id = str(operation.get("runId", ""))
    path = str(operation.get("worktreePath", ""))
    branch = "" if operation.get("intent") == "reclaim" else str(operation.get("branch", ""))
    if path:
        remove_worktree(root, Path(path), branch)
        if Path(path).exists():
            operation["state"] = "needs_attention"
            operation["failureStage"] = "commit"
            operation["error"] = "Scripts completed but the worktree directory could not be removed"
            _touch(operation)
            _save_operation(root, operation)
            return
    run = get_run(db, run_id)
    if run is not None:
        if operation.get("intent") == "delete-task":
            run.worktree_path = ""
            run.branch = ""
        else:
            run.worktree_reclaimed_at = stamp()
            run.worktree_path = ""
        asyncio.get_running_loop().create_task(_save(engine, run))
    operation["state"] = "completed"
    operation["finishedAt"] = stamp()
    operation.pop("error", None)
    _touch(operation)
    _save_operation(root, operation)
    _clear_active(root, run_id, str(operation.get("id", "")))


async def _save(engine: Engine, run: Run) -> None:
    await engine._save(run)


def _config(root: Path) -> tuple[dict[str, list[dict[str, str]]], str]:
    path = root / ".ai" / "cezar" / "config.json"
    if not path.is_file():
        return {"afterCreate": [], "beforeRemove": []}, ""
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return {"afterCreate": [], "beforeRemove": []}, ""
    if not isinstance(loaded, dict) or "worktreeLifecycle" not in loaded:
        return {"afterCreate": [], "beforeRemove": []}, ""
    raw = loaded["worktreeLifecycle"]
    if not isinstance(raw, dict):
        return {"afterCreate": [], "beforeRemove": []}, "worktreeLifecycle is invalid"
    try:
        return {
            "afterCreate": _entries(raw.get("afterCreate")),
            "beforeRemove": _entries(raw.get("beforeRemove")),
        }, ""
    except LifecycleFailure as exc:
        return {"afterCreate": [], "beforeRemove": []}, str(exc)


def _entries(raw: object) -> list[dict[str, str]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise LifecycleFailure("worktreeLifecycle is invalid", 409)
    found: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise LifecycleFailure("worktreeLifecycle is invalid", 409)
        entry_id = item.get("id")
        command = item.get("command")
        if not isinstance(entry_id, str) or not _UUID.match(entry_id):
            raise LifecycleFailure("worktreeLifecycle is invalid", 409)
        if not isinstance(command, str) or not command.strip():
            raise LifecycleFailure("worktreeLifecycle is invalid", 409)
        if entry_id in seen:
            raise LifecycleFailure("Entry IDs must be unique", 409)
        seen.add(entry_id)
        found.append({"id": entry_id, "command": command, "name": str(item.get("name", ""))})
    return found


def _render(command: str, variables: dict[str, str]) -> str:
    if not command.strip():
        raise LifecycleFailure("Enter a command", 400)
    if "{{" not in command:
        return command
    if command.count("{{") != len(_VAR.findall(command)):
        raise LifecycleFailure("Close the template with }}", 400)

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in _NAMES:
            raise LifecycleFailure(f"Unknown variable {name!r}", 400)
        prefix = command[: match.start()].rstrip()
        if prefix.endswith(("'", '"', "$")):
            raise LifecycleFailure(
                "Place template variables unquoted in ordinary shell arguments", 400
            )
        return shlex.quote(variables[name])

    return _VAR.sub(replace, command)


def _next_entry(operation: dict[str, Any], entries: list[dict[str, str]]) -> dict[str, str] | None:
    variables = _variables(operation)
    done = {
        (str(item.get("entryId")), str(item.get("fingerprint")))
        for item in operation.get("successfulEntries", [])
        if isinstance(item, dict)
    }
    for ordinal, entry in enumerate(entries):
        rendered = _render(entry["command"], variables)
        fingerprint = _digest(
            {"command": entry["command"], **{name: variables[name] for name in _NAMES}}
        )
        if (entry["id"], fingerprint) in done:
            continue
        return {**entry, "rendered": rendered, "fingerprint": fingerprint, "ordinal": str(ordinal)}
    return None


def _open_execution(operation: dict[str, Any], pending: dict[str, str]) -> dict[str, Any]:
    executions = operation.setdefault("executions", [])
    attempt = 1
    if isinstance(executions, list):
        attempt += sum(
            1
            for item in executions
            if isinstance(item, dict) and item.get("entryId") == pending["id"]
        )
    execution = {
        "id": str(uuid.uuid4()),
        "operationId": operation["id"],
        "entryId": pending["id"],
        "fingerprint": pending["fingerprint"],
        "ordinal": int(pending["ordinal"]),
        "label": pending.get("name") or f"Command {int(pending['ordinal']) + 1}",
        "commandPreview": pending["rendered"],
        "attempt": attempt,
        "state": "running",
        "startedAt": stamp(),
    }
    if isinstance(executions, list):
        executions.append(execution)
    return execution


def _execution(operation: dict[str, Any], execution_id: str) -> dict[str, Any] | None:
    for item in operation.get("executions", []):
        if isinstance(item, dict) and item.get("id") == execution_id:
            return item
    return None


def _view(root: Path, operation: dict[str, Any]) -> dict[str, object]:
    config, _broken = _config(root)
    phase = "beforeRemove" if operation.get("phase") != "setup" else "afterCreate"
    entries = _entry_rows(operation, config[phase])
    state = str(operation.get("state", ""))
    if state in ("queued", "running"):
        allowed = ["stop"]
    elif state in ("needs_attention", "interrupted"):
        allowed = ["retry", "keep-worktree", "force-delete"]
    else:
        allowed = []
    history = []
    for item in operation.get("executions", []):
        if isinstance(item, dict):
            history.append({key: value for key, value in item.items() if key != "process"})
    shown = {
        "id": operation.get("id"),
        "worktreeId": operation.get("worktreeId"),
        "generation": operation.get("generation", 1),
        "phase": operation.get("phase"),
        "intent": operation.get("intent"),
        "state": state,
        "revision": operation.get("revision", 0),
        "createdAt": operation.get("createdAt"),
        "updatedAt": operation.get("updatedAt"),
        "history": history,
        "entries": entries,
        "allowedActions": allowed,
    }
    if operation.get("finishedAt"):
        shown["finishedAt"] = operation["finishedAt"]
    if operation.get("error"):
        shown["error"] = operation["error"]
    if operation.get("failureStage"):
        shown["failureStage"] = operation["failureStage"]
    return shown


def _entry_rows(
    operation: dict[str, Any], entries: list[dict[str, str]]
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    variables = _variables(operation)
    for index, entry in enumerate(entries):
        try:
            preview = _render(entry["command"], variables)
        except LifecycleFailure:
            preview = entry["command"]
        latest = None
        for item in operation.get("executions", []):
            if isinstance(item, dict) and item.get("entryId") == entry["id"]:
                latest = item
        rows.append(
            {
                "entryId": entry["id"],
                "label": entry.get("name") or f"Command {index + 1}",
                "commandPreview": preview,
                "state": (latest or {}).get("state", "pending"),
                "attempt": (latest or {}).get("attempt", 0),
            }
        )
    return rows


def _variables(operation: dict[str, Any]) -> dict[str, str]:
    return {
        "root_path": str(operation.get("root", "")),
        "worktree_path": str(operation.get("worktreePath", "")),
        "worktree_id": str(operation.get("worktreeId", "")),
        "task_id": str(operation.get("runId", "")),
    }


def _store_frames(root: Path, operation_id: str, frames: list[dict[str, object]]) -> None:
    path = _output_path(root, operation_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = _frames(root, operation_id)
    seq = _seq(existing[-1]) if existing else 0
    with path.open("a", encoding="utf-8") as handle:
        for frame in frames:
            seq += 1
            row = {
                "seq": seq,
                "time": stamp(),
                "executionId": frame["executionId"],
                "stream": frame["stream"],
                "text": frame["text"],
            }
            handle.write(json.dumps(row) + "\n")


def _frames(root: Path, operation_id: str) -> list[dict[str, object]]:
    path = _output_path(root, operation_id)
    if not path.is_file():
        return []
    rows: list[dict[str, object]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            loaded = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(loaded, dict):
            rows.append(loaded)
    return rows


def _find_request(root: Path, request_id: str) -> dict[str, object] | None:
    directory = root / ".ai" / "cezar" / "lifecycle" / "operations"
    if not directory.is_dir():
        return None
    for path in directory.glob("*.json"):
        operation = _read_json(path)
        for item in operation.get("requests", []):
            if isinstance(item, dict) and item.get("requestId") == request_id:
                return {**item, "operationId": operation.get("id")}
    return None


def _operation_for_request(root: Path, request_id: str) -> dict[str, Any] | None:
    found = _find_request(root, request_id)
    if found is None:
        return None
    return _read_json(_operation_path(root, str(found.get("operationId", ""))))


def _clear_active(root: Path, run_id: str, operation_id: str) -> None:
    path = _worktree_path(root, run_id)
    record = _read_json(path)
    if record.get("activeOperationId") == operation_id:
        record.pop("activeOperationId", None)
        _write_json(path, record)


def _decision_action(operation: dict[str, Any]) -> str:
    decision = operation.get("decision")
    if isinstance(decision, dict):
        return str(decision.get("action", ""))
    return ""


def _touch(operation: dict[str, Any]) -> None:
    operation["revision"] = int(operation.get("revision", 0)) + 1
    operation["updatedAt"] = stamp()


def _seq(frame: dict[str, object]) -> int:
    raw = frame.get("seq", 0)
    return raw if type(raw) is int else 0


def _digest(body: dict[str, object]) -> str:
    payload = json.dumps(body, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _operation_path(root: Path, operation_id: str) -> Path:
    return root / ".ai" / "cezar" / "lifecycle" / "operations" / f"{operation_id}.json"


def _worktree_path(root: Path, run_id: str) -> Path:
    return root / ".ai" / "cezar" / "lifecycle" / "worktrees" / f"{run_id}.json"


def _output_path(root: Path, operation_id: str) -> Path:
    return root / ".ai" / "cezar" / "lifecycle" / "output" / f"{operation_id}.ndjson"


def _save_operation(root: Path, operation: dict[str, Any]) -> None:
    _write_json(_operation_path(root, str(operation["id"])), operation)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _write_json(path: Path, body: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)
