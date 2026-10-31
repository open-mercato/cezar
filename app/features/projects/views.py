import hashlib

from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.engine.model import Project
from app.features.projects.urls import PROJECTS_ADD, PROJECTS_BASE, PROJECTS_LIVE, PROJECTS_REMOVE


def branch_signal(project_id: str) -> str:
    """A signal name is an identifier. Project ids may contain hyphens."""
    digest = hashlib.sha256(project_id.encode()).hexdigest()[:12]
    return f"branch_{digest}"


def render(projects: list[Project], chrome: Chrome, tab: str) -> HtmlElement:
    rows = []
    signals: dict[str, str] = {"tab": tab, "path": "", "_error": ""}
    for project in projects:
        signal = branch_signal(project.id)
        signals[signal] = project.base_branch
        rows.append(
            h.Div(
                {"class": "card-block"},
                h.Strong(project.name),
                h.P({"class": "sub"}, project.root),
                h.P({"class": "meta"}, f"base {project.base_branch}"),
                h.Form(
                    data.on("submit", at.post(PROJECTS_BASE.href(project.id)), prevent=True),
                    h.Label(
                        {"class": "field"},
                        h.Span("Base branch"),
                        h.Input(
                            {
                                "required": True,
                                "maxlength": "200",
                                "aria-label": f"Base branch for {project.name}",
                            },
                            data.bind(signal),
                        ),
                    ),
                    h.Button({"class": "btn", "type": "submit"}, "Save base branch"),
                ),
                h.Button(
                    {"type": "button", "class": "btn btn-danger"},
                    data.on("click", at.post(PROJECTS_REMOVE.href(project.id))),
                    "Remove",
                ),
            )
        )
    return frame(
        chrome,
        PROJECTS_LIVE.href(),
        signals,
        h.Main(
            {"id": "projects"},
            h.H1("Projects"),
            h.P({"class": "sub"}, "Each directory is a repo the cockpit can run tasks in."),
            *rows,
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(PROJECTS_ADD.href()), prevent=True),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Directory"),
                    h.Input(
                        {"type": "text", "required": True, "maxlength": "500"}, data.bind("path")
                    ),
                ),
                h.P(
                    {"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error")
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Add project",
                ),
            ),
        ),
    )
