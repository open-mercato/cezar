from collections.abc import Mapping
from dataclasses import dataclass

from litewriter import LiteWriter
from stario import h
from stario.datastar import ModuleScript, at, data
from stario.datastar.format import SignalValue
from stario.markup import HtmlElement, baked

from app.assets import DATASTAR_JS, SCRIPTS, STYLE_CSS
from app.config import Config
from app.engine.model import Project
from app.features.automations.urls import AUTOMATIONS
from app.features.dashboard.urls import DASHBOARD
from app.features.places.urls import GITHUB, INBOX, PALETTE_RESULTS, REPO, TRACKER
from app.features.projects.urls import PROJECTS
from app.features.secrets.urls import SECRETS
from app.features.settings.urls import SETTINGS
from app.features.skills.urls import SKILLS
from app.features.tasks.urls import TASKS
from app.features.workflows.urls import WORKFLOWS
from app.store.db import get_settings, list_projects


@dataclass(frozen=True, slots=True)
class Chrome:
    title: str
    section: str
    project_id: str
    projects: tuple[Project, ...]
    theme: str
    accent: str
    dry_run: bool


@baked
def page(title: str, theme_class: str, accent: str, body: HtmlElement) -> HtmlElement:
    return h.HtmlDocument(
        {"lang": "en", "data-accent": accent, "class": theme_class},
        h.Head(
            h.Meta({"charset": "utf-8"}),
            h.Meta({"name": "viewport", "content": "width=device-width, initial-scale=1"}),
            h.Title(title),
            h.Link({"rel": "stylesheet", "href": STYLE_CSS}),
            *[h.Script({"src": src, "defer": True}) for src in SCRIPTS],
            ModuleScript(DATASTAR_JS),
        ),
        h.Body(
            body,
            h.Output(
                {"id": "toast", "role": "status"},
                data.signals({"_toast": ""}, if_missing=True),
                data.show("$_toast"),
                data.text("$_toast"),
                data.effect("$_toast && setTimeout(() => $_toast = '', 4000)"),
            ),
        ),
    )


def frame(
    chrome: Chrome,
    live: str | None,
    signals: Mapping[str, SignalValue],
    *children: HtmlElement,
) -> HtmlElement:
    merged = {"q": "", **dict(signals)}
    nodes = [data.signals(merged, if_missing=True)]
    if live is not None:
        nodes.append(data.init(at.get(live, retry="always")))
    body = h.Div(
        {"id": "app", "class": "app"},
        data.on(
            "keydown",
            "if ((evt.metaKey || evt.ctrlKey) && evt.key === 'k') $_palette.showModal()",
            target="window",
        ),
        *nodes,
        _sidebar(chrome),
        h.Div({"class": "main"}, *children),
        _palette(),
    )
    theme_class = "light" if chrome.theme == "light" else ""
    return page(f"cezar · {chrome.title}", theme_class, chrome.accent, body)


def _sidebar(chrome: Chrome) -> HtmlElement:
    project = chrome.project_id or "all"
    query = {"project": project, "status": "all"}
    links = (
        ("tasks", "Tasks", TASKS.href(query=query)),
        ("inbox", "Inbox", INBOX.href()),
        ("git", "Repository", REPO.href()),
        ("github", "GitHub", GITHUB.href()),
        ("tracker", "Tracker", TRACKER.href()),
        ("dashboard", "Dashboard", DASHBOARD.href()),
        ("workflows", "Workflows", WORKFLOWS.href(query={"project": project})),
        ("skills", "Skills", SKILLS.href(query={"project": project})),
        ("secrets", "Secrets", SECRETS.href(query={"project": project})),
        ("automations", "Automations", AUTOMATIONS.href(query={"project": project})),
        ("projects", "Projects", PROJECTS.href()),
        ("settings", "Settings", SETTINGS.href()),
    )
    if chrome.dry_run:
        banner = "Python port. Dry run is on — tasks use the mock agent."
    else:
        banner = "Python port. Tasks spawn the selected agent CLI."
    return h.Aside(
        {"class": "sidebar"},
        h.Div({"class": "wordmark"}, "ce", h.Span("zar")),
        h.Nav(
            {"class": "nav"},
            *[_nav_link(section, label, href, chrome.section) for section, label, href in links],
        ),
        h.Button(
            {"type": "button", "id": "command-palette-open"},
            data.on("click", "$_palette.showModal(); " + at.get(PALETTE_RESULTS.href())),
            "Search",
        ),
        h.P({"class": "banner"}, banner),
    )


def _palette() -> HtmlElement:
    return h.Dialog(
        {"id": "command-palette"},
        data.ref("_palette"),
        data.preserve_attr("open"),
        h.Input(
            {
                "type": "search",
                "placeholder": "Tasks and pages",
                "aria-label": "Command palette",
            },
            data.bind("q"),
            data.on("input", at.get(PALETTE_RESULTS.href()), debounce="150ms"),
        ),
        h.Div({"id": "palette-results"}),
    )


def _nav_link(section: str, label: str, href: str, current: str) -> HtmlElement:
    attrs = {"href": href, "class": "active"} if section == current else {"href": href}
    return h.A(attrs, label)


def status_chip(status: str) -> HtmlElement:
    return h.Span({"class": f"status status-{status}"}, status)


def load_chrome(
    db: LiteWriter, config: Config, title: str, section: str, project_id: str
) -> Chrome:
    settings = get_settings(db)
    return Chrome(
        title=title,
        section=section,
        project_id=project_id,
        projects=tuple(list_projects(db)),
        theme=settings.theme,
        accent=settings.accent,
        dry_run=config.dry_run,
    )


def project_name(projects: tuple[Project, ...], project_id: str) -> str:
    for project in projects:
        if project.id == project_id:
            return project.name
    return project_id or "no project"
