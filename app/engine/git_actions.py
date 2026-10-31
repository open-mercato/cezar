"""Worktree git actions and a draft pull request.

`CEZ_DRY_RUN=1` does not push and does not call `gh`. The fake pull request URL
is the one the TypeScript helper returns. A commit uses the repo's identity,
and supplies `cezar <cezar@localhost>` only when `user.name` is unset, so a
container without a git identity can still commit.
"""

from __future__ import annotations

from pathlib import Path

from app.engine.gitwork import git, is_safe_git_ref

DRY_PR_URL = "https://github.com/open-mercato/demo/pull/777"


def commit_all(cwd: Path, message: str) -> dict[str, str]:
    if not message.strip():
        return {"ok": "false", "error": "commit message is empty"}
    if message.startswith("-") or any(ch in message for ch in "\r\n\0"):
        return {"ok": "false", "error": "commit message must be one plain line"}
    ok, status, err = git(cwd, ["status", "--porcelain"])
    if not ok:
        return {"ok": "false", "error": err.strip() or "git status failed"}
    if not status.strip():
        return {"ok": "true", "result": "nothing"}
    git(cwd, ["add", "-A"])
    args = ["commit", "-m", message]
    named, name, _err = git(cwd, ["config", "user.name"])
    if not named or not name.strip():
        args = ["-c", "user.name=cezar", "-c", "user.email=cezar@localhost", *args]
    ok, _out, err = git(cwd, args)
    if not ok:
        return {"ok": "false", "error": err.strip() or "git commit failed"}
    ok, sha, err = git(cwd, ["rev-parse", "HEAD"])
    if not ok:
        return {"ok": "false", "error": err.strip() or "git rev-parse failed"}
    return {"ok": "true", "result": "committed", "sha": sha.strip()}


def push_branch(cwd: Path, branch: str, *, dry_run: bool) -> dict[str, str | bool]:
    if not branch or not is_safe_git_ref(branch):
        return {"ok": False, "error": "this task has no branch of its own to push"}
    from app.engine.git_remotes import resolve_task_remotes

    remote = resolve_task_remotes(cwd).push or "origin"
    if not is_safe_git_ref(remote):
        return {"ok": False, "error": "refusing option-like push remote"}
    if dry_run:
        return {
            "ok": True,
            "branch": branch,
            "remote": remote,
            "upstreamSet": False,
            "dryRun": True,
        }
    ok, _out, err = git(cwd, ["push", "-u", remote, branch], timeout=30)
    if not ok:
        return {"ok": False, "error": err.strip() or "git push failed"}
    return {"ok": True, "branch": branch, "remote": remote, "upstreamSet": True, "dryRun": False}


def worktree_git_status(cwd: Path, base: str) -> dict[str, object]:
    ok, porcelain, err = git(cwd, ["status", "--porcelain"])
    if not ok:
        return {"ok": False, "error": err.strip() or "git status failed"}
    behind = ahead = 0
    if base and is_safe_git_ref(base):
        counted, out, _err = git(cwd, ["rev-list", "--left-right", "--count", f"{base}...HEAD"])
        parts = out.split()
        if counted and len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            behind, ahead = int(parts[0]), int(parts[1])
    return {
        "ok": True,
        "uncommitted": bool(porcelain.strip()),
        "unpushed": ahead,
        "behind": behind,
        "ahead": ahead,
    }


def sync_base(cwd: Path, base: str) -> dict[str, str]:
    if not base or not is_safe_git_ref(base):
        return {"ok": "false", "error": "no base branch recorded for this task"}
    ok, out, err = git(cwd, ["merge", "--no-edit", base])
    if ok:
        return {"ok": "true", "port": "done"}
    combined = f"{out}\n{err}"
    if "CONFLICT" in combined or "conflict" in combined:
        git(cwd, ["merge", "--abort"])
        return {"ok": "true", "port": "conflict"}
    return {"ok": "false", "error": err.strip() or out.strip() or "git merge failed"}


def create_draft_pr(cwd: Path, branch: str, title: str, *, dry_run: bool) -> dict[str, str | bool]:
    if not branch or not is_safe_git_ref(branch):
        return {"ok": False, "error": "no worktree/branch to publish"}
    if dry_run:
        return {"ok": True, "url": DRY_PR_URL, "dryRun": True}
    pushed = push_branch(cwd, branch, dry_run=False)
    if not pushed.get("ok"):
        return {"ok": False, "error": str(pushed.get("error", "git push failed"))}
    return _gh_pr(cwd, title or branch, branch)


def _gh_pr(cwd: Path, title: str, branch: str) -> dict[str, str | bool]:
    import subprocess

    try:
        proc = subprocess.run(
            ["gh", "pr", "create", "--draft", "--title", title, "--body", "Opened by cezar."],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc), "manual": f"git merge {branch}"}
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip() or "gh pr create failed"
        return {"ok": False, "error": detail, "manual": f"git merge {branch}"}
    url = ""
    for line in proc.stdout.splitlines():
        if line.startswith("https://"):
            url = line.strip()
    if not url:
        return {"ok": False, "error": "gh did not return a pull request URL"}
    return {"ok": True, "url": url, "dryRun": False}
