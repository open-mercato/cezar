from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame, status_chip
from app.engine.gitwork import Diff
from app.engine.model import Event, Run
from app.features.commit.urls import TASK_COMMIT_DETAIL
from app.features.places.urls import COMPARE
from app.features.task.data import list_commits, list_worktree_files, split_commit_line
from app.features.task.mermaid import diagrams
from app.features.task.urls import (
    TASK,
    TASK_APPROVE,
    TASK_CANCEL,
    TASK_COMMIT,
    TASK_DELETE,
    TASK_DISPATCH,
    TASK_FINISH,
    TASK_LIVE,
    TASK_MESSAGE,
    TASK_NOTES,
    TASK_PR,
    TASK_PR_ADOPT,
    TASK_PUSH,
    TASK_REJECT,
    TASK_REVIEW,
    TASK_SHELL,
    TaskView,
)


def render(
    run: Run,
    events: list[Event],
    children: list[Run],
    view: TaskView,
    diff: Diff | None,
    chrome: Chrome,
    tab: str,
    merge: dict[str, object] | None = None,
) -> HtmlElement:
    steps = run.definition().steps
    rail = []
    for index, step in enumerate(steps):
        klass = "here" if index == run.step_index and run.status == "running" else ""
        attrs = {"class": klass} if klass else {}
        rail.append(h.Li(attrs, step.name or step.id))
    transcript = [
        h.Li(
            {"class": f"ev ev-{event.type}"},
            h.Span({"class": "ev-type"}, event.type),
            event.text,
            *diagrams(event.text),
        )
        for event in events
    ]
    actions: list[HtmlElement] = []
    if run.status in ("queued", "running", "waiting", "review"):
        actions.append(_button(TASK_CANCEL.href(run.id), "Cancel"))
    if run.status == "review":
        actions += [
            _button(TASK_FINISH.href(run.id), "Finish", "btn btn-primary"),
            _button(TASK_COMMIT.href(run.id), "Commit"),
            _button(TASK_PUSH.href(run.id), "Push"),
            _button(TASK_PR.href(run.id), "Draft PR"),
        ]
    if run.status in ("review", "done", "failed", "cancelled"):
        actions.append(_button(TASK_DELETE.href(run.id), "Delete", "btn btn-danger"))
    panes = h.Nav(
        {"class": "filters"},
        *[
            h.A({"href": TASK.href(run.id, query={"pane": pane})}, label)
            for pane, label in (
                ("session", "Session"),
                ("diff", "Changes"),
                ("files", "Files"),
                ("commits", "Commits"),
                ("graph", "Graph"),
                ("notes", "Notes"),
                ("terminal", "Terminal"),
                ("browser", "Browser"),
            )
        ],
    )
    blocks: list[HtmlElement] = [
        h.Div(
            {"class": "top"},
            h.Div(
                h.H1(run.title),
                h.P(
                    {"class": "sub"},
                    status_chip(run.status),
                    " ",
                    run.workflow,
                    " · ",
                    run.runner,
                    f" · variant {run.variant}" if run.variant else "",
                    f" · {run.branch}" if run.branch else "",
                    f" · {run.pull_request_url}" if run.pull_request_url else "",
                    " · " if run.group_id else "",
                    h.A({"href": COMPARE.href(run.id)}, "Compare") if run.group_id else None,
                ),
            ),
            h.Div({"class": "actions"}, *actions) if actions else None,
        ),
        _merge_box(merge, run.id) if merge and merge.get("available") else None,
        _adopt_form(run) if _can_adopt(run) else None,
        panes,
        h.Ol({"class": "steps"}, *rail),
    ]
    if run.error:
        blocks.append(h.P({"class": "error"}, run.error))
    if run.status == "waiting" and run.ask:
        blocks.append(h.Div({"class": "card-block ask"}, h.Strong("The agent asked"), h.P(run.ask)))
    blocks.extend(_pane(run, view, diff, transcript, len(events)))
    blocks.extend(_composers(run))
    if children:
        blocks.append(h.H2("Children"))
        blocks.append(
            h.Div(
                {"class": "stack"},
                *[
                    h.A(
                        {"class": "task-row", "href": TASK.href(child.id)},
                        status_chip(child.status),
                        h.Span(child.title),
                    )
                    for child in children
                ],
            )
        )
    blocks.append(
        h.P({"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error"))
    )
    return frame(
        chrome,
        TASK_LIVE.href(run.id, query=view.query()),
        {
            "tab": tab,
            "message": "",
            "objective": "",
            "notes": run.notes,
            "adopt_pr": "",
            "command": "",
            "_shell": "",
            "_error": "",
        },
        h.Main({"id": "task"}, *blocks),
    )


def _button(url: str, label: str, klass: str = "btn") -> HtmlElement:
    return h.Button(
        {"type": "button", "class": klass},
        data.on("click", at.post(url)),
        data.indicator("_saving"),
        label,
    )


def _composers(run: Run) -> list[HtmlElement]:
    """The gate, answer/follow-up and dispatch forms the run's status allows."""
    forms: list[HtmlElement] = []
    if run.status == "waiting" and run.graph_park.get("kind") == "gate.human":
        forms.append(
            h.Form(
                {"class": "composer", "id": "gate"},
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Comment (optional)"),
                    h.Textarea({"maxlength": "20000"}, data.bind("message")),
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "button"},
                    data.on("click", at.post(TASK_APPROVE.href(run.id))),
                    data.attr("disabled", "$_saving"),
                    "Approve",
                ),
                h.Button(
                    {"class": "btn btn-danger", "type": "button"},
                    data.on("click", at.post(TASK_REJECT.href(run.id))),
                    data.attr("disabled", "$_saving"),
                    "Reject",
                ),
            )
        )
    elif run.status in ("waiting", "review"):
        forms.append(
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(TASK_MESSAGE.href(run.id)), prevent=True),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Answer" if run.status == "waiting" else "Follow-up"),
                    h.Textarea({"required": True, "maxlength": "20000"}, data.bind("message")),
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Send",
                ),
            )
        )
    if run.status in ("running", "waiting") and run.branch:
        forms.append(
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(TASK_DISPATCH.href(run.id)), prevent=True),
                data.indicator("_dispatching"),
                h.Label(
                    {"class": "field"},
                    h.Span("Dispatch a child task"),
                    h.Textarea({"required": True, "maxlength": "4000"}, data.bind("objective")),
                ),
                h.Button(
                    {"class": "btn", "type": "submit"},
                    data.attr("disabled", "$_dispatching"),
                    "Dispatch",
                ),
            )
        )
    return forms


def _pane(
    run: Run, view: TaskView, diff: Diff | None, transcript: list, event_count: int
) -> list[HtmlElement]:
    if view.pane == "diff":
        body = diff.text if diff and diff.text else "No diff yet."
        return [h.Pre({"class": "diff"}, body)]
    if view.pane == "files":
        names = list_worktree_files(run.worktree_path)
        rows = [h.Li(name) for name in names] or [h.Li({"class": "muted"}, "No files yet.")]
        return [h.H2("Files"), h.Ul(*rows)]
    if view.pane == "commits":
        rows = []
        for line in list_commits(run.worktree_path):
            parsed = split_commit_line(line)
            if parsed is None:
                rows.append(h.Li(line))
                continue
            sha, subject = parsed
            rows.append(
                h.Li(h.A({"href": TASK_COMMIT_DETAIL.href(run.id, sha)}, sha), f" {subject}")
            )
        return [h.H2("Commits"), h.Ul(*(rows or [h.Li({"class": "muted"}, "No commits.")]))]
    if view.pane == "graph":
        graph = run.workflow_def.get("graph")
        nodes = graph.get("nodes") if isinstance(graph, dict) else None
        if isinstance(nodes, list) and nodes:
            rows = [
                h.Li(f"{item.get('id')} · {item.get('type')}")
                for item in nodes
                if isinstance(item, dict)
            ]
        else:
            rows = [h.Li(step.name or step.id) for step in run.definition().steps]
        return [h.H2("Graph"), h.Ol(*rows)]
    if view.pane == "notes":
        return [
            h.H2("Notes"),
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(TASK_NOTES.href(run.id)), prevent=True),
                h.Textarea({"maxlength": "20000"}, data.bind("notes")),
                h.Button({"class": "btn", "type": "submit"}, "Save notes"),
            ),
        ]
    if view.pane == "terminal":
        return [
            h.H2("Terminal"),
            h.P({"class": "sub"}, "A PTY in this task's worktree. Resize is cols and rows."),
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(TASK_SHELL.href(run.id)), prevent=True),
                h.Input(
                    {"required": True, "maxlength": "400", "aria-label": "Command"},
                    data.bind("command"),
                ),
                h.Button({"class": "btn", "type": "submit"}, "Run"),
            ),
            h.Pre({"id": "shell-output", "class": "diff"}, data.text("$_shell")),
        ]
    if view.pane == "browser":
        return [
            h.H2("Browser"),
            h.P(
                {"class": "sub"},
                "Design Mode mirrors a loopback http server and injects a picker marker. "
                "It is off when the cockpit is hosted.",
            ),
        ]
    virtual = view.thread == "virtual" or (view.thread != "flat" and event_count > 300)
    return [
        h.Ol(
            {
                "id": "transcript",
                "class": "transcript",
                "data-virtualized": "true" if virtual else "false",
                "data-window": "16",
            },
            data.init("app.thread.mount(el)"),
            *transcript,
        )
    ]


def _can_adopt(run: Run) -> bool:
    return bool(run.branch) and not run.in_place and not run.pull_request_url


def _adopt_form(run: Run) -> HtmlElement:
    return h.Form(
        {"class": "composer", "id": "adopt-pr"},
        data.on("submit", at.post(TASK_PR_ADOPT.href(run.id)), prevent=True),
        data.indicator("_adopting"),
        h.Label(
            {"class": "field"},
            h.Span("Adopt an existing pull request (number or URL, empty to find this branch's)"),
            h.Input({"maxlength": "300", "aria-label": "Pull request"}, data.bind("adopt_pr")),
        ),
        h.Button(
            {"class": "btn", "type": "submit"}, data.attr("disabled", "$_adopting"), "Adopt PR"
        ),
    )


def _merge_box(payload: dict[str, object], run_id: str) -> HtmlElement:
    state = payload.get("mergeState")
    inner = state if isinstance(state, dict) else {}
    heading = "Ready to merge" if inner.get("eligibility") == "ready" else "Merge blocked"
    blockers = inner.get("blockers")
    rows = blockers if isinstance(blockers, list) else []
    messages = [h.Li(str(item.get("message", ""))) for item in rows if isinstance(item, dict)]
    number = inner.get("number")
    button = None
    review = None
    if isinstance(number, int):
        review = h.Form(
            {"id": "review-form"},
            data.on("submit", at.post(TASK_REVIEW.href(run_id)), prevent=True),
            h.Select(
                data.bind("review_event"),
                h.Option({"value": "comment"}, "Comment"),
                h.Option({"value": "approve"}, "Approve"),
                h.Option({"value": "request-changes"}, "Request changes"),
            ),
            h.Textarea({"id": "review-body", "maxlength": "20000"}, data.bind("review_body")),
            h.Button({"class": "btn", "type": "submit"}, "Send review"),
        )
    if inner.get("canMerge") is True and isinstance(number, int):
        button = h.Button(
            {"type": "button", "class": "btn btn-primary", "id": "merge-pr"},
            data.on("click", at.post(f"/api/v1/github/prs/{number}/merge")),
            "Squash and merge",
        )
    return h.Section(
        {"id": "merge-box"},
        h.H2(heading),
        h.Ul(*messages) if messages else None,
        review,
        button,
    )


def render_missing(chrome: Chrome, tab: str) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "task"},
            h.H1("Task not found"),
            h.P({"class": "sub"}, "That run is not in this cockpit."),
        ),
    )
