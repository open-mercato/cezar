"""GitHub checks, search, ref status, review comments, and PR changes.

`CEZ_DRY_RUN=1` answers from a fixed catalog and does not run `gh`. With
dry-run off, the same shapes come from `gh` in the repository. A missing
`gh` or a forge error is `{available: false, reason}` — never a raise.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.engine.gitwork import gh as _gh

GH_CHECKS_MAX = 100
GH_SEARCH_MAX = 50
GH_REF_STATUS_MAX = 100
_CACHE_MS = 60_000

_LABELS = {
    "bug": "d73a4a",
    "auth": "5319e7",
    "enhancement": "a2eeef",
    "cli": "0e8a16",
    "flaky-test": "fbca04",
    "tests": "c5def5",
    "server": "1d76db",
    "draft": "6a737d",
}


def catalog() -> dict[str, Any]:
    def item(kind: str, number: int, title: str, **extra: object) -> dict[str, Any]:
        row: dict[str, Any] = {
            "kind": kind,
            "number": number,
            "title": title,
            "author": "mock",
            "labels": [],
            "url": f"https://github.com/mock/repo/{'pull' if kind == 'pr' else 'issues'}/{number}",
            "comments": 0,
            "body": "",
        }
        row.update(extra)
        return row

    return {
        "available": True,
        "repo": "mock/repo",
        "issues": [
            item(
                "issue",
                142,
                "Login form drops session on refresh",
                labels=["bug", "auth"],
                comments=3,
                body="Repro: log in, hit reload.",
            ),
            item("issue", 139, "Add --json flag to cez CLI output", labels=["enhancement", "cli"]),
            item("issue", 135, "Flaky e2e: worktree cleanup race on cancel", labels=["bug"]),
        ],
        "prs": [
            item(
                "pr",
                128,
                "Fix flaky auth test in CI",
                labels=["tests"],
                checks="passing",
                additions=6,
                deletions=3,
            ),
            item(
                "pr",
                124,
                "Rate limit /api/runs",
                labels=["server", "draft"],
                isDraft=True,
                checks="failing",
                additions=118,
                deletions=7,
                comments=4,
            ),
        ],
        "labelColors": _LABELS,
    }


def github_overview(cwd: Path, *, dry_run: bool) -> dict[str, Any]:
    """The GitHub tab: open issues and pull requests, including drafts."""
    if dry_run:
        data = catalog()
        data["syncedAt"] = "dry-run"
        return data
    try:
        issues_ok, issues_out, issues_err = _gh(
            cwd, ["issue", "list", "--state", "open", "--limit", "20", "--json", "number,title,url"]
        )
        prs_ok, prs_out, prs_err = _gh(
            cwd,
            [
                "pr",
                "list",
                "--state",
                "open",
                "--limit",
                "20",
                "--json",
                "number,title,url,isDraft",
            ],
        )
    except OSError as exc:
        return {"available": False, "reason": _reason(str(exc)), "issues": [], "prs": []}
    if not issues_ok or not prs_ok:
        return {
            "available": False,
            "reason": _reason(issues_err or prs_err),
            "issues": [],
            "prs": [],
        }
    issues = _loads(issues_out)
    prs = _loads(prs_out)
    return {
        "available": True,
        "issues": issues if isinstance(issues, list) else [],
        "prs": prs if isinstance(prs, list) else [],
    }


def github_checks(cwd: Path, numbers: list[int], *, dry_run: bool) -> dict[str, Any]:
    if dry_run:
        by_number = {row["number"]: row.get("checks") for row in catalog()["prs"]}
        return {"available": True, "checks": {n: by_number.get(n) for n in numbers}}
    wanted = list(dict.fromkeys(n for n in numbers if isinstance(n, int) and n > 0))[:GH_CHECKS_MAX]
    checks: dict[int, str | None] = {}
    try:
        for number in wanted:
            ok, out, err = _gh(
                cwd, ["pr", "view", str(number), "--json", "statusCheckRollup,state"]
            )
            if not ok:
                if _missing(err):
                    return {"available": False, "reason": _reason(err)}
                checks[number] = None
                continue
            checks[number] = _glyph(_loads(out).get("statusCheckRollup"))
    except OSError as exc:
        return {"available": False, "reason": _reason(str(exc))}
    return {"available": True, "checks": checks}


def github_search(
    cwd: Path, kind: str, query: str, *, limit: int = GH_SEARCH_MAX, dry_run: bool
) -> dict[str, Any]:
    trimmed = query.strip()
    if not trimmed:
        return {"available": True, "items": []}
    capped = min(max(limit, 1), GH_SEARCH_MAX)
    if dry_run:
        pool = catalog()["issues" if kind == "issue" else "prs"]
        needle = trimmed.removeprefix("#").lower()
        items = [
            row
            for row in pool
            if needle in str(row["number"]) or needle in str(row["title"]).lower()
        ][:capped]
        return {"available": True, "items": items, "truncated": len(items) >= capped}
    numeric = trimmed.removeprefix("#")
    try:
        if numeric.isdigit():
            fields = "number,title,url,author,labels"
            if kind == "pr":
                fields += ",isDraft,additions,deletions"
            command = kind if kind == "pr" else "issue"
            ok, out, err = _gh(cwd, [command, "view", numeric, "--json", fields])
            if ok:
                hit = _loads(out)
                return {"available": True, "items": [_search_item(kind, hit)]}
            if _missing(err):
                return {"available": False, "reason": _reason(err), "items": []}
        handle = _handle(cwd)
        if not handle:
            return {"available": False, "reason": "no GitHub remote to search", "items": []}
        ok, out, err = _gh(
            cwd,
            [
                "search",
                "prs" if kind == "pr" else "issues",
                "--repo",
                handle,
                "--limit",
                str(capped),
                "--json",
                "number,title,url",
                "--",
                trimmed,
            ],
        )
        if not ok:
            return {"available": False, "reason": _reason(err), "items": []}
        hits = _loads(out)
        rows = hits if isinstance(hits, list) else []
        items = [_search_item(kind, row) for row in rows if isinstance(row, dict)]
        return {"available": True, "items": items, "truncated": len(items) >= capped}
    except OSError as exc:
        return {"available": False, "reason": _reason(str(exc)), "items": []}


def github_ref_status(
    cwd: Path, prs: list[int], issues: list[int], *, dry_run: bool
) -> dict[str, Any]:
    if dry_run:
        data = catalog()
        by_pr = {row["number"]: row for row in data["prs"]}
        known_issues = {row["number"] for row in data["issues"]}
        pr_status = {}
        for number in prs:
            row = by_pr.get(number)
            if row is not None:
                pr_status[number] = derive_pr_status(
                    state="OPEN",
                    is_draft=bool(row.get("isDraft")),
                    checks=row.get("checks"),
                )
        issue_status = {number: "open" for number in issues if number in known_issues}
        return {
            "available": True,
            "prs": pr_status,
            "issues": issue_status,
            "recheckAfterMs": _CACHE_MS,
        }
    try:
        pr_status = {}
        for number in prs[:GH_REF_STATUS_MAX]:
            ok, out, err = _gh(
                cwd,
                [
                    "pr",
                    "view",
                    str(number),
                    "--json",
                    "state,isDraft,statusCheckRollup,reviewDecision",
                ],
            )
            if not ok:
                if _missing(err):
                    return _ref_unavailable(err)
                continue
            loaded = _loads(out)
            pr_status[number] = derive_pr_status(
                state=str(loaded.get("state", "OPEN")),
                is_draft=bool(loaded.get("isDraft")),
                checks=_glyph(loaded.get("statusCheckRollup")),
                review_decision=loaded.get("reviewDecision"),
            )
        issue_status = {}
        for number in issues[:GH_REF_STATUS_MAX]:
            ok, out, err = _gh(cwd, ["issue", "view", str(number), "--json", "state"])
            if not ok:
                if _missing(err):
                    return _ref_unavailable(err)
                continue
            state = str(_loads(out).get("state", "")).upper()
            if state == "OPEN":
                issue_status[number] = "open"
            elif state == "CLOSED":
                issue_status[number] = "completed"
        return {
            "available": True,
            "prs": pr_status,
            "issues": issue_status,
            "recheckAfterMs": _CACHE_MS,
        }
    except OSError as exc:
        return _ref_unavailable(str(exc))


def github_comments(kind: str, number: int, *, dry_run: bool, cwd: Path) -> dict[str, Any]:
    if dry_run:
        return _mock_comments(kind)
    try:
        ok, out, err = _gh(cwd, ["api", f"repos/{{owner}}/{{repo}}/issues/{number}/comments"])
        if not ok:
            return {"available": False, "reason": _reason(err), "comments": []}
        comments = _comment_rows(_loads(out))
        events: list[dict[str, Any]] = []
        if kind == "pr":
            reviewed, review_out, review_err = _gh(
                cwd, ["api", f"repos/{{owner}}/{{repo}}/pulls/{number}/reviews"]
            )
            if reviewed:
                comments.extend(_review_rows(_loads(review_out)))
            elif _missing(review_err):
                return {"available": False, "reason": _reason(review_err), "comments": []}
        comments.sort(key=lambda row: str(row.get("createdAt", "")))
        return {"available": True, "comments": comments, "events": events}
    except OSError as exc:
        return {"available": False, "reason": _reason(str(exc)), "comments": []}


def github_pr_changes(cwd: Path, number: int, *, dry_run: bool) -> dict[str, Any]:
    if dry_run:
        return _mock_pr_diff(number)
    try:
        ok, out, err = _gh(cwd, ["api", f"repos/{{owner}}/{{repo}}/pulls/{number}/files"])
        if not ok:
            if "404" in err or "not found" in err.lower():
                raise _NotFound(f"pull request {number} was not found")
            return {"available": False, "reason": _reason(err)}
        files = _change_files(_loads(out))
        return {
            "available": True,
            "number": number,
            "files": files,
            "additions": sum(int(row.get("additions", 0)) for row in files),
            "deletions": sum(int(row.get("deletions", 0)) for row in files),
            "truncated": any(row.get("truncated") for row in files),
        }
    except OSError as exc:
        return {"available": False, "reason": _reason(str(exc))}


def github_item(cwd: Path, kind: str, number: int, *, dry_run: bool) -> dict[str, Any]:
    """One pull request or issue for its detail screen: `{available, item}`.

    A number `gh` does not know is `{available: False, code: "not_found"}`.
    """
    if dry_run:
        pool = catalog()["issues" if kind == "issue" else "prs"]
        for row in pool:
            if row["number"] == number:
                return {"available": True, "item": {**row, "state": "OPEN"}}
        return _item_missing(kind, number)
    fields = "number,title,state,author,body,url,labels"
    if kind == "pr":
        fields += ",isDraft,headRefName,baseRefName,additions,deletions,reviewDecision"
    try:
        ok, out, err = _gh(
            cwd, ["pr" if kind == "pr" else "issue", "view", str(number), "--json", fields]
        )
    except OSError as exc:
        return {"available": False, "code": "unavailable", "reason": _reason(str(exc))}
    if not ok:
        folded = err.lower()
        if "could not resolve" in folded or ("not found" in folded and "gh" not in folded):
            return _item_missing(kind, number)
        return {"available": False, "code": "unavailable", "reason": _reason(err)}
    loaded = _loads(out)
    if not isinstance(loaded, dict) or not loaded:
        return _item_missing(kind, number)
    labels = loaded.get("labels")
    author = loaded.get("author")
    item = {
        **loaded,
        "kind": kind,
        "author": author.get("login", "") if isinstance(author, dict) else "",
        "labels": [str(row.get("name", "")) for row in labels if isinstance(row, dict)]
        if isinstance(labels, list)
        else [],
    }
    return {"available": True, "item": item}


def _item_missing(kind: str, number: int) -> dict[str, Any]:
    name = "pull request" if kind == "pr" else "issue"
    return {"available": False, "code": "not_found", "reason": f"{name} {number} was not found"}


class PrNotFound(Exception):
    pass


class _NotFound(PrNotFound):
    pass


def derive_pr_status(
    *,
    state: str,
    is_draft: bool = False,
    checks: str | None = None,
    review_decision: object = None,
    head_committed_at: str | None = None,
    head_parent_count: int | None = None,
    head_first_parent_at: str | None = None,
    changes_requested_at: str | None = None,
    review_requested: bool | None = None,
    review_requested_at: str | None = None,
) -> str:
    folded = state.upper()
    if folded == "MERGED":
        return "merged"
    if folded == "CLOSED":
        return "closed"
    if is_draft:
        return "draft"
    if checks == "pending":
        return "checks-pending"
    decision = str(review_decision or "").upper()
    changes = decision == "CHANGES_REQUESTED"
    re_requested = review_requested is True and (
        not changes_requested_at or _after(review_requested_at, changes_requested_at)
    )
    work_at = head_committed_at if (head_parent_count or 1) < 2 else head_first_parent_at
    answered = re_requested or _after(work_at, changes_requested_at)
    if changes and not answered:
        return "changes-requested"
    if checks == "failing":
        return "checks-failing"
    if decision == "APPROVED":
        return "ready"
    if changes or decision == "REVIEW_REQUIRED" or review_requested is True:
        return "review-required"
    return "ready"


def parse_number_list(raw: str | None, *, cap: int) -> list[int] | None:
    """None when a token is not a positive integer. Empty is an empty list."""
    parts = [part.strip() for part in (raw or "").split(",") if part.strip()]
    if len(parts) > cap:
        return None
    numbers: list[int] = []
    for part in parts:
        if not part.isdigit():
            return None
        number = int(part)
        if number <= 0 or str(number) != part:
            return None
        numbers.append(number)
    return numbers


def _glyph(rollup: object) -> str | None:
    if not isinstance(rollup, list) or not rollup:
        state = rollup.get("state") if isinstance(rollup, dict) else None
    else:
        state = None
        for item in rollup:
            if isinstance(item, dict) and item.get("state"):
                state = item.get("state")
                if str(state).upper() in ("FAILURE", "ERROR", "PENDING"):
                    break
    folded = str(state or "").upper()
    if folded in ("SUCCESS", "PASSING"):
        return "passing"
    if folded in ("FAILURE", "ERROR", "FAILING"):
        return "failing"
    if folded in ("PENDING", "EXPECTED", "QUEUED"):
        return "pending"
    return None


def _search_item(kind: str, hit: dict[str, Any]) -> dict[str, Any]:
    author = hit.get("author")
    login = author.get("login") if isinstance(author, dict) else author
    return {
        "kind": kind,
        "number": hit.get("number"),
        "title": hit.get("title", ""),
        "url": hit.get("url", ""),
        "author": login or "",
    }


def _comment_rows(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    rows = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        user = _as_dict(item.get("user"))
        rows.append(
            {
                "id": item.get("id"),
                "author": str(user.get("login", "?")),
                "createdAt": item.get("created_at", ""),
                "body": str(item.get("body") or "")[:8000],
                "kind": "comment",
                "url": item.get("html_url", ""),
            }
        )
    return rows


def _review_rows(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    states = {
        "APPROVED": "approved",
        "CHANGES_REQUESTED": "changes_requested",
        "COMMENTED": "commented",
        "DISMISSED": "dismissed",
    }
    rows = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        state = str(item.get("state", "")).upper()
        body = str(item.get("body") or "")
        if not body and state in ("COMMENTED", "PENDING", ""):
            continue
        user = _as_dict(item.get("user"))
        rows.append(
            {
                "id": item.get("id"),
                "author": str(user.get("login", "?")),
                "createdAt": item.get("submitted_at") or "",
                "body": body[:8000],
                "kind": "review",
                "reviewState": states.get(state, "commented"),
                "url": item.get("html_url", ""),
            }
        )
    return rows


def _change_files(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    files = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        row: dict[str, Any] = {
            "path": item.get("filename", ""),
            "status": item.get("status", "modified"),
            "additions": item.get("additions", 0),
            "deletions": item.get("deletions", 0),
        }
        if item.get("previous_filename"):
            row["previousPath"] = item["previous_filename"]
        patch = item.get("patch")
        if isinstance(patch, str):
            row["patch"] = patch
        elif item.get("status") == "renamed":
            pass
        else:
            row["patchUnavailableReason"] = "binary" if not patch else "too-large"
        files.append(row)
    return files


def _mock_pr_diff(number: int) -> dict[str, Any]:
    return {
        "available": True,
        "number": number,
        "headSha": "0123456789abcdef0123456789abcdef01234567",
        "additions": 15,
        "deletions": 4,
        "truncated": True,
        "reason": "One or more patches were not provided by GitHub.",
        "files": [
            {
                "path": "src/session.ts",
                "status": "modified",
                "additions": 8,
                "deletions": 3,
                "patch": "@@ -1,3 +1,4 @@\n-old\n+new\n context",
            },
            {
                "path": "src/new-name.ts",
                "previousPath": "src/old-name.ts",
                "status": "renamed",
                "additions": 7,
                "deletions": 1,
                "patch": "@@ -1 +1 @@\n-old name\n+new name",
            },
            {
                "path": "assets/logo.png",
                "status": "modified",
                "additions": 0,
                "deletions": 0,
                "patchUnavailableReason": "binary",
            },
            {
                "path": "generated/output.txt",
                "status": "modified",
                "additions": 0,
                "deletions": 0,
                "patchUnavailableReason": "too-large",
                "truncated": True,
            },
        ],
    }


def _mock_comments(kind: str) -> dict[str, Any]:
    base = 1_700_000_000_000

    def at(offset: int) -> str:
        # Stable enough for ordering. Milliseconds since a fixed instant, as ISO-ish via epoch.
        from datetime import UTC, datetime

        return datetime.fromtimestamp((base + offset) / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    comments: list[dict[str, Any]] = [
        {
            "id": 1,
            "author": "ada",
            "createdAt": at(0),
            "body": "Thanks for the report.",
            "kind": "comment",
            "url": "https://github.com/mock/repo/issues/1#issuecomment-1",
        },
        {
            "id": 2,
            "author": "lin",
            "createdAt": at(600_000),
            "body": "Here is the failing screen.",
            "kind": "comment",
            "url": "https://github.com/mock/repo/issues/1#issuecomment-2",
        },
    ]
    if kind == "pr":
        comments.append(
            {
                "id": 3,
                "author": "grace",
                "createdAt": at(1_200_000),
                "body": "Please add a regression test.",
                "kind": "review",
                "reviewState": "changes_requested",
                "url": "https://github.com/mock/repo/pull/1#pullrequestreview-3",
            }
        )

    def sha(seed: str) -> str:
        return (seed * 40)[:40]

    events: list[dict[str, Any]] = [
        {
            "id": "evt-100",
            "kind": "labeled",
            "actor": "ada",
            "createdAt": at(300_000),
            "label": {"name": "bug"},
        },
        {
            "id": f"evt-{sha('a')}",
            "kind": "committed",
            "actor": "Lin Zhao",
            "createdAt": at(900_000),
            "sha": sha("a"),
            "message": "fix(session): keep the refresh token",
            "checks": "passing",
        },
        {
            "id": f"evt-{sha('b')}",
            "kind": "committed",
            "actor": "Lin Zhao",
            "createdAt": at(960_000),
            "sha": sha("b"),
            "message": "test(session): cover the reload path",
            "checks": "failing",
        },
        {
            "id": f"evt-{sha('c')}",
            "kind": "committed",
            "actor": "Lin Zhao",
            "createdAt": at(1_020_000),
            "sha": sha("c"),
            "message": "chore: appease the linter",
            "checks": "pending",
        },
        {
            "id": f"evt-{sha('d')}",
            "kind": "committed",
            "actor": "Lin Zhao",
            "createdAt": at(1_080_000),
            "sha": sha("d"),
            "message": "docs: note the new behavior",
            "checks": None,
        },
        {
            "id": "evt-101",
            "kind": "cross-referenced",
            "actor": "grace",
            "createdAt": at(1_500_000),
            "refNumber": 42,
        },
    ]
    if kind == "pr":
        events.append(
            {"id": "evt-102", "kind": "merged", "actor": "grace", "createdAt": at(1_800_000)}
        )
    return {
        "available": True,
        "comments": comments,
        "events": events,
        "detail": {"body": "Mock body."},
    }


def _after(later: str | None, earlier: str | None) -> bool:
    if not later or not earlier:
        return False
    return later > earlier


def repo_handle(cwd: Path) -> str:
    """`owner/name` of the repository `gh` resolves in `cwd`, or empty."""
    return _handle(cwd)


def _handle(cwd: Path) -> str:
    ok, out, _err = _gh(cwd, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
    return out.strip() if ok else ""


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _loads(text: str) -> Any:
    try:
        return json.loads(text) if text.strip() else {}
    except json.JSONDecodeError:
        return {}


def _missing(err: str) -> bool:
    folded = err.lower()
    if "enoent" in folded or "no such file" in folded:
        return True
    return "not found" in folded and "gh" in folded


def _reason(err: str) -> str:
    if "no such file" in err.lower() or "enoent" in err.lower() or err.startswith("[Errno 2]"):
        return "gh CLI not found — install it and run `gh auth login`"
    line = err.strip().splitlines()
    return line[0] if line else "GitHub could not be reached"


def _ref_unavailable(err: str) -> dict[str, Any]:
    return {"available": False, "reason": _reason(err), "recheckAfterMs": None}
