import uuid
from dataclasses import dataclass

from litewriter import LiteWriter
from stario import App, Context, Relay, Writer

from app.common.live import read_form, stream
from app.common.shell import load_chrome
from app.config import RUNNERS, Config
from app.engine.engine import Engine
from app.engine.model import Settings
from app.features.settings.urls import SETTINGS, SETTINGS_LIVE, SETTINGS_SAVE
from app.features.settings.views import render
from app.features.settings.workspace import WorkspaceSettings
from app.store.db import get_settings


@dataclass(frozen=True, slots=True)
class SettingsPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(SETTINGS, self.show)
        app.add(SETTINGS_LIVE, self.live)
        app.add(SETTINGS_SAVE, self.save)
        WorkspaceSettings(self.db, self.engine, self.config).register(app)

    async def show(self, c: Context, w: Writer) -> None:
        w.html(self._render(uuid.uuid7().hex))

    async def live(self, c: Context, w: Writer) -> None:
        await stream(c, w, self.relay, self._render)

    async def save(self, c: Context, w: Writer) -> None:
        signals, _tab = await read_form(c, w)
        if signals is None:
            return
        raw = signals.get("max_parallel")
        if isinstance(raw, str) and raw.isdecimal():
            raw = int(raw)
        if isinstance(raw, bool) or not isinstance(raw, int) or not 1 <= raw <= 16:
            w.text("tasks at once must be from 1 to 16", 400)
            return
        runner = str(signals.get("default_runner", "claude"))
        theme = str(signals.get("theme", "dark"))
        accent = str(signals.get("accent", "lime"))
        if (
            runner not in RUNNERS
            or theme not in ("dark", "light")
            or accent not in ("lime", "violet")
        ):
            w.text("unknown setting", 400)
            return
        w.empty()
        await self.engine.save_workspace(Settings(raw, runner, theme, accent))

    def _render(self, tab: str):
        return render(
            get_settings(self.db),
            load_chrome(self.db, self.config, "Settings", "settings", self.engine.boot_project_id),
            tab,
        )
