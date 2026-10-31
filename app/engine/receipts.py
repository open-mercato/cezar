"""Archive sweep and read receipts.

The rules match `RunStore.archiveFinished` and `markAllRead`: a waiting question
is not an outcome, cancelled runs are never unread, and a failed run that still
has an auto-resume or an open question is not an unread result.
"""

from __future__ import annotations

from app.engine.model import Run

_ARCHIVE = frozenset({"done", "failed", "cancelled"})


def archive_finished(runs: list[Run], at: str) -> list[Run]:
    changed: list[Run] = []
    for run in runs:
        if run.archived or run.status not in _ARCHIVE or run.awaiting_answer_since:
            continue
        run.archived = True
        run.archived_at = at
        run.pinned = False
        run.pinned_at = ""
        run.auto_resume_at = ""
        run.awaiting_answer_since = ""
        changed.append(run)
    return changed


def is_unread(run: Run) -> bool:
    if run.archived or run.status not in ("done", "failed") or not run.finished_at:
        return False
    if run.status == "failed" and (run.auto_resume_at or run.awaiting_answer_since):
        return False
    return not run.seen_at or run.seen_at < run.finished_at


def mark_all_read(runs: list[Run], at: str) -> list[Run]:
    changed: list[Run] = []
    for run in runs:
        if not is_unread(run):
            continue
        run.seen_at = at
        changed.append(run)
    return changed
