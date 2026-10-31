"""Queue, worktrees, and the workflow walk.

A successful workflow stops at `done` unless the review gate is on.
Finish records `done`. Neither merges.
`waiting` does not hold a parallelism slot: the agent process has already exited.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field, replace
from datetime import timedelta
from pathlib import Path
from typing import Any, cast
from urllib.error import URLError
from urllib.request import Request, urlopen

from litewriter import LiteWriter, Tx
from litewriter.errors import StateError
from stario import App, Relay

from app.clock import after, now, parse_stamp, stamp
from app.config import RUNNERS, Config, single_project
from app.engine.agent_tmp import (
    AgentTempDirError,
    agent_tmp_env,
    remove_agent_tmp_dir,
    shared_cache_dir,
    sweep_agent_tmp_dirs,
)
from app.engine.agents import AgentSpec, Runner, usage_from_line
from app.engine.autosave import autosave_commit
from app.engine.catalog import find_workflow, load_workflows
from app.engine.deferred import DeferredBuffer
from app.engine.deltas import DeltaCoalescer
from app.engine.dispatch_logic import (
    BudgetChild,
    DispatchOrder,
    append_report,
    carve_child_budget,
    child_report_text,
    child_task_envelope,
    in_flight_refusal,
)
from app.engine.git_actions import (
    commit_all,
    create_draft_pr,
    push_branch,
    sync_base,
    worktree_git_status,
)
from app.engine.gitignore_data import ensure_data_gitignore
from app.engine.gitwork import (
    WorktreeError,
    create_worktree,
    drop_worktree_dir,
    head_branch,
    is_git_repo,
    prune_orphans,
    remove_worktree,
    task_diff,
)
from app.engine.graph import (
    GraphResult,
    advance,
    compare_values,
    enter_graph,
    fork_shape,
    render_refs,
)
from app.engine.instructions import run_instructions
from app.engine.model import TERMINAL, Automation, Project, Run, Settings, Step, Workflow
from app.engine.namer import propose_name, propose_title
from app.engine.poller import AutomationPoller, automation_env
from app.engine.prompts import (
    AUTO_RESUME_GRACE_S,
    AUTONOMOUS_NUDGE,
    COMPACTION_NUDGE,
    MAX_AUTO_CONTINUES,
    MAX_AUTO_RESUMES,
    MAX_COMPACTION_CONTINUES,
    MONITORING_WAKE_NUDGE,
    REPO_LOCK_DISABLED_NOTE,
    RESTART_CONTINUATION,
    build_user_prompt,
)
from app.engine.reap import reap_task_processes
from app.engine.receipts import archive_finished as sweep_archive
from app.engine.receipts import mark_all_read as sweep_read
from app.engine.retention import select_index_prune, select_reclaimable
from app.engine.review_gate import review_gate_enabled
from app.engine.session_extras import load_project_mcp, prompt_task, v2_snapshots
from app.engine.skills import find_skill
from app.engine.terminal_hub import TerminalHub
from app.engine.uploads import materialize
from app.engine.usage_limit import parse_usage_limit
from app.engine.workflows import newer_catalog_workflow, retryable_exit
from app.integrations.pr_head import prune_pr_head_refs
from app.secrets.store import SecretStore, redact
from app.store import polling
from app.store.db import (
    add_event,
    count_in_flight_children,
    delete_run_row,
    find_project_by_root,
    get_project,
    get_run,
    get_run_tx,
    get_settings,
    insert_project,
    insert_run,
    list_children,
    list_enabled_automations,
    list_projects,
    list_queued,
    list_run_ids,
    list_runs,
    mark_interrupted,
    save_automation,
    save_project,
    save_run,
)

CHANGED = "cezar.changed"


def _interrupted(run: Run) -> bool:
    return run.status == "failed" and run.error == "interrupted by restart"


def _markerless(text: str) -> bool:
    return "CEZ:DONE" not in text and "CEZ:ASK" not in text and "CEZ:MONITORING" not in text


def _pr_number(url: str) -> str:
    if "/pull/" not in url:
        return ""
    number = url.rstrip("/").rsplit("/", 1)[-1]
    return number if number.isdigit() else ""


def _profile_home(config: Config, account_id: str, runner: str) -> str:
    from app.integrations.accounts import profile_home_for

    home = profile_home_for(config, account_id, runner)
    return home or ""


def _measured_diff(run: Run):
    return task_diff(
        Path(run.worktree_path),
        base_branch=run.base_branch,
        task_branch=run.branch,
        started_at=run.started_at,
        fallback_sha=run.base_sha,
    )


def _gh_checks(cwd: Path, number: str) -> str:
    import json
    import subprocess

    try:
        proc = subprocess.run(
            ["gh", "pr", "checks", number, "--json", "state"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        return ""
    if proc.returncode != 0:
        return ""
    try:
        loaded = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return ""
    if not isinstance(loaded, list) or not loaded:
        return "pending"
    states = [str(item.get("state", "")).upper() for item in loaded if isinstance(item, dict)]
    if any(state in ("FAILURE", "ERROR", "CANCELLED") for state in states):
        return "failing"
    if states and all(state == "SUCCESS" for state in states):
        return "passing"
    return "pending"


def _gh(cwd: Path, args: list[str]) -> tuple[bool, str]:
    import subprocess

    try:
        proc = subprocess.run(
            ["gh", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except FileNotFoundError:
        return False, "gh is not installed"
    except subprocess.TimeoutExpired:
        return False, "gh timed out"
    except OSError as exc:
        return False, str(exc)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        return False, detail[0] if detail else "gh failed"
    return True, proc.stdout.strip()


def _post_json(url: str, payload: dict[str, object]) -> tuple[int, str]:
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return 0, "webhook url must be http or https"
    raw = json.dumps(payload).encode()
    request = Request(url, data=raw, headers={"content-type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=15) as response:
            return int(response.status), ""
    except URLError as exc:
        reason = getattr(exc, "reason", exc)
        code = getattr(exc, "code", 0)
        return int(code or 0), f"webhook failed — {reason}"


def _usage_event(total: int, gained: int) -> str:
    import json

    return json.dumps({"type": "usage.updated", "usage": {"total": total, "delta": gained}})


def _delta_snapshot(text: str) -> str:
    import json

    item = {"id": "message", "type": "message", "text": text}
    return json.dumps({"type": "item.completed", "item": item}, separators=(",", ":"))


def _ask_line(text: str) -> str:
    for line in text.splitlines():
        if "CEZ:ASK" not in line:
            continue
        _prefix, _sep, rest = line.partition("CEZ:ASK")
        return rest.lstrip(": ").strip() or line.strip()
    return text.strip()


def title_from(task: str) -> str:
    line = task.strip().splitlines()[0].strip() if task.strip() else "task"
    if len(line) > 80:
        return line[:79] + "…"
    return line


def slug_for(name: str, taken: set[str]) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in name).strip("-")
    base = cleaned[:40] or "project"
    if base == "default":
        base = "default-repo"
    candidate = base
    number = 2
    while candidate in taken:
        candidate = f"{base}-{number}"
        number += 1
    return candidate


@dataclass
class Engine:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    config: Config
    agent: Runner | None = None
    app: App | None = None
    boot_project_id: str = ""
    _tasks: dict[str, asyncio.Task[None]] = field(default_factory=dict)
    _cancel: dict[str, asyncio.Event] = field(default_factory=dict)
    _finish: set[str] = field(default_factory=set)
    _live: dict[str, list[Callable[[dict[str, object]], None]]] = field(default_factory=dict)
    _wake: asyncio.Event = field(default_factory=asyncio.Event)
    _runners: dict[str, Runner] = field(default_factory=dict)
    _deferred_buf: DeferredBuffer | None = None
    _coalescer: DeltaCoalescer = field(default_factory=DeltaCoalescer)
    _terminals: TerminalHub = field(default_factory=TerminalHub)
    _workspace: list[Callable[[str, object], None]] = field(default_factory=list)
    _repo_locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    _auto_continues: dict[str, int] = field(default_factory=dict)
    _compaction: dict[str, int] = field(default_factory=dict)
    _last_autosave: dict[str, float] = field(default_factory=dict)
    _land_attempts: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.poller = AutomationPoller(self)
        self._coalescer.spawn = self._schedule
        self._terminals.bind(self._schedule)

    def _schedule(
        self, coro: Coroutine[Any, Any, None] | Awaitable[None], *, name: str | None = None
    ) -> asyncio.Task[None]:
        """`App.create_task` when a server is bound. The CLI has no app."""
        if self.app is not None:
            return self.app.create_task(coro, name=name)  # type: ignore[arg-type]
        return asyncio.create_task(coro, name=name)  # type: ignore[arg-type]

    def subscribe_events(
        self, run_id: str, listener: Callable[[dict[str, object]], None]
    ) -> Callable[[], None]:
        bucket = self._live.setdefault(run_id, [])
        bucket.append(listener)

        def off() -> None:
            current = self._live.get(run_id, [])
            if listener in current:
                current.remove(listener)

        return off

    def kick(self) -> None:
        self._wake.set()

    def publish(self) -> None:
        self.relay.publish(CHANGED, {})

    def subscribe_workspace(self, listener: Callable[[str, object], None]) -> Callable[[], None]:
        self._workspace.append(listener)

        def off() -> None:
            if listener in self._workspace:
                self._workspace.remove(listener)

        return off

    def _emit_workspace(self, event: str, data: object) -> None:
        for listener in list(self._workspace):
            listener(event, data)

    async def startup(self) -> None:
        repo = self.config.repo_root
        if repo.is_dir() and repo.resolve() != Path.home().resolve():
            await asyncio.to_thread(ensure_data_gitignore, repo)
            await self._ensure_boot_project()
            if is_git_repo(repo):
                await asyncio.to_thread(prune_orphans, repo, list_run_ids(self.db))
                await self.retain()
        for run_id, message in self._buffer().lost_on_startup():
            if get_run(self.db, run_id) is not None:
                await self._note(run_id, "lifecycle", message)
        await self.db.write(rebaseline_automations)
        await self.recover()

    def _resumable(self, run: Run) -> bool:
        """Whether the agent's session outlives the process and can be reopened.

        Claude and Pi name the session after the run id. Codex and OpenCode need the thread id
        they reported. The dry-run mock resumes anything that opened a session.
        """
        runner = run.session_runner
        if not runner:
            return False
        if self.config.dry_run:
            return True
        if runner in ("claude", "pi"):
            return True
        return runner in ("codex", "opencode") and bool(run.codex_thread)

    async def recover(self) -> None:
        """Startup recovery, before the server takes requests (TypeScript `RunManager.recover`).

        `queued` stays queued for the first tick and `waiting` stays waiting, graph parks
        included. A `running` agent with a resumable session is queued as a follow-up that
        reopens it and points the agent at its handoff file. A `running` linear workflow that
        never reached an agent session (queued behind the working-tree lease, or still
        spawning) goes back to the queue whole, as TypeScript does. Every other `running` row
        fails with "interrupted by restart": a runner that cannot resume, a graph parent still
        waiting on its dispatched children (re-attaching to those is not ported), or a graph
        with no session yet. TypeScript re-queues that last one at its persisted cursor; this
        port persists none, so a re-run from the entry could repeat a commit, push or PR node.
        """
        from app.engine.handoff import append_heartbeat

        # A crash never reaches the terminal reap, so sweep every temp directory of a run that
        # is not live.
        live = {
            run.id
            for status in ("queued", "waiting", "running")
            for run in list_runs(self.db, None, status, limit=1000)
        }
        await asyncio.to_thread(sweep_agent_tmp_dirs, self.config.data_dir, live)
        for run in list_runs(self.db, None, "running", limit=1000):
            if not self._resumable(run):
                if not run.session_runner and not run.definition().graph:
                    await self._requeue_whole(run)
                continue
            if run.definition().graph and count_in_flight_children(self.db, run.id):
                continue
            run.mode = "followup"
            run.continuation = RESTART_CONTINUATION
            run.status = "queued"
            run.error = ""
            run.finished_at = ""
            await self._save(run)
            append_heartbeat(self.config.data_dir, run.id, "cezar restarted", at=stamp())
            await self._note(
                run.id,
                "lifecycle",
                "cezar restarted — resuming the interrupted task from its last session",
            )
        await self.db.write(mark_interrupted)

    async def _requeue_whole(self, run: Run) -> None:
        """A `running` row that had no agent session: nothing to resume, so start it over."""
        run.status = "queued"
        run.error = ""
        run.finished_at = ""
        await self._save(run)
        await self._note(
            run.id,
            "lifecycle",
            "cezar restarted — the task had not reached its agent session, so it was re-queued",
        )

    async def serve(self) -> None:
        while self.app is not None and not self.app.shutting_down:
            await self.tick()
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), self.config.tick_seconds)
            except TimeoutError:
                pass

    async def tick(self) -> None:
        await self._resume_due()
        await self._expire_parks()
        await self._launch_due()
        await self.poller.tick()
        await self._wake_monitors()
        await self._resume_limited()
        await self._periodic_autosave()
        settings = get_settings(self.db)
        alive = [run_id for run_id, task in self._tasks.items() if not task.done()]
        slots = settings.max_parallel - len(alive)
        for run in list_queued(self.db):
            if slots <= 0:
                return
            if run.id in alive or run.id in self._tasks:
                continue
            self._tasks[run.id] = self._spawn(run.id)
            slots -= 1

    def _spawn(self, run_id: str) -> asyncio.Task[None]:
        return self._schedule(self.execute(run_id), name=f"run-{run_id[:8]}")

    async def execute(self, run_id: str) -> None:
        cancel = self._cancel.setdefault(run_id, asyncio.Event())
        try:
            run = get_run(self.db, run_id)
            if run is None or run.status != "queued":
                return
            run.status = "running"
            if not run.started_at:
                run.started_at = stamp()
            await self._save(run)
            await self._note(run.id, "lifecycle", "running")
            if run.mode == "followup":
                await self._followup(run, cancel)
                return
            await self._workflow(run, cancel)
        except asyncio.CancelledError:
            try:
                current = get_run(self.db, run_id)
                if current is not None and current.status == "running":
                    current.status = "failed"
                    current.error = "interrupted by shutdown"
                    current.finished_at = stamp()
                    await self.db.write(save_run, current)
            except StateError:
                pass
            raise
        except StateError:
            return
        finally:
            try:
                await self._report_child(run_id)
            except StateError:
                pass
            self._tasks.pop(run_id, None)
            self._cancel.pop(run_id, None)
            self.kick()

    async def _workflow(self, run: Run, cancel: asyncio.Event) -> None:
        run = await self._prepare(run)
        if run.status == "failed":
            return
        lock = await self._claim_root(run)
        try:
            await self._walk(run, cancel)
        finally:
            if lock is not None and lock.locked():
                lock.release()

    async def _claim_root(self, run: Run) -> asyncio.Lock | None:
        if not run.in_place or not run.worktree_path:
            return None
        if not self.config.repo_lock:
            await self._note(run.id, "note", REPO_LOCK_DISABLED_NOTE)
            return None
        key = str(Path(run.worktree_path).resolve())
        lock = self._repo_locks.setdefault(key, asyncio.Lock())
        await lock.acquire()
        return lock

    async def _walk(self, run: Run, cancel: asyncio.Event) -> None:
        if run.definition().graph:
            await self._graph_walk(run, cancel)
            return
        if run.step_index == 0 and not run.pending_note:
            run = await self._refresh_workflow(run)
        while True:
            run = self._fresh(run)
            if run.status in ("cancelled", "failed", "waiting"):
                return
            if cancel.is_set():
                await self._stop(run)
                return
            steps = run.definition().steps
            if run.step_index >= len(steps):
                await self._enter_review(run)
                return
            step = steps[run.step_index]
            await self._note(run.id, "step-start", step.name or step.id, step.id)
            if step.kind == "check":
                action = await self._check(run, step, cancel)
            else:
                action = await self._agent_step(run, cancel)
            if action == "stop":
                return
            if action == "jump":
                continue
            current = self._fresh(run)
            current.step_index += 1
            current.pending_note = ""
            current.check_failure = ""
            upcoming = current.definition().steps
            nxt = upcoming[current.step_index] if current.step_index < len(upcoming) else None
            if nxt is not None and nxt.kind == "agent":
                held = self._buffer().take(current.id)
                if held:
                    current.pending_note = "\n\n".join(held)
            await self._save(current)

    async def _followup(self, run: Run, cancel: asyncio.Event) -> None:
        if not run.worktree_path:
            await self._fail(run, "no worktree to continue in")
            return
        message = run.continuation or run.pending_note
        run.continuation = ""
        run.mode = "workflow"
        run.ask = ""
        run.pending_note = ""
        await self._save(run)
        action = await self._agent_step(run, cancel, followup=message)
        if action == "stop":
            return
        current = get_run(self.db, run.id)
        if current is None or current.status in ("cancelled", "failed", "waiting"):
            return
        await self._enter_review(current)

    async def _prepare(self, run: Run) -> Run:
        if run.worktree_path:
            await self._lay_down_attachments(run)
            return run
        project = get_project(self.db, run.project_id)
        if project is None:
            return await self._fail(run, "project is gone")
        root = Path(project.root)
        base = run.base_branch or project.base_branch or "main"
        from app.engine.landing import inplace_requested

        git_checkout = is_git_repo(root)
        if run.in_place or not git_checkout or inplace_requested(root):
            run.in_place = True
            run.worktree_path = str(root)
            run.base_branch = base
            await self._lay_down_attachments(run)
            await self._save(run)
            if git_checkout:
                await self._note(
                    run.id,
                    "note",
                    (
                        "running in the checkout, one task at a time; "
                        "the task will land on this branch"
                    ),
                )
            else:
                await self._note(run.id, "note", "not a git repository; ran in place")
            return run
        _prompt, naming = run_instructions(root)
        named = await propose_name(
            run.task,
            naming,
            dry_run=self.config.dry_run,
            cwd=root,
            binary=self.config.runner_bins.get("claude", "claude"),
            model=self._namer_model(),
        )
        wanted = named.branch if named and named.branch else None
        if named and named.title:
            run.title = named.title
        try:
            path, branch, sha = await asyncio.to_thread(
                create_worktree,
                root,
                run.id,
                base,
                fetch=not self.config.dry_run,
                branch=wanted,
            )
        except WorktreeError as exc:
            return await self._fail(run, str(exc))
        run.worktree_path = str(path)
        run.branch = branch
        run.base_sha = sha
        run.base_branch = base
        await self._lay_down_attachments(run)
        await self._save(run)
        self._emit_workspace(
            "worktree-lifecycle",
            {"projectId": run.project_id, "runId": run.id, "kind": "created"},
        )
        return run

    async def _refresh_workflow(self, run: Run) -> Run:
        project = get_project(self.db, run.project_id)
        if project is None:
            return run
        catalog, _issues = load_workflows(Path(project.root))
        fresh = newer_catalog_workflow(run.definition(), catalog)
        if fresh is None:
            return run
        run.workflow = fresh.name
        run.workflow_def = fresh.to_json()
        await self._save(run)
        await self._note(run.id, "note", f'workflow "{fresh.name}" was re-read from the catalog')
        return run

    async def _graph_walk(self, run: Run, cancel: asyncio.Event) -> None:
        graph = run.definition().graph
        if not isinstance(graph, dict):
            await self._fail(run, "graph workflow has no graph")
            return
        body = cast(dict[str, Any], graph)
        loops: dict[str, int] = {}
        outputs: dict[str, dict[str, str]] = {}
        resumed = await self._resume_park(run, body, loops, outputs)
        cursor = resumed or enter_graph(body, loops)
        for _guard in range(50):
            if cancel.is_set():
                await self._stop(run)
                return
            if cursor.kind != "node" or cursor.node is None:
                current = self._fresh(run)
                if cursor.status == "failed":
                    await self._fail(current, "the graph ended on a failure port")
                else:
                    await self._enter_review(current)
                return
            node = cursor.node
            node_id = str(node.get("id", ""))
            await self._note(run.id, "step-start", str(node.get("name") or node_id), node_id)
            outcome = await self._graph_node(run, cancel, body, node, outputs, loops)
            if outcome is None:
                return
            port, node_id = outcome
            cursor = advance(body, node_id, port, loops)
        await self._fail(run, "graph walk did not end")

    async def _graph_node(
        self,
        run: Run,
        cancel: asyncio.Event,
        graph: dict[str, Any],
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
        loops: dict[str, int],
    ) -> tuple[str, str] | None:
        """Run one node: `(port, node id)` to follow, or None when the walk ends here."""
        node_id = str(node.get("id", ""))
        kind = str(node.get("type", ""))
        if kind in ("gate.human", "ask-user"):
            await self._park_graph(run, node, outputs, loops)
            return None
        if kind == "join":
            await self._fail(run, "a join can only be reached from a fork")
            return None
        if kind == "if":
            return _if_port(run, node, outputs), node_id
        handlers: dict[str, Callable[[], Awaitable[tuple[str, str] | None]]] = {
            "agent": lambda: self._graph_agent(run, cancel, node, outputs),
            "check": lambda: self._graph_check(run, cancel, node, outputs),
            "workflow": lambda: self._run_subworkflow(run, cancel, node, outputs),
            "fork": lambda: self._run_fork(run, cancel, graph, node, outputs),
            "dispatch": lambda: self._run_dispatch(run, cancel, node, outputs),
            "git.commit": lambda: self._run_git_commit(run, node, outputs),
            "git.push": lambda: self._run_git_push(run, node_id),
            "git.sync-base": lambda: self._run_git_sync(run, node_id),
            "github.draft-pr": lambda: self._run_draft_pr(run, node, outputs),
            "github.wait-ci": lambda: self._run_wait_ci(run, node, outputs),
            "github.pr-comment": lambda: self._run_github_note(run, node, outputs),
            "github.issue-comment": lambda: self._run_github_note(run, node, outputs),
            "github.pr-update": lambda: self._run_github_note(run, node, outputs),
            "notify.webhook": lambda: self._run_webhook(run, node, outputs),
        }
        if kind in handlers:
            return await handlers[kind]()
        await self._fail(run, f'graph node "{node_id}" ({kind}) is not executed by the Python port')
        return None

    async def _graph_agent(
        self,
        run: Run,
        cancel: asyncio.Event,
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
    ) -> tuple[str, str] | None:
        node_id = str(node.get("id", ""))
        step = Step(
            id=node_id,
            name=str(node.get("name") or node_id),
            prompt=render_refs(str(node.get("prompt") or "{{task}}"), outputs),
            skill=str(node.get("skill") or ""),
            runner=str(node.get("runner") or ""),
            model=str(node.get("model") or ""),
        )
        if await self._agent_step(run, cancel, graph_step=step) == "stop":
            return None
        outputs[node_id] = {"summary": "done"}
        return "done", node_id

    async def _graph_check(
        self,
        run: Run,
        cancel: asyncio.Event,
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
    ) -> tuple[str, str] | None:
        node_id = str(node.get("id", ""))
        raw_allow = node.get("bashAllowlist")
        allow = (
            tuple(i for i in raw_allow if isinstance(i, str)) if isinstance(raw_allow, list) else ()
        )
        step = Step(
            id=node_id,
            name=node_id,
            command=render_refs(str(node.get("command") or ""), outputs),
            bash_allowlist=allow,
        )
        code, output = await self._run_check(run, step, cancel)
        await self._note(run.id, "check-output", output or f"exit {code}", node_id)
        if cancel.is_set() or code < 0:
            await self._mark_cancelled(self._fresh(run))
            return None
        outputs[node_id] = {"exitCode": str(code), "output": output[-2_000:]}
        return ("pass" if code == 0 else "fail"), node_id

    async def _park_graph(
        self,
        run: Run,
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
        loops: dict[str, int],
    ) -> None:
        """Park the run as `waiting` with the walk's state saved on the row.

        The coroutine ends, so the park holds no slot and a restart loses nothing.
        """
        node_id = str(node.get("id", ""))
        kind = str(node.get("type", ""))
        text = str(node.get("message" if kind == "gate.human" else "question") or "")
        timeout = node.get("timeoutMs")
        deadline = ""
        if isinstance(timeout, int) and timeout > 0:
            deadline = stamp(now() + timedelta(milliseconds=timeout))
        current = self._fresh(run)
        current.status = "waiting"
        current.ask = render_refs(text, outputs).replace("{{task}}", run.task)
        current.awaiting_answer_since = stamp()
        current.graph_park = {
            "node": node_id,
            "kind": kind,
            "loops": dict(loops),
            "outputs": {key: dict(value) for key, value in outputs.items()},
            "deadline": deadline,
        }
        await self._save(current)
        await self._note(current.id, "lifecycle", "waiting", node_id)
        self._notify(current, "running")

    async def _resume_park(
        self,
        run: Run,
        graph: dict[str, Any],
        loops: dict[str, int],
        outputs: dict[str, dict[str, str]],
    ) -> GraphResult | None:
        current = self._fresh(run)
        park = current.graph_park
        if not park:
            return None
        current.graph_park = {}
        await self._save(current)
        reply = park.get("reply")
        if not isinstance(reply, dict):
            return None
        for key, value in cast(dict[str, Any], park.get("loops") or {}).items():
            loops[str(key)] = int(value)
        for key, fields in cast(dict[str, Any], park.get("outputs") or {}).items():
            outputs[str(key)] = {str(a): str(b) for a, b in fields.items()}
        node_id = str(park.get("node", ""))
        port = str(reply.get("port", ""))
        if port == "answered":
            outputs[node_id] = {"answer": str(reply.get("text", ""))}
        elif port in ("approve", "reject"):
            outputs[node_id] = {"comment": str(reply.get("text", ""))}
        return advance(graph, node_id, port, loops)

    async def resolve_park(self, run_id: str, kind: str, port: str, text: str = "") -> str | None:
        """Route a parked `gate.human` or `ask-user` to a port and queue the run."""
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        park = run.graph_park
        if run.status != "waiting" or park.get("kind") != kind or "reply" in park:
            return "this run is not waiting on that"
        run.graph_park = {**park, "reply": {"port": port, "text": text.strip()[:20_000]}}
        run.ask = ""
        run.awaiting_answer_since = ""
        run.status = "queued"
        await self._save(run)
        self.kick()
        return None

    async def _expire_parks(self) -> None:
        moment = now()
        for run in list_runs(self.db, None, "waiting", limit=100):
            due = parse_stamp(str(run.graph_park.get("deadline") or ""))
            if due is not None and due <= moment and "reply" not in run.graph_park:
                await self.resolve_park(run.id, str(run.graph_park.get("kind")), "timeout")

    async def _run_subworkflow(
        self,
        run: Run,
        cancel: asyncio.Event,
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
    ) -> tuple[str, str] | None:
        node_id = str(node.get("id", ""))
        name = str(node.get("workflow") or "")
        project = get_project(self.db, run.project_id)
        chosen = find_workflow(Path(project.root), name) if project else None
        if chosen is None:
            await self._note(run.id, "note", f'no workflow named "{name}"', node_id)
            return "failed", node_id
        prompt = render_refs(str(node.get("prompt") or "{{task}}"), outputs)
        child_id, reason = await self.dispatch(
            run.id,
            DispatchOrder(
                objective=prompt.replace("{{task}}", run.task)[:4_000],
                title=str(node.get("name") or name),
                max_cost=node.get("budgetUsd")
                if type(node.get("budgetUsd")) in (int, float)
                else None,
            ),
            nested=chosen,
        )
        if reason or not child_id:
            await self._note(run.id, "note", f"sub-workflow refused — {reason}", node_id)
            return "failed", node_id
        await self._note(run.id, "note", f'started sub-workflow "{name}" as {child_id}', node_id)
        outputs[node_id] = {"runId": child_id, "status": "running", "summary": ""}
        settled = await self._await_children([child_id], "all", cancel)
        if settled is None:
            await self._mark_cancelled(self._fresh(run))
            return None
        status = settled.get(child_id, "failed")
        child = get_run(self.db, child_id)
        summary = ""
        if child is not None:
            summary = str(child.dispatch_report.get("result") or child.error or "")
        outputs[node_id] = {"runId": child_id, "status": status, "summary": summary}
        return ("done" if status in ("done", "review") else "failed"), node_id

    async def _run_fork(
        self,
        run: Run,
        cancel: asyncio.Event,
        graph: dict[str, Any],
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
    ) -> tuple[str, str] | None:
        node_id = str(node.get("id", ""))
        shape = fork_shape(graph, node_id)
        if isinstance(shape, str):
            await self._fail(run, shape)
            return None
        child_ids: list[str] = []
        for branch in shape.branches:
            prompt = render_refs(str(branch.agent.get("prompt") or "{{task}}"), outputs)
            title = str(branch.agent.get("name") or branch.agent.get("id") or "branch")
            child_id, reason = await self.dispatch(
                run.id,
                DispatchOrder(objective=prompt[:4_000], title=title),
            )
            if reason or not child_id:
                await self._note(run.id, "note", f'branch "{title}" refused — {reason}', node_id)
                continue
            child_ids.append(child_id)
            outputs[str(branch.agent.get("id", ""))] = {"runId": child_id, "status": "running"}
        outputs[node_id] = {"runIds": ",".join(child_ids)}
        if not child_ids:
            return "failed", shape.join
        settled = await self._await_children(child_ids, shape.wait, cancel)
        if settled is None:
            await self._mark_cancelled(self._fresh(run))
            return None
        succeeded = [item for item in settled.values() if item in ("done", "review")]
        if shape.wait == "any":
            port = "done" if succeeded else "failed"
        else:
            port = "done" if len(succeeded) == len(child_ids) else "failed"
        await self._note(
            run.id,
            "note",
            f"fork {node_id}: {len(succeeded)} succeeded, {len(settled) - len(succeeded)} failed",
            node_id,
        )
        return port, shape.join

    async def _run_dispatch(
        self,
        run: Run,
        cancel: asyncio.Event,
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
    ) -> tuple[str, str] | None:
        node_id = str(node.get("id", ""))
        prompt = render_refs(str(node.get("prompt") or "{{task}}"), outputs)
        child_id, reason = await self.dispatch(
            run.id,
            DispatchOrder(
                objective=prompt[:4_000],
                title=str(node.get("name") or node_id),
            ),
        )
        if reason or not child_id:
            await self._note(run.id, "note", f"dispatch refused — {reason}", node_id)
            return "failed", node_id
        outputs[node_id] = {"runId": child_id, "status": "running", "summary": ""}
        settled = await self._await_children([child_id], "all", cancel)
        if settled is None:
            await self._mark_cancelled(self._fresh(run))
            return None
        status = settled.get(child_id, "failed")
        outputs[node_id] = {"runId": child_id, "status": status, "summary": ""}
        return ("done" if status in ("done", "review") else "failed"), node_id

    async def _await_children(
        self, child_ids: list[str], mode: str, cancel: asyncio.Event
    ) -> dict[str, str] | None:
        pending = list(child_ids)
        settled: dict[str, str] = {}
        while pending:
            if cancel.is_set():
                return None
            await self.tick()
            still: list[str] = []
            for child_id in pending:
                child = get_run(self.db, child_id)
                if child is None:
                    settled[child_id] = "failed"
                    continue
                if child.status in ("done", "review", "failed", "cancelled"):
                    settled[child_id] = child.status
                    continue
                still.append(child_id)
            pending = still
            if mode == "any" and any(status in ("done", "review") for status in settled.values()):
                for child_id in pending:
                    await self.cancel(child_id)
                break
            if pending:
                await asyncio.sleep(0.05)
        return settled

    async def _run_git_commit(
        self, run: Run, node: dict[str, Any], outputs: dict[str, dict[str, str]]
    ) -> tuple[str, str]:
        node_id = str(node.get("id", ""))
        cwd = Path(run.worktree_path or ".")
        message = render_refs(str(node.get("message") or "cezar graph commit"), outputs)
        result = await asyncio.to_thread(commit_all, cwd, message)
        if result.get("ok") != "true":
            await self._note(run.id, "note", str(result.get("error", "commit failed")), node_id)
            return "failed", node_id
        if result.get("result") == "nothing":
            await self._note(run.id, "note", "nothing to commit", node_id)
            return "nothing", node_id
        sha = str(result.get("sha", ""))
        outputs[node_id] = {"sha": sha}
        await self._note(run.id, "note", f"committed {sha[:8]}", node_id)
        return "done", node_id

    async def _run_git_push(self, run: Run, node_id: str) -> tuple[str, str]:
        await self._autosave(run, "pre-PR")
        if not run.branch or run.in_place:
            await self._note(run.id, "note", "this task has no branch of its own to push", node_id)
            return "failed", node_id
        result = await asyncio.to_thread(
            push_branch, Path(run.worktree_path or "."), run.branch, dry_run=self.config.dry_run
        )
        if not result.get("ok"):
            await self._note(run.id, "note", str(result.get("error", "push failed")), node_id)
            return "failed", node_id
        await self._note(run.id, "note", f"pushed {run.branch}", node_id)
        return "done", node_id

    async def _run_git_sync(self, run: Run, node_id: str) -> tuple[str, str]:
        result = await asyncio.to_thread(sync_base, Path(run.worktree_path or "."), run.base_branch)
        if result.get("ok") != "true":
            await self._note(run.id, "note", str(result.get("error", "sync failed")), node_id)
            return "failed", node_id
        port = str(result.get("port", "failed"))
        await self._note(run.id, "note", f"sync with {run.base_branch}: {port}", node_id)
        return port, node_id

    async def _run_draft_pr(
        self, run: Run, node: dict[str, Any], outputs: dict[str, dict[str, str]]
    ) -> tuple[str, str]:
        node_id = str(node.get("id", ""))
        if run.pull_request_url:
            outputs[node_id] = {"url": run.pull_request_url}
            await self._note(
                run.id, "note", f"draft PR already open: {run.pull_request_url}", node_id
            )
            return "created", node_id
        title = render_refs(str(node.get("title") or run.title), outputs)
        await self._autosave(run, "pre-PR")
        result = await asyncio.to_thread(
            create_draft_pr,
            Path(run.worktree_path or "."),
            run.branch,
            title,
            dry_run=self.config.dry_run,
        )
        if not result.get("ok"):
            await self._note(run.id, "note", str(result.get("error", "draft PR failed")), node_id)
            return "failed", node_id
        url = str(result.get("url", ""))
        run.pull_request_url = url
        await self._save(run)
        outputs[node_id] = {"url": url}
        note = f"draft PR opened: {url}"
        if result.get("dryRun"):
            note += " (dry run — no real PR)"
        await self._note(run.id, "note", note, node_id)
        return "created", node_id

    async def _run_wait_ci(
        self, run: Run, node: dict[str, Any], outputs: dict[str, dict[str, str]]
    ) -> tuple[str, str]:
        node_id = str(node.get("id", ""))
        number = _pr_number(run.pull_request_url)
        if not number:
            await self._note(run.id, "note", "no PR on this task — nothing to wait for", node_id)
            outputs[node_id] = {"status": "no-pr"}
            return "failed", node_id
        if self.config.dry_run:
            await self._note(
                run.id, "note", f"dry run — CI on PR #{number} reported green", node_id
            )
            outputs[node_id] = {"status": "passing"}
            return "green", node_id
        glyph = await asyncio.to_thread(_gh_checks, Path(run.worktree_path or "."), number)
        port = "green" if glyph == "passing" else "red" if glyph == "failing" else "timeout"
        outputs[node_id] = {"status": glyph or "timeout"}
        await self._note(run.id, "note", f"CI on PR #{number}: {glyph or 'timeout'}", node_id)
        return port, node_id

    async def _run_github_note(
        self,
        run: Run,
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
    ) -> tuple[str, str]:
        node_id = str(node.get("id", ""))
        kind = str(node.get("type", ""))
        body = render_refs(str(node.get("body") or ""), outputs).replace("{{task}}", run.task)
        cwd = Path(run.worktree_path or ".")
        if kind == "github.issue-comment":
            issue = node.get("issue")
            number = str(issue) if type(issue) is int and issue > 0 else ""
            missing = "no issue on this task to comment on (set one on the node)"
            command = ["issue", "comment", number, "--body", body]
            done = f"commented on issue #{number}"
        else:
            number = _pr_number(run.pull_request_url)
            missing = (
                "no PR on this task to update"
                if kind == "github.pr-update"
                else "no PR on this task to comment on"
            )
            command = ["pr", "comment", number, "--body", body]
            done = f"commented on PR #{number}"
        if not number:
            await self._note(run.id, "note", missing, node_id)
            return "failed", node_id
        if kind == "github.pr-update":
            return await self._update_pr(run, node, node_id, number, cwd)
        if self.config.dry_run:
            if kind == "github.issue-comment":
                outputs[node_id] = {"issue": number}
            await self._note(run.id, "note", f"dry run — {done}", node_id)
            return "done", node_id
        ok, error = await asyncio.to_thread(_gh, cwd, command)
        if not ok:
            await self._note(run.id, "note", f"{kind} failed — {error}", node_id)
            return "failed", node_id
        if kind == "github.issue-comment":
            outputs[node_id] = {"issue": number}
        await self._note(run.id, "note", done, node_id)
        return "done", node_id

    async def _update_pr(
        self, run: Run, node: dict[str, Any], node_id: str, number: str, cwd: Path
    ) -> tuple[str, str]:
        if self.config.dry_run:
            await self._note(run.id, "note", f"dry run — updated PR #{number}", node_id)
            return "done", node_id
        if node.get("ready") is True:
            ok, error = await asyncio.to_thread(_gh, cwd, ["pr", "ready", number])
            if not ok:
                await self._note(run.id, "note", f"PR update failed — {error}", node_id)
                return "failed", node_id
        args = ["pr", "edit", number]
        labels = node.get("addLabels")
        reviewers = node.get("reviewers")
        if isinstance(labels, list):
            for label in labels:
                if isinstance(label, str) and label:
                    args.extend(["--add-label", label])
        if isinstance(reviewers, list):
            for reviewer in reviewers:
                if isinstance(reviewer, str) and reviewer:
                    args.extend(["--add-reviewer", reviewer])
        if len(args) > 3:
            ok, error = await asyncio.to_thread(_gh, cwd, args)
            if not ok:
                await self._note(run.id, "note", f"PR update failed — {error}", node_id)
                return "failed", node_id
        await self._note(run.id, "note", f"updated PR #{number}", node_id)
        return "done", node_id

    async def _run_webhook(
        self,
        run: Run,
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
    ) -> tuple[str, str]:
        node_id = str(node.get("id", ""))
        url = str(node.get("url") or "")
        if not self.config.workflow_webhooks:
            await self._note(
                run.id,
                "note",
                "webhooks are off — set CEZ_WORKFLOW_WEBHOOKS=1 to let workflows POST to URLs",
                node_id,
            )
            return "failed", node_id
        if self.config.dry_run:
            outputs[node_id] = {"status": "200"}
            await self._note(run.id, "note", f"dry run — webhook to {url} not sent", node_id)
            return "done", node_id
        text = render_refs(str(node.get("body") or "cezar: {{task}}"), outputs).replace(
            "{{task}}", run.task
        )
        payload = {
            "text": text,
            "run": {"id": run.id, "title": run.title, "status": run.status},
            "node": node_id,
        }
        status, error = await asyncio.to_thread(_post_json, url, payload)
        outputs[node_id] = {"status": str(status)}
        if error or status < 200 or status >= 300:
            await self._note(run.id, "note", error or f"webhook answered {status}", node_id)
            return "failed", node_id
        await self._note(run.id, "note", f"webhook sent ({status})", node_id)
        return "done", node_id

    async def _agent_step(
        self,
        run: Run,
        cancel: asyncio.Event,
        followup: str = "",
        graph_step: Step | None = None,
    ) -> str:
        if graph_step is not None:
            steps, index = (graph_step,), 0
        elif followup:
            steps, index = (Step(id="followup", name="Follow up", prompt=followup),), 0
        else:
            steps, index = run.definition().steps, run.step_index
            if index >= len(steps):
                return "stop"
        step = steps[index]
        first = index == 0 and not followup and graph_step is None
        if first and "```mermaid" in run.task:
            await self._note(run.id, "text", run.task)
        try:
            spec = await self._agent_spec(run, cancel, steps, index, resume=bool(followup))
        except AgentTempDirError as exc:
            await self._fail(self._fresh(run), str(exc))
            return "stop"
        if run.session_runner != spec.runner:
            opened = self._fresh(run)
            opened.session_runner = spec.runner
            await self._save(opened)
            run.session_runner = spec.runner
        turn = await self._stream_turn(run, cancel, spec, step.id)
        if turn is None:
            return "stop"
        texts, in_gained, out_gained, saw_text, compacted_turn = turn
        gained = in_gained + out_gained
        full = self._coalescer.take_full(run.id, "message")
        if full and not saw_text:
            await self._note(run.id, "item.completed", _delta_snapshot(full), step.id)
        current = self._fresh(run)
        current.tokens_used += gained
        current.input_tokens += in_gained
        current.output_tokens += out_gained
        if gained:
            await self._note(
                current.id, "usage.updated", _usage_event(current.tokens_used, gained), step.id
            )
        if run.pending_reports:
            current.pending_reports = []
        joined = "\n".join(texts)
        await self._refresh_live_title(current, joined)
        from app.engine.handoff import append_heartbeat

        append_heartbeat(self.config.data_dir, current.id, "turn complete", at=stamp())
        continued = await self._continue_compacted(current, cancel, joined, compacted_turn, step.id)
        if continued is not None:
            return continued
        nudged = await self._nudge_autonomous(current, cancel, joined)
        if nudged is not None:
            return nudged
        finishing = run.id in self._finish
        if "CEZ:ASK" in joined and not followup and not finishing:
            current.status = "waiting"
            current.ask = _ask_line(joined)
            current.awaiting_answer_since = stamp()
            await self._save(current)
            await self._note(current.id, "lifecycle", "waiting")
            self._notify(current, "running")
            return "stop"
        if joined.rstrip().endswith("CEZ:MONITORING") and not finishing:
            return await self._park_monitoring(current)
        current.pending_note = ""
        current.check_failure = ""
        await self._save(current)
        await self._autosave(current, "turn end")
        return "ok"

    async def _agent_spec(
        self,
        run: Run,
        cancel: asyncio.Event,
        steps: tuple[Step, ...],
        index: int,
        *,
        resume: bool,
    ) -> AgentSpec:
        """The prompt, environment and runner for one agent step."""
        from app.engine.handoff import HANDOFF_INSTRUCTIONS, handoff_path, seed_handoff
        from app.features.settings.store import read_prompt

        step = steps[index]
        project = get_project(self.db, run.project_id)
        root = Path(project.root) if project else self.config.repo_root
        # Global rules first; the project's own prompt follows and wins on conflict.
        system_parts = [read_prompt(self.config.data_dir).strip(), run_instructions(root)[0]]
        if step.skill:
            skill = find_skill(root, step.skill)
            if skill is None:
                from app.engine.team_skills import org_skill

                skill = org_skill(self.config.data_dir, step.skill)
            if skill is None:
                await self._note(run.id, "note", f'skill "{step.skill}" was not found', step.id)
            else:
                system_parts.append(skill.body)
        seeded = seed_handoff(
            self.config.data_dir,
            run_id=run.id,
            title=run.title,
            workflow=run.workflow,
            task=run.task,
            branch=run.branch,
            worktree=run.worktree_path,
        )
        if run.autonomous:
            system_parts.append(
                "Work autonomously. Do not stop to ask the user. "
                "When this step's own goal is achieved, end your turn with CEZ:DONE."
            )
        if self.config.dry_run and step.bash_allowlist:
            await self._note(
                run.id, "note", "bashAllowlist is not applied by the dry-run mock", step.id
            )
        prompt = build_user_prompt(
            steps,
            index,
            prompt_task(run),
            check_failure=run.check_failure,
            pending_note=run.pending_note,
            reports=list(run.pending_reports),
        )
        if run.attachment_paths:
            prompt += "\n\nThe user attached:\n" + "\n".join(run.attachment_paths)
        if seeded.is_file():
            prompt = f"{HANDOFF_INSTRUCTIONS}\n\n{prompt}"
        tmp_env = agent_tmp_env(self.config.data_dir, run.id, enabled=self.config.agent_tmpdir)
        runner = step.runner or run.runner
        return AgentSpec(
            user_prompt=prompt,
            system_prompt="\n\n".join(part for part in system_parts if part),
            cwd=run.worktree_path or str(root),
            runner=runner,
            model=step.model or run.model,
            cancel=cancel,
            allowed_tools=step.allowed_tools,
            bash_allowlist=step.bash_allowlist,
            session_id=run.id,
            resume=resume or run.step_index > 0,
            timeout_ms=15 * 60 * 1000,
            images=tuple(
                {"mediaType": str(image.get("mediaType", "")), "data": str(image.get("data", ""))}
                for image in run.images
                if index == 0 and not resume
            ),
            mcp_servers=load_project_mcp(root),
            codex_thread=run.codex_thread,
            profile_home=_profile_home(self.config, run.account_id, runner),
            handoff_file=str(handoff_path(self.config.data_dir, run.id)),
            env=tuple((tmp_env | automation_env(run)).items()),
        )

    async def _stream_turn(
        self, run: Run, cancel: asyncio.Event, spec: AgentSpec, step_id: str
    ) -> tuple[list[str], int, int, bool, bool] | None:
        """Stream one agent turn into the run's feed.

        Returns `(texts, input tokens, output tokens, saw text, compacted)`, or None when
        the run ended (cancelled, failed, paused at the memory cap) before the turn did.
        """
        from app.features.settings.store import read_memory

        texts: list[str] = []
        in_gained = out_gained = 0
        saw_text = compacted_turn = False
        paused = asyncio.Event()
        watch: asyncio.Task[None] | None = None
        if read_memory(self.config.data_dir):
            watch = asyncio.create_task(self._watch_memory(run, Path(spec.cwd), paused))
        try:
            async for event in self._agent_for(spec.runner).stream(spec):
                if paused.is_set():
                    break
                in_gained += event.input_tokens
                out_gained += event.output_tokens
                if event.type == "delta" and event.text:
                    self._coalescer.push(run.id, "message", "text", event.text, self._live_delta)
                    continue
                if event.type == "plan" and event.text:
                    await self._note(run.id, "plan.updated", event.text, step_id)
                    continue
                if event.type == "session" and event.text:
                    current_run = self._fresh(run)
                    current_run.codex_thread = event.text
                    await self._save(current_run)
                    continue
                if event.type == "text" and event.text:
                    saw_text = True
                    parsed = usage_from_line(event.text)
                    if parsed is not None:
                        in_gained += parsed[0]
                        out_gained += parsed[1]
                    texts.append(event.text)
                    await self._emit_live(run.id, "item.delta", event.text, step_id)
                await self._note(run.id, event.type, event.text or event.name, step_id)
                for v2_type, v2_text in v2_snapshots(event.type, event.text, event.name, step_id):
                    await self._note(run.id, v2_type, v2_text, step_id)
                if event.type == "turn-end" and event.name == "context-compaction":
                    compacted_turn = True
                if event.type == "error" and not paused.is_set():
                    if cancel.is_set() or event.text == "cancelled":
                        await self._stop(run)
                    else:
                        await self._fail(self._fresh(run), event.text or "agent failed")
                    return None
        finally:
            self._coalescer.flush()
            if watch is not None:
                watch.cancel()
        if paused.is_set():
            current = self._fresh(run)
            current.status = "waiting"
            current.ask = (
                "Paused because this task crossed the memory cap. Send a message to resume."
            )
            current.error = ""
            current.finished_at = ""
            await self._save(current)
            return None
        return texts, in_gained, out_gained, saw_text, compacted_turn

    async def _run_check(self, run: Run, step: Step, cancel: asyncio.Event) -> tuple[int, str]:
        project = get_project(self.db, run.project_id)
        store = SecretStore(self.config.data_dir / "secrets")
        # A fork's head is untrusted code. Like GitHub Actions withholding secrets from fork
        # PRs, its checks get no credentials.
        untrusted = run.automation.get("untrustedHead") is True
        values, notes = (
            ({}, [])
            if untrusted
            else store.resolve(
                "checks",
                project_id=run.project_id,
                root=project.root if project else "",
                bindings=step.secret_bindings,
            )
        )
        for note in notes:
            await self._note(run.id, "note", note, step.id)
        env = {key: value for key, value in os.environ.items() if not key.startswith("CEZ_")}
        env.update(
            {
                "CEZ_RUN_ID": run.id,
                "CEZ_STEP_ID": step.id,
                "CEZ_WORKTREE": run.worktree_path or "",
                "CEZ_ATTEMPT": "1",
            }
        )
        env["CEZ_TASK_ID"] = run.id
        env.update(automation_env(run))
        cache = shared_cache_dir(self.config.data_dir, run.project_id) if run.project_id else None
        if cache is not None:
            env["CEZ_SHARED_CACHE_DIR"] = str(cache)
        from app.engine.handoff import handoff_path

        env["CEZ_HANDOFF_FILE"] = str(handoff_path(self.config.data_dir, run.id))
        if run.project_id:
            env["CEZ_PROJECT_ID"] = run.project_id
        if run.branch:
            env["CEZ_BRANCH"] = run.branch
        if run.base_branch:
            env["CEZ_BASE"] = run.base_branch
        env.update(values)
        from app.engine.proc_usage import unwatch, watch

        def started(pid: int) -> None:
            watch(run.id, pid)

        try:
            code, output = await run_shell(
                step.command,
                Path(run.worktree_path or "."),
                cancel,
                self.config.check_timeout_seconds,
                env,
                on_pid=started,
            )
        finally:
            unwatch(run.id)
        return code, redact(output, list(values.values()))

    async def _check(self, run: Run, step: Step, cancel: asyncio.Event) -> str:
        # The TypeScript check shell is always `bash -lc`. `bashAllowlist` is an
        # agent-argv concern and does not gate the command.
        code, output = await self._run_check(run, step, cancel)
        await self._note(run.id, "check-output", output or f"exit {code}", step.id)
        if cancel.is_set() or code < 0:
            await self._stop(run)
            return "stop"
        if code == 0:
            return "ok"
        current = self._fresh(run)
        if step.retry and retryable_exit(step.retry_on, code):
            used = current.retries.get(step.id, 0)
            target = next(
                (i for i, item in enumerate(current.definition().steps) if item.id == step.retry),
                -1,
            )
            if target >= 0 and used < step.retry_max:
                current.retries[step.id] = used + 1
                current.check_failure = output[-8_000:] or "(no output)"
                current.pending_note = ""
                current.step_index = target
                await self._save(current)
                await self._note(
                    current.id,
                    "note",
                    (
                        f'check "{step.id}" failed; retrying "{step.retry}" '
                        f"({used + 1}/{step.retry_max})"
                    ),
                    step.id,
                )
                return "jump"
        if step.retry:
            message = f'check "{step.id}" failed after {step.retry_max + 1} attempts'
        else:
            message = f'check "{step.id}" failed (exit {code})'
        await self._fail(current, message)
        if "usage limit" in output.lower():
            failed = get_run(self.db, current.id)
            if failed is not None and failed.auto_resume_attempts < 3:
                from datetime import timedelta

                failed.auto_resume_at = stamp(now() + timedelta(milliseconds=400))
                await self._save(failed)
        return "stop"

    async def _review_applies(self, run: Run) -> bool:
        if run.autonomous or not run.worktree_path or not run.base_sha:
            return False
        project = get_project(self.db, run.project_id)
        root = Path(project.root) if project else self.config.repo_root
        if not review_gate_enabled(root):
            return False
        diff = await asyncio.to_thread(_measured_diff, run)
        return diff.files > 0

    def _notify(self, run: Run, previous: str) -> None:
        from app.integrations.lifecycle import notify_task

        notify_task(
            self.config.data_dir,
            run_id=run.id,
            title=run.title,
            status=run.status,
            previous=previous,
            project_id=run.project_id,
            error=run.error,
            dry_run=self.config.dry_run,
        )

    async def _enter_review(self, run: Run) -> None:
        current = self._fresh(run)
        if current.status in ("cancelled", "failed"):
            return
        stopped = "the task was finished" if run.id in self._finish else ""
        if not stopped and await self._release_deferred(current, stopped=""):
            return
        if stopped:
            await self._release_deferred(current, stopped=stopped)
        if not await self._review_applies(current):
            if await self._auto_land(current, finish=current.id in self._finish):
                return
            await self._mark_done(current)
            return
        previous = current.status
        current.status = "review"
        current.finished_at = stamp()
        current.ask = ""
        current.mode = "workflow"
        await self._save(current)
        if current.worktree_path and current.base_sha and not current.in_place:
            diff = await asyncio.to_thread(_measured_diff, current)
            await self._note(
                current.id,
                "note",
                f"{diff.files} files, +{diff.adds} −{diff.dels}",
            )
        await self._note(current.id, "lifecycle", "review")
        self._notify(current, previous)

    async def _fail(self, run: Run, message: str) -> Run:
        await self._release_deferred(run, stopped="the run failed")
        previous = run.status
        run.status = "failed"
        run.error = message
        run.finished_at = stamp()
        await self._save(run)
        await self._note(run.id, "error", message)
        await self._note(run.id, "lifecycle", "failed")
        self._notify(run, previous)
        await self._schedule_auto_resume(run)
        self._reap(run.id)
        return run

    def _fresh(self, run: Run) -> Run:
        return get_run(self.db, run.id) or run

    async def _stop(self, run: Run) -> None:
        """Settle a cancelled walk: done when the user chose Finish, cancelled otherwise."""
        run = self._fresh(run)
        await (self._mark_done(run) if run.id in self._finish else self._mark_cancelled(run))

    async def _mark_cancelled(self, run: Run) -> None:
        if run.status == "cancelled":
            return
        self._finish.discard(run.id)
        await self._release_deferred(run, stopped="the run was cancelled")
        previous = run.status
        run.status = "cancelled"
        run.finished_at = stamp()
        await self._save(run)
        await self._note(run.id, "lifecycle", "cancelled")
        self._notify(run, previous)
        self._reap(run.id)

    async def _resume_due(self) -> None:
        if not self.config.auto_resume:
            return
        moment = now()
        for run in list_runs(self.db, None, "failed", limit=100):
            if not run.auto_resume_at:
                continue
            due = parse_stamp(run.auto_resume_at)
            if due is None or due > moment:
                continue
            run.auto_resume_attempts += 1
            run.auto_resume_at = ""
            run.status = "queued"
            run.mode = "followup"
            run.continuation = (
                "The usage limit has reset. Continue the task from where you left off."
            )
            run.error = ""
            run.finished_at = ""
            await self._save(run)
            await self._note(run.id, "lifecycle", "auto-resume")
            self.kick()

    async def cancel_auto_resume(self, run_id: str) -> bool:
        run = get_run(self.db, run_id)
        if run is None or not run.auto_resume_at:
            return False
        run.auto_resume_at = ""
        await self._save(run)
        return True

    async def _mark_done(self, run: Run) -> None:
        self._finish.discard(run.id)
        if run.status == "done":
            return
        if run.in_place:
            project = get_project(self.db, run.project_id)
            root = Path(project.root) if project else self.config.repo_root
            from app.engine.landing import land_inplace, read_policy

            # Auto-land owns the commit when `landing: auto` is set. Otherwise
            # an in-place checkout is committed here, excluding `.ai/cezar`.
            if is_git_repo(root) and read_policy(root) is None:
                result = await asyncio.to_thread(land_inplace, root)
                if result.get("result") == "failed":
                    await self._fail(run, str(result.get("error") or "land failed"))
                    return
                if result.get("result") == "landed":
                    sha = str(result.get("sha", ""))
                    await self._note(run.id, "lifecycle", f"landed {sha}")
        await self._release_deferred(run, stopped="the task was finished")
        previous = run.status
        run.status = "done"
        run.ask = ""
        run.finished_at = stamp()
        await self._save(run)
        await self._note(run.id, "lifecycle", "done")
        self._notify(run, previous)
        await self._autosave(run, "run finalize")
        self._reap(run.id)

    async def _watch_memory(self, run: Run, cwd: Path, paused: asyncio.Event) -> None:
        import signal

        from app.engine.memory_guard import pids_in, rss_bytes_in
        from app.features.settings.store import read_memory

        while not paused.is_set():
            limit = read_memory(self.config.data_dir)
            if not limit or limit <= 0:
                await asyncio.sleep(0.05)
                continue
            limit_bytes = limit * 1024 * 1024
            rss = rss_bytes_in(cwd)
            if rss is not None and rss > limit_bytes:
                paused.set()
                used = max(1, round(rss / (1024 * 1024)))
                await self._note(
                    run.id,
                    "note",
                    "memory limit exceeded — this task's process tree is using "
                    f"{used} MiB (limit {limit} MiB). Pausing it and letting the next "
                    "queued task run; resume it with a message.",
                )
                for pid in pids_in(cwd):
                    if pid == os.getpid():
                        continue
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except OSError:
                        pass
                return
            await asyncio.sleep(0.05)

    async def _auto_land(self, run: Run, *, finish: bool) -> bool:
        """Land an in-place run. True when this call owns the settle."""
        from app.engine.landing import (
            MAX_LAND_ATTEMPTS,
            failure_prompt,
            has_unlanded,
            land_in_place,
            read_policy,
        )
        from app.features.settings.store import read_checks

        if not run.in_place or not run.worktree_path:
            return False
        project = get_project(self.db, run.project_id)
        root = Path(project.root) if project else Path(run.worktree_path)
        policy = read_policy(root, tuple(read_checks(self.config.data_dir, run.project_id)))
        if policy is None:
            return False
        if policy.refusal:
            await self._note(run.id, "note", policy.refusal)
            return False
        dirty = await asyncio.to_thread(has_unlanded, root)
        if not finish and not run.autonomous:
            if not dirty:
                return False
            run.status = "waiting"
            run.ask = ""
            run.finished_at = ""
            await self._save(run)
            label = policy.base_branch or run.base_branch or "the base branch"
            await self._note(
                run.id,
                "note",
                "changes ready for review — check Changes, reply with corrections, "
                f"or Commit to {label} (or Finish) to land them",
            )
            return True
        if not dirty:
            return False
        outcome = await asyncio.to_thread(
            land_in_place,
            root,
            checks=policy.checks,
            base_branch=policy.base_branch,
            since=run.base_sha,
            dry_run=self.config.dry_run,
            check_timeout=self.config.check_timeout_seconds,
        )
        if outcome.result == "landed":
            run.landing = {
                "status": "landed",
                "branch": outcome.branch,
                "sha": outcome.sha,
                "pushed": outcome.pushed,
                "files": list(outcome.files),
            }
            pushed = " and pushed" if outcome.pushed else ""
            await self._note(
                run.id,
                "note",
                f"landed {outcome.sha[:8]} on {outcome.branch}{pushed}",
            )
            await self._mark_done(run)
            return True
        if outcome.result == "nothing":
            run.landing = {"status": "nothing"}
            await self._note(run.id, "note", "auto-land — nothing to land")
            await self._mark_done(run)
            return True
        run.landing = {"status": "failed", "stage": outcome.stage, "error": outcome.error}
        await self._save(run)
        attempts = self._land_attempts.get(run.id, 0) + 1
        self._land_attempts[run.id] = attempts
        if attempts >= MAX_LAND_ATTEMPTS:
            await self._note(
                run.id,
                "note",
                f"auto-land failed {attempts} times ({outcome.stage}) — not landed",
            )
            await self._fail(run, outcome.error)
            return True
        run.mode = "followup"
        run.continuation = failure_prompt(outcome)
        run.status = "queued"
        run.finished_at = ""
        await self._save(run)
        await self._note(
            run.id,
            "note",
            f"auto-land failed at {outcome.stage} — sent back to the agent "
            f"({attempts}/{MAX_LAND_ATTEMPTS})",
        )
        self.kick()
        return True

    async def set_archived(self, run_id: str, archived: bool) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        run.archived = archived
        run.archived_at = stamp() if archived else ""
        if archived:
            run.pinned = False
            run.pinned_at = ""
            if run.status in ("queued", "running", "waiting"):
                self._cancel.setdefault(run_id, asyncio.Event()).set()
        await self._save(run)
        return None

    async def set_pinned(self, run_id: str, pinned: bool) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        run.pinned = pinned
        run.pinned_at = stamp() if pinned else ""
        if pinned:
            run.archived = False
            run.archived_at = ""
        await self._save(run)
        return None

    async def _refresh_live_title(self, run: Run, turn: str) -> None:
        if not self.config.title_updates or not turn.strip():
            return
        project = get_project(self.db, run.project_id)
        root = Path(project.root) if project else self.config.repo_root
        title = await propose_title(
            run.task,
            turn,
            dry_run=self.config.dry_run,
            cwd=root,
            binary=self.config.runner_bins.get("claude", "claude"),
            model=self._namer_model(),
        )
        if title and title != run.title:
            run.title = title

    async def _continue_compacted(
        self,
        run: Run,
        cancel: asyncio.Event,
        joined: str,
        compacted: bool,
        step_id: str,
    ) -> str | None:
        if not compacted or not _markerless(joined) or run.id in self._finish:
            if not compacted:
                self._compaction.pop(run.id, None)
            return None
        attempts = self._compaction.get(run.id, 0)
        if attempts >= MAX_COMPACTION_CONTINUES:
            if attempts == MAX_COMPACTION_CONTINUES:
                self._compaction[run.id] = attempts + 1
                await self._note(
                    run.id,
                    "note",
                    (
                        f"context compaction ended {MAX_COMPACTION_CONTINUES} turns in a row "
                        "with no progress in between — the run parks for you "
                        "instead of continuing again"
                    ),
                    step_id,
                )
            return None
        self._compaction[run.id] = attempts + 1
        await self._note(
            run.id,
            "note",
            (
                "context was compacted mid-task — continuing on the same thread "
                f"({self._compaction[run.id]}/{MAX_COMPACTION_CONTINUES})"
            ),
            step_id,
        )
        await self._save(run)
        return await self._agent_step(run, cancel, followup=COMPACTION_NUDGE)

    async def _nudge_autonomous(self, run: Run, cancel: asyncio.Event, joined: str) -> str | None:
        if "CEZ:DONE" in joined:
            self._auto_continues.pop(run.id, None)
            return None
        if not run.autonomous or run.id in self._finish:
            return None
        if count_in_flight_children(self.db, run.id):
            return None
        attempts = self._auto_continues.get(run.id, 0)
        if attempts >= MAX_AUTO_CONTINUES:
            return None
        self._auto_continues[run.id] = attempts + 1
        await self._note(
            run.id,
            "note",
            f"automatic continuation ({self._auto_continues[run.id]}/{MAX_AUTO_CONTINUES})",
        )
        await self._save(run)
        return await self._agent_step(run, cancel, followup=AUTONOMOUS_NUDGE)

    async def _park_monitoring(self, run: Run) -> str:
        run.status = "monitoring"
        run.ask = ""
        run.finished_at = ""
        wake = now() + timedelta(seconds=self.config.monitoring_wake_seconds)
        run.monitoring_wake_at = stamp(wake)
        await self._save(run)
        await self._note(run.id, "lifecycle", "monitoring")
        return "stop"

    async def _wake_monitors(self) -> None:
        moment = now()
        for project in list_projects(self.db):
            for run in list_runs(self.db, project.id, "monitoring", limit=200):
                if count_in_flight_children(self.db, run.id):
                    continue
                if run.monitoring_wakes >= MAX_AUTO_CONTINUES:
                    run.status = "waiting"
                    run.ask = "monitoring wake-up cap reached — continue this task manually"
                    run.monitoring_wake_at = ""
                    await self._save(run)
                    await self._note(run.id, "lifecycle", "waiting")
                    continue
                due = parse_stamp(run.monitoring_wake_at)
                if due is None or due > moment:
                    continue
                run.monitoring_wakes += 1
                run.monitoring_wake_at = ""
                run.mode = "followup"
                run.continuation = MONITORING_WAKE_NUDGE
                run.status = "queued"
                await self._save(run)
                await self._note(
                    run.id,
                    "lifecycle",
                    f"automatic monitoring wake-up ({run.monitoring_wakes}/{MAX_AUTO_CONTINUES})",
                )

    async def _schedule_auto_resume(self, run: Run) -> None:
        if not self.config.auto_resume or run.archived or run.status != "failed":
            return
        hit = parse_usage_limit(run.error, now())
        if hit is None:
            return
        if run.auto_resume_attempts >= MAX_AUTO_RESUMES:
            await self._note(
                run.id,
                "note",
                f"automatic resume cap reached ({MAX_AUTO_RESUMES}) — continue this task manually",
            )
            return
        wake = hit.reset_at + timedelta(seconds=AUTO_RESUME_GRACE_S)
        run.auto_resume_at = stamp(wake)
        await self._save(run)
        await self._note(
            run.id,
            "lifecycle",
            f"usage limit reached — resuming automatically at {run.auto_resume_at}",
        )

    async def clear_auto_resume(self, run_id: str) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if not run.auto_resume_at:
            return None
        run.auto_resume_at = ""
        await self._save(run)
        await self._note(run.id, "lifecycle", "automatic resume cancelled")
        return None

    async def _resume_limited(self) -> None:
        if not self.config.auto_resume:
            return
        moment = now()
        for project in list_projects(self.db):
            for run in list_runs(self.db, project.id, "failed", limit=200):
                if not run.auto_resume_at:
                    continue
                due = parse_stamp(run.auto_resume_at)
                if due is None or due > moment:
                    continue
                run.auto_resume_attempts += 1
                run.auto_resume_at = ""
                run.status = "queued"
                run.mode = "followup"
                run.continuation = (
                    "The usage limit has reset. Continue the task from where you left off."
                )
                run.error = ""
                run.finished_at = ""
                await self._save(run)
                await self._note(
                    run.id,
                    "lifecycle",
                    (
                        "usage limit reset — resuming automatically "
                        f"({run.auto_resume_attempts}/{MAX_AUTO_RESUMES})"
                    ),
                )

    async def _autosave(self, run: Run, reason: str) -> None:
        if reason == "periodic" and not self.config.autosave:
            return
        if not run.worktree_path:
            return
        # An in-place auto-land checkout is the user's branch. Turn-end autosave
        # would commit it before the review park. TypeScript skips that flush
        # when the cwd is the repo root.
        if run.in_place:
            from app.engine.landing import read_policy

            if read_policy(Path(run.worktree_path)) is not None:
                return
        result = await asyncio.to_thread(autosave_commit, Path(run.worktree_path), reason)
        if result == "committed":
            await self._note(run.id, "note", f"cezar autosave ({reason})")

    async def _periodic_autosave(self) -> None:
        if not self.config.autosave:
            return
        moment = asyncio.get_running_loop().time()
        interval = self.config.autosave_interval_s
        for project in list_projects(self.db):
            for run in list_runs(self.db, project.id, "running", limit=50):
                last = self._last_autosave.get(run.id, 0)
                if moment - last < interval:
                    continue
                self._last_autosave[run.id] = moment
                await self._autosave(run, "periodic")

    def _reap(self, run_id: str) -> None:
        reap_task_processes(run_id, enabled=self.config.task_process_reap)
        remove_agent_tmp_dir(self.config.data_dir, run_id)

    async def _deliver_report(self, parent_id: str, child_id: str, text: str) -> None:
        parent = get_run(self.db, parent_id)
        if parent is None or parent.status == "cancelled":
            return
        if parent.status == "running" and await self._steer(parent, text):
            parent.pending_reports = [
                item for item in parent.pending_reports if item.get("from_id") != child_id
            ]
            await self._save(parent)
            await self._note(parent.id, "note", "report delivered into the live session")
            return
        if parent.status == "queued":
            parent.queued_messages.append(
                {"id": uuid.uuid4().hex, "text": text, "createdAt": stamp()}
            )
            parent.pending_reports = [
                item for item in parent.pending_reports if item.get("from_id") != child_id
            ]
            await self._save(parent)
            return
        # `done` keeps the stored report for a later prompt. Requeueing it races the
        # graph dispatch node that just observed this child and finished the parent.
        if parent.status in ("failed", "review"):
            parent.mode = "followup"
            parent.continuation = text
            parent.status = "queued"
            parent.finished_at = ""
            parent.pending_reports = [
                item for item in parent.pending_reports if item.get("from_id") != child_id
            ]
            await self._save(parent)
            self.kick()

    async def _steer(self, run: Run, text: str) -> bool:
        agent = self._agent_for(run.runner)
        steer = getattr(agent, "steer", None)
        if steer is None:
            return False
        result = steer(run.id, text)
        if asyncio.iscoroutine(result):
            result = await result
        return bool(result)

    async def queue_message(
        self, run_id: str, text: str
    ) -> tuple[dict[str, object] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if run.status != "queued":
            return None, "run already started"
        message: dict[str, object] = {"id": uuid.uuid4().hex, "text": text, "createdAt": stamp()}
        run.queued_messages.append(message)
        await self._save(run)
        return message, None

    async def edit_queued_message(
        self, run_id: str, message_id: str, text: str
    ) -> tuple[dict[str, object] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if run.status != "queued":
            return None, "run already started"
        for message in run.queued_messages:
            if message.get("id") == message_id:
                message["text"] = text
                await self._save(run)
                return message, None
        return None, "not found"

    async def remove_queued_message(self, run_id: str, message_id: str) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.status != "queued":
            return "run already started"
        kept = [message for message in run.queued_messages if message.get("id") != message_id]
        if len(kept) == len(run.queued_messages):
            return "not found"
        run.queued_messages = kept
        await self._save(run)
        return None

    async def _save(self, run: Run) -> None:
        await self.db.write(save_run, run)
        self._emit_workspace("run", run)
        self.publish()

    async def _note(self, run_id: str, type: str, text: str, step_id: str = "") -> None:
        from app.engine.agent_env import scrub

        text = scrub(text)
        at = stamp()
        seq = await self.db.write(add_event, run_id, type, text, step_id, at)
        self._fanout(
            {
                "runId": run_id,
                "seq": int(seq),
                "type": type,
                "text": text,
                "stepId": step_id,
                "at": at,
            }
        )
        self.publish()

    async def _emit_live(self, run_id: str, type: str, text: str, step_id: str) -> None:
        """`item.delta` is live-only. It is not written to the event log."""
        self._live_delta(run_id, "message", "text", text, step_id=step_id, type_name=type)

    def _live_delta(
        self,
        run_id: str,
        item_id: str,
        field_name: str,
        text: str,
        *,
        step_id: str = "",
        type_name: str = "item.delta",
    ) -> None:
        self._fanout(
            {
                "runId": run_id,
                "seq": 0,
                "type": type_name,
                "text": text,
                "stepId": step_id,
                "itemId": item_id,
                "field": field_name,
                "at": stamp(),
                "live": True,
            }
        )

    def _fanout(self, payload: dict[str, object]) -> None:
        run_id = str(payload.get("runId", ""))
        for listener in list(self._live.get(run_id, ())):
            listener(payload)

    def _agent_for(self, runner: str) -> Runner:
        if self.agent is not None:
            return self.agent
        if self.config.dry_run:
            from app.engine.agents import DryRunAgent

            return DryRunAgent()
        cached = self._runners.get(runner)
        if cached is not None:
            return cached
        from app.engine.runners.protocol import ProtocolRunner

        created = ProtocolRunner(
            runner,
            self.config.runner_bins.get(runner, runner),
            approval_gate=self.config.approval_gate,
            codex_network_off=self.config.codex_network_off,
            codex_reasoning=self.config.codex_reasoning,
        )
        self._runners[runner] = created
        return created

    async def retain(self) -> list[str]:
        """Reclaim finished worktree directories past the cap, and drop old index rows."""
        reclaimed: list[str] = []
        from app.features.settings.store import read_retention

        for project in list_projects(self.db):
            saved = read_retention(self.config.data_dir, project.id)
            keep = self.config.worktree_keep if saved is None else saved
            runs = list_runs(self.db, project.id, None, limit=10_000)
            for run_id in select_reclaimable(runs, keep):
                run = get_run(self.db, run_id)
                if run is None or not run.worktree_path:
                    continue
                gone = await asyncio.to_thread(
                    drop_worktree_dir, Path(project.root), Path(run.worktree_path)
                )
                if not gone:
                    continue
                run.worktree_reclaimed_at = stamp()
                await self._save(run)
                reclaimed.append(run_id)
                self._emit_workspace(
                    "worktree-lifecycle",
                    {"projectId": project.id, "runId": run_id, "kind": "reclaimed"},
                )
            runs = list_runs(self.db, project.id, None, limit=10_000)
            # A reclaimed worktree no longer needs the PR head it forked from.
            needed = {
                int(head["number"])
                for run in runs
                if run.worktree_path
                and not run.worktree_reclaimed_at
                and isinstance(head := run.automation.get("prHead"), dict)
                and isinstance(head.get("number"), int)
            }
            await asyncio.to_thread(prune_pr_head_refs, Path(project.root), needed)
            for run_id in select_index_prune(
                runs, keep=self.config.runs_keep, archived_keep=self.config.archived_keep
            ):
                await self.db.write(delete_run_row, run_id)
        if reclaimed:
            self.publish()
        return reclaimed

    async def _lay_down_attachments(self, run: Run) -> None:
        if run.attachment_paths or not run.images or not run.worktree_path:
            return
        paths = await asyncio.to_thread(
            materialize,
            self.config.data_dir / "uploads",
            Path(run.worktree_path) / ".cezar-attachments",
            run.images,
        )
        if paths:
            run.attachment_paths = paths
            await self._save(run)

    def _buffer(self) -> DeferredBuffer:
        if self._deferred_buf is None:
            self._deferred_buf = DeferredBuffer(self.config.data_dir / "runs")
        return self._deferred_buf

    def defer_message(self, run_id: str, text: str) -> bool:
        run = get_run(self.db, run_id)
        if run is None or run.status != "running" or not text.strip():
            return False
        self._buffer().add(run_id, text.strip())
        return True

    async def _release_deferred(self, run: Run, *, stopped: str) -> bool:
        pending = self._buffer().take(run.id)
        if not pending:
            return False
        count = len(pending)
        word = "a message" if count == 1 else f"{count} messages"
        if stopped:
            await self._note(
                run.id,
                "lifecycle",
                f"{word} sent while the session was closing could not be delivered — {stopped}",
            )
            return False
        run.mode = "followup"
        run.continuation = "\n\n".join(pending)
        run.status = "queued"
        run.finished_at = ""
        run.ask = ""
        await self._save(run)
        await self._note(
            run.id,
            "lifecycle",
            "delivered a message sent while the session was closing",
        )
        return True

    async def archive_finished(self, project_id: str) -> int:
        changed = sweep_archive(list_runs(self.db, project_id, None, limit=10_000), stamp())
        for run in changed:
            await self._save(run)
        return len(changed)

    async def mark_all_read(self, project_id: str) -> int:
        changed = sweep_read(list_runs(self.db, project_id, None, limit=10_000), stamp())
        for run in changed:
            await self._save(run)
        return len(changed)

    async def set_notes(self, run_id: str, notes: str) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        run.notes = notes
        await self._save(run)
        return None

    async def set_read(self, run_id: str, read: bool) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        run.seen_at = stamp() if read else ""
        await self._save(run)
        return None

    async def git_commit(
        self, run_id: str, message: str
    ) -> tuple[dict[str, str] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if not run.worktree_path:
            return None, "no worktree"
        result = await asyncio.to_thread(commit_all, Path(run.worktree_path), message)
        if result.get("ok") != "true":
            return None, str(result.get("error", "commit failed"))
        await self._note(
            run.id,
            "note",
            f"commit: {result.get('result', '')} {result.get('sha', '')}",
        )
        return result, None

    async def git_push(self, run_id: str) -> tuple[dict[str, object] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if not run.worktree_path or not run.branch:
            return None, "no worktree"
        result = await asyncio.to_thread(
            push_branch, Path(run.worktree_path), run.branch, dry_run=self.config.dry_run
        )
        if not result.get("ok"):
            return None, str(result.get("error", "push failed"))
        await self._note(run.id, "note", f"pushed {run.branch}")
        return cast(dict[str, object], result), None

    async def git_status(self, run_id: str) -> tuple[dict[str, object] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if not run.worktree_path:
            return None, "no worktree"
        result = await asyncio.to_thread(
            worktree_git_status, Path(run.worktree_path), run.base_branch or "HEAD"
        )
        if not result.get("ok"):
            return None, str(result.get("error", "git status failed"))
        return result, None

    async def open_draft_pr(self, run_id: str) -> tuple[dict[str, object] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if run.status in ("queued", "running", "waiting"):
            return None, "run is still active — wait for the review gate"
        if not run.worktree_path or not run.branch or run.in_place:
            return None, "no worktree/branch to publish"
        head = run.automation.get("prHead")
        if isinstance(head, dict) and head.get("number"):
            return None, (
                f"this run verified pull request #{head['number']}; "
                "publishing its changes is not supported yet"
            )
        result = await asyncio.to_thread(
            create_draft_pr,
            Path(run.worktree_path),
            run.branch,
            run.title,
            dry_run=self.config.dry_run,
        )
        if not result.get("ok"):
            return None, str(result.get("error", "draft PR failed"))
        url = str(result.get("url", ""))
        run.pull_request_url = url
        run.status = "done"
        if not run.finished_at:
            run.finished_at = stamp()
        await self._save(run)
        suffix = " (dry run — no real PR)" if result.get("dryRun") else ""
        await self._note(run.id, "note", f"draft PR created: {url}{suffix}")
        return {"url": url, "dryRun": bool(result.get("dryRun"))}, None

    async def adopt_pr(self, run_id: str, ref_text: str) -> tuple[str | None, str | None]:
        """Record a PR the agent (or the user) opened. Returns `(url, reason)`.

        Like `POST /api/v1/runs/:id/pr/adopt`, the status stays: the agent's session, not the
        cockpit, owns the run. An empty `ref_text` finds the open PR for the task's branch; a
        number or URL adopts that PR once it is shown to be this task's.
        """
        from app.integrations.pr_adopt import (
            PrTarget,
            adopt_named,
            find_branch_pr,
            parse_pr_ref,
            resolve_pr_target,
        )

        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if run.pull_request_url:
            return run.pull_request_url, None
        if not run.worktree_path or not run.branch or run.in_place:
            return None, "no worktree/branch to adopt a pull request for"
        worktree = Path(run.worktree_path)
        dry = self.config.dry_run
        target = await asyncio.to_thread(resolve_pr_target, worktree, run.branch, run.base_branch)
        if target is None:
            if not dry:
                return None, "no git remote to look up pull requests on"
            target = PrTarget(None, run.branch, None)
        if ref_text.strip():
            ref = parse_pr_ref(ref_text)
            if ref is None:
                return None, "enter a pull request number or URL"
            found = await asyncio.to_thread(adopt_named, worktree, target, ref, dry_run=dry)
            if isinstance(found, str):
                return None, found
            url = found[0]
        else:
            branch_pr = await asyncio.to_thread(find_branch_pr, worktree, target, dry_run=dry)
            if branch_pr is None:
                return None, f"no open pull request found for branch {run.branch}"
            url = branch_pr[0]
        if not url:
            return None, "the pull request has no URL"
        run.pull_request_url = url
        await self._save(run)
        await self._note(run.id, "note", f"PR adopted: {url}")
        return url, None

    def plan_run(
        self,
        *,
        project: Project,
        task: str,
        workflow_name: str,
        runner: str,
        model: str = "",
        autonomous: bool | None = None,
        parent: Run | None = None,
        budget_usd: float | None = None,
        base_branch: str = "",
        kind: str = "implement",
        workflow: Workflow | None = None,
        in_place: bool | None = None,
    ) -> tuple[Run | None, str | None]:
        text = task.strip()
        if not text:
            return None, "task is empty"
        if len(text) > 100_000:
            return None, "must be at most 100000 characters"
        if runner not in RUNNERS:
            return None, f"unknown runner {runner}"
        chosen = workflow
        if chosen is None:
            chosen = find_workflow(Path(project.root), workflow_name)
        if chosen is None:
            return None, f"unknown workflow: {workflow_name}"
        workflow = chosen
        from app.features.settings.store import read_composer_defaults

        composer = read_composer_defaults(self.config.data_dir)
        if autonomous is None:
            autonomous = (
                composer.autonomous
                if composer.autonomous is not None
                else self.config.autonomous_default is True
            )
        if in_place is None:
            in_place = (
                not composer.worktree
                if composer.worktree is not None
                else not self.config.worktree_default
            )
        model = self.default_model(runner, model)
        from app.integrations.accounts import selected_account

        account_id = (
            parent.account_id
            if parent and parent.account_id and parent.runner == runner
            else selected_account(self.config, project.id, runner)
        )
        run = Run(
            id=uuid.uuid4().hex,
            project_id=project.id,
            account_id=account_id,
            title=title_from(text),
            task=text,
            workflow=workflow.name,
            status="queued",
            runner=runner,
            created_at=stamp(),
            workflow_def=workflow.to_json(),
            autonomous=autonomous,
            in_place=in_place,
            model=model,
            parent_id=parent.id if parent else "",
            root_id=(parent.root_id or parent.id) if parent else "",
            budget_usd=budget_usd,
            base_branch=base_branch,
            kind=kind,
        )
        return run, None

    def plan_variants(self, count: int, **plan: Any) -> tuple[list[Run], str | None]:
        """`count` runs of one plan (1 to 3), lettered A to C and grouped when there are several."""
        runs: list[Run] = []
        for letter in "ABC"[:count]:
            run, reason = self.plan_run(**plan)
            if run is None:
                return [], reason
            if count > 1:
                run.group_id = runs[0].id if runs else run.id
                run.variant = letter
            runs.append(run)
        return runs, None

    def _namer_model(self) -> str:
        """`namerModel`: the cheap alias the title and branch namer asks Claude with."""
        from app.features.settings.store import read_agent_defaults

        return read_agent_defaults(self.config.data_dir).namer_model

    def models_locked(self) -> bool:
        """`CEZ_AGENT_MODELS_LOCKED=1` or `modelsLocked` on the Agents page."""
        from app.features.settings.store import models_locked

        return models_locked(self.config.agent_models_locked, self.config.data_dir)

    def model_lock_error(self, model: str) -> str | None:
        """The refusal for a task that names a model while the agents' own setting rules."""
        from app.features.settings.store import MODELS_LOCKED_ERROR

        return MODELS_LOCKED_ERROR if model.strip() and self.models_locked() else None

    def default_model(self, runner: str, picked: str = "") -> str:
        """The model a new task runs: the pick, else the runner's `defaultModels` preset.

        Locked means neither applies and the agent's own configured model runs.
        """
        from app.features.settings.store import read_agent_defaults

        if self.models_locked():
            return ""
        if picked.strip():
            return picked.strip()
        return read_agent_defaults(self.config.data_dir).model_for(runner)

    async def enqueue(self, run: Run) -> None:
        await self.db.write(insert_run, run)
        self.publish()
        self.kick()

    async def cancel(self, run_id: str) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.status not in ("queued", "running", "waiting", "review"):
            return "cannot cancel a settled run"
        self._cancel.setdefault(run_id, asyncio.Event()).set()
        await self._mark_cancelled(run)
        await self._report_child(run_id)
        self.kick()
        return None

    async def finish(self, run_id: str) -> str | None:
        """Accept the review gate. An in-place checkout is committed; a worktree is not pushed."""
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.status == "review" or run.status == "waiting":
            self._finish.add(run_id)
            if not await self._auto_land(run, finish=True):
                await self._mark_done(run)
            self._finish.discard(run_id)
            await self._report_child(run_id)
            return None
        if run.status == "running":
            self._finish.add(run_id)
            self._cancel.setdefault(run_id, asyncio.Event()).set()
            await self._note(run_id, "lifecycle", "session closed by user")
            return None
        return "no open session"

    async def delete(self, run_id: str) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.status in ("queued", "running", "waiting"):
            return "cancel the run before deleting it"
        project = get_project(self.db, run.project_id)
        if project and run.worktree_path and not run.in_place:
            await asyncio.to_thread(
                remove_worktree,
                Path(project.root),
                Path(run.worktree_path),
                run.branch,
            )
        await self.db.write(delete_run_row, run_id)
        self._emit_workspace("run-deleted", {"id": run_id, "projectId": run.project_id})
        self.publish()
        return None

    async def deliver(self, run_id: str, message: str) -> str | None:
        text = message.strip()
        if not text:
            return "message is empty"
        if len(text) > 20_000:
            return "message is too long"
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.status == "waiting" and run.graph_park:
            if run.graph_park.get("kind") != "ask-user":
                return "approve or reject this gate"
            return await self.resolve_park(run_id, "ask-user", "answered", text)
        if run.status == "waiting":
            run.pending_note = f"The user answered:\n{text}"
            run.ask = ""
            run.awaiting_answer_since = ""
            run.status = "queued"
            await self._save(run)
            self.kick()
            return None
        if run.status in ("review", "monitoring") or _interrupted(run):
            if run.status == "monitoring":
                run.monitoring_wakes = 0
                run.monitoring_wake_at = ""
            run.mode = "followup"
            run.continuation = text
            run.status = "queued"
            run.error = ""
            run.finished_at = ""
            await self._save(run)
            self.kick()
            return None
        return "a message can be sent to a run that is waiting or in review"

    async def start_now(self, run_id: str) -> str | None:
        """Drop a usage-limit hold and queue the run on the next tick."""
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.auto_resume_at:
            run.status = "queued"
            run.auto_resume_at = ""
            run.finished_at = ""
            run.error = ""
            await self._save(run)
            await self._note(run.id, "lifecycle", "start-now")
            self.kick()
            return None
        if run.status == "queued":
            self.kick()
            return None
        return "nothing is scheduled"

    async def dispatch(
        self, parent_id: str, order: DispatchOrder, nested: Workflow | None = None
    ) -> tuple[str | None, str | None]:
        if not self.config.dispatch_enabled:
            return None, "dispatch is disabled on this cockpit (CEZ_DISPATCH=0)"
        parent = get_run(self.db, parent_id)
        if parent is None:
            return None, "not found"
        if parent.status in TERMINAL:
            return None, f"run {parent_id} has already settled ({parent.status})"
        if parent.in_place or not parent.branch:
            reason = "the parent has no branch yet"
            await self._note(parent.id, "note", f"dispatch refused — {reason}")
            return None, reason
        project = get_project(self.db, parent.project_id)
        if project is None:
            return None, "project is gone"
        in_flight = count_in_flight_children(self.db, parent.id)
        refusal = in_flight_refusal(in_flight)
        if refusal:
            await self._note(parent.id, "note", f"dispatch refused — {refusal}")
            return None, refusal
        children = list_children(self.db, parent.id)
        budget, reason = carve_child_budget(
            parent.budget_usd,
            parent.cost_usd,
            [BudgetChild(child.status, child.cost_usd, child.budget_usd) for child in children],
            order.max_cost,
        )
        if reason:
            await self._note(parent.id, "note", f"dispatch refused — {reason}")
            return None, reason
        objective = order.objective.strip()
        if not objective:
            return None, "objective is empty"
        envelope = child_task_envelope(order, parent.id, parent.branch)
        workflow = nested or Workflow(
            name="(planned)",
            description="",
            source="built-in",
            steps=(Step(id="task", name=title_from(objective), prompt="{{task}}"),),
        )
        child = Run(
            id=uuid.uuid4().hex,
            project_id=parent.project_id,
            title=order.title.strip() or title_from(objective),
            task=envelope,
            workflow=workflow.name,
            status="queued",
            runner=parent.runner,
            created_at=stamp(),
            workflow_def=workflow.to_json(),
            autonomous=True,
            model=parent.model,
            parent_id=parent.id,
            root_id=parent.root_id or parent.id,
            budget_usd=budget,
            base_branch=parent.branch,
            kind=order.kind or "implement",
            # A nested workflow's parent awaits the child in its node; a report would
            # requeue a parent that already settled on the child's failure.
            reported=nested is not None,
        )
        await self.enqueue(child)
        await self._note(parent.id, "note", f'dispatched "{child.title}" ({child.id})')
        return child.id, None

    async def record_report(self, run_id: str, report: dict[str, object]) -> str | None:
        """The `cez task report` body. A settled child keeps this instead of a generic note."""
        if not self.config.dispatch_enabled:
            return "dispatch is disabled on this cockpit (CEZ_DISPATCH=0)"
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if not run.parent_id:
            return "run is not part of a dispatch tree"
        status = report.get("status")
        result = report.get("result")
        if status not in ("done", "partial", "failed", "blocked"):
            return "status must be done, partial, failed, or blocked"
        if not isinstance(result, str) or not result.strip() or len(result) > 4000:
            return "result is required"
        verdict = report.get("verdict")
        if verdict is not None and verdict not in ("approve", "changes", "reject"):
            return "verdict must be approve, changes, or reject"
        stored: dict[str, object] = {"status": status, "result": result.strip()}
        if isinstance(verdict, str):
            stored["verdict"] = verdict
        entry: dict[str, object] = {
            "title": run.title,
            "text": result.strip(),
            "status": status,
            "from_id": run.id,
            "at": stamp(),
        }
        await self.db.write(_persist_explicit_report, run.id, run.parent_id, entry, stored)
        self.publish()
        return None

    async def _report_child(self, run_id: str) -> None:
        run = get_run(self.db, run_id)
        if run is None or not run.parent_id or run.reported or run.status not in TERMINAL:
            return
        text, mapped = child_report_text(
            title=run.title,
            run_id=run.id,
            status=run.status,
            branch=run.branch,
            base_branch=run.base_branch,
            error=run.error,
            cost_usd=run.cost_usd,
        )
        entry: dict[str, object] = {
            "title": run.title,
            "text": text,
            "status": mapped,
            "from_id": run.id,
            "at": stamp(),
        }
        await self.db.write(_persist_report, run.id, run.parent_id, entry)
        self.publish()
        await self._deliver_report(run.parent_id, run.id, text)

    async def _ensure_boot_project(self) -> None:
        root = str(self.config.repo_root)
        existing = find_project_by_root(self.db, root)
        if existing is not None:
            self.boot_project_id = existing.id
            return
        taken = {project.id for project in list_projects(self.db)}
        branch = (
            head_branch(self.config.repo_root) if is_git_repo(self.config.repo_root) else "main"
        )
        project = Project(
            id=slug_for(self.config.repo_root.name, taken),
            name=self.config.repo_root.name,
            root=root,
            base_branch=branch,
            created_at=stamp(),
        )
        await self.db.write(insert_project, project)
        self.boot_project_id = project.id

    async def add_project(self, path: Path) -> tuple[Project | None, str | None]:
        if single_project():
            return None, "single-project mode is enabled; adding projects is disabled"
        root = path.expanduser().resolve()
        if not root.is_dir():
            return None, "that path is not a directory"
        if root == Path.home().resolve():
            return None, "refusing to register the home directory"
        existing = find_project_by_root(self.db, str(root))
        if existing is not None:
            return None, "that directory is already a project"
        taken = {project.id for project in list_projects(self.db)}
        branch = head_branch(root) if is_git_repo(root) else "main"
        project = Project(
            id=slug_for(root.name, taken),
            name=root.name,
            root=str(root),
            base_branch=branch,
            created_at=stamp(),
        )
        await self.db.write(insert_project, project)
        self.publish()
        return project, None

    async def set_base_branch(self, project_id: str, branch: str) -> str | None:
        from app.engine.gitwork import is_safe_git_ref

        if not is_safe_git_ref(branch) or len(branch) > 200 or any(ch.isspace() for ch in branch):
            return "base branch must be a plain git ref"
        project = get_project(self.db, project_id)
        if project is None:
            return "not found"
        await self.db.write(save_project, replace(project, base_branch=branch))
        self.publish()
        return None

    async def save_workspace(self, settings: Settings) -> None:
        from app.store.db import save_settings

        await self.db.write(save_settings, settings)
        self.publish()

    async def create_automation(self, item: Automation) -> None:
        from app.store.db import insert_automation

        await self.db.write(insert_automation, item)
        self.publish()

    async def set_automation_enabled(self, automation_id: str, enabled: bool) -> str | None:
        item = await self._automation(automation_id)
        if item is None:
            return "not found"
        moment = now()
        nxt = item.next_at
        due = parse_stamp(item.next_at)
        if enabled and (due is None or due < moment):
            nxt = after(item.every_minutes, moment)
        await self.db.write(save_automation, replace(item, enabled=enabled, next_at=nxt))
        if enabled and not item.enabled and item.kind != "schedule":
            await self.poller.baseline(item)
        self.publish()
        return None

    async def run_automation_now(self, automation_id: str) -> tuple[str | None, str | None]:
        item = await self._automation(automation_id)
        if item is None:
            return None, "not found"
        run_id = await self._spawn_automation(item, move_schedule=False)
        if run_id is None:
            return None, "could not start a run"
        return run_id, None

    async def remove_automation(self, automation_id: str) -> str | None:
        from app.store.db import delete_automation

        if await self._automation(automation_id) is None:
            return "not found"
        await self.db.write(delete_automation, automation_id)
        self.publish()
        return None

    async def _automation(self, automation_id: str) -> Automation | None:
        from app.store.db import get_automation

        return get_automation(self.db, automation_id)

    async def save_automation_edit(self, before: Automation, after_edit: Automation) -> None:
        """Save an edit. A changed trigger starts its cursor over, so old items never fire."""
        await self.db.write(save_automation, after_edit)
        changed = (before.kind, before.events, before.filters) != (
            after_edit.kind,
            after_edit.events,
            after_edit.filters,
        )
        if changed and after_edit.kind != "schedule":
            await self.poller.baseline(after_edit)
        self.publish()

    async def check_automation(self, item: Automation, execute: bool) -> dict[str, object]:
        """Poll a GitHub or tracker automation now. A preview launches nothing."""
        return await self.poller.check(item, "execute" if execute else "preview")

    async def retry_automation_log(
        self, automation_id: str, entry_id: str
    ) -> tuple[dict[str, object] | None, str | None, int]:
        return await self.poller.retry(automation_id, entry_id)

    async def _launch_due(self) -> None:
        """Only a `schedule` row fires on time. `github` and `tracker` rows wait for a match."""
        moment = now()
        for item in list_enabled_automations(self.db):
            if item.kind not in ("", "schedule"):
                continue
            due = parse_stamp(item.next_at)
            if due is not None and due <= moment:
                await self._spawn_automation(item, move_schedule=True)

    async def _spawn_automation(self, item: Automation, *, move_schedule: bool) -> str | None:
        project = get_project(self.db, item.project_id)
        if project is None:
            return None
        settings = get_settings(self.db)
        run, _error = self.plan_run(
            project=project,
            task=item.task,
            workflow_name=item.workflow,
            runner=item.runner or settings.default_runner,
            autonomous=True,
        )
        if run is None:
            return None
        await self.enqueue(run)
        updated = replace(item, last_run_id=run.id)
        if move_schedule:
            if item.once:
                updated = replace(updated, enabled=False)
            else:
                updated = replace(updated, next_at=after(item.every_minutes))
        await self.db.write(save_automation, updated)
        await self.poller.record_run(item, run.id, "schedule" if move_schedule else "manual")
        return run.id


def rebaseline_automations(tx: Tx) -> None:
    """An idle schedule does not launch a backlog when it wakes."""
    from app.store.db import IdData, _automation

    moment = now()
    rows = tx.query("SELECT id, data FROM automations WHERE enabled = 1", IdData)
    for row in rows:
        item = _automation(row)
        due = parse_stamp(item.next_at)
        if due is None:
            continue
        from datetime import timedelta

        if due < moment - timedelta(minutes=item.every_minutes):
            save_automation(tx, replace(item, next_at=after(item.every_minutes, moment)))
            if item.kind != "schedule":
                polling.reset_state(tx, item.id)
                polling.clear_seen(tx, item.id)


def _if_port(run: Run, node: dict[str, Any], outputs: dict[str, dict[str, str]]) -> str:
    raw_condition = node.get("condition")
    condition = raw_condition if isinstance(raw_condition, dict) else {}
    kind = condition.get("kind")
    if kind == "output":
        ref = str(condition.get("ref", ""))
        node_id, _, field_name = ref.partition(".")
        actual = outputs.get(node_id, {}).get(field_name)
        ok = compare_values(actual, str(condition.get("op", "equals")), condition.get("value"))
        return "true" if ok else "false"
    if kind == "branch":
        return "true" if run.base_branch == condition.get("value") else "false"
    return "false"


def _persist_explicit_report(
    tx: Tx,
    child_id: str,
    parent_id: str,
    entry: dict[str, object],
    report: dict[str, object],
) -> None:
    child = get_run_tx(tx, child_id)
    if child is None:
        return
    child.reported = True
    child.dispatch_report = report
    save_run(tx, child)
    parent = get_run_tx(tx, parent_id)
    if parent is None:
        return
    parent.pending_reports = append_report(parent.pending_reports, entry)
    save_run(tx, parent)


def _persist_report(tx: Tx, child_id: str, parent_id: str, entry: dict[str, object]) -> None:
    child = get_run_tx(tx, child_id)
    if child is None or child.reported or child.status not in TERMINAL:
        return
    child.reported = True
    save_run(tx, child)
    parent = get_run_tx(tx, parent_id)
    if parent is None:
        return
    parent.pending_reports = append_report(parent.pending_reports, entry)
    save_run(tx, parent)
    add_event(tx, parent.id, "note", str(entry.get("text", "")), "", stamp())


async def run_shell(
    command: str,
    cwd: Path,
    cancel: asyncio.Event,
    timeout: float,
    env: dict[str, str] | None = None,
    on_pid: Callable[[int], None] | None = None,
) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        "bash",
        "-lc",
        command,
        cwd=cwd,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    if on_pid is not None and proc.pid:
        on_pid(proc.pid)
    communicate = asyncio.create_task(proc.communicate())
    stopper = asyncio.create_task(cancel.wait())
    timer = asyncio.create_task(asyncio.sleep(timeout))
    done, pending = await asyncio.wait(
        {communicate, stopper, timer},
        return_when=asyncio.FIRST_COMPLETED,
    )
    if communicate not in done:
        proc.kill()
        await proc.wait()
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending)
    if communicate not in done:
        if cancel.is_set():
            return -1, "cancelled"
        return 124, "check timed out"
    out, _err = communicate.result()
    text = out.decode(errors="replace")
    if len(text) > 16_000:
        text = text[:16_000] + "\n… truncated\n"
    code = proc.returncode if proc.returncode is not None else 1
    return code, text
