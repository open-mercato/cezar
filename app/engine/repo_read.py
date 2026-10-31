"""Read-only repository views for `/repo/*`.

Nothing here fetches. Push, pull, and fetch are the only commands that talk
to a remote, and they use the resolved push or base remote rather than a
hard-coded `origin`. A path is readable only when `git ls-files` lists it,
so an untracked `.env` is not served.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.engine.git_remotes import resolve_task_remotes
from app.engine.gitwork import git, is_git_repo, is_safe_git_ref

TREE_CAP = 20_000
DIFF_CAP = 400_000


def snapshot(root: Path, hide: set[str] | None = None) -> dict[str, object]:
    hidden = hide or set()
    if not is_git_repo(root):
        return {
            "info": None,
            "status": [],
            "log": [],
            "branches": [],
            "checkedOutElsewhere": {},
            "baseBranch": None,
        }
    info = repo_info(root)
    return {
        "info": info,
        "status": status(root),
        "log": log(root),
        "branches": branches(root, hidden),
        "checkedOutElsewhere": {},
        "baseBranch": _base_branch(root),
    }


def repo_info(root: Path) -> dict[str, str] | None:
    ok, out, _err = git(root, ["rev-parse", "--show-toplevel"])
    if not ok:
        return None
    top = out.strip() or str(root)
    ok, branch, _err = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
    info = {"root": top, "branch": branch.strip() if ok else ""}
    remotes = resolve_task_remotes(root)
    name = remotes.base or (remotes.names[0] if remotes.names else "")
    if name and is_safe_git_ref(name):
        ok, url, _err = git(root, ["remote", "get-url", name])
        if ok and url.strip():
            info["remote"] = url.strip()
    return info


def status(root: Path) -> list[dict[str, str]]:
    ok, out, _err = git(root, ["status", "--porcelain"])
    if not ok:
        return []
    rows = []
    for line in out.splitlines():
        if len(line) < 4:
            continue
        rows.append({"status": line[:2].strip() or "??", "path": line[3:]})
    return rows


def diff_text(root: Path, cap: int = DIFF_CAP) -> str | None:
    if not is_git_repo(root):
        return None
    _ok, out, _err = git(root, ["diff", "HEAD"])
    if len(out) > cap:
        return out[:cap] + "\n… (diff truncated)"
    return out


def changes(root: Path) -> dict[str, object] | str:
    if not is_git_repo(root):
        return "not a git repository"
    ok, out, err = git(root, ["diff", "--numstat", "HEAD"])
    if not ok:
        return err.strip() or "git diff failed"
    files = []
    adds = dels = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added = int(parts[0]) if parts[0].isdigit() else 0
        deleted = int(parts[1]) if parts[1].isdigit() else 0
        adds += added
        dels += deleted
        files.append(
            {"path": parts[2], "status": "modified", "additions": added, "deletions": deleted}
        )
    return {"files": files, "stat": {"files": len(files), "additions": adds, "deletions": dels}}


def tree(root: Path, cap: int = TREE_CAP) -> dict[str, object] | str:
    if not is_git_repo(root):
        return "not a git repository"
    ok, out, err = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    if not ok:
        return err.strip() or "git ls-files failed"
    paths = sorted(part for part in out.split("\0") if part)
    truncated = len(paths) > cap
    return {"paths": paths[:cap], "truncated": truncated}


def file_text(root: Path, rel: str) -> tuple[str | None, str]:
    """Return `(text, "")` or `(None, reason)`."""
    if not rel or rel.startswith("/") or ".." in Path(rel).parts:
        return None, "path is outside the repository"
    listed = tree(root)
    if isinstance(listed, str):
        return None, listed
    paths = listed["paths"]
    if not isinstance(paths, list) or rel not in paths:
        return None, "not in the repository index"
    file = (root / rel).resolve()
    try:
        file.relative_to(root.resolve())
    except ValueError:
        return None, "path is outside the repository"
    if not file.is_file() or file.is_symlink():
        return None, "not a file"
    return file.read_text(encoding="utf-8", errors="replace"), ""


def commit_text(root: Path, sha: str, cap: int = 200_000) -> str:
    if not _sha(sha):
        return "(not a commit hash)"
    if not is_git_repo(root):
        return "not a git repository"
    ok, out, err = git(root, ["show", "--stat", "--patch", "--no-color", sha])
    if not ok:
        return f"(git show failed: {err.strip() or 'unknown'})"
    if len(out) > cap:
        return out[:cap] + "\n… (diff truncated)"
    return out


def commit_structured(root: Path, sha: str) -> dict[str, object] | str:
    if not _sha(sha):
        return "not a commit hash"
    if not is_git_repo(root):
        return "not a git repository"
    ok, out, err = git(root, ["show", "-s", "--format=%H%x1f%s%x1f%an%x1f%cI", sha])
    if not ok:
        return err.strip() or "git show failed"
    parts = out.strip().split("\x1f")
    if len(parts) < 4:
        return "git show failed"
    stat = changes_between(root, f"{sha}^", sha)
    files = stat["files"] if isinstance(stat, dict) else []
    summary = stat["stat"] if isinstance(stat, dict) else {}
    return {
        "sha": parts[0],
        "subject": parts[1],
        "author": parts[2],
        "when": parts[3],
        "files": files,
        "stat": summary,
    }


def changes_between(root: Path, left: str, right: str) -> dict[str, object] | str:
    ok, out, err = git(root, ["diff", "--numstat", left, right])
    if not ok:
        return err.strip() or "git diff failed"
    files = []
    adds = dels = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added = int(parts[0]) if parts[0].isdigit() else 0
        deleted = int(parts[1]) if parts[1].isdigit() else 0
        adds += added
        dels += deleted
        files.append(
            {"path": parts[2], "status": "modified", "additions": added, "deletions": deleted}
        )
    return {"files": files, "stat": {"files": len(files), "additions": adds, "deletions": dels}}


def branches(root: Path, hide: set[str]) -> list[str]:
    names: set[str] = set()
    ok, out, _err = git(root, ["branch", "--list", "--format=%(refname:short)"])
    if ok:
        names.update(line.strip() for line in out.splitlines() if line.strip())
    ok, out, _err = git(root, ["branch", "-r", "--list", "--format=%(refname:short)"])
    if ok:
        for line in out.splitlines():
            name = line.strip()
            if not name or "HEAD" in name:
                continue
            if name.startswith("origin/"):
                name = name[len("origin/") :]
            names.add(name)
    return sorted(name for name in names if not name.startswith("cez/") and name not in hide)


def switch_branch(root: Path, name: str, start: str = "") -> dict[str, object] | str:
    if not name or not is_safe_git_ref(name) or name.startswith("-"):
        return "refusing option-like branch name"
    ok, _out, _err = git(root, ["check-ref-format", "--branch", name])
    if not ok:
        return "refusing branch name"
    exists, _out, _err = git(root, ["show-ref", "--verify", "--quiet", f"refs/heads/{name}"])
    if exists:
        ok, _out, err = git(root, ["checkout", name])
        if not ok:
            return err.strip() or "git checkout failed"
        return {"branch": name, "created": False}
    args = ["checkout", "-b", name]
    if start:
        if not is_safe_git_ref(start):
            return "refusing option-like start ref"
        args.append(start)
    ok, _out, err = git(root, args)
    if not ok:
        return err.strip() or "git checkout failed"
    return {"branch": name, "created": True}


def sync_status(root: Path) -> dict[str, object] | str:
    if not is_git_repo(root):
        return "not a git repository"
    remotes = resolve_task_remotes(root)
    branch_ok, branch, _err = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
    name = branch.strip() if branch_ok else ""
    remote = remotes.push or remotes.base
    ahead = behind = 0
    if remote and name and is_safe_git_ref(remote) and is_safe_git_ref(name):
        counted, out, _err = git(
            root, ["rev-list", "--left-right", "--count", f"{remote}/{name}...HEAD"]
        )
        parts = out.split()
        if counted and len(parts) == 2 and all(part.isdigit() for part in parts):
            behind, ahead = int(parts[0]), int(parts[1])
    return {"branch": name, "remote": remote, "ahead": ahead, "behind": behind}


def fetch_remote(root: Path) -> dict[str, object] | str:
    return _network(root, "fetch")


def pull_remote(root: Path) -> dict[str, object] | str:
    return _network(root, "pull")


def push_remote(root: Path) -> dict[str, object] | str:
    return _network(root, "push")


def sync_remote(root: Path) -> dict[str, object] | str:
    fetched = fetch_remote(root)
    if isinstance(fetched, str):
        return fetched
    pulled = pull_remote(root)
    if isinstance(pulled, str):
        return pulled
    return push_remote(root)


def log(root: Path, count: int = 20) -> list[dict[str, str]]:
    ok, out, _err = git(root, ["log", f"-{count}", "--pretty=format:%h%x1f%s%x1f%an%x1f%cr"])
    if not ok:
        return []
    rows = []
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) < 4:
            continue
        rows.append({"hash": parts[0], "subject": parts[1], "author": parts[2], "when": parts[3]})
    return rows


def _network(root: Path, action: str) -> dict[str, object] | str:
    if not is_git_repo(root):
        return "not a git repository"
    remotes = resolve_task_remotes(root)
    remote = remotes.push if action == "push" else (remotes.base or remotes.push)
    if not remote or not is_safe_git_ref(remote):
        return "no remote"
    if action == "push":
        args = ["push", "-u", remote, "HEAD"]
    elif action == "pull":
        branch_ok, branch, _err = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
        name = branch.strip() if branch_ok and branch.strip() else "HEAD"
        args = ["pull", remote, name]
    else:
        args = ["fetch", remote]
    ok, out, err = git(root, args, timeout=30)
    if not ok:
        return err.strip() or out.strip() or f"git {action} failed"
    status = sync_status(root)
    if isinstance(status, str):
        return status
    return {"message": out.strip() or err.strip() or action, "sync": status}


def _base_branch(root: Path) -> str | None:
    path = root / ".ai" / "cezar" / "config.json"
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return None
    if isinstance(loaded, dict) and isinstance(loaded.get("baseBranch"), str):
        return loaded["baseBranch"]
    return None


def _sha(value: str) -> bool:
    return 4 <= len(value) <= 40 and all(ch in "0123456789abcdefABCDEF" for ch in value)
