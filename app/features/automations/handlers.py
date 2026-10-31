import asyncio
import uuid
from dataclasses import dataclass, replace
from pathlib import Path

from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE

from app.clock import after, stamp
from app.common.live import read_form, read_tab, stream
from app.common.shell import load_chrome
from app.config import Config
from app.engine.catalog import load_workflows
from app.engine.engine import Engine
from app.engine.model import Automation
from app.features.automations.data import parse_form, signals_for
from app.features.automations.forms import (
    render_detail,
    render_log,
    render_log_entries,
    render_new,
    render_summary,
)
from app.features.automations.urls import (
    AUTOMATION,
    AUTOMATION_CHECK,
    AUTOMATION_LIVE,
    AUTOMATION_LOG,
    AUTOMATION_LOG_LIVE,
    AUTOMATION_RETRY,
    AUTOMATION_UPDATE,
    AUTOMATIONS,
    AUTOMATIONS_CREATE,
    AUTOMATIONS_DELETE,
    AUTOMATIONS_ENABLE,
    AUTOMATIONS_LIVE,
    AUTOMATIONS_NEW,
    AUTOMATIONS_PAUSE,
    AUTOMATIONS_RUN,
    AutomationsView,
    LogView,
)
from app.features.automations.views import render
from app.integrations.tracker import automation_options
from app.store import polling
from app.store.db import (
    IdData,
    automation_from_row,
    get_automation,
    get_project,
    get_settings,
    list_automations,
)


@dataclass(frozen=True, slots=True)
class AutomationsPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(AUTOMATIONS, self.show)
        app.add(AUTOMATIONS_LIVE, self.live)
        app.add(AUTOMATIONS_NEW, self.new)
        app.add(AUTOMATIONS_CREATE, self.create)
        app.add(AUTOMATION, self.detail)
        app.add(AUTOMATION_LIVE, self.detail_live)
        app.add(AUTOMATION_UPDATE, self.update)
        app.add(AUTOMATION_LOG, self.log)
        app.add(AUTOMATION_LOG_LIVE, self.log_live)
        app.add(AUTOMATION_CHECK, self.check)
        app.add(AUTOMATION_RETRY, self.retry)
        app.add(AUTOMATIONS_ENABLE, self.enable)
        app.add(AUTOMATIONS_PAUSE, self.pause)
        app.add(AUTOMATIONS_RUN, self.run)
        app.add(AUTOMATIONS_DELETE, self.delete)

    def _view(self, query: object) -> AutomationsView:
        view = AutomationsView.from_query(query)  # type: ignore[arg-type]
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
        if signals is None or tab is None:
            return
        project = get_project(self.db, view.project)
        if project is None:
            w.text("unknown project", 400)
            return
        form, reason = parse_form(signals, project, get_settings(self.db).default_runner)
        if form is None:
            w.text(reason, 400)
            return
        item = Automation(
            id=uuid.uuid4().hex,
            project_id=project.id,
            name=form.name,
            task=form.task,
            workflow=form.workflow,
            runner=form.runner,
            every_minutes=form.every,
            enabled=False,
            next_at=after(form.every),
            created_at=stamp(),
            kind=form.kind,
            events=form.events,
            filters=form.filters,
        )
        sse = SSE(w)
        sse.patch_signals({"name": "", "task": "", "_error": ""})
        await self.engine.create_automation(item)
        if c.req.query.get("then") == "detail":
            sse.navigate(AUTOMATION.href(item.id))

    async def new(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        project = get_project(self.db, view.project)
        if project is None:
            w.text("unknown project", 404)
            return
        workflows = load_workflows(Path(project.root))[0]
        options = await asyncio.to_thread(automation_options, self.config, Path(project.root))
        w.html(
            render_new(
                load_chrome(self.db, self.config, "New automation", "automations", view.project),
                view,
                signals_for(None),
                workflows,
                options,
                uuid.uuid7().hex,
            )
        )

    async def detail(self, c: Context, w: Writer) -> None:
        item = self._known(c, w)
        if item is None:
            return
        project = get_project(self.db, item.project_id)
        root = Path(project.root) if project else self.config.repo_root
        workflows = load_workflows(root)[0]
        options = await asyncio.to_thread(automation_options, self.config, root)
        view = AutomationsView(item.project_id)
        w.html(
            render_detail(
                load_chrome(self.db, self.config, item.name, "automations", item.project_id),
                view,
                item,
                signals_for(item),
                workflows,
                options,
                uuid.uuid7().hex,
            )
        )

    async def detail_live(self, c: Context, w: Writer) -> None:
        automation_id = c.match.params["automation_id"]
        if not _valid_id(automation_id):
            w.text("not found", 404)
            return
        tab = await read_tab(c, w)
        if tab is None:
            return
        sse = SSE(w)
        sql = "SELECT id, data FROM automations WHERE id = :id"
        async with self.db.watch(sql, IdData, id=automation_id) as rows:
            async for found in c.alive(rows):
                if not found:
                    sse.navigate(AUTOMATIONS.href())
                    return
                sse.patch_elements(render_summary(automation_from_row(found[0])))

    async def update(self, c: Context, w: Writer) -> None:
        automation_id, tab = await _id(c, w)
        if automation_id is None or tab is None:
            return
        signals, _tab_id = await read_form(c, w)
        item = get_automation(self.db, automation_id)
        if item is None or signals is None:
            w.text("not found", 404)
            return
        project = get_project(self.db, item.project_id)
        if project is None:
            w.text("unknown project", 400)
            return
        form, reason = parse_form(signals, project, item.runner)
        if form is None:
            w.text(reason, 400)
            return
        edited = replace(
            item,
            name=form.name,
            task=form.task,
            workflow=form.workflow,
            runner=form.runner,
            every_minutes=form.every,
            kind=form.kind,
            events=form.events,
            filters=form.filters,
            revision=item.revision + 1,
        )
        SSE(w).patch_signals({"_error": ""})
        await self.engine.save_automation_edit(item, edited)

    async def log(self, c: Context, w: Writer) -> None:
        item = self._known(c, w)
        if item is None:
            return
        log_view = LogView.from_query(c.req.query)
        w.html(self._render_log(item, log_view, uuid.uuid7().hex))

    async def log_live(self, c: Context, w: Writer) -> None:
        item = self._known(c, w)
        if item is None:
            return
        tab = await read_tab(c, w)
        if tab is None:
            return
        log_view = LogView.from_query(c.req.query)
        sse = SSE(w)
        sql = (
            "SELECT id, data FROM automation_log WHERE automation_id = :a"
            " ORDER BY at DESC LIMIT 100"
        )
        async with self.db.watch(sql, polling.IdData, a=item.id) as rows:
            async for found in c.alive(rows):
                entries = [e for row in found if (e := polling.get_log(self.db, row.id))]
                sse.patch_elements(render_log_entries(item.id, entries, log_view))

    async def check(self, c: Context, w: Writer) -> None:
        automation_id, tab = await _id(c, w)
        if automation_id is None or tab is None:
            return
        item = get_automation(self.db, automation_id)
        if item is None:
            w.text("not found", 404)
            return
        mode = c.req.query.get("mode", "preview")
        if mode not in ("preview", "execute"):
            w.text("mode must be preview or execute", 400)
            return
        if item.kind == "schedule":
            w.text("a schedule has no event filter; use run now", 409)
            return
        w.empty()

        async def job() -> None:
            await self.engine.check_automation(item, mode == "execute")

        self.engine._schedule(job(), name=f"check-{item.id[:8]}")

    async def retry(self, c: Context, w: Writer) -> None:
        automation_id, tab = await _id(c, w)
        if automation_id is None or tab is None:
            return
        entry_id = c.match.params["entry_id"]
        if not _valid_id(entry_id):
            w.text("not found", 404)
            return
        _entry, reason, status = await self.engine.retry_automation_log(automation_id, entry_id)
        if reason:
            w.text(reason, status)
            return
        w.empty()

    def _known(self, c: Context, w: Writer):
        automation_id = c.match.params["automation_id"]
        item = get_automation(self.db, automation_id) if _valid_id(automation_id) else None
        if item is None:
            w.text("not found", 404)
        return item

    def _render_log(self, item: Automation, log_view: LogView, tab: str):
        entries = polling.list_log(self.db, item.id, 100)
        return render_log(
            load_chrome(self.db, self.config, "Execution log", "automations", item.project_id),
            item,
            entries,
            log_view,
            tab,
        )

    async def enable(self, c: Context, w: Writer) -> None:
        await self._toggle(c, w, True)

    async def pause(self, c: Context, w: Writer) -> None:
        await self._toggle(c, w, False)

    async def _toggle(self, c: Context, w: Writer, enabled: bool) -> None:
        automation_id, tab = await _id(c, w)
        if automation_id is None or tab is None:
            return
        reason = await self.engine.set_automation_enabled(automation_id, enabled)
        if reason:
            w.text(reason, 404)
            return
        w.empty()

    async def run(self, c: Context, w: Writer) -> None:
        automation_id, tab = await _id(c, w)
        if automation_id is None:
            return
        _run_id, reason = await self.engine.run_automation_now(automation_id)
        if reason:
            w.text(reason, 404)
            return
        w.empty()

    async def delete(self, c: Context, w: Writer) -> None:
        automation_id, _tab = await _id(c, w)
        if automation_id is None:
            return
        reason = await self.engine.remove_automation(automation_id)
        if reason:
            w.text(reason, 404)
            return
        w.empty()

    def _render(self, view: AutomationsView, tab: str):
        project = get_project(self.db, view.project)
        workflows = load_workflows(Path(project.root))[0] if project else []
        items = list_automations(self.db, view.project or None)
        return render(
            items,
            workflows,
            view,
            load_chrome(self.db, self.config, "Automations", "automations", view.project),
            tab,
        )


async def _id(c: Context, w: Writer):
    _signals, tab = await read_form(c, w)
    automation_id = c.match.params["automation_id"]
    if tab is None:
        return None, None
    if not _valid_id(automation_id):
        w.text("not found", 404)
        return None, None
    return automation_id, tab


def _valid_id(value: str) -> bool:
    return len(value) == 32 and value.isalnum()
