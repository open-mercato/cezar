"""Settings pages that were still a heading: tasks, tracker, global instructions,
global skills, and resources.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass

from litewriter import LiteWriter
from stario import App, Context, Writer, h
from stario.datastar import read_signals
from stario.datastar.format import SignalValue
from stario.exceptions import RequestBodyError
from stario.markup import HtmlElement

from app.common.shell import frame, load_chrome
from app.config import RUNNERS, Config
from app.engine.engine import Engine
from app.engine.providers import provider_status
from app.features.places.urls import SETTINGS_AGENTS
from app.features.settings import workspace_views as views
from app.features.settings.nav import settings_nav
from app.features.settings.store import (
    ComposerDefaults,
    parse_agent_defaults,
    parse_checks,
    parse_memory,
    parse_prompt,
    parse_skill_defaults,
    parse_skill_repo,
    parse_tracker,
    parse_tri,
    read_agent_defaults,
    read_checks,
    read_composer_defaults,
    read_memory,
    read_prompt,
    read_skill_defaults,
    read_skill_repos,
    read_tracker,
    tri_word,
    write_agent_defaults,
    write_checks,
    write_composer_defaults,
    write_memory,
    write_prompt,
    write_skill_defaults,
    write_skill_repos,
    write_tracker,
)
from app.features.settings.urls import (
    AGENTS_SAVE,
    GLOBAL_INSTRUCTIONS,
    GLOBAL_INSTRUCTIONS_SAVE,
    GLOBAL_SKILLS,
    GLOBAL_SKILLS_REMOVE,
    GLOBAL_SKILLS_SAVE,
    RESOURCES,
    RESOURCES_SAVE,
    TASKS_SETTINGS,
    TASKS_SETTINGS_SAVE,
    TRACKER_SETTINGS,
    TRACKER_SETTINGS_SAVE,
)
from app.store.db import get_project


@dataclass(frozen=True, slots=True)
class WorkspaceSettings:
    db: LiteWriter
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(SETTINGS_AGENTS, self.agents)
        app.add(AGENTS_SAVE, self.save_agents)
        app.add(TASKS_SETTINGS, self.tasks)
        app.add(TASKS_SETTINGS_SAVE, self.save_tasks)
        app.add(TRACKER_SETTINGS, self.tracker)
        app.add(TRACKER_SETTINGS_SAVE, self.save_tracker)
        app.add(GLOBAL_INSTRUCTIONS, self.instructions)
        app.add(GLOBAL_INSTRUCTIONS_SAVE, self.save_instructions)
        app.add(GLOBAL_SKILLS, self.skills)
        app.add(GLOBAL_SKILLS_SAVE, self.save_skill)
        app.add(GLOBAL_SKILLS_REMOVE, self.remove_skill)
        app.add(RESOURCES, self.resources)
        app.add(RESOURCES_SAVE, self.save_resources)

    async def agents(self, _c: Context, w: Writer) -> None:
        status = provider_status(self.config.runner_bins)
        providers = status.get("providers")
        lines = []
        if isinstance(providers, list):
            for item in providers:
                if isinstance(item, dict):
                    lines.append(
                        f"{item.get('provider')}: "
                        f"{'installed' if item.get('installed') else 'missing'}"
                    )
        defaults = read_agent_defaults(self.config.data_dir)
        signals: dict[str, SignalValue] = {
            "planner_model": defaults.planner_model,
            "namer_model": defaults.namer_model,
            "locked": defaults.locked,
        }
        for runner in RUNNERS:
            signals[f"model_{runner}"] = defaults.models.get(runner, "")
            signals[f"auto_{runner}"] = runner in defaults.auto
        w.html(self._page("Agents", "agents", signals, *views.agents(lines, defaults)))

    async def save_agents(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        value, issue = parse_agent_defaults(signals)
        if issue or value is None:
            w.text(issue or "invalid agent defaults", 400)
            return
        write_agent_defaults(self.config.data_dir, value)
        w.redirect(SETTINGS_AGENTS.href(), 303)

    async def tasks(self, _c: Context, w: Writer) -> None:
        project = get_project(self.db, self.engine.boot_project_id)
        branch = project.base_branch if project else "main"
        checks = read_checks(self.config.data_dir, self.engine.boot_project_id)
        composer = read_composer_defaults(self.config.data_dir)
        default_skill, ask_skill = read_skill_defaults(
            self.config.data_dir, self.engine.boot_project_id
        )
        w.html(
            self._page(
                "Tasks",
                "task-settings",
                {
                    "branch": branch,
                    "checks": ", ".join(checks),
                    "default_skill": default_skill,
                    "ask_skill": ask_skill,
                    "composer_autonomous": tri_word(composer.autonomous),
                    "composer_worktree": tri_word(composer.worktree),
                },
                *views.tasks(branch, checks, composer, default_skill, ask_skill),
            )
        )

    async def save_tasks(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        branch = str(signals.get("branch", "")).strip()
        checks, issue = parse_checks(str(signals.get("checks", "")))
        if issue or checks is None:
            w.text(issue or "invalid checks", 400)
            return
        skills, issue = parse_skill_defaults(
            str(signals.get("default_skill", "")), str(signals.get("ask_skill", ""))
        )
        if issue or skills is None:
            w.text(issue or "invalid skill", 400)
            return
        autonomous, issue = parse_tri(signals.get("composer_autonomous"))
        if issue:
            w.text(issue, 400)
            return
        worktree, issue = parse_tri(signals.get("composer_worktree"))
        if issue:
            w.text(issue, 400)
            return
        reason = await self.engine.set_base_branch(self.engine.boot_project_id, branch)
        if reason:
            w.text(reason, 404 if reason == "not found" else 400)
            return
        write_checks(self.config.data_dir, self.engine.boot_project_id, checks)
        write_skill_defaults(self.config.data_dir, self.engine.boot_project_id, *skills)
        write_composer_defaults(self.config.data_dir, ComposerDefaults(autonomous, worktree))
        w.redirect(TASKS_SETTINGS.href(), 303)

    async def tracker(self, _c: Context, w: Writer) -> None:
        row = read_tracker(self.config.data_dir)
        w.html(
            self._page(
                "Tracker",
                "tracker-settings",
                {"kind": row.kind, "site": row.site, "email": row.email, "token": ""},
                *views.tracker(row),
            )
        )

    async def save_tracker(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        previous = read_tracker(self.config.data_dir)
        row, issue = parse_tracker(
            str(signals.get("kind", "jira")),
            str(signals.get("site", "")),
            str(signals.get("email", "")),
            str(signals.get("token", "")),
            previous.token,
        )
        if issue or row is None:
            w.text(issue or "invalid tracker", 400)
            return
        write_tracker(self.config.data_dir, row)
        w.redirect(TRACKER_SETTINGS.href(), 303)

    async def instructions(self, _c: Context, w: Writer) -> None:
        prompt = read_prompt(self.config.data_dir)
        w.html(
            self._page(
                "Global instructions",
                "global-instructions",
                {"prompt": prompt},
                *views.instructions(prompt),
            )
        )

    async def save_instructions(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        prompt = str(signals.get("prompt", ""))
        issue = parse_prompt(prompt)
        if issue:
            w.text(issue, 400)
            return
        write_prompt(self.config.data_dir, prompt.strip())
        w.redirect(GLOBAL_INSTRUCTIONS.href(), 303)

    async def skills(self, _c: Context, w: Writer) -> None:
        rows = read_skill_repos(self.config.data_dir)
        w.html(
            self._page(
                "Skills",
                "global-skills",
                {"repo": "", "ref": "main"},
                *views.skills(rows),
            )
        )

    async def save_skill(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        row, issue = parse_skill_repo(str(signals.get("repo", "")), str(signals.get("ref", "")))
        if issue or row is None:
            w.text(issue or "invalid repo", 400)
            return
        rows = [item for item in read_skill_repos(self.config.data_dir) if item.repo != row.repo]
        rows.append(row)
        write_skill_repos(self.config.data_dir, rows)
        w.redirect(GLOBAL_SKILLS.href(), 303)

    async def remove_skill(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        repo = str(signals.get("repo", "")).strip()
        rows = [item for item in read_skill_repos(self.config.data_dir) if item.repo != repo]
        write_skill_repos(self.config.data_dir, rows)
        w.redirect(GLOBAL_SKILLS.href(), 303)

    async def resources(self, _c: Context, w: Writer) -> None:
        limit = read_memory(self.config.data_dir)
        w.html(
            self._page(
                "Resources",
                "resources",
                {"memory": "" if limit is None else str(limit)},
                *views.resources(limit),
            )
        )

    async def save_resources(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        limit, issue = parse_memory(signals.get("memory", ""))
        if issue:
            w.text(issue, 400)
            return
        write_memory(self.config.data_dir, limit)
        w.redirect(RESOURCES.href(), 303)

    def _page(
        self,
        title: str,
        element_id: str,
        signals: Mapping[str, SignalValue],
        *children: HtmlElement,
    ):
        chrome = load_chrome(self.db, self.config, title, "settings", self.engine.boot_project_id)
        payload: dict[str, SignalValue] = {"tab": uuid.uuid7().hex}
        payload.update(signals)
        return frame(
            chrome,
            None,
            payload,
            h.Main({"id": element_id}, settings_nav(), h.H1(title), *children),
        )


async def _signals(c: Context, w: Writer) -> dict[str, object] | None:
    try:
        loaded = await read_signals(c.req)
    except RequestBodyError:
        w.text("invalid input", 400)
        return None
    if not isinstance(loaded, dict):
        w.text("invalid input", 400)
        return None
    tab = str(loaded.get("tab", ""))
    if tab and not (tab.isalnum() and len(tab) <= 32):
        w.text("tab must be a short id", 400)
        return None
    return loaded
