"""In-place commits.

`land_in_place` is the auto-land from `landInPlace` in
`packages/cezar/src/workflows/landing.ts`. A git-tracked config cannot grant
it. Required checks run during that land.

`land_inplace` is the explicit `POST …/land` commit. It does not push, and it
does not stage `.ai/cezar`.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.engine.gitwork import git

_EXCLUDE = [".", ":(exclude).ai/cezar"]
_UNMERGED = frozenset({"UU", "AA", "DD", "AU", "UA", "DU", "UD"})
MAX_LAND_ATTEMPTS = 3


@dataclass(frozen=True, slots=True)
class LandingPolicy:
    checks: tuple[str, ...]
    base_branch: str
    refusal: str = ""


@dataclass(frozen=True, slots=True)
class LandResult:
    result: str
    stage: str = ""
    error: str = ""
    branch: str = ""
    sha: str = ""
    pushed: bool = False
    files: tuple[str, ...] = ()


def read_policy(repo: Path, extra_checks: tuple[str, ...] = ()) -> LandingPolicy | None:
    """`landing: auto` from an untracked config file. Anything else is not a policy."""
    path = repo / ".ai" / "cezar" / "config.json"
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return None
    if not isinstance(loaded, dict) or loaded.get("landing") != "auto":
        return None
    if _tracked(repo):
        return LandingPolicy(
            (),
            "",
            "auto-land is off — .ai/cezar/config.json is tracked by git, "
            "and only local configuration can grant it",
        )
    raw = loaded.get("requiredChecks")
    if isinstance(raw, list):
        checks = tuple(item for item in raw if isinstance(item, str) and item.strip())
    else:
        checks = extra_checks
    base = loaded.get("baseBranch")
    return LandingPolicy(checks, base if isinstance(base, str) else "")


def has_unlanded(repo: Path) -> bool:
    ok, status, _err = git(repo, ["status", "--porcelain", "--", *_EXCLUDE])
    return ok and bool(status.strip())


def land_in_place(
    repo: Path,
    *,
    checks: tuple[str, ...],
    base_branch: str,
    since: str = "",
    dry_run: bool = False,
    check_timeout: float = 600,
) -> LandResult:
    ok, branch, _err = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
    branch = branch.strip()
    if not ok or not branch or branch == "HEAD":
        return LandResult(
            "failed",
            "branch",
            "the checkout is on a detached HEAD — check out the base branch",
        )
    if base_branch and branch != base_branch:
        return LandResult(
            "failed",
            "branch",
            f"the checkout is on {branch}, but this project lands on {base_branch}",
        )
    identity = _identity(repo)
    upstream = _upstream(repo)
    if upstream is None:
        if not has_unlanded(repo):
            return LandResult("nothing")
        checked = _checks(repo, checks, check_timeout)
        if checked is not None:
            return checked
        committed = _commit(repo, identity)
        if committed.result != "committed":
            return LandResult(committed.result, "commit", committed.error)
        files = _files(repo, f"{since}..HEAD") if since else ()
        return LandResult("landed", branch=branch, sha=committed.sha, files=files)
    committed = _commit(repo, identity)
    if committed.result == "failed":
        return LandResult("failed", "commit", committed.error)
    remote, upstream_branch, upstream_ref = upstream
    if committed.result == "nothing" and _count(repo, f"{upstream_ref}..HEAD") == 0:
        return LandResult("nothing")
    for attempt in range(2):
        if not dry_run:
            fetched, _out, err = git(repo, ["fetch", remote, upstream_branch], timeout=60)
            if not fetched:
                return LandResult(
                    "failed", "sync", f"git fetch failed: {err.strip() or 'no answer'}"
                )
        detail = _rebase(repo, identity, upstream_ref)
        if detail:
            return LandResult("failed", "sync", detail)
        checked = _checks(repo, checks, check_timeout)
        if checked is not None:
            return checked
        sha_ok, sha, _err = git(repo, ["rev-parse", "HEAD"])
        files = _files(repo, f"{upstream_ref}..HEAD")
        if not sha_ok:
            return LandResult("failed", "sync", "could not read HEAD")
        if dry_run:
            return LandResult("landed", branch=branch, sha=sha.strip(), files=files)
        pushed, _out, err = git(repo, ["push", remote, f"HEAD:{upstream_branch}"], timeout=60)
        if pushed:
            return LandResult("landed", branch=branch, sha=sha.strip(), pushed=True, files=files)
        if attempt == 1 or "rejected" not in err.lower():
            return LandResult("failed", "push", f"git push failed: {err.strip() or 'no answer'}")
    return LandResult("failed", "push", "git push was rejected twice")


def _rebase(repo: Path, identity: list[str], upstream_ref: str) -> str:
    """Rebase onto the upstream. Empty when it worked, else why it did not (rebase aborted)."""
    rebased, _out, err = git(repo, [*identity, "rebase", "--autostash", upstream_ref])
    if rebased:
        return ""
    conflicted, names, _err = git(repo, ["diff", "--name-only", "--diff-filter=U"])
    git(repo, ["rebase", "--abort"])
    listed = [line for line in names.splitlines() if line.strip()] if conflicted else []
    if listed:
        return f"rebasing onto {upstream_ref} conflicts in: {', '.join(listed)}"
    return f"rebasing onto {upstream_ref} failed: {err.strip() or 'unknown error'}"


def failure_prompt(outcome: LandResult) -> str:
    return (
        f"Auto-land failed at {outcome.stage}: {outcome.error}\n"
        "Fix that and end the turn with CEZ:DONE so the landing can run again."
    )


@dataclass(frozen=True, slots=True)
class _Commit:
    result: str
    sha: str = ""
    error: str = ""


def _tracked(repo: Path) -> bool:
    ok, out, _err = git(repo, ["ls-files", "--", ".ai/cezar/config.json"])
    return ok and bool(out.strip())


def _identity(repo: Path) -> list[str]:
    named, name, _err = git(repo, ["config", "user.name"])
    if named and name.strip():
        return []
    return ["-c", "user.name=cezar", "-c", "user.email=cezar@local"]


def _upstream(repo: Path) -> tuple[str, str, str] | None:
    ok, ref, _err = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    ref = ref.strip()
    if not ok or not ref:
        return None
    head_ok, head, _err = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
    branch = head.strip() if head_ok else ""
    remote_ok, remote, _err = git(repo, ["config", f"branch.{branch}.remote"])
    merge_ok, merge, _err = git(repo, ["config", f"branch.{branch}.merge"])
    remote, merge = remote.strip(), merge.strip()
    if not remote_ok or not merge_ok or not remote or remote == "." or not merge:
        return None
    return remote, merge.removeprefix("refs/heads/"), ref


def _checks(repo: Path, checks: tuple[str, ...], timeout: float) -> LandResult | None:
    for command in checks:
        try:
            proc = subprocess.run(
                ["bash", "-lc", command],
                cwd=repo,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return LandResult("failed", "checks", f"required check `{command}` timed out")
        except OSError as exc:
            return LandResult("failed", "checks", f"required check `{command}` failed: {exc}")
        if proc.returncode != 0:
            detail = (proc.stdout + proc.stderr).strip() or f"exit {proc.returncode}"
            return LandResult("failed", "checks", f"required check `{command}` failed:\n{detail}")
    return None


def _commit(repo: Path, identity: list[str]) -> _Commit:
    ok, status, err = git(repo, ["status", "--porcelain", "--", *_EXCLUDE])
    if not ok:
        return _Commit("failed", error=err.strip() or "git status failed")
    if not status.strip():
        return _Commit("nothing")
    for line in status.splitlines():
        if line[:2] in _UNMERGED:
            return _Commit("failed", error="refusing to commit a mid-merge tree")
    added, _out, err = git(repo, ["add", "-A", "--", *_EXCLUDE])
    if not added:
        return _Commit("failed", error=err.strip() or "git add failed")
    message = _message(status)
    committed, _out, err = git(repo, [*identity, "commit", "--no-verify", "-m", message])
    if not committed:
        if "nothing" in err.lower():
            return _Commit("nothing")
        return _Commit("failed", error=err.strip() or "git commit failed")
    sha_ok, sha, err = git(repo, ["rev-parse", "HEAD"])
    if not sha_ok:
        return _Commit("failed", error=err.strip() or "git rev-parse failed")
    return _Commit("committed", sha=sha.strip())


def _message(status: str) -> str:
    names = []
    for line in status.splitlines():
        path = line[3:].strip()
        if path:
            names.append(path.split("/")[-1])
    if not names:
        return "Update files"
    if len(names) <= 2:
        return f"Update {' and '.join(names)}"
    return f"Update {len(names)} files"


def _files(repo: Path, range_expr: str) -> tuple[str, ...]:
    ok, out, _err = git(repo, ["diff", "--name-only", range_expr])
    if not ok:
        return ()
    return tuple(line.strip() for line in out.splitlines() if line.strip())[:200]


def _count(repo: Path, range_expr: str) -> int:
    ok, out, _err = git(repo, ["rev-list", "--count", range_expr])
    if not ok or not out.strip().isdigit():
        return 0
    return int(out.strip())


def land_inplace(root: Path) -> dict[str, Any]:
    ok, status, err = git(root, ["status", "--porcelain", "--", ".", ":(exclude).ai/cezar"])
    if not ok:
        return {"result": "failed", "stage": "commit", "error": err.strip() or "git status failed"}
    if not status.strip():
        return {"result": "nothing"}
    added, _out, add_err = git(root, ["add", "-A", "--", ".", ":(exclude).ai/cezar"])
    if not added:
        return {"result": "failed", "stage": "commit", "error": add_err.strip() or "git add failed"}
    committed, _cout, commit_err = git(root, ["commit", "-m", "land the task"])
    if not committed:
        return {
            "result": "failed",
            "stage": "commit",
            "error": commit_err.strip() or "git commit failed",
        }
    _ok, sha, _sha_err = git(root, ["rev-parse", "HEAD"])
    files = [line[3:] for line in status.splitlines() if len(line) > 3]
    return {"result": "landed", "sha": sha.strip(), "files": files}


def inplace_requested(root: Path) -> bool:
    path = root / ".ai" / "cezar" / "config.json"
    try:
        import json

        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError:
        return False
    return isinstance(loaded, dict) and loaded.get("inPlace") is True
