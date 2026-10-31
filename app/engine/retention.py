"""Which finished worktrees and settled runs to drop.

Worktree retention keeps the newest finished directories and removes the rest.
The branch stays, so the work can be checked out again. `keep <= 0` reclaims
nothing. The index cap matches `CEZ_RUNS_KEEP`: live runs count toward the
window and are never deleted. Defaults are 10 worktrees and 300 runs.
"""

from __future__ import annotations

from app.engine.model import Run

_FINISHED = frozenset({"done", "failed", "cancelled"})
_LIVE = frozenset({"queued", "running", "waiting"})
DEFAULT_RUNS_KEEP = 300
DEFAULT_ARCHIVED_KEEP = 500


def select_reclaimable(runs: list[Run], keep: int) -> list[str]:
    if keep <= 0:
        return []
    reclaimable = [
        run
        for run in runs
        if run.status in _FINISHED and run.worktree_path and not run.worktree_reclaimed_at
    ]
    reclaimable.sort(key=lambda run: run.finished_at or run.created_at, reverse=True)
    return [run.id for run in reclaimable[keep:]]


def select_index_prune(
    runs: list[Run],
    *,
    keep: int = DEFAULT_RUNS_KEEP,
    archived_keep: int = DEFAULT_ARCHIVED_KEEP,
) -> list[str]:
    """Ids past the cap. `runs` must be newest first. Live rows are kept."""
    if keep < 1:
        keep = 1
    if archived_keep < 1:
        archived_keep = 1
    pinned = {run.id for run in runs if run.status in _LIVE}
    pinned.update(run.parent_id for run in runs if run.status in _LIVE and run.parent_id)
    pinned.update(run.root_id for run in runs if run.status in _LIVE and run.root_id)
    active = [run for run in runs if not run.archived]
    archived = [run for run in runs if run.archived]
    stale = active[keep:] + archived[archived_keep:]
    return [run.id for run in stale if run.id not in pinned]
