"""Adopt an existing pull request onto a task.

`POST /api/v1/runs/:id/pr/adopt` in the TypeScript server looks up the open PR whose head is
the task's branch (`resolvePrTarget` + `findBranchPr` in `forge/github.ts`) and records its
URL. This port also takes a number or URL the user names, and holds it to the same checks: the
PR must be open, on the repository the task would open its PR on, and its head must be this
task's branch from the owner that pushed it. `CEZ_DRY_RUN=1` has no forge, so it stands in with
the demo PR `create_draft_pr` fakes.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.engine.git_actions import DRY_PR_URL
from app.engine.git_remotes import parse_remote, resolve_task_remotes, split_remote_ref
from app.engine.gitwork import git

_NUMBER = re.compile(r"^#?(\d{1,9})$")
_URL = re.compile(r"^https?://([^/\s]+)/([^/\s]+)/([^/\s]+)/pull/(\d{1,9})/?$", re.IGNORECASE)
_SHA_BASE = re.compile(r"^[0-9a-f]{7,40}$", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class PrTarget:
    """Where a PR from this task belongs, exactly what `gh pr create` is handed."""

    repo: str | None  # `host/owner/name`
    head: str  # the branch, `owner:branch` when it is pushed to a fork
    base: str | None


@dataclass(frozen=True, slots=True)
class PrRef:
    number: int
    repo: str | None  # `host/owner/name` when the user pasted a URL


def parse_pr_ref(text: str) -> PrRef | None:
    """A PR number (`12`, `#12`) or pull request URL. Anything else is None."""
    cleaned = text.strip()
    number = _NUMBER.match(cleaned)
    if number and int(number.group(1)) > 0:
        return PrRef(int(number.group(1)), None)
    url = _URL.match(cleaned)
    if url and int(url.group(4)) > 0:
        host, owner, name = url.group(1), url.group(2), url.group(3)
        return PrRef(int(url.group(4)), f"{host}/{owner}/{name}".lower())
    return None


def resolve_pr_target(worktree: Path, branch: str, base_branch: str) -> PrTarget | None:
    remotes = resolve_task_remotes(worktree)
    if not remotes.base or not remotes.push:
        return None

    def remote(name: str):
        ok, out, _err = git(worktree, ["remote", "get-url", name])
        return parse_remote(out.strip()) if ok else None

    target = remote(remotes.base)
    repo = f"{target.host}/{target.owner}/{target.repo}" if target else None
    head = branch
    if target and remotes.push != remotes.base:
        source = remote(remotes.push)
        same = (
            source is not None
            and source.host == target.host
            and source.owner.lower() == target.owner.lower()
            and source.repo.lower() == target.repo.lower()
        )
        if source is not None and not same:
            head = f"{source.owner}:{branch}"
    base = split_remote_ref(base_branch, remotes.names)[1] if base_branch else None
    if base and _SHA_BASE.match(base):
        base = None
    return PrTarget(repo, head, base)


def pick_branch_pr(prs: list[dict[str, Any]], owner: str | None) -> dict[str, Any] | None:
    """The first OPEN PR whose head repository belongs to `owner`."""
    for pr in prs:
        if pr.get("state") != "OPEN":
            continue
        head_owner = pr.get("headRepositoryOwner")
        login = str(head_owner.get("login", "")) if isinstance(head_owner, dict) else ""
        if not owner or login.lower() == owner.lower():
            return pr
    return None


def find_branch_pr(worktree: Path, target: PrTarget, *, dry_run: bool) -> tuple[str, int] | None:
    """The newest open PR whose head is the task's branch, or None (also on any failure)."""
    if dry_run:
        return DRY_PR_URL, 777
    fork_owner, _colon, rest = target.head.partition(":")
    branch = rest if _colon else target.head
    owner = fork_owner if _colon else _repo_owner(target.repo)
    args = ["pr", "list", *_repo_flag(target), "--head", branch]
    if target.base:
        args += ["--base", target.base]
    args += ["--state", "open", "--json", "url,number,state,headRepositoryOwner", "--limit", "10"]
    ok, out = _gh(worktree, args)
    if not ok:
        return None
    rows = _rows(out)
    match = pick_branch_pr(rows, owner)
    if match is None:
        return None
    return str(match.get("url", "")), int(match.get("number", 0))


def adopt_named(
    worktree: Path, target: PrTarget, ref: PrRef, *, dry_run: bool
) -> tuple[str, int] | str:
    """`(url, number)` of the PR the user named, or the reason it cannot be adopted."""
    if ref.repo and target.repo and ref.repo != target.repo.lower():
        return f"that pull request is on {ref.repo}, not {target.repo}"
    if dry_run:
        return DRY_PR_URL.rsplit("/", 1)[0] + f"/{ref.number}", ref.number
    ok, out = _gh(
        worktree,
        [
            "pr",
            "view",
            str(ref.number),
            *_repo_flag(target),
            "--json",
            "url,number,state,headRefName,baseRefName,headRepositoryOwner",
        ],
    )
    if not ok:
        return f"pull request {ref.number} was not found"
    try:
        loaded = json.loads(out)
    except json.JSONDecodeError:
        return f"pull request {ref.number} was not found"
    if not isinstance(loaded, dict):
        return f"pull request {ref.number} was not found"
    if loaded.get("state") != "OPEN":
        return f"pull request {ref.number} is not open"
    fork_owner, colon, rest = target.head.partition(":")
    branch = rest if colon else target.head
    if loaded.get("headRefName") != branch:
        return f"pull request {ref.number} is not from branch {branch}"
    if target.base and loaded.get("baseRefName") != target.base:
        return f"pull request {ref.number} does not target {target.base}"
    if pick_branch_pr([loaded], fork_owner if colon else _repo_owner(target.repo)) is None:
        return f"pull request {ref.number} was pushed from another fork"
    return str(loaded.get("url", "")), int(loaded.get("number", ref.number))


def _repo_owner(repo: str | None) -> str | None:
    parts = (repo or "").split("/")
    return parts[1] if len(parts) == 3 else None


def _repo_flag(target: PrTarget) -> list[str]:
    return ["--repo", target.repo] if target.repo else []


def _rows(out: str) -> list[dict[str, Any]]:
    try:
        loaded = json.loads(out)
    except json.JSONDecodeError:
        return []
    return [row for row in loaded if isinstance(row, dict)] if isinstance(loaded, list) else []


def _gh(cwd: Path, args: list[str]) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            ["gh", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
            env={**os.environ, "GH_PROMPT_DISABLED": "1"},
        )
    except OSError, subprocess.TimeoutExpired:
        return False, ""
    return proc.returncode == 0, proc.stdout
