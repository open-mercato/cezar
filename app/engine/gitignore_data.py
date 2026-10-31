"""`.ai/cezar/.gitignore` — run data stays out of the repo; workflows and skills stay in.

The entry list matches `packages/cezar/src/data-gitignore.ts`. Append missing lines;
leave anything the user added.
"""

from __future__ import annotations

from pathlib import Path

DATA_GITIGNORE_ENTRIES: tuple[str, ...] = (
    "runs.json",
    "runs.json.tmp",
    "runs/",
    "webhooks/",
    "dispatch/",
    "attachments/",
    "worktrees/",
    "lifecycle/",
    "config.lifecycle.lock/",
    "config.json.*.tmp",
    "tmp/",
    "drafts/",
    "layouts/",
    "todos.json",
    "todos.json.tmp",
    "mcp.local.json",
    "mcp.local.json.cez-tmp-*",
    "tracker.json",
    "tracker.json.tmp",
    "tracker.json.*.tmp",
    "tracker-association.lock/",
    "launch-key",
    "automations.json",
    "automations.json.tmp",
    "automation-state.json",
    "automation-state.json.tmp",
    "automation-receipts.ndjson",
    "automation-receipts.ndjson.tmp",
    "automation-log.ndjson",
    "automation-log.ndjson.tmp",
    "automation-poll.lock",
    "automation-poll.lock.guard/",
    "automation-mutation.lock.guard/",
    "automation-mutation.lock",
)


def ensure_data_gitignore(repo: Path) -> None:
    directory = repo / ".ai" / "cezar"
    path = directory / ".gitignore"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        lines = current.split("\n")
        missing = [entry for entry in DATA_GITIGNORE_ENTRIES if entry not in lines]
        if not missing:
            return
        glue = "\n" if current and not current.endswith("\n") else ""
        path.write_text(current + glue + "\n".join(missing) + "\n", encoding="utf-8")
    except OSError:
        return
