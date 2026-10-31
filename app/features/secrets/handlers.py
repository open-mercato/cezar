import uuid
from dataclasses import dataclass

from litewriter import LiteWriter
from stario import App, Context, Writer
from stario.datastar import SSE, read_signals
from stario.exceptions import RequestBodyError

from app.common.shell import load_chrome
from app.config import Config
from app.engine.engine import Engine
from app.features.secrets.urls import SECRETS, SECRETS_SAVE
from app.features.secrets.views import render
from app.secrets.store import SecretsError, SecretStore
from app.store.db import get_project


@dataclass(frozen=True, slots=True)
class SecretsPage:
    db: LiteWriter
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(SECRETS, self.show)
        app.add(SECRETS_SAVE, self.save)

    async def show(self, c: Context, w: Writer) -> None:
        w.html(self._page(uuid.uuid7().hex, ""))

    async def save(self, c: Context, w: Writer) -> None:
        try:
            signals = await read_signals(c.req)
        except RequestBodyError:
            w.text("invalid input", 400)
            return
        tab = str(signals.get("tab", ""))
        name = str(signals.get("name", "")).strip()
        value = str(signals.get("value", ""))
        if not (tab.isalnum() and len(tab) <= 32):
            w.text("tab must be a short id", 400)
            return
        project = get_project(self.db, self.engine.boot_project_id)
        if project is None:
            w.text("unknown project", 400)
            return
        store = SecretStore(self.config.data_dir / "secrets")
        try:
            store.set(project.id, name, value, root=project.root)
        except SecretsError as exc:
            SSE(w).patch_signals({"_error": str(exc)})
            return
        SSE(w).patch_signals({"name": "", "value": "", "_error": ""})
        SSE(w).patch_elements(self._page(tab, ""))

    def _page(self, tab: str, error: str):
        project = get_project(self.db, self.engine.boot_project_id)
        root = project.root if project else ""
        rows, _skipped = SecretStore(self.config.data_dir / "secrets").list(
            project.id if project else "", root=root
        )
        chrome = load_chrome(
            self.db, self.config, "Secrets", "secrets", self.engine.boot_project_id
        )
        return render(rows, chrome, tab, error)
