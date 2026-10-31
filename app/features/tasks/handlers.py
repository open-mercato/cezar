import uuid
from dataclasses import dataclass, replace

from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE, read_signals
from stario.exceptions import RequestBodyError

from app.common.live import stream
from app.common.shell import load_chrome
from app.config import RUNNERS, Config
from app.engine.catalog import load_workflows
from app.engine.engine import Engine
from app.engine.model import Workflow
from app.engine.skills import load_skills
from app.engine.workflows import skills_to_steps
from app.features.places.urls import COMPARE
from app.features.settings.store import (
    read_composer_defaults,
    read_skill_defaults,
)
from app.features.task.urls import TASK
from app.features.tasks.urls import (
    HOME,
    TASKS,
    TASKS_ARCHIVE,
    TASKS_CREATE,
    TASKS_LIVE,
    TASKS_NEW,
    TASKS_READ,
    TasksView,
)
from app.features.tasks.views import render_list, render_new
from app.store.db import get_project, get_settings, list_runs


@dataclass(frozen=True, slots=True)
class TasksPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(HOME, self.home)
        app.add(TASKS, self.show)
        app.add(TASKS_LIVE, self.live)
        app.add(TASKS_NEW, self.new)
        app.add(TASKS_CREATE, self.create)
        app.add(TASKS_ARCHIVE, self.archive_finished)
        app.add(TASKS_READ, self.mark_read)

    def _view(self, query: object) -> TasksView:
        view = TasksView.from_query(query)  # type: ignore[arg-type]
        if not view.project:
            view = replace(view, project=self.engine.boot_project_id)
        return view

    async def home(self, c: Context, w: Writer) -> None:
        w.redirect(
            TASKS.href(query={"project": self.engine.boot_project_id, "status": "all"}),
            303,
        )

    async def show(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        w.html(render_list(self._runs(view), view, self._chrome(view.project), uuid.uuid7().hex))

    async def new(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        project = get_project(self.db, view.project)
        workflows = load_workflows(project_root(project))[0] if project else []
        settings = get_settings(self.db)
        launch = c.req.query.get("launch", "")
        if launch:
            from app.features.editors.store import launch_key

            if launch != launch_key(self.config.data_dir):
                w.text("unknown launch key", 403)
                return
        chosen = c.req.query.get("workflow", "quick-task")
        names = [item.name for item in workflows]
        if chosen not in names:
            chosen = (
                "quick-task" if "quick-task" in names else (names[0] if names else "quick-task")
            )
        composer = read_composer_defaults(self.config.data_dir)
        autonomous = (
            composer.autonomous
            if composer.autonomous is not None
            else self.config.autonomous_default is True
        )
        worktree = (
            composer.worktree if composer.worktree is not None else self.config.worktree_default
        )
        default_skill, _ask = read_skill_defaults(self.config.data_dir, view.project)
        skills = tuple(skill.name for skill in load_skills(project_root(project)))
        w.html(
            render_new(
                workflows,
                view,
                self._chrome(view.project),
                uuid.uuid7().hex,
                settings.default_runner,
                chosen,
                launched=bool(launch),
                model=self.engine.default_model(settings.default_runner),
                autonomous=autonomous,
                worktree=worktree,
                skills=skills,
                default_skill=default_skill if default_skill in skills else "",
            )
        )

    async def live(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        await stream(
            c,
            w,
            self.relay,
            lambda tab: render_list(self._runs(view), view, self._chrome(view.project), tab),
        )

    async def create(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        try:
            signals = await read_signals(c.req)
        except RequestBodyError:
            w.text("invalid input", 400)
            return
        tab = str(signals.get("tab", ""))
        task = str(signals.get("task", "")).strip()
        workflow = str(signals.get("workflow", "quick-task")).strip()
        runner = str(signals.get("runner", "")).strip()
        model = str(signals.get("model", "")).strip()
        autonomous = signals.get("autonomous") is True
        worktree = signals.get("worktree") is not False
        skill = str(signals.get("skill", "")).strip()
        if not (tab.isalnum() and len(tab) <= 32):
            w.text("tab must be a short id", 400)
            return
        if not task or len(task) > 20_000:
            w.text("task must be 1 to 20000 characters", 400)
            return
        if runner not in RUNNERS:
            w.text("unknown runner", 400)
            return
        if len(model) > 120:
            w.text("model is too long", 400)
            return
        locked = self.engine.model_lock_error(model)
        if locked:
            w.text(locked, 409)
            return
        count = _variant_count(signals.get("variants", 1))
        if isinstance(count, str):
            w.text(count, 400)
            return
        project = get_project(self.db, view.project)
        if project is None:
            w.text("unknown project", 400)
            return
        chosen, skill_reason = self._skill_workflow(project, view.project, task, workflow, skill)
        if skill_reason:
            w.text(skill_reason, 400)
            return
        made, reason = self.engine.plan_variants(
            count,
            project=project,
            task=task,
            workflow_name=workflow,
            runner=runner,
            model=model,
            autonomous=autonomous,
            workflow=chosen,
            in_place=not worktree,
        )
        if not made:
            self.relay.publish(f"tab.{tab}", {"_error": reason or "could not start"})
            SSE(w).patch_signals({"_error": reason or "could not start"})
            return
        for item in made:
            await self.engine.enqueue(item)
        run = made[0]
        target = COMPARE.href(run.id) if count > 1 else TASK.href(run.id)
        SSE(w).navigate(target)

    def _skill_workflow(
        self, project: object, project_id: str, task: str, workflow: str, skill: str
    ) -> tuple[Workflow | None, str]:
        """A one-skill workflow for the pick, or for the project's `defaultSkill`.

        The default applies only while the workflow stays `quick-task` and the skill is left on
        Default. `askSkill` is stored and editable but nothing reads it: it belongs to an Ask
        mode this port does not have, and the text of a task never selects it.
        """
        names = {item.name for item in load_skills(project_root(project))}
        if skill == "none":
            return None, ""
        if skill:
            if skill not in names:
                return None, f"unknown skill: {skill}"
            wanted = skill
        elif workflow != "quick-task":
            return None, ""
        else:
            wanted, _ask = read_skill_defaults(self.config.data_dir, project_id)
            if wanted not in names:
                return None, ""
        return (
            Workflow(
                name=wanted,
                description=f"Skill {wanted}",
                steps=skills_to_steps([wanted]),
                source="skill",
            ),
            "",
        )

    async def archive_finished(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        await self.engine.archive_finished(view.project)
        w.empty()

    async def mark_read(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        await self.engine.mark_all_read(view.project)
        w.empty()

    def _runs(self, view: TasksView) -> list:
        project = view.project or None
        status = None if view.status in ("all", "archived") else view.status
        rows = list_runs(self.db, project, status)
        if view.status == "archived":
            return [run for run in rows if run.archived]
        if view.status == "all":
            return [run for run in rows if not run.archived]
        return rows

    def _chrome(self, project_id: str):
        return load_chrome(self.db, self.config, "Tasks", "tasks", project_id)


def _variant_count(raw: object) -> int | str:
    if raw in (None, ""):
        return 1
    if isinstance(raw, str) and raw.isdecimal():
        raw = int(raw)
    if isinstance(raw, bool) or not isinstance(raw, int) or not 1 <= raw <= 3:
        return "variants must be 1, 2, or 3"
    return raw


def project_root(project: object):
    from pathlib import Path

    root = getattr(project, "root", "")
    return Path(root) if root else Path(".")
