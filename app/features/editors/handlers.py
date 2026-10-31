"""Settings editors that were still missing: instructions, agent config, accounts,
notifications, keyboard, bookmarklets, and integrations.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from litewriter import LiteWriter
from stario import App, Context, Writer, h
from stario.datastar import at, data, read_signals
from stario.exceptions import RequestBodyError

from app.common.shell import frame, load_chrome
from app.config import Config
from app.engine.engine import Engine
from app.engine.ui_state import merge_state, read_state
from app.features.editors import store
from app.features.editors.urls import (
    AGENT_CONFIG,
    AGENT_CONFIG_ONE,
    AGENT_CONFIG_SAVE,
    BOOKMARKLETS,
    INSTRUCTIONS,
    INSTRUCTIONS_SAVE,
    INTEGRATIONS,
    INTEGRATIONS_QUEUE,
    KEYBOARD,
    KEYBOARD_SAVE,
    NOTIFICATIONS,
    NOTIFICATIONS_SAVE,
)
from app.features.settings.nav import settings_nav
from app.secrets.store import SecretsError, SecretStore
from app.store.db import get_project


class EditorsPage:
    def __init__(self, db: LiteWriter, engine: Engine, config: Config) -> None:
        self.db = db
        self.engine = engine
        self.config = config

    def register(self, app: App) -> None:
        app.add(INSTRUCTIONS, self.instructions)
        app.add(INSTRUCTIONS_SAVE, self.save_instructions)
        app.add(AGENT_CONFIG, self.agent_config)
        app.add(AGENT_CONFIG_ONE, self.agent_file)
        app.add(AGENT_CONFIG_SAVE, self.save_agent_file)
        app.add(NOTIFICATIONS, self.notifications)
        app.add(NOTIFICATIONS_SAVE, self.save_notifications)
        app.add(KEYBOARD, self.keyboard)
        app.add(KEYBOARD_SAVE, self.save_keyboard)
        app.add(BOOKMARKLETS, self.bookmarklets)
        app.add(INTEGRATIONS, self.integrations)
        app.add(INTEGRATIONS_QUEUE, self.queue_integration)

    async def instructions(self, _c: Context, w: Writer) -> None:
        current = store.read_instructions(self._root())
        w.html(
            self._doc(
                "Instructions",
                "instructions",
                current["systemPrompt"],
                current["branchNaming"],
            )
        )

    async def save_instructions(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        reason = store.write_instructions(
            self._root(),
            str(signals.get("systemPrompt", "")),
            str(signals.get("branchNaming", "")),
        )
        if reason:
            w.text(reason, 400)
            return
        w.redirect(INSTRUCTIONS.href(), 303)

    async def agent_config(self, _c: Context, w: Writer) -> None:
        items = [
            h.Li(h.A({"href": AGENT_CONFIG_ONE.href(file_id)}, label))
            for file_id, label in store.CATALOG.items()
        ]
        w.html(self._main("Agent config", "agent-config", h.Ul(*items)))

    async def agent_file(self, c: Context, w: Writer) -> None:
        found = store.read_agent_file(self._root(), c.match.params.get("file_id", ""))
        if found is None:
            w.text("unknown config file", 404)
            return
        relative, text = found
        w.html(
            self._main(
                "Agent config",
                "agent-config",
                h.Form(
                    {"id": "agent-file-form"},
                    data.on(
                        "submit",
                        at.post(AGENT_CONFIG_SAVE.href(c.match.params.get("file_id", ""))),
                        prevent=True,
                    ),
                    h.Label(
                        {"class": "field"},
                        h.Span(relative),
                        h.Textarea({"id": "agent-file-input"}, data.bind("text"), text),
                    ),
                    h.Button({"type": "submit"}, "Save"),
                ),
                signals={"text": text},
            )
        )

    async def save_agent_file(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        reason = store.write_agent_file(
            self._root(),
            c.match.params.get("file_id", ""),
            str(signals.get("text", "")),
            hosted=self.config.hosted,
        )
        if reason == "agent config writes are local-only":
            w.text(reason, 409)
            return
        if reason:
            w.text(reason, 404)
            return
        w.redirect(AGENT_CONFIG.href(), 303)

    async def notifications(self, _c: Context, w: Writer) -> None:
        state = read_state(self._ui())
        notes = state.get("notifications")
        enabled = isinstance(notes, dict) and notes.get("browser") is True
        text = "Browser notifications are on." if enabled else "Browser notifications are off."
        w.html(self._main("Notifications", "notifications", h.P({"id": "notify"}, text)))

    async def save_notifications(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        merge_state(self._ui(), {"notifications": {"browser": signals.get("browser") is True}})
        w.redirect(NOTIFICATIONS.href(), 303)

    async def keyboard(self, _c: Context, w: Writer) -> None:
        state = read_state(self._ui())
        shortcut = "mod+enter"
        keyboard = state.get("keyboard")
        if isinstance(keyboard, dict) and keyboard.get("submit") in store.SHORTCUTS:
            shortcut = str(keyboard["submit"])
        w.html(self._main("Keyboard", "keyboard", h.P({"id": "shortcut"}, shortcut)))

    async def save_keyboard(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        shortcut = str(signals.get("submit", ""))
        if shortcut not in store.SHORTCUTS:
            w.text("unknown shortcut", 400)
            return
        merge_state(self._ui(), {"keyboard": {"submit": shortcut}})
        w.redirect(KEYBOARD.href(), 303)

    async def bookmarklets(self, _c: Context, w: Writer) -> None:
        key = self._launch_key()
        href = f"javascript:void(window.open('/tasks/new?launch={key}'))"
        w.html(
            self._main(
                "Bookmarklets",
                "bookmarklets",
                h.A({"id": "bookmarklet", "href": href}, "New task"),
            )
        )

    async def integrations(self, _c: Context, w: Writer) -> None:
        w.html(
            self._main(
                "External integrations",
                "integrations",
                h.P("Test frameworks. Queuing setup starts a task you review before it lands."),
                h.A({"href": "https://github.com/tester-army/e2e"}, "Tester Army"),
                h.Form(
                    data.on("submit", at.post(INTEGRATIONS_QUEUE.href()), prevent=True),
                    h.Label(
                        {"class": "field"},
                        h.Span("Model key (optional, checks only)"),
                        h.Input(
                            {
                                "type": "password",
                                "minlength": "12",
                                "autocomplete": "off",
                                "aria-label": "Model key",
                            },
                            data.bind("credential"),
                        ),
                    ),
                    h.Button({"class": "btn btn-primary", "type": "submit"}, "Set up e2e"),
                ),
                signals={"credential": ""},
            )
        )

    async def queue_integration(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        project = get_project(self.db, self.engine.boot_project_id)
        if project is None:
            w.text("unknown project", 404)
            return
        key = str(signals.get("credential", "")).strip()
        if key:
            if len(key) < 12:
                w.text("a model key is at least 12 characters", 400)
                return
            try:
                SecretStore(self.config.data_dir / "secrets").set(
                    project.id, "AI_GATEWAY_API_KEY", key, root=project.root
                )
            except SecretsError as exc:
                w.text(str(exc), 400)
                return
        run, reason = self.engine.plan_run(
            project=project,
            task="Set up the e2e test framework (Tester Army).",
            workflow_name="quick-task",
            runner="claude",
        )
        if run is None:
            w.text(reason or "could not start", 400)
            return
        run.title = "Tester Army"
        await self.engine.enqueue(run)
        _write_e2e_scaffold(self._root())
        w.redirect(f"/tasks/{run.id}", 303)

    def _root(self) -> Path:
        project = get_project(self.db, self.engine.boot_project_id)
        return Path(project.root) if project else self.config.repo_root

    def _ui(self) -> Path:
        return self._root() / ".ai" / "cezar" / "ui-state.json"

    def _launch_key(self) -> str:
        return store.launch_key(self.config.data_dir)

    def _doc(self, title: str, element_id: str, prompt: str, naming: str):
        return self._main(
            title,
            element_id,
            h.Form(
                {"id": "instructions-form"},
                data.on("submit", at.post(INSTRUCTIONS_SAVE.href()), prevent=True),
                h.Label(
                    {"class": "field"},
                    h.Span("System prompt"),
                    h.Textarea({"id": "system-prompt-input"}, data.bind("systemPrompt")),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Branch naming"),
                    h.Input({"id": "branch-naming-input"}, data.bind("branchNaming")),
                ),
                h.Button({"type": "submit"}, "Save"),
            ),
            h.P({"id": "system-prompt"}, prompt),
            h.P({"id": "branch-naming"}, naming),
            signals={"systemPrompt": prompt, "branchNaming": naming},
        )

    def _main(self, title: str, element_id: str, *children, signals: dict | None = None):
        chrome = load_chrome(self.db, self.config, title, "settings", self.engine.boot_project_id)
        payload = {"tab": uuid.uuid7().hex}
        if signals:
            payload.update(signals)
        return frame(
            chrome,
            None,
            payload,
            h.Main({"id": element_id}, settings_nav(), h.H1(title), *children),
        )


_E2E_CONFIG = """\
export default {
  app: {
    url: 'http://127.0.0.1:0',
    command: {
      executable: 'npm',
      args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '{port}'],
      env: { PORT: '{port}' },
    },
  },
}
"""

_E2E_WORKFLOW = """\
name: implement-and-e2e
description: Implement, unit-test, then prove it in a real browser (set up by cezar).
steps:
  - id: implement
    name: Implement
    prompt: |
      {{task}}
  - id: browser
    name: Browser e2e
    command: "npm run test:e2e"
"""


def _write_e2e_scaffold(root: Path) -> None:
    """The files `e2e init` would leave. Skip a file that is already there."""
    config = root / "e2e.config.ts"
    if not config.exists():
        config.write_text(_E2E_CONFIG, encoding="utf-8")
    workflow = root / ".ai" / "cezar" / "workflows" / "implement-and-e2e.yaml"
    if not workflow.exists():
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text(_E2E_WORKFLOW, encoding="utf-8")


async def _signals(c: Context, w: Writer) -> dict[str, object] | None:
    try:
        loaded = await read_signals(c.req)
    except RequestBodyError:
        w.text("invalid input", 400)
        return None
    if not isinstance(loaded, dict):
        w.text("invalid input", 400)
        return None
    return loaded
