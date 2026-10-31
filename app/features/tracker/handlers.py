import asyncio
import uuid
from dataclasses import dataclass, replace
from pathlib import Path

from litewriter import LiteWriter
from stario import App, Context, Writer

from app.common.shell import load_chrome
from app.config import Config
from app.engine.engine import Engine
from app.features.settings.store import tracker_overrides
from app.features.tracker import views
from app.features.tracker.urls import TRACKER_ITEM
from app.integrations.tracker import list_issues
from app.store.db import get_project

_RESERVED = ("association", "candidates", "search", "connection", "watch")


@dataclass(frozen=True, slots=True)
class TrackerItemPage:
    """One issue of the project's tracker connection. Read from the tracker, so server-rendered."""

    db: LiteWriter
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(TRACKER_ITEM, self.show)

    async def show(self, c: Context, w: Writer) -> None:
        item_id = c.match.params.get("item_id", "")
        title = f"Tracker {item_id}"
        chrome = load_chrome(self.db, self.config, title, "tracker", self.engine.boot_project_id)
        tab = uuid.uuid7().hex
        if not item_id or len(item_id) > 120 or item_id in _RESERVED:
            w.html(views.missing(title, "That item is not in the tracker.", chrome, tab), 404)
            return
        project = get_project(self.db, self.engine.boot_project_id)
        root = Path(project.root) if project else self.config.repo_root
        cfg = replace(self.config, **tracker_overrides(self.config.data_dir))
        listed = await asyncio.to_thread(list_issues, cfg, root, state="all")
        if listed.get("available") is not True:
            reason = str(listed.get("reason", "the tracker is unavailable"))
            w.html(views.missing(title, reason, chrome, tab))
            return
        rows = listed.get("items")
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict) and row.get("id") == item_id:
                w.html(views.item(row, chrome, tab))
                return
        w.html(views.missing(title, "That item is not in the tracker.", chrome, tab), 404)
