"""GitHub merge eligibility. The ladder matches `normalizeMergeState`.

Unknown requirements stay unknown. `canMerge` is true only when eligibility
is `ready`. Dry-run builds a ready document and does not call `gh`.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.engine.gitwork import gh as _gh

_METHODS = ("squash", "merge", "rebase")
_PASSING = frozenset({"SUCCESS", "NEUTRAL", "SKIPPED"})
_FAILING = frozenset({"FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"})
_PENDING = frozenset({"PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING", "REQUESTED"})


def normalize_merge_state(
    pr: dict[str, object],
    policy: dict[str, object],
    *,
    requirements_readable: bool = True,
    required_checks: list[str] | None = None,
    checks_tier: str = "detailed",
) -> dict[str, object]:
    required = required_checks or []
    state = _state(str(pr.get("state", "OPEN")))
    mergeable = _mergeable(pr.get("mergeable"))
    review = _review(pr.get("reviewDecision"))
    rollup = _list(pr.get("statusCheckRollup"))
    checks = [_check(item, requirements_readable, required, checks_tier) for item in rollup]
    methods = _methods(policy)
    default = _default_method(policy, methods)
    blockers: list[dict[str, str]] = []
    eligibility = "ready"
    draft = pr.get("isDraft") is True
    status = str(pr.get("mergeStateStatus", "")).upper()
    if state != "open":
        eligibility = "terminal"
        message = (
            "This pull request is merged." if state == "merged" else "This pull request is closed."
        )
        blockers.append(_blocker("terminal", message))
    elif draft:
        eligibility = "blocked"
        blockers.append(_blocker("draft", "Mark the pull request ready for review before merging."))
    elif mergeable == "conflicting":
        eligibility = "blocked"
        blockers.append(_blocker("conflicts", "Conflicts must be resolved before merging."))
    elif any(item["state"] == "failing" for item in checks):
        eligibility = "blocked"
        blockers.append(_blocker("checks-failing", "One or more checks are failing."))
    elif review in ("changes-requested", "review-required"):
        eligibility = "blocked"
        if review == "changes-requested":
            blockers.append(_blocker("reviews", "Changes were requested."))
        else:
            blockers.append(_blocker("reviews", "A required review is missing."))
    elif checks_tier == "none":
        eligibility = "unknown"
        blockers.append(
            _blocker("checks-unknown", "This token cannot read the checks on this pull request.")
        )
    elif review == "unknown" or not requirements_readable:
        eligibility = "unknown"
        blockers.append(
            {
                "code": "rules-unknown",
                "message": "GitHub could not confirm review and branch-protection requirements.",
            }
        )
    elif any(item["state"] == "pending" for item in checks) or status == "UNSTABLE":
        eligibility = "pending"
        blockers.append(_blocker("pending", "Checks or GitHub mergeability are still pending."))
    elif mergeable != "mergeable" or status not in ("CLEAN", "HAS_HOOKS") or not methods:
        eligibility = "unknown"
        blockers.append(_blocker("unknown", "GitHub could not confirm every merge requirement."))
    can_merge = eligibility == "ready"
    return {
        "number": pr.get("number"),
        "title": str(pr.get("title", "")),
        "url": str(pr.get("url", "")),
        "state": state,
        "isDraft": draft,
        "headRef": str(pr.get("headRefName", "")),
        "baseRef": str(pr.get("baseRefName", "")),
        "headSha": str(pr.get("headRefOid", "")),
        "mergeable": mergeable,
        "reviewDecision": review,
        "checks": checks,
        "checksTier": checks_tier,
        "methods": methods,
        "defaultMethod": default,
        "eligibility": eligibility,
        "blockers": blockers,
        "canMerge": can_merge,
    }


def dry_run_merge_state(number: int) -> dict[str, object]:
    return normalize_merge_state(
        {
            "number": number,
            "title": f"Pull request {number}",
            "url": f"https://github.com/open-mercato/demo/pull/{number}",
            "state": "OPEN",
            "isDraft": False,
            "headRefName": "cez/demo",
            "baseRefName": "main",
            "headRefOid": "a" * 40,
            "mergeable": "MERGEABLE",
            "reviewDecision": "APPROVED",
            "mergeStateStatus": "CLEAN",
            "statusCheckRollup": [{"name": "ci", "state": "SUCCESS"}],
        },
        {
            "allow_squash_merge": True,
            "allow_merge_commit": True,
            "allow_rebase_merge": True,
            "squash_merge_commit_title": "PR_TITLE",
        },
    )


def load_merge_state(number: int, cwd: Path) -> tuple[dict[str, object] | None, str]:
    fields = ",".join(
        (
            "number",
            "title",
            "url",
            "state",
            "isDraft",
            "headRefName",
            "baseRefName",
            "headRefOid",
            "mergeable",
            "reviewDecision",
            "mergeStateStatus",
            "statusCheckRollup",
        )
    )
    ok, out, err = _gh(cwd, ["pr", "view", str(number), "--json", fields])
    if not ok:
        return None, err or "gh pr view failed"
    try:
        pr = json.loads(out)
    except json.JSONDecodeError:
        return None, "gh pr view did not return JSON"
    if not isinstance(pr, dict):
        return None, "gh pr view did not return an object"
    policy_ok, policy_out, _policy_err = _gh(
        cwd,
        ["repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"],
    )
    policy = _policy(policy_out) if policy_ok else {}
    tier = "detailed" if isinstance(pr.get("statusCheckRollup"), list) else "none"
    return normalize_merge_state(pr, policy, checks_tier=tier, requirements_readable=policy_ok), ""


def _policy(raw: str) -> dict[str, object]:
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(loaded, dict):
        return {}
    return {
        "allow_squash_merge": loaded.get("squashMergeAllowed") is True,
        "allow_merge_commit": loaded.get("mergeCommitAllowed") is True,
        "allow_rebase_merge": loaded.get("rebaseMergeAllowed") is True,
        "squash_merge_commit_title": "PR_TITLE" if loaded.get("squashMergeAllowed") is True else "",
    }


def _blocker(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _state(value: str) -> str:
    upper = value.upper()
    if upper == "MERGED":
        return "merged"
    if upper == "CLOSED":
        return "closed"
    return "open"


def _mergeable(value: object) -> str:
    upper = str(value or "").upper()
    if upper == "MERGEABLE":
        return "mergeable"
    if upper == "CONFLICTING":
        return "conflicting"
    return "unknown"


def _review(value: object) -> str:
    upper = str(value or "").upper()
    if upper == "APPROVED":
        return "approved"
    if upper == "CHANGES_REQUESTED":
        return "changes-requested"
    if upper == "REVIEW_REQUIRED":
        return "review-required"
    return "unknown"


def _check(item: object, readable: bool, required: list[str], tier: str) -> dict[str, object]:
    raw = item if isinstance(item, dict) else {}
    value = str(raw.get("conclusion") or raw.get("state") or raw.get("status") or "").upper()
    if value in _PASSING:
        state = "passing"
    elif value in _FAILING:
        state = "failing"
    elif value in _PENDING:
        state = "pending"
    else:
        state = "unknown"
    name = str(raw.get("name", ""))
    if tier == "aggregate" or not readable:
        needed: bool | None = None
    else:
        needed = name in required
    return {"name": name, "state": state, "required": needed}


def _methods(policy: dict[str, object]) -> list[str]:
    methods: list[str] = []
    if policy.get("allow_squash_merge") is True:
        methods.append("squash")
    if policy.get("allow_merge_commit") is True:
        methods.append("merge")
    if policy.get("allow_rebase_merge") is True:
        methods.append("rebase")
    return [name for name in methods if name in _METHODS]


def _default_method(policy: dict[str, object], methods: list[str]) -> str | None:
    if policy.get("squash_merge_commit_title") and "squash" in methods:
        return "squash"
    if policy.get("merge_commit_title") and "merge" in methods:
        return "merge"
    return methods[0] if methods else None


def _list(value: object) -> list[object]:
    if isinstance(value, list):
        return value
    return []
