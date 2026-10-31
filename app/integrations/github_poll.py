"""Poll GitHub for automation candidates through the `gh` CLI (TypeScript `github-poller.ts`).

One poll turns an automation's `events` and `filters` into candidates: opened pull requests and
issues, label changes and review activity reconstructed from the issue timeline, and closed or
merged pull requests. Nothing here writes. The caller dedupes on `Candidate.event_id`, which is
stable for the same GitHub event across polls.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

EVENTS = (
    "pull_request.opened",
    "issue.opened",
    "issue.labeled",
    "issue.unlabeled",
    "pull_request.reviewed",
    "pull_request.review_requested",
    "pull_request.rereview_requested",
    "pull_request.closed",
    "pull_request.merged",
)
LIST_FILTERS = (
    "authors",
    "assignees",
    "allLabels",
    "anyLabels",
    "excludeLabels",
    "changedLabels",
    "reviewers",
)
CAP = 100
TIMELINE_PAGE = 100
TIMELINE_PAGES = 5
CLOSED_PAGES = 10
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

Gh = Callable[[list[str]], str]


class GhError(Exception):
    pass


def gh_api(args: list[str], *, host: str = "") -> str:
    """Run `gh <args>`; raise `GhError` with the first stderr line on failure."""
    argv = ["gh", *args]
    if host and host.lower() != "github.com" and args[:1] == ["api"]:
        argv = ["gh", "api", "--hostname", host, *args[1:]]
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            env={**os.environ, "GH_PROMPT_DISABLED": "1"},
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GhError(str(exc)) from exc
    if proc.returncode != 0:
        lines = (proc.stderr or proc.stdout).strip().splitlines()
        raise GhError(lines[0] if lines else "gh failed")
    return proc.stdout


@dataclass(frozen=True, slots=True)
class Candidate:
    event_id: str
    event: str
    timestamp: str
    tie_breaker: str
    repo: str
    node_id: str
    number: int
    title: str
    url: str
    author: str
    assignees: tuple[str, ...] = ()
    labels: tuple[str, ...] = ()
    changed_label: str = ""
    reviewer: str = ""

    def to_json(self) -> dict[str, object]:
        return {
            "eventId": self.event_id,
            "event": self.event,
            "timestamp": self.timestamp,
            "tieBreaker": self.tie_breaker,
            "repo": self.repo,
            "nodeId": self.node_id,
            "number": self.number,
            "title": self.title,
            "url": self.url,
            "author": self.author,
            "assignees": list(self.assignees),
            "labels": list(self.labels),
            "changedLabel": self.changed_label,
            "reviewer": self.reviewer,
        }

    @classmethod
    def from_json(cls, raw: object) -> Candidate | None:
        if not isinstance(raw, dict):
            return None
        number = raw.get("number")
        event = raw.get("event")
        if not isinstance(number, int) or isinstance(number, bool) or event not in EVENTS:
            return None
        return cls(
            event_id=str(raw.get("eventId", "")),
            event=str(event),
            timestamp=str(raw.get("timestamp", "")),
            tie_breaker=str(raw.get("tieBreaker", "")),
            repo=str(raw.get("repo", "")),
            node_id=str(raw.get("nodeId", "")),
            number=number,
            title=str(raw.get("title", "")),
            url=str(raw.get("url", "")),
            author=str(raw.get("author", "")),
            assignees=_strings(raw.get("assignees")),
            labels=_strings(raw.get("labels")),
            changed_label=str(raw.get("changedLabel", "")),
            reviewer=str(raw.get("reviewer", "")),
        )


@dataclass(slots=True)
class PollResult:
    candidates: list[Candidate] = field(default_factory=list)
    truncated: bool = False
    cursor: str = ""


def _strings(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str))


def zstamp(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def lookback_start(filters: dict[str, object], moment: datetime) -> str:
    days = _bounded(filters.get("lookbackDays"), 7, 1, 90)
    return (moment - timedelta(days=days)).strftime("%Y-%m-%d")


def _bounded(value: object, default: int, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return min(max(value, low), high)


def definition_issue(kind: str, events: tuple[str, ...], filters: dict[str, object]) -> str | None:
    """The reason a kind, event list and filter object cannot be stored, or None."""
    if kind not in ("schedule", "github", "tracker"):
        return "kind must be schedule, github or tracker"
    for key in LIST_FILTERS:
        value = filters.get(key)
        if value is None:
            continue
        if not isinstance(value, list) or len(value) > 100:
            return f"filters.{key} must be a list of at most 100 strings"
        if any(not isinstance(item, str) or not item.strip() or len(item) > 200 for item in value):
            return f"filters.{key} must be a list of 1 to 200 character strings"
    for key, low, high in (("lookbackDays", 1, 90), ("maxRecords", 1, CAP)):
        value = filters.get(key)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            return f"filters.{key} must be a number from {low} to {high}"
    repo = filters.get("repo")
    if repo not in (None, "") and (not isinstance(repo, str) or not REPO_RE.match(repo)):
        return "filters.repo must be owner/name"
    if kind != "github":
        return None
    if not events or len(events) > len(EVENTS):
        return "a GitHub automation needs at least one event"
    unknown = [item for item in events if item not in EVENTS]
    if unknown:
        return f"unknown event {unknown[0]}"
    checkout = filters.get("checkout")
    fork_heads = filters.get("allowForkHeads")
    if checkout not in (None, "", "base", "pr-head"):
        return "filters.checkout must be base or pr-head"
    if fork_heads is not None and not isinstance(fork_heads, bool):
        return "filters.allowForkHeads must be true or false"
    if checkout == "pr-head":
        if any(not item.startswith("pull_request.") for item in events):
            return "checkout pr-head needs pull_request events only"
        if "pull_request.closed" in events or "pull_request.merged" in events:
            return "checkout pr-head cannot be used with pull_request.closed or pull_request.merged"
    elif fork_heads:
        return "filters.allowForkHeads needs checkout pr-head"
    wants_labels = "issue.labeled" in events or "issue.unlabeled" in events
    if wants_labels and not filters.get("changedLabels"):
        return "filters.changedLabels is required for issue label events"
    return None


def build_query(
    repo: str,
    filters: dict[str, object],
    *,
    family: str,
    activity: str,
    since: str,
    open_only: bool = False,
) -> str:
    terms = [
        f"repo:{repo}",
        "is:pr" if family == "prs" else "is:issue" if family == "issues" else "",
        "is:open" if open_only else "",
        f"{activity}:>={since}",
    ]
    for key, qualifier in (("authors", "author"), ("assignees", "assignee")):
        for name in _strings(filters.get(key)):
            terms.append(f"{qualifier}:{re.sub(r'[^A-Za-z0-9_.-]', '', name)}")
    for label in _strings(filters.get("allLabels")):
        terms.append(f"label:{json.dumps(label)}")
    return " ".join(term for term in terms if term)


def matches_filters(candidate: Candidate, filters: dict[str, object]) -> bool:
    def low(key: str) -> set[str]:
        return {value.lower() for value in _strings(filters.get(key))}

    labels = {value.lower() for value in candidate.labels}
    if low("authors") and candidate.author.lower() not in low("authors"):
        return False
    if low("assignees") and not any(
        item.lower() in low("assignees") for item in candidate.assignees
    ):
        return False
    if any(value not in labels for value in low("allLabels")):
        return False
    if low("anyLabels") and not labels & low("anyLabels"):
        return False
    if labels & low("excludeLabels"):
        return False
    if candidate.changed_label and low("changedLabels"):
        if candidate.changed_label.lower() not in low("changedLabels"):
            return False
    if (
        candidate.reviewer
        and low("reviewers")
        and candidate.reviewer.lower() not in low("reviewers")
    ):
        return False
    return True


def poll(
    repo: str,
    events: tuple[str, ...],
    filters: dict[str, object],
    *,
    since: str,
    gh: Gh,
    enterprise: bool = False,
) -> PollResult:
    """Candidates for `events` since `since` (a date or a `…Z` timestamp). Raises `GhError`."""
    wanted = set(events)
    opened = wanted & {"pull_request.opened", "issue.opened"}
    labels = wanted & {"issue.labeled", "issue.unlabeled"}
    reviews = wanted & {
        "pull_request.reviewed",
        "pull_request.review_requested",
        "pull_request.rereview_requested",
    }
    closed = wanted & {"pull_request.closed", "pull_request.merged"}
    sources: list[tuple[str, str]] = []
    if opened:
        family = (
            "prs"
            if opened == {"pull_request.opened"}
            else "issues"
            if opened == {"issue.opened"}
            else "mixed"
        )
        sources.append((family, "created"))
    if labels:
        sources.append(("labels", "updated"))
    if reviews:
        sources.append(("reviews", "updated"))
    if closed:
        sources.append(("closed", "closed"))
    cap = min(_bounded(filters.get("maxRecords"), 25, 1, CAP), CAP)
    expected = f"/repos/{repo}".lower()
    observations: list[tuple[str, str, Candidate | None]] = []
    truncated = False
    for family, activity in sources:
        is_closed = family == "closed"
        is_reviews = family == "reviews"
        is_labels = family == "labels"
        query = build_query(
            repo,
            filters,
            family="prs" if is_reviews or is_closed else "issues" if is_labels else family,
            activity=activity,
            since=since,
            open_only=is_reviews,
        )

        def search(
            page: int, query: str = query, is_closed: bool = is_closed, activity: str = activity
        ) -> list[dict[str, Any]]:
            args = [
                "api", "--method", "GET", "/search/issues",
                "-f", f"q={query}",
                "-f", f"per_page={CAP if is_closed else cap}",
                "-f", f"sort={'updated' if is_closed else activity}",
                "-f", "order=asc",
            ]  # fmt: skip
            if page > 1:
                args += ["-f", f"page={page}"]
            body = _json(gh(args))
            rows = body.get("items") if isinstance(body, dict) else None
            return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []

        items = search(1)
        if is_closed:
            last = items
            page = 2
            while len(last) >= CAP and page <= CLOSED_PAGES:
                last = search(page)
                items = [*items, *last]
                page += 1
        truncated = truncated or len(items) >= cap
        found: list[tuple[str, str, Candidate | None]] = []
        for item in items if is_closed else items[:CAP]:
            parsed = _item(item)
            if parsed is None:
                continue
            url = str(item.get("repository_url", "")).lower()
            if not url.endswith(expected) or (
                not enterprise and url != f"https://api.github.com{expected}"
            ):
                continue
            is_pr = item.get("pull_request") is not None
            if family in ("prs", "issues", "mixed"):
                event = "pull_request.opened" if is_pr else "issue.opened"
                if event in wanted:
                    cand = _opened(repo, parsed, event)
                    if _at_or_after(cand.timestamp, since):
                        keep = cand if matches_filters(cand, filters) else None
                        found.append((cand.timestamp, cand.tie_breaker, keep))
            if is_closed and is_pr:
                cand = _closed(repo, parsed, item.get("pull_request"))
                if cand is not None and _at_or_after(cand.timestamp, since):
                    keep = cand if cand.event in wanted and matches_filters(cand, filters) else None
                    found.append((cand.timestamp, cand.tie_breaker, keep))
            if is_labels and not is_pr:
                rows = _label_events(repo, parsed, _timeline(gh, repo, parsed["number"]))
                for row in rows:
                    if _at_or_after(row.timestamp, since):
                        keep = (
                            row if row.event in wanted and matches_filters(row, filters) else None
                        )
                        found.append((row.timestamp, row.tie_breaker, keep))
                        if len(found) >= cap:
                            break
                _activity(found, parsed, rows, since, cap)
            if is_reviews and is_pr:
                rows = _review_events(repo, parsed, _timeline(gh, repo, parsed["number"]))
                merge = {
                    "pull_request.review_requested",
                    "pull_request.rereview_requested",
                } <= wanted
                rereviewed = {
                    r.tie_breaker for r in rows if r.event == "pull_request.rereview_requested"
                }
                for row in rows:
                    if not _at_or_after(row.timestamp, since):
                        continue
                    superseded = (
                        merge
                        and row.event == "pull_request.review_requested"
                        and f"{row.tie_breaker}:rereview" in rereviewed
                    )
                    keep = (
                        row
                        if not superseded and row.event in wanted and matches_filters(row, filters)
                        else None
                    )
                    found.append((row.timestamp, row.tie_breaker, keep))
                    if len(found) >= cap:
                        break
                _activity(found, parsed, rows, since, cap)
            if not is_closed and len(found) >= cap:
                break
        found.sort(key=lambda row: (row[0], row[1]))
        truncated = truncated or len(found) >= cap
        observations.extend(found[:cap])
    observations.sort(key=lambda row: (row[0], row[1]))
    evaluated = observations[:cap]
    kept = [row[2] for row in evaluated if row[2] is not None]
    return PollResult(
        candidates=_one_per_pull_request(kept),
        truncated=truncated or len(observations) > cap,
        cursor=evaluated[-1][0] if evaluated else "",
    )


def _activity(
    found: list[tuple[str, str, Candidate | None]],
    item: dict[str, Any],
    rows: list[Candidate],
    since: str,
    cap: int,
) -> None:
    updated = str(item.get("updated_at", ""))
    last = rows[-1].timestamp if rows else ""
    if (
        len(found) < cap
        and updated
        and _at_or_after(updated, since)
        and (not last or updated > last)
    ):
        found.append((updated, f"activity:{item['node_id']}", None))


def _one_per_pull_request(candidates: list[Candidate]) -> list[Candidate]:
    """One launch per PR per poll for review events: the latest row of each family wins."""

    def family(event: str) -> str:
        if event == "pull_request.reviewed":
            return "reviewed"
        if event in ("pull_request.review_requested", "pull_request.rereview_requested"):
            return "requested"
        return ""

    latest: dict[str, Candidate] = {}
    for cand in candidates:
        if family(cand.event):
            latest[f"{cand.number}:{family(cand.event)}"] = cand
    kept = {id(value) for value in latest.values()}
    return [c for c in candidates if not family(c.event) or id(c) in kept]


def _json(text: str) -> Any:
    try:
        return json.loads(text) if text.strip() else {}
    except json.JSONDecodeError as exc:
        raise GhError("GitHub returned something that is not JSON") from exc


def _item(item: dict[str, Any]) -> dict[str, Any] | None:
    user = item.get("user")
    number = item.get("number")
    if (
        not isinstance(user, dict)
        or not isinstance(user.get("login"), str)
        or not isinstance(number, int)
        or isinstance(number, bool)
        or not isinstance(item.get("node_id"), str)
        or not item["node_id"]
        or not isinstance(item.get("created_at"), str)
        or not isinstance(item.get("html_url"), str)
    ):
        return None
    return item


def _clean(value: str, limit: int) -> str:
    return re.sub(r"[\x00-\x1f\x7f]", " ", value)[:limit]


def _opened(repo: str, item: dict[str, Any], event: str) -> Candidate:
    node = str(item["node_id"])
    created = str(item["created_at"])
    assignees = tuple(
        str(a["login"]) for a in item.get("assignees") or [] if isinstance(a, dict) and "login" in a
    )
    labels = tuple(
        str(a["name"]) for a in item.get("labels") or [] if isinstance(a, dict) and "name" in a
    )
    return Candidate(
        event_id=f"{repo}:{node}:{event}:{created}",
        event=event,
        timestamp=created,
        tie_breaker=node,
        repo=repo,
        node_id=node,
        number=int(item["number"]),
        title=_clean(str(item.get("title", "")), 500),
        url=str(item["html_url"]),
        author=str(item["user"]["login"]),
        assignees=assignees,
        labels=labels,
    )


def _closed(repo: str, item: dict[str, Any], stub: object) -> Candidate | None:
    closed_at = item.get("closed_at")
    if not isinstance(closed_at, str) or not closed_at:
        return None
    merged = stub.get("merged_at") if isinstance(stub, dict) else None
    event = "pull_request.merged" if isinstance(merged, str) and merged else "pull_request.closed"
    when = str(merged) if event == "pull_request.merged" else closed_at
    base = _opened(repo, item, "pull_request.opened")
    return Candidate(
        **{
            **_fields(base),
            "event": event,
            "event_id": f"{repo}:{base.node_id}:{event}:{when}",
            "timestamp": when,
            "tie_breaker": f"{base.node_id}:{event}",
        }
    )


def _fields(candidate: Candidate) -> dict[str, Any]:
    return {name: getattr(candidate, name) for name in Candidate.__slots__}


def _with(candidate: Candidate, **changes: Any) -> Candidate:
    return Candidate(**{**_fields(candidate), **changes})


def _label_events(
    repo: str, item: dict[str, Any], timeline: list[dict[str, Any]]
) -> list[Candidate]:
    entries = [
        row
        for row in timeline
        if row.get("event") in ("labeled", "unlabeled")
        and isinstance(row.get("created_at"), str)
        and isinstance(row.get("label"), dict)
        and isinstance(row["label"].get("name"), str)
    ]
    current = {str(a["name"]) for a in item.get("labels") or [] if isinstance(a, dict)}
    base = _opened(repo, item, "issue.opened")
    rows: list[Candidate] = []
    for entry in sorted(entries, key=lambda row: row["created_at"], reverse=True):
        post = sorted(current)
        name = entry["label"]["name"]
        if entry["event"] == "labeled":
            current.discard(name)
        else:
            current.add(name)
        labels = post if entry["event"] == "labeled" else sorted(current)
        kind = "issue.labeled" if entry["event"] == "labeled" else "issue.unlabeled"
        stable = str(
            entry.get("node_id") or entry.get("id") or f"{entry['created_at']}:{name.lower()}"
        )
        rows.append(
            _with(
                base,
                event=kind,
                event_id=f"{repo}:{base.node_id}:{kind}:{stable}",
                timestamp=entry["created_at"],
                tie_breaker=stable,
                labels=tuple(labels),
                changed_label=name,
            )
        )
    return sorted(rows, key=lambda row: (row.timestamp, row.tie_breaker))


def _review_events(
    repo: str, item: dict[str, Any], timeline: list[dict[str, Any]]
) -> list[Candidate]:
    entries: list[tuple[str, dict[str, Any]]] = []
    for row in timeline:
        if (
            row.get("event") == "reviewed"
            and isinstance(row.get("submitted_at"), str)
            and isinstance(row.get("user"), dict)
            and isinstance(row["user"].get("login"), str)
        ):
            entries.append((row["submitted_at"], row))
        elif row.get("event") == "review_requested" and isinstance(row.get("created_at"), str):
            entries.append((row["created_at"], row))
    base = _opened(repo, item, "pull_request.opened")
    has_reviewed: set[str] = set()
    rows: list[Candidate] = []
    for at, entry in sorted(entries, key=lambda pair: pair[0]):
        stable = str(entry.get("node_id") or entry.get("id") or entry["event"])
        if entry["event"] == "reviewed":
            login = str(entry["user"]["login"])
            rows.append(
                _with(
                    base,
                    event="pull_request.reviewed",
                    event_id=f"{repo}:{base.node_id}:pull_request.reviewed:{stable}",
                    timestamp=at,
                    tie_breaker=stable,
                    reviewer=login,
                )
            )
            has_reviewed.add(login.lower())
            continue
        requested = entry.get("requested_reviewer")
        reviewer = requested.get("login") if isinstance(requested, dict) else None
        if not isinstance(reviewer, str) or not reviewer:
            continue
        rows.append(
            _with(
                base,
                event="pull_request.review_requested",
                event_id=f"{repo}:{base.node_id}:pull_request.review_requested:{stable}",
                timestamp=at,
                tie_breaker=stable,
                reviewer=reviewer,
            )
        )
        if reviewer.lower() in has_reviewed:
            rows.append(
                _with(
                    base,
                    event="pull_request.rereview_requested",
                    event_id=f"{repo}:{base.node_id}:pull_request.rereview_requested:{stable}",
                    timestamp=at,
                    tie_breaker=f"{stable}:rereview",
                    reviewer=reviewer,
                )
            )
    return sorted(rows, key=lambda row: (row.timestamp, row.tie_breaker))


def _timeline(gh: Gh, repo: str, number: int) -> list[dict[str, Any]]:
    """One issue or PR timeline with the NEWEST rows present (GitHub returns it ascending)."""
    first = _timeline_page(gh, repo, number, 1)
    if len(first) < TIMELINE_PAGE:
        return first
    raw = gh(
        [
            "api", "--include", "--method", "GET", f"repos/{repo}/issues/{number}/timeline",
            "-H", "Accept: application/vnd.github+json", "-f", f"per_page={TIMELINE_PAGE}",
        ]
    )  # fmt: skip
    last = last_page(raw)
    start = max(2, last - TIMELINE_PAGES + 1)
    rows = list(first) if start == 2 else []
    for page in range(start, last + 1):
        rows.extend(_timeline_page(gh, repo, number, page))
    return rows


def _timeline_page(gh: Gh, repo: str, number: int, page: int) -> list[dict[str, Any]]:
    raw = gh(
        [
            "api", "--method", "GET", f"repos/{repo}/issues/{number}/timeline",
            "-H", "Accept: application/vnd.github+json", "-f", f"per_page={TIMELINE_PAGE}",
            "-f", f"page={page}",
        ]
    )  # fmt: skip
    loaded = _json(raw)
    return [row for row in loaded if isinstance(row, dict)] if isinstance(loaded, list) else []


def last_page(raw: str) -> int:
    """`<…page=7>; rel="last"` out of a `gh api --include` response; 1 when there is none."""
    header = re.split(r"\r?\n\r?\n", raw, maxsplit=1)[0]
    link = next((ln for ln in header.splitlines() if ln.lower().startswith("link:")), "")
    for part in link.split(","):
        if not re.search(r'rel="?last"?', part):
            continue
        found = re.search(r"[?&]page=(\d+)", part)
        if found and int(found.group(1)) > 0:
            return int(found.group(1))
    return 1


def _at_or_after(timestamp: str, since: str) -> bool:
    return not since or timestamp >= since


def pr_head(gh: Gh, repo: str, number: int) -> dict[str, str] | None:
    """`headSha`, `headRef`, `baseRef` of a pull request, or None when GitHub does not say."""
    try:
        body = _json(gh(["api", "--method", "GET", f"repos/{repo}/pulls/{number}"]))
    except GhError:
        return None
    head = body.get("head") if isinstance(body, dict) else None
    base = body.get("base") if isinstance(body, dict) else None
    if not isinstance(head, dict) or not isinstance(base, dict):
        return None
    sha, ref, base_ref = head.get("sha"), head.get("ref"), base.get("ref")
    if not (isinstance(sha, str) and isinstance(ref, str) and isinstance(base_ref, str)):
        return None
    return {"headSha": sha, "headRef": ref, "baseRef": base_ref}
