"""`/settings/accounts`: the agent accounts, their login state, and which one a project uses.

Port of the capability in `workspace/agent-profiles.ts` and the `agent-profiles` family of
`server.ts`: login status and details come from the account's own files (no agent CLI is
spawned), and the per-project choice is a command that a run started later reads.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from litewriter import LiteWriter
from stario import App, Context, Writer, h
from stario.datastar import SSE, at, data, read_signals
from stario.exceptions import RequestBodyError
from stario.markup import HtmlElement

from app.common.shell import frame, load_chrome
from app.config import RUNNERS, Config, agent_accounts_enabled
from app.engine.engine import Engine
from app.engine.model import Project
from app.features.editors.urls import ACCOUNT_ONE, ACCOUNT_SELECT, ACCOUNTS, ACCOUNTS_SAVE
from app.features.settings.nav import settings_nav
from app.integrations.accounts import (
    account_details,
    account_state,
    add_account,
    get_account,
    list_accounts,
    read_selections,
    select_account,
)
from app.store.db import get_project, list_projects

CAPABLE = ("claude", "codex")
_TITLE = "Agent accounts"


@dataclass(frozen=True, slots=True)
class AccountsPage:
    db: LiteWriter
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(ACCOUNTS, self.show)
        app.add(ACCOUNTS_SAVE, self.save)
        app.add(ACCOUNT_ONE, self.one)
        app.add(ACCOUNT_SELECT, self.select)

    async def show(self, _c: Context, w: Writer) -> None:
        rows = list_accounts(self.config) if agent_accounts_enabled(self.config) else []
        items = []
        for row in rows:
            state = account_state(row)
            items.append(
                h.Li(
                    h.A({"href": ACCOUNT_ONE.href(row["id"])}, f"{row['name']} · {row['runner']}"),
                    " ",
                    h.Span({"class": "meta", "data-state": state.status}, state.status),
                )
            )
        if not items:
            items = [h.Li({"class": "muted"}, "No extra accounts.")]
        w.html(
            self._main(
                {"name": "", "runner": "claude", "account": ""},
                h.Form(
                    data.on("submit", at.post(ACCOUNTS_SAVE.href()), prevent=True),
                    h.Label(
                        {"class": "field"},
                        h.Span("Name"),
                        h.Input(
                            {"required": True, "maxlength": "80", "aria-label": "Name"},
                            data.bind("name"),
                        ),
                    ),
                    h.Label(
                        {"class": "field"},
                        h.Span("Runner"),
                        h.Select(
                            {"aria-label": "Runner"},
                            data.bind("runner"),
                            *[h.Option({"value": runner}, runner) for runner in RUNNERS],
                        ),
                    ),
                    h.Button({"class": "btn btn-primary", "type": "submit"}, "Add account"),
                ),
                h.Ul({"id": "account-list"}, *items),
                self._selection(),
            )
        )

    async def save(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        reason = add_account(
            self.config, str(signals.get("name", "")), str(signals.get("runner", "claude"))
        )
        if reason:
            status = 409 if reason.startswith("agent accounts are disabled") else 400
            w.text(reason, status)
            return
        w.redirect(ACCOUNTS.href(), 303)

    async def one(self, c: Context, w: Writer) -> None:
        row = get_account(self.config, c.match.params.get("account_id", ""))
        if row is None or not agent_accounts_enabled(self.config):
            w.html(self._main({}, h.P({"class": "sub"}, "That account does not exist.")), 404)
            return
        state = account_state(row)
        fields, reason = account_details(row)
        w.html(
            self._main(
                {},
                h.Nav({"class": "filters"}, h.A({"href": ACCOUNTS.href()}, "All accounts")),
                h.H2(f"{row['name']} · {row['runner']}"),
                h.Dl(
                    {"id": "account-state"},
                    h.Dt("Login"),
                    h.Dd(state.status),
                    h.Dt("Folder"),
                    h.Dd(row["home"] or "the agent's default"),
                    h.Dt("Folder exists"),
                    h.Dd("yes" if state.exists else "no"),
                    h.Dt("Looks like an agent folder"),
                    h.Dd("yes" if state.looks_valid else "no"),
                ),
                h.H3("Signed in as"),
                h.Dl({"id": "account-details"}, *[_pair(label, value) for label, value in fields])
                if fields
                else h.P({"class": "muted"}, reason),
            )
        )

    async def select(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        project_id = c.match.params.get("project_id", "")
        runner = c.match.params.get("runner", "")
        if runner not in CAPABLE:
            w.text(f"{runner or 'that runner'} cannot carry more than one account", 400)
            return
        if get_project(self.db, project_id) is None:
            w.text("unknown project", 404)
            return
        reason = select_account(self.config, project_id, runner, str(signals.get("account", "")))
        if reason:
            w.text(reason, 409 if reason.startswith("agent accounts are disabled") else 400)
            return
        SSE(w).patch_elements(self._selection())

    def _selection(self) -> HtmlElement:
        accounts = list_accounts(self.config) if agent_accounts_enabled(self.config) else []
        chosen = read_selections(self.config)
        sections: list[HtmlElement] = []
        for project in list_projects(self.db):
            for runner in CAPABLE:
                options = [row for row in accounts if row["runner"] == runner]
                if options:
                    sections.append(
                        _picker(
                            project, runner, options, chosen.get(project.id, {}).get(runner, "")
                        )
                    )
        return h.Section(
            {"id": "account-selection"},
            h.H2("Account per project"),
            h.P(
                {"class": "sub"},
                "A task started in a project uses the account chosen here when it names none.",
            ),
            *(
                sections
                or [h.P({"class": "muted"}, "Add a Claude or Codex account to choose one.")]
            ),
        )

    def _main(self, signals: dict, *children: HtmlElement) -> HtmlElement:
        chrome = load_chrome(self.db, self.config, _TITLE, "settings", self.engine.boot_project_id)
        return frame(
            chrome,
            None,
            {"tab": uuid.uuid7().hex, **signals},
            h.Main({"id": "accounts"}, settings_nav(), h.H1(_TITLE), *children),
        )


def _pair(label: str, value: str) -> HtmlElement:
    return h.Div(h.Dt(label), h.Dd(value))


def _picker(
    project: Project, runner: str, options: list[dict[str, str]], current: str
) -> HtmlElement:
    post = at.post(ACCOUNT_SELECT.href(project.id, runner))
    return h.Label(
        {"class": "field", "data-project": project.id, "data-runner": runner},
        h.Span(f"{project.name} · {runner}"),
        h.Select(
            {"aria-label": f"{project.name} {runner} account"},
            data.on("change", f"$account = evt.target.value; {post}"),
            h.Option({"value": "", "selected": not current}, "Default login"),
            *[
                h.Option({"value": row["id"], "selected": row["id"] == current}, row["name"])
                for row in options
            ],
        ),
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
    return loaded
