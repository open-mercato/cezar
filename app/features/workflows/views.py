from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.engine.catalog import LoadIssue
from app.engine.model import Workflow
from app.features.places.urls import WORKFLOW
from app.features.workflows.urls import (
    WORKFLOWS_CREATE,
    WORKFLOWS_DELETE,
    WORKFLOWS_LIVE,
    WorkflowsView,
)


def render(
    workflows: list[Workflow],
    issues: list[LoadIssue],
    view: WorkflowsView,
    chrome: Chrome,
    tab: str,
) -> HtmlElement:
    rows = []
    for item in workflows:
        tail: HtmlElement | str
        if item.source == "file":
            tail = h.Button(
                {"type": "button", "class": "btn btn-danger"},
                data.on("click", at.post(WORKFLOWS_DELETE.href(item.name, query=view.query()))),
                data.indicator("_saving"),
                "Delete",
            )
        else:
            tail = h.Span({"class": "meta"}, "built-in")
        rows.append(
            h.Div(
                {"class": "task-row"},
                h.A({"href": WORKFLOW.href(item.name)}, h.Strong(item.name)),
                h.A({"href": f"/workflows/{item.name}/editor"}, "Edit graph"),
                h.Span({"class": "meta grow"}, item.description or f"{len(item.steps)} steps"),
                tail,
            )
        )
    issue_nodes = [h.P({"class": "error"}, f"{issue.path}: {issue.message}") for issue in issues]
    return frame(
        chrome,
        WORKFLOWS_LIVE.href(query=view.query()),
        {"tab": tab, "name": "", "template": "agent", "_error": ""},
        h.Main(
            {"id": "workflows"},
            h.H1("Workflows"),
            h.P(
                {"class": "sub"},
                "YAML files in .ai/cezar/workflows. A file named quick-task replaces the built-in.",
            ),
            *issue_nodes,
            h.Div({"class": "stack"}, *rows),
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(WORKFLOWS_CREATE.href(query=view.query())), prevent=True),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Name"),
                    h.Input(
                        {
                            "required": True,
                            "maxlength": "64",
                            "pattern": "[A-Za-z0-9][A-Za-z0-9_-]*",
                        },
                        data.bind("name"),
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Template"),
                    h.Select(
                        data.bind("template"),
                        h.Option({"value": "agent"}, "One agent step"),
                        h.Option(
                            {"value": "fix-and-verify"}, "Implement, then a check that retries"
                        ),
                    ),
                ),
                h.P(
                    {"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error")
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Save workflow",
                ),
            ),
            h.P(
                {"class": "muted"},
                "Open a name to read its steps, or Edit graph to add, move, and connect nodes.",
            ),
        ),
    )
