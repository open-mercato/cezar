from typing import Any

from stario import h
from stario.markup import HtmlElement

from app.common.diff import diff_block
from app.common.shell import Chrome, frame
from app.features.github.urls import GITHUB_ISSUE, GITHUB_PR, GITHUB_PRS, PR_PANES, PrView
from app.features.places.urls import GITHUB


def _shell(chrome: Chrome, tab: str, element_id: str, *children: HtmlElement) -> HtmlElement:
    return frame(chrome, None, {"tab": tab}, h.Main({"id": element_id}, *children))


def _notice(reason: str) -> HtmlElement:
    return h.P({"class": "sub", "id": "github-notice"}, reason)


def pr_list(prs: list[dict[str, Any]], notice: str, chrome: Chrome, tab: str) -> HtmlElement:
    rows = [
        h.A(
            {"class": "task-row", "href": GITHUB_PR.href(str(row.get("number")))},
            h.Strong(f"#{row.get('number')}"),
            h.Span(str(row.get("title", ""))),
            h.Span({"class": "meta"}, "draft") if row.get("isDraft") else None,
        )
        for row in prs
    ]
    return _shell(
        chrome,
        tab,
        "github-prs",
        h.H1("Pull requests"),
        h.Nav({"class": "filters"}, h.A({"href": GITHUB.href()}, "Issues")),
        _notice(notice) if notice else None,
        h.Div({"class": "task-list", "id": "pr-rows"}, *rows)
        if rows
        else h.P({"class": "muted"}, "No open pull requests."),
    )


def _labels(item: dict[str, Any]) -> HtmlElement | None:
    labels = item.get("labels")
    names = [str(name) for name in labels] if isinstance(labels, list) else []
    return h.P({"class": "meta"}, "Labels: " + ", ".join(names)) if names else None


def _comments(payload: dict[str, Any]) -> HtmlElement:
    if payload.get("available") is not True:
        return h.P({"class": "muted"}, str(payload.get("reason", "Comments are unavailable.")))
    rows = payload.get("comments")
    comments = [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
    if not comments:
        return h.P({"class": "muted"}, "No comments.")
    return h.Div(
        {"class": "stack", "id": "comments"},
        *[
            h.Div(
                {"class": "comment"},
                h.Strong(str(row.get("author", ""))),
                h.Span({"class": "meta"}, f" {row.get('kind', 'comment')}"),
                h.P(str(row.get("body", ""))),
            )
            for row in comments
        ],
    )


def issue(
    number: int, item: dict[str, Any], comments: dict[str, Any], chrome: Chrome, tab: str
) -> HtmlElement:
    return _shell(
        chrome,
        tab,
        "github-issue",
        h.H1(f"#{number} {item.get('title', '')}"),
        h.Nav({"class": "filters"}, h.A({"href": GITHUB.href()}, "Issues")),
        h.P(
            {"class": "meta", "id": "issue-state"},
            f"{str(item.get('state', 'open')).lower()} · {item.get('author', '')}",
        ),
        _labels(item),
        h.P(
            {"class": "pr-body", "id": "issue-body"}, str(item.get("body", "")) or "No description."
        ),
        h.A({"href": str(item.get("url", "")), "rel": "noreferrer"}, "Open on GitHub")
        if item.get("url")
        else None,
        h.H2("Comments"),
        _comments(comments),
    )


def pr(
    number: int,
    item: dict[str, Any],
    view: PrView,
    comments: dict[str, Any],
    changes: dict[str, Any] | None,
    chrome: Chrome,
    tab: str,
) -> HtmlElement:
    panes = h.Nav(
        {"class": "filters", "id": "pr-panes"},
        *[
            h.A(
                {"href": GITHUB_PR.href(str(number), query={"pane": name})}
                | ({"class": "on"} if name == view.pane else {}),
                name,
            )
            for name in PR_PANES
        ],
    )
    head = [
        h.H1(f"#{number} {item.get('title', '')}"),
        h.Nav({"class": "filters"}, h.A({"href": GITHUB_PRS.href()}, "All pull requests")),
        h.P(
            {"class": "meta", "id": "pr-state"},
            f"{str(item.get('state', 'open')).lower()}"
            f"{' · draft' if item.get('isDraft') else ''} · {item.get('author', '')}"
            f" · {item.get('headRefName', '')} → {item.get('baseRefName', '')}",
        ),
        _labels(item),
        panes,
    ]
    if view.pane == "changes":
        return _shell(chrome, tab, "github-pr", *head, *_changes(changes))
    return _shell(
        chrome,
        tab,
        "github-pr",
        *head,
        h.P({"class": "pr-body", "id": "pr-body"}, str(item.get("body", "")) or "No description."),
        h.A({"href": str(item.get("url", "")), "rel": "noreferrer"}, "Open on GitHub")
        if item.get("url")
        else None,
        h.H2("Comments"),
        _comments(comments),
    )


def _changes(changes: dict[str, Any] | None) -> list[HtmlElement]:
    if changes is None or changes.get("available") is not True:
        reason = str((changes or {}).get("reason", "Changes are unavailable."))
        return [h.P({"class": "muted", "id": "pr-changes"}, reason)]
    rows = changes.get("files")
    files = [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
    blocks: list[HtmlElement] = [
        h.P(
            {"class": "meta", "id": "pr-changes"},
            f"{len(files)} files · +{changes.get('additions', 0)} −{changes.get('deletions', 0)}",
        )
    ]
    if changes.get("truncated"):
        blocks.append(
            h.P({"class": "muted"}, "Some patches were not provided by GitHub and are not shown.")
        )
    for row in files:
        patch = row.get("patch")
        previous = row.get("previousPath")
        title = f"{previous} → {row.get('path')}" if previous else str(row.get("path", ""))
        blocks.append(
            h.Section(
                {"class": "diff-file"},
                h.H3(f"{title} ({row.get('status', 'modified')})"),
                diff_block(patch)
                if isinstance(patch, str)
                else h.P(
                    {"class": "muted"}, f"No patch: {row.get('patchUnavailableReason', 'n/a')}"
                ),
            )
        )
    return blocks


def missing(title: str, reason: str, chrome: Chrome, tab: str) -> HtmlElement:
    return _shell(chrome, tab, "github-missing", h.H1(title), h.P({"class": "sub"}, reason))


__all__ = ["GITHUB_ISSUE", "issue", "missing", "pr", "pr_list"]
