from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame, project_name, status_chip
from app.config import RUNNERS
from app.engine.model import Run, Workflow
from app.features.task.urls import TASK
from app.features.tasks.urls import (
    TASKS,
    TASKS_ARCHIVE,
    TASKS_CREATE,
    TASKS_LIVE,
    TASKS_NEW,
    TASKS_READ,
    TasksView,
)


def render_list(runs: list[Run], view: TasksView, chrome: Chrome, tab: str) -> HtmlElement:
    filters = []
    for status in ("all", "queued", "running", "waiting", "review", "done", "failed", "cancelled"):
        nxt = TasksView(view.project, status)
        attrs = {"href": TASKS.href(query=nxt.query())}
        if view.status == status:
            attrs["class"] = "on"
        filters.append(h.A(attrs, status))
    rows: list[HtmlElement] = []
    for run in runs:
        rows.append(
            h.A(
                {"class": "task-row", "href": TASK.href(run.id)},
                status_chip(run.status),
                h.Strong(run.title),
                h.Span({"class": "meta grow"}, run.workflow),
                h.Span({"class": "meta"}, "child" if run.parent_id else ""),
            )
        )
    if not rows:
        rows.append(h.P({"class": "muted"}, "No tasks yet."))
    name = project_name(chrome.projects, view.project)
    return frame(
        chrome,
        TASKS_LIVE.href(query=view.query()),
        {"tab": tab},
        h.Div(
            {"id": "tasks"},
            h.Div(
                {"class": "top"},
                h.Div(h.H1("Tasks"), h.P({"class": "sub"}, name)),
                h.A(
                    {"class": "btn btn-primary", "href": TASKS_NEW.href(query=view.query())},
                    "New task",
                ),
                h.Button(
                    {"type": "button", "class": "btn"},
                    data.on("click", at.post(TASKS_ARCHIVE.href(query=view.query()))),
                    "Archive finished",
                ),
                h.Button(
                    {"type": "button", "class": "btn"},
                    data.on("click", at.post(TASKS_READ.href(query=view.query()))),
                    "Mark read",
                ),
            ),
            h.Nav({"class": "filters"}, *filters),
            h.Div({"class": "task-list"}, *rows),
        ),
    )


def render_new(
    workflows: list[Workflow],
    view: TasksView,
    chrome: Chrome,
    tab: str,
    default_runner: str,
    workflow: str,
    *,
    launched: bool,
    model: str = "",
    autonomous: bool = False,
    worktree: bool = True,
    skills: tuple[str, ...] = (),
    default_skill: str = "",
) -> HtmlElement:
    return frame(
        chrome,
        None,
        {
            "tab": tab,
            "task": "",
            "workflow": workflow,
            "runner": default_runner,
            "model": model,
            "skill": "",
            "variants": "1",
            "autonomous": autonomous,
            "worktree": worktree,
            "_error": "",
        },
        h.Main(
            {"id": "new-task"},
            h.H1("New task"),
            h.P({"class": "sub"}, project_name(chrome.projects, view.project)),
            h.P({"id": "bookmarklet-launch"}, "Opened from the bookmarklet.") if launched else None,
            h.Form(
                {"id": "new-task-form"},
                data.on(
                    "submit",
                    at.post(TASKS_CREATE.href(query=view.query())),
                    prevent=True,
                ),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Task"),
                    h.Textarea(
                        {"required": True, "maxlength": "20000"},
                        data.bind("task"),
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Workflow"),
                    h.Select(
                        data.bind("workflow"),
                        *[h.Option({"value": item.name}, item.name) for item in workflows],
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Agent"),
                    h.Select(
                        data.bind("runner"),
                        *[h.Option({"value": runner}, runner) for runner in RUNNERS],
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Skill"),
                    h.Select(
                        {"aria-label": "Skill"},
                        data.bind("skill"),
                        h.Option(
                            {"value": ""},
                            f"Default ({default_skill})" if default_skill else "Default (none)",
                        ),
                        h.Option({"value": "none"}, "No skill"),
                        *[h.Option({"value": name}, name) for name in skills],
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Model (optional)"),
                    h.Input({"type": "text", "maxlength": "120"}, data.bind("model")),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Variants"),
                    h.Select(
                        {"aria-label": "Variants"},
                        data.bind("variants"),
                        h.Option({"value": "1"}, "One"),
                        h.Option({"value": "2"}, "×2"),
                        h.Option({"value": "3"}, "×3"),
                    ),
                ),
                h.Label(
                    {"class": "inline"},
                    h.Input({"type": "checkbox"}, data.bind("autonomous")),
                    "Autonomous — tell the agent not to stop and ask",
                ),
                h.Label(
                    {"class": "inline"},
                    h.Input({"type": "checkbox"}, data.bind("worktree")),
                    "Own worktree — off runs in the checkout",
                ),
                h.P(
                    {"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error")
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Start",
                ),
            ),
        ),
    )
