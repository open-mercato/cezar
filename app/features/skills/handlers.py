import asyncio
import uuid
from dataclasses import dataclass, replace
from pathlib import Path

from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE

from app.common.live import read_form, read_tab, stream
from app.common.shell import load_chrome
from app.config import Config
from app.engine.engine import CHANGED, Engine
from app.engine.skills import load_skills, valid_skill_name, write_skill
from app.engine.team_skills import list_team_skills, refresh_team_skills
from app.features.skills.urls import SKILLS, SKILLS_CREATE, SKILLS_LIVE, SKILLS_REFRESH, SkillsView
from app.features.skills.views import render
from app.store.db import get_project


@dataclass(frozen=True, slots=True)
class SkillsPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(SKILLS, self.show)
        app.add(SKILLS_LIVE, self.live)
        app.add(SKILLS_CREATE, self.create)
        app.add(SKILLS_REFRESH, self.refresh)

    def _view(self, query: object) -> SkillsView:
        view = SkillsView.from_query(query)  # type: ignore[arg-type]
        if not view.project:
            view = replace(view, project=self.engine.boot_project_id)
        return view

    async def show(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        w.html(self._render(view, uuid.uuid7().hex))

    async def live(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        await stream(c, w, self.relay, lambda tab: self._render(view, tab))

    async def create(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        signals, tab = await read_form(c, w)
        if signals is None:
            return
        name = str(signals.get("name", "")).strip()
        description = str(signals.get("description", "")).strip()
        body = str(signals.get("body", "")).strip()
        if not valid_skill_name(name):
            w.text("name must be letters, digits, or hyphens", 400)
            return
        if not body or len(body) > 20_000 or len(description) > 200:
            w.text("body must be 1 to 20000 characters", 400)
            return
        project = get_project(self.db, view.project)
        if project is None:
            w.text("unknown project", 400)
            return
        SSE(w).patch_signals({"name": "", "description": "", "body": "", "_error": ""})
        write_skill(Path(project.root), name, description, body)
        self.relay.publish(CHANGED, {})

    async def refresh(self, c: Context, w: Writer) -> None:
        if await read_tab(c, w) is None:
            return
        w.empty()
        await asyncio.to_thread(refresh_team_skills, self.config.data_dir)
        self.relay.publish(CHANGED, {})

    def _render(self, view: SkillsView, tab: str):
        project = get_project(self.db, view.project)
        skills = load_skills(Path(project.root)) if project else []
        names = {skill.name for skill in skills}
        for skill in list_team_skills(self.config.data_dir):
            if skill.name not in names:
                skills.append(skill)
        return render(
            skills,
            view,
            load_chrome(self.db, self.config, "Skills", "skills", view.project),
            tab,
        )
