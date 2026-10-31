import asyncio
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from litewriter import LiteWriter
from stario import App, Context, Writer

from app.common.shell import load_chrome
from app.config import Config
from app.engine.engine import Engine
from app.features.github import views
from app.features.github.urls import GITHUB_ISSUE, GITHUB_PR, GITHUB_PRS, PrView
from app.integrations.github_read import (
    PrNotFound,
    github_comments,
    github_item,
    github_overview,
    github_pr_changes,
)
from app.store.db import get_project

_MAX_NUMBER = 10_000_000


@dataclass(frozen=True, slots=True)
class GithubPages:
    """Pull request list, pull request detail (with a changes pane), and issue detail.

    Every read calls `gh`, so each page is rendered on the server and has no live stream.
    """

    db: LiteWriter
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(GITHUB_PRS, self.prs)
        app.add(GITHUB_PR, self.pr)
        app.add(GITHUB_ISSUE, self.issue)

    async def prs(self, _c: Context, w: Writer) -> None:
        loaded = await asyncio.to_thread(github_overview, self._cwd(), dry_run=self.config.dry_run)
        rows = loaded.get("prs")
        prs = [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
        notice = "" if loaded.get("available") is True else str(loaded.get("reason", "unavailable"))
        w.html(views.pr_list(prs, notice, self._chrome("Pull requests"), uuid.uuid7().hex))

    async def pr(self, c: Context, w: Writer) -> None:
        number = _number(c.match.params.get("number", ""))
        if number is None:
            w.text("pull request number must be a positive integer", 400)
            return
        view = PrView.from_query(c.req.query)
        cwd = self._cwd()
        dry = self.config.dry_run
        found = await asyncio.to_thread(github_item, cwd, "pr", number, dry_run=dry)
        if found.get("available") is not True:
            self._unavailable(w, f"Pull request #{number}", found)
            return
        item = _item(found)
        comments: dict[str, Any] = {}
        changes: dict[str, Any] | None = None
        if view.pane == "changes":
            try:
                changes = await asyncio.to_thread(github_pr_changes, cwd, number, dry_run=dry)
            except PrNotFound:
                self._unavailable(
                    w,
                    f"Pull request #{number}",
                    {"code": "not_found", "reason": f"pull request {number} was not found"},
                )
                return
        else:
            comments = await asyncio.to_thread(github_comments, "pr", number, dry_run=dry, cwd=cwd)
        w.html(
            views.pr(
                number,
                item,
                view,
                comments,
                changes,
                self._chrome(f"Pull request #{number}"),
                uuid.uuid7().hex,
            )
        )

    async def issue(self, c: Context, w: Writer) -> None:
        number = _number(c.match.params.get("number", ""))
        if number is None:
            w.text("issue number must be a positive integer", 400)
            return
        cwd = self._cwd()
        dry = self.config.dry_run
        found = await asyncio.to_thread(github_item, cwd, "issue", number, dry_run=dry)
        if found.get("available") is not True:
            self._unavailable(w, f"Issue #{number}", found)
            return
        comments = await asyncio.to_thread(github_comments, "issue", number, dry_run=dry, cwd=cwd)
        w.html(
            views.issue(
                number,
                _item(found),
                comments,
                self._chrome(f"Issue #{number}"),
                uuid.uuid7().hex,
            )
        )

    def _unavailable(self, w: Writer, title: str, found: dict[str, Any]) -> None:
        status = 404 if found.get("code") == "not_found" else 200
        reason = str(found.get("reason", "unavailable"))
        w.html(views.missing(title, reason, self._chrome(title), uuid.uuid7().hex), status)

    def _cwd(self) -> Path:
        project = get_project(self.db, self.engine.boot_project_id)
        return Path(project.root) if project else self.config.repo_root

    def _chrome(self, title: str):
        return load_chrome(self.db, self.config, title, "github", self.engine.boot_project_id)


def _number(raw: str) -> int | None:
    if raw.isascii() and raw.isdigit() and 0 < int(raw) <= _MAX_NUMBER:
        return int(raw)
    return None


def _item(found: dict[str, Any]) -> dict[str, Any]:
    item = found.get("item")
    return item if isinstance(item, dict) else {}
