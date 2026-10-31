import uuid
from dataclasses import dataclass
from pathlib import Path

import apsw
from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE

from app.common.live import read_form, stream
from app.common.shell import load_chrome
from app.config import Config
from app.engine.engine import CHANGED, Engine
from app.features.projects.urls import (
    PROJECTS,
    PROJECTS_ADD,
    PROJECTS_BASE,
    PROJECTS_LIVE,
    PROJECTS_REMOVE,
)
from app.features.projects.views import branch_signal, render
from app.store.db import list_projects


@dataclass(frozen=True, slots=True)
class ProjectsPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(PROJECTS, self.show)
        app.add(PROJECTS_LIVE, self.live)
        app.add(PROJECTS_ADD, self.add)
        app.add(PROJECTS_BASE, self.base)
        app.add(PROJECTS_REMOVE, self.remove)

    async def show(self, c: Context, w: Writer) -> None:
        w.html(self._render(uuid.uuid7().hex))

    async def live(self, c: Context, w: Writer) -> None:
        await stream(c, w, self.relay, self._render)

    async def add(self, c: Context, w: Writer) -> None:
        signals, tab = await read_form(c, w)
        if signals is None or tab is None:
            return
        raw = str(signals.get("path", "")).strip()
        if not raw or len(raw) > 500:
            w.text("path is required", 400)
            return
        try:
            project, reason = await self.engine.add_project(Path(raw))
        except apsw.ConstraintError:
            project, reason = None, "that directory is already a project"
        if project is None:
            self.relay.publish(f"tab.{tab}", {"_error": reason or "could not add"})
            SSE(w).patch_signals({"_error": reason or "could not add"})
            return
        SSE(w).patch_signals({"path": "", "_error": ""})

    async def base(self, c: Context, w: Writer) -> None:
        signals, tab = await read_form(c, w)
        if signals is None or tab is None:
            return
        project_id = c.match.params["project_id"]
        if not project_id.replace("-", "").isalnum():
            w.text("not found", 404)
            return
        branch = str(signals.get(branch_signal(project_id), "")).strip()
        reason = await self.engine.set_base_branch(project_id, branch)
        if reason == "not found":
            w.text(reason, 404)
            return
        if reason:
            self.relay.publish(f"tab.{tab}", {"_error": reason})
            SSE(w).patch_signals({"_error": reason})
            return
        SSE(w).patch_signals({"_error": ""})

    async def remove(self, c: Context, w: Writer) -> None:
        from app.store.db import delete_project, get_project

        project_id, tab = await _id(c, w)
        if project_id is None:
            return
        if get_project(self.db, project_id) is None:
            w.text("not found", 404)
            return
        w.empty()
        await self.db.write(delete_project, project_id)
        self.relay.publish(CHANGED, {})

    def _render(self, tab: str):
        return render(
            list_projects(self.db),
            load_chrome(self.db, self.config, "Projects", "projects", self.engine.boot_project_id),
            tab,
        )


async def _id(c: Context, w: Writer):
    _signals, tab = await read_form(c, w)
    project_id = c.match.params["project_id"]
    if tab is None:
        return None, None
    if not project_id.replace("-", "").isalnum():
        w.text("not found", 404)
        return None, None
    return project_id, tab
