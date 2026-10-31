"""Pull-request review and merge.

Dry-run answers without calling `gh` or the network. A real `gh` runs only when
dry-run is off.
"""

from __future__ import annotations

from pathlib import Path

from app.engine.gitwork import gh as _gh
from app.integrations.merge_state import dry_run_merge_state, load_merge_state

METHODS = frozenset({"merge", "squash", "rebase"})
REVIEWS = frozenset({"approve", "request-changes", "comment"})


def merge_state(number: int, *, dry_run: bool, cwd: Path) -> dict[str, object]:
    if number < 1:
        return {"available": False, "reason": "invalid pull request number"}
    if dry_run:
        return {"available": True, "dryRun": True, "mergeState": dry_run_merge_state(number)}
    state, err = load_merge_state(number, cwd)
    if state is None:
        return {"available": False, "reason": err or "gh pr view failed"}
    return {"available": True, "dryRun": False, "mergeState": state}


def merge_pr(
    number: int,
    method: str,
    *,
    dry_run: bool,
    cwd: Path,
    expected_head: str = "",
) -> dict[str, object]:
    if number < 1:
        return {"ok": False, "status": 400, "error": "invalid pull request number"}
    if method not in METHODS:
        return {"ok": False, "status": 400, "error": "method must be merge, squash, or rebase"}
    if expected_head and (
        len(expected_head) != 40 or any(ch not in "0123456789abcdef" for ch in expected_head)
    ):
        return {"ok": False, "status": 400, "error": "invalid merge request"}
    if dry_run:
        if expected_head and expected_head != "a" * 40:
            return {
                "ok": False,
                "status": 409,
                "error": "the pull request head moved",
                "code": "head_moved",
                "current": "a" * 40,
            }
        return {
            "ok": True,
            "merged": True,
            "number": number,
            "method": method,
            "dryRun": True,
            "url": f"https://github.com/open-mercato/demo/pull/{number}",
            "mergeCommitSha": "0" * 40,
        }
    current, err = load_merge_state(number, cwd)
    if current is None:
        return {"ok": False, "status": 409, "error": err or "gh pr view failed"}
    head = str(current.get("headSha", ""))
    if expected_head and head and expected_head != head:
        return {
            "ok": False,
            "status": 409,
            "error": "the pull request head moved",
            "code": "head_moved",
            "current": head,
        }
    if current.get("canMerge") is not True:
        blockers = current.get("blockers")
        message = "The pull request is not eligible to merge."
        if isinstance(blockers, list) and blockers and isinstance(blockers[0], dict):
            message = str(blockers[0].get("message", message))
        return {
            "ok": False,
            "status": 409,
            "error": message,
            "eligibility": current.get("eligibility"),
        }
    flag = {"merge": "--merge", "squash": "--squash", "rebase": "--rebase"}[method]
    args = ["pr", "merge", str(number), flag, "--yes"]
    if expected_head:
        args.extend(["--match-head-commit", expected_head])
    ok, out, err = _gh(cwd, args)
    if not ok:
        return {"ok": False, "status": 409, "error": err or "gh pr merge failed"}
    return {
        "ok": True,
        "merged": True,
        "number": number,
        "method": method,
        "dryRun": False,
        "url": out.strip().splitlines()[-1] if out.strip() else "",
    }


def review_pr(number: int, event: str, body: str, *, dry_run: bool, cwd: Path) -> dict[str, object]:
    if number < 1:
        return {"ok": False, "status": 400, "error": "invalid pull request number"}
    if event not in REVIEWS:
        return {
            "ok": False,
            "status": 400,
            "error": "event must be approve, request-changes, or comment",
        }
    if not body.strip():
        return {"ok": False, "status": 400, "error": "review body is empty"}
    if dry_run:
        return {"ok": True, "submitted": True, "dryRun": True, "event": event, "number": number}
    flag = {
        "approve": "--approve",
        "request-changes": "--request-changes",
        "comment": "--comment",
    }[event]
    ok, _out, err = _gh(cwd, ["pr", "review", str(number), flag, "--body", body])
    if not ok:
        return {"ok": False, "status": 409, "error": err or "gh pr review failed"}
    return {"ok": True, "submitted": True, "dryRun": False, "event": event, "number": number}
