import asyncio
import uuid
from dataclasses import dataclass
from pathlib import Path

from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE, read_signals
from stario.exceptions import RequestBodyError

from app.common.live import stream
from app.common.shell import load_chrome
from app.config import Config, terminal_enabled
from app.engine.dispatch_logic import DispatchOrder
from app.engine.engine import Engine
from app.engine.gitwork import Diff, task_diff
from app.engine.model import Run
from app.features.task.urls import (
    TASK,
    TASK_APPROVE,
    TASK_CANCEL,
    TASK_COMMIT,
    TASK_DELETE,
    TASK_DISPATCH,
    TASK_FINISH,
    TASK_LIVE,
    TASK_MESSAGE,
    TASK_NOTES,
    TASK_PR,
    TASK_PR_ADOPT,
    TASK_PUSH,
    TASK_REJECT,
    TASK_REVIEW,
    TASK_SHELL,
    TaskView,
)
from app.features.task.views import render, render_missing
from app.features.tasks.urls import TASKS
from app.http.loopback import hosted_mode
from app.store.db import get_project, get_run, list_children, list_events


@dataclass(frozen=True, slots=True)
class TaskPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(TASK, self.show)
        app.add(TASK_LIVE, self.live)
        app.add(TASK_CANCEL, self.cancel)
        app.add(TASK_FINISH, self.finish)
        app.add(TASK_DELETE, self.delete)
        app.add(TASK_MESSAGE, self.message)
        app.add(TASK_APPROVE, self.approve)
        app.add(TASK_REJECT, self.reject)
        app.add(TASK_DISPATCH, self.dispatch)
        app.add(TASK_COMMIT, self.commit)
        app.add(TASK_PUSH, self.push)
        app.add(TASK_PR, self.draft_pr)
        app.add(TASK_PR_ADOPT, self.adopt_pr)
        app.add(TASK_REVIEW, self.review)
        app.add(TASK_NOTES, self.notes)
        app.add(TASK_SHELL, self.shell)

    async def show(self, c: Context, w: Writer) -> None:
        run_id = c.match.params["run_id"]
        if not _run_id(run_id):
            w.html(render_missing(self._chrome(""), uuid.uuid7().hex))
            return
        run = get_run(self.db, run_id)
        if run is None:
            w.html(render_missing(self._chrome(""), uuid.uuid7().hex))
            return
        view = TaskView.from_query(c.req.query)
        w.html(
            render(
                run,
                list_events(self.db, run.id),
                list_children(self.db, run.id),
                view,
                await self._diff(run, view),
                self._chrome(run.project_id),
                uuid.uuid7().hex,
                self._merge(run),
            )
        )

    async def live(self, c: Context, w: Writer) -> None:
        run_id = c.match.params["run_id"]
        if not _run_id(run_id):
            w.text("not found", 404)
            return
        view = TaskView.from_query(c.req.query)
        await stream(c, w, self.relay, lambda tab: self._picture(run_id, view, tab))

    async def cancel(self, c: Context, w: Writer) -> None:
        await self._command(c, w, self.engine.cancel)

    async def finish(self, c: Context, w: Writer) -> None:
        await self._command(c, w, self.engine.finish)

    async def delete(self, c: Context, w: Writer) -> None:
        run_id, tab, signals = await self._input(c, w)
        if run_id is None:
            return
        reason = await self.engine.delete(run_id)
        if reason:
            self._tell(w, tab or "", reason, 409 if reason != "not found" else 404)
            return
        SSE(w).navigate(TASKS.href())

    async def message(self, c: Context, w: Writer) -> None:
        run_id, tab, signals = await self._input(c, w)
        if run_id is None or signals is None or tab is None:
            return
        message = str(signals.get("message", "")).strip()
        reason = await self.engine.deliver(run_id, message)
        if reason:
            self._tell(w, tab, reason, 409 if reason != "not found" else 404)
            return
        SSE(w).patch_signals({"message": "", "_error": ""})

    async def approve(self, c: Context, w: Writer) -> None:
        await self._gate(c, w, "approve")

    async def reject(self, c: Context, w: Writer) -> None:
        await self._gate(c, w, "reject")

    async def _gate(self, c: Context, w: Writer, port: str) -> None:
        run_id, tab, signals = await self._input(c, w)
        if run_id is None or signals is None or tab is None:
            return
        comment = str(signals.get("message", "")).strip()
        reason = await self.engine.resolve_park(run_id, "gate.human", port, comment)
        if reason:
            self._tell(w, tab, reason, 409 if reason != "not found" else 404)
            return
        SSE(w).patch_signals({"message": "", "_error": ""})

    async def dispatch(self, c: Context, w: Writer) -> None:
        run_id, tab, signals = await self._input(c, w)
        if run_id is None or signals is None or tab is None:
            return
        objective = str(signals.get("objective", "")).strip()
        if not objective or len(objective) > 4_000:
            w.text("objective must be 1 to 4000 characters", 400)
            return
        child_id, reason = await self.engine.dispatch(run_id, DispatchOrder(objective=objective))
        if reason or child_id is None:
            self._tell(w, tab, reason or "refused", 409)
            return
        SSE(w).patch_signals({"objective": "", "_error": ""})

    async def commit(self, c: Context, w: Writer) -> None:
        run_id, tab, _signals = await self._input(c, w)
        if run_id is None or tab is None:
            return
        _result, reason = await self.engine.git_commit(run_id, "cezar")
        if reason:
            self._tell(w, tab, reason, 409)
            return
        w.empty()

    async def push(self, c: Context, w: Writer) -> None:
        run_id, tab, _signals = await self._input(c, w)
        if run_id is None or tab is None:
            return
        _result, reason = await self.engine.git_push(run_id)
        if reason:
            self._tell(w, tab, reason, 409)
            return
        w.empty()

    async def draft_pr(self, c: Context, w: Writer) -> None:
        run_id, tab, _signals = await self._input(c, w)
        if run_id is None or tab is None:
            return
        _result, reason = await self.engine.open_draft_pr(run_id)
        if reason:
            self._tell(w, tab, reason, 409)
            return
        w.empty()

    async def adopt_pr(self, c: Context, w: Writer) -> None:
        from app.integrations.pr_adopt import parse_pr_ref

        run_id, tab, signals = await self._input(c, w)
        if run_id is None or tab is None or signals is None:
            return
        ref = str(signals.get("adopt_pr", "")).strip()
        if len(ref) > 300 or (ref and parse_pr_ref(ref) is None):
            self._tell(w, tab, "enter a pull request number or URL", 400)
            return
        url, reason = await self.engine.adopt_pr(run_id, ref)
        if reason or url is None:
            self._tell(w, tab, reason or "refused", 404 if reason == "not found" else 409)
            return
        SSE(w).patch_signals({"adopt_pr": "", "_error": ""})

    async def review(self, c: Context, w: Writer) -> None:
        from app.integrations.github_review import review_pr

        run_id, tab, signals = await self._input(c, w)
        if run_id is None or tab is None or signals is None:
            return
        run = get_run(self.db, run_id)
        if run is None:
            self._tell(w, tab, "not found", 404)
            return
        number = _pull_number(run.pull_request_url)
        if number is None:
            self._tell(w, tab, "no pull request on this task", 409)
            return
        event = str(signals.get("review_event", "comment"))
        body = str(signals.get("review_body", ""))
        project = get_project(self.db, run.project_id)
        cwd = Path(project.root) if project else self.config.repo_root
        result = review_pr(number, event, body, dry_run=self.config.dry_run, cwd=cwd)
        if not result.get("ok"):
            self._tell(w, tab, str(result.get("error", "review failed")), 400)
            return
        self.relay.publish(f"tab.{tab}", {"_toast": "Review sent"})
        w.empty()

    async def notes(self, c: Context, w: Writer) -> None:
        run_id, tab, signals = await self._input(c, w)
        if run_id is None or tab is None or signals is None:
            return
        text = str(signals.get("notes", ""))
        if len(text) > 20_000:
            self._tell(w, tab, "notes are too long", 400)
            return
        reason = await self.engine.set_notes(run_id, text)
        if reason:
            self._tell(w, tab, reason, 404)
            return
        w.empty()

    async def shell(self, c: Context, w: Writer) -> None:
        run_id, tab, signals = await self._input(c, w)
        if run_id is None or tab is None or signals is None:
            return
        command = str(signals.get("command", "")).strip()
        if not command or len(command) > 400:
            self._tell(w, tab, "command must be 1 to 400 characters", 400)
            return
        if not terminal_enabled(hosted_mode(self.config)):
            self._tell(w, tab, "terminal is disabled", 409)
            return
        run = get_run(self.db, run_id)
        if run is None or not run.worktree_path:
            self._tell(w, tab, "no worktree", 409)
            return
        session_id = await self.engine._terminals.open(Path(run.worktree_path))
        try:
            await self.engine._terminals.write(session_id, command + "\n")
            text = ""
            marker = command.split()[0]
            seen = False
            for _ in range(40):
                text = self.engine._terminals.output(session_id) or ""
                if seen and marker in text:
                    break
                if marker in text and len(text) > len(command):
                    seen = True
                await asyncio.sleep(0.05)
        finally:
            await self.engine._terminals.close(session_id)
        SSE(w).patch_signals({"_shell": text[-2000:], "command": "", "_error": ""})

    async def _command(self, c: Context, w: Writer, fn) -> None:
        run_id, tab, _signals = await self._input(c, w)
        if run_id is None or tab is None:
            return
        reason = await fn(run_id)
        if reason:
            status = 404 if reason == "not found" else 409
            self._tell(w, tab, reason, status)
            return
        w.empty()

    async def _input(self, c: Context, w: Writer):
        run_id = c.match.params["run_id"]
        try:
            signals = await read_signals(c.req)
        except RequestBodyError:
            w.text("invalid input", 400)
            return None, None, None
        tab = str(signals.get("tab", ""))
        if not _run_id(run_id) or not (tab.isalnum() and len(tab) <= 32):
            w.text("tab must be a short id", 400)
            return None, None, None
        return run_id, tab, signals

    def _tell(self, w: Writer, tab: str, reason: str, status: int) -> None:
        if tab:
            self.relay.publish(f"tab.{tab}", {"_error": reason})
        w.text(reason, status)

    async def _picture(self, run_id: str, view: TaskView, tab: str):
        run = get_run(self.db, run_id)
        if run is None:
            return render_missing(self._chrome(""), tab)
        return render(
            run,
            list_events(self.db, run.id),
            list_children(self.db, run.id),
            view,
            await self._diff(run, view),
            self._chrome(run.project_id),
            tab,
            self._merge(run),
        )

    async def _diff(self, run, view: TaskView) -> Diff | None:
        if view.pane != "diff" or not run.worktree_path or not run.base_sha or run.in_place:
            if view.pane == "diff" and run.in_place:
                return Diff("This run was not given a worktree.", 0, 0, 0, False)
            return None
        return await asyncio.to_thread(
            task_diff,
            Path(run.worktree_path),
            base_branch=run.base_branch,
            task_branch=run.branch,
            started_at=run.started_at,
            fallback_sha=run.base_sha,
        )

    def _chrome(self, project_id: str):
        return load_chrome(self.db, self.config, "Task", "tasks", project_id)

    def _merge(self, run: Run) -> dict[str, object] | None:
        from app.integrations.github_review import merge_state

        number = _pull_number(run.pull_request_url)
        if number is None:
            return None
        project = get_project(self.db, run.project_id)
        cwd = Path(project.root) if project else self.config.repo_root
        return merge_state(number, dry_run=self.config.dry_run, cwd=cwd)


def _pull_number(url: str) -> int | None:
    piece = url.rstrip("/").rsplit("/", 1)[-1]
    if piece.isdigit() and int(piece) > 0:
        return int(piece)
    return None


def _run_id(value: str) -> bool:
    return len(value) == 32 and all(ch in "0123456789abcdef" for ch in value)
