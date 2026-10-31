"""Which ref anchors this task's diff.

The ordinary answer is `merge-base` of the freshest base ref and `HEAD`. The
freshest ref is `origin/<base>` when the local branch is behind it — agents
fetch, they never pull — and the local branch when it is equal or ahead. When
the two have diverged, the side the task actually forked from wins.

A worktree whose `HEAD` is no longer the task branch is measured against that
branch as the run first saw it (`<branch>@{<started at>}`), unless the
merge-base attributes fewer changed lines. Without a start time the anchor
stays `HEAD`, so the diff cannot claim commits that were already on the
branch. The helper never raises: a failing git call degrades to the base name.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from app.engine.git_remotes import remotes_from_config, split_remote_ref
from app.engine.gitwork import is_safe_git_ref

GitRun = Callable[[list[str]], tuple[bool, str]]

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
_PINNED = re.compile(r"^[0-9a-f]{7,64}$", re.IGNORECASE)
_STAT = re.compile(r"(\d+) (?:insertions?\(\+\)|deletions?\(-\))")


@dataclass(frozen=True, slots=True)
class RepointedHead:
    head_branch: str
    task_branch: str


@dataclass(frozen=True, slots=True)
class TaskDiffBase:
    base: str
    repointed_head: RepointedHead | None = None


def resolve_task_diff_base(
    run_git: GitRun,
    base_branch: str,
    *,
    task_branch: str = "",
    run_started_at: str = "",
) -> TaskDiffBase:
    base = freshest_base_ref(run_git, base_branch)

    def merge_base() -> str:
        ok, out = run_git(["merge-base", base, "HEAD"])
        pinned = out.strip() if ok else ""
        return pinned or base

    if not task_branch:
        return TaskDiffBase(merge_base())
    ok, out = run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    head = out.strip() if ok else ""
    if not head or head == task_branch:
        return TaskDiffBase(merge_base())
    repointed = RepointedHead(head, task_branch)
    baseline = _checkout_baseline(run_git, head, run_started_at)
    if baseline is None:
        return TaskDiffBase("HEAD", repointed)
    anchor = merge_base()
    via_baseline = _changed_lines(run_git, baseline)
    if via_baseline is None:
        return TaskDiffBase(anchor, repointed)
    via_merge = _changed_lines(run_git, anchor)
    if via_merge is None or via_baseline <= via_merge:
        return TaskDiffBase(baseline, repointed)
    return TaskDiffBase(anchor, repointed)


def freshest_base_ref(run_git: GitRun, base: str) -> str:
    if not is_safe_git_ref(base) or base == "HEAD":
        return base
    ok, out = run_git(["config", "--get-regexp", r"^remote\."])
    remotes = remotes_from_config(out if ok else "")
    remote_name, _branch = split_remote_ref(base, remotes.names)
    if remote_name:
        return base
    if _PINNED.fullmatch(base):
        return _freshest_pinned(run_git, base, remotes.base)
    if not remotes.base:
        return base
    remote = f"{remotes.base}/{base}"
    has_remote, _out = run_git(["rev-parse", "--verify", "--quiet", f"{remote}^{{commit}}"])
    if not has_remote:
        return base
    local_current, _out = run_git(["merge-base", "--is-ancestor", remote, base])
    if local_current:
        return base
    local_behind, _out = run_git(["merge-base", "--is-ancestor", base, remote])
    if local_behind:
        return remote
    ok_local, local_out = run_git(["merge-base", base, "HEAD"])
    ok_remote, remote_out = run_git(["merge-base", remote, "HEAD"])
    local = local_out.strip() if ok_local else ""
    upstream = remote_out.strip() if ok_remote else ""
    if not local or not upstream or local == upstream:
        return remote
    forked_local, _out = run_git(["merge-base", "--is-ancestor", upstream, local])
    return base if forked_local else remote


def _freshest_pinned(run_git: GitRun, base: str, base_remote: str | None) -> str:
    if not base_remote:
        return base
    ok, out = run_git(["symbolic-ref", "--quiet", "--short", f"refs/remotes/{base_remote}/HEAD"])
    remote = out.strip() if ok else ""
    if not remote.startswith(f"{base_remote}/") or not is_safe_git_ref(remote):
        return base
    contains, _out = run_git(["merge-base", "--is-ancestor", base, remote])
    return remote if contains else base


def _checkout_baseline(run_git: GitRun, head_branch: str, started_at: str) -> str | None:
    if not started_at or _ISO.fullmatch(started_at) is None:
        return None
    if head_branch == "HEAD" or not is_safe_git_ref(head_branch):
        return None
    ok, out = run_git(
        ["rev-parse", "--verify", "--quiet", f"{head_branch}@{{{started_at}}}^{{commit}}"]
    )
    sha = out.strip() if ok else ""
    return sha or None


def _changed_lines(run_git: GitRun, ref: str) -> int | None:
    ok, out = run_git(["diff", "--shortstat", ref])
    if not ok:
        return None
    return sum(int(match.group(1)) for match in _STAT.finditer(out))
