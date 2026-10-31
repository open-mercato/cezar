import asyncio
import uuid
from dataclasses import dataclass
from pathlib import Path

from litewriter import LiteWriter
from stario import App, Context, Writer

from app.common.shell import load_chrome
from app.config import Config
from app.engine.engine import Engine
from app.engine.gitwork import git
from app.engine.repo_read import commit_text
from app.features.commit import views
from app.features.commit.urls import REPO_COMMIT, TASK_COMMIT_DETAIL, valid_sha
from app.features.places.urls import REPO
from app.features.task.urls import TASK
from app.store.db import get_project, get_run


@dataclass(frozen=True, slots=True)
class CommitPages:
    """A commit's stat and patch, from the repository or from one task's worktree.

    `git show` runs on the server, so there is no live stream.
    """

    db: LiteWriter
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(REPO_COMMIT, self.repo_commit)
        app.add(TASK_COMMIT_DETAIL, self.task_commit)

    async def repo_commit(self, c: Context, w: Writer) -> None:
        sha = c.match.params.get("sha", "")
        project = get_project(self.db, self.engine.boot_project_id)
        root = Path(project.root) if project else self.config.repo_root
        await self._show(w, root, sha, REPO.href(query={"pane": "commits"}), "Repository", "git")

    async def task_commit(self, c: Context, w: Writer) -> None:
        sha = c.match.params.get("sha", "")
        run_id = c.match.params.get("run_id", "")
        run = get_run(self.db, run_id) if _run_id(run_id) else None
        back = TASK.href(run_id, query={"pane": "commits"}) if run else REPO.href()
        if run is None or not run.worktree_path:
            w.html(
                views.missing(
                    sha,
                    "That task has no worktree.",
                    back,
                    "Task",
                    self._chrome("Commit", "tasks"),
                    uuid.uuid7().hex,
                ),
                404,
            )
            return
        await self._show(w, Path(run.worktree_path), sha, back, "Task commits", "tasks")

    async def _show(
        self, w: Writer, root: Path, sha: str, back: str, back_label: str, section: str
    ) -> None:
        chrome = self._chrome("Commit", section)
        tab = uuid.uuid7().hex
        if not valid_sha(sha):
            w.html(
                views.missing(sha, "That is not a commit hash.", back, back_label, chrome, tab), 400
            )
            return
        known, _out, _err = await asyncio.to_thread(
            git, root, ["cat-file", "-e", f"{sha}^{{commit}}"]
        )
        if not known:
            w.html(
                views.missing(
                    sha, "That commit is not in this repository.", back, back_label, chrome, tab
                ),
                404,
            )
            return
        text = await asyncio.to_thread(commit_text, root, sha)
        w.html(views.detail(sha, text, back, back_label, chrome, tab))

    def _chrome(self, title: str, section: str):
        return load_chrome(self.db, self.config, title, section, self.engine.boot_project_id)


def _run_id(value: str) -> bool:
    return len(value) == 32 and all(ch in "0123456789abcdef" for ch in value)
