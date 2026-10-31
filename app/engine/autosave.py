"""Janitor commits on a task branch.

`periodic` is the opt-in timer (`CEZ_AUTOSAVE=1`). Turn end, run finalize, and
pre-PR always run, matching `autosaveCommit` in
`packages/cezar/src/git-worktree.ts`. A worktree that is mid-merge is left
dirty: committing it would record a conflict.

Signing follows the repo's git config. That function does not pass
`commit.gpgsign`. Tests set `commit.gpgsign false` on the repo they create.
"""

from __future__ import annotations

from pathlib import Path

from app.engine.gitwork import git

_UNMERGED = frozenset({"UU", "AA", "DD", "AU", "UA", "DU", "UD"})


def autosave_commit(cwd: Path, reason: str) -> str:
    """`committed`, `nothing`, `refused`, or `skipped` when git cannot run.

    Same identity rule as `autosaveCommit`: the current git user, or
    `cezar <cezar@local>` when `user.name` is unset. `--no-verify` matches
    that function.
    """
    # Same exclusion as in-place landing: `.ai/cezar` is cockpit state, not the task.
    spec = ["--", ".", ":(exclude).ai/cezar"]
    ok, status, _err = git(cwd, ["status", "--porcelain", *spec])
    if not ok:
        return "skipped"
    if not status.strip():
        return "nothing"
    for line in status.splitlines():
        if line[:2] in _UNMERGED:
            return "refused"
    git(cwd, ["add", "-A", *spec])
    args = ["commit", "--no-verify", "-m", f"cezar autosave ({reason})"]
    named, name, _err = git(cwd, ["config", "user.name"])
    if not named or not name.strip():
        args = ["-c", "user.name=cezar", "-c", "user.email=cezar@local", *args]
    ok, _out, err = git(cwd, args)
    if not ok:
        return "skipped"
    if "nothing" in err.lower():
        return "nothing"
    return "committed"
