import calendar
from datetime import UTC, datetime

from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.clock import parse_stamp
from app.common.shell import Chrome, frame
from app.engine.model import Automation, Workflow
from app.features.automations.forms import new_link, toggle_button
from app.features.automations.urls import (
    AUTOMATION,
    AUTOMATIONS_CREATE,
    AUTOMATIONS_DELETE,
    AUTOMATIONS_LIVE,
    AUTOMATIONS_RUN,
    AutomationsView,
)


def render(
    items: list[Automation],
    workflows: list[Workflow],
    view: AutomationsView,
    chrome: Chrome,
    tab: str,
) -> HtmlElement:
    rows = []
    for item in items:
        toggle = toggle_button(item)
        rows.append(
            h.Div(
                {"class": "card-block"},
                h.Strong(h.A({"href": AUTOMATION.href(item.id)}, item.name)),
                h.P(
                    {"class": "sub"},
                    f"{item.kind} · every {item.every_minutes} min · "
                    f"{'enabled' if item.enabled else 'paused'} · next {item.next_at}",
                ),
                h.P(item.task),
                h.Div(
                    {"class": "actions"},
                    toggle,
                    h.Button(
                        {"type": "button", "class": "btn"},
                        data.on("click", at.post(AUTOMATIONS_RUN.href(item.id))),
                        "Run now",
                    ),
                    h.Button(
                        {"type": "button", "class": "btn btn-danger"},
                        data.on("click", at.post(AUTOMATIONS_DELETE.href(item.id))),
                        "Delete",
                    ),
                ),
            )
        )
    if not rows:
        rows.append(
            h.P({"class": "muted"}, "No automations. A new one stays paused until you enable it.")
        )
    return frame(
        chrome,
        AUTOMATIONS_LIVE.href(query=view.query()),
        {"tab": tab, "name": "", "task": "", "every": 60, "workflow": "quick-task", "_error": ""},
        h.Main(
            {"id": "automations"},
            h.H1("Automations"),
            h.P(
                {"class": "sub"},
                "Schedules fire on their interval. GitHub and tracker automations poll on it and "
                "start a run per new match. Enabling a stale automation does not launch a backlog.",
            ),
            new_link(view),
            *rows,
            _calendar(items),
            h.Form(
                {"class": "composer"},
                data.on(
                    "submit", at.post(AUTOMATIONS_CREATE.href(query=view.query())), prevent=True
                ),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Name"),
                    h.Input({"required": True, "maxlength": "80"}, data.bind("name")),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Task"),
                    h.Textarea({"required": True, "maxlength": "20000"}, data.bind("task")),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Every N minutes"),
                    h.Input(
                        {"type": "number", "min": "1", "max": "10080", "required": True},
                        data.bind("every"),
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
                h.P(
                    {"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error")
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Add paused automation",
                ),
            ),
        ),
    )


def _calendar(items: list[Automation]) -> HtmlElement:
    moment = datetime.now(UTC)
    months = {(moment.year, moment.month)}
    placed: dict[tuple[int, int, int], list[str]] = {}
    for item in items:
        parsed = parse_stamp(item.next_at)
        if parsed is None:
            continue
        months.add((parsed.year, parsed.month))
        placed.setdefault((parsed.year, parsed.month, parsed.day), []).append(item.name)
    return h.Div(
        {"id": "calendar"},
        h.H2("Calendar"),
        *[_month(year, month, placed) for year, month in sorted(months)],
    )


def _month(year: int, month: int, placed: dict[tuple[int, int, int], list[str]]) -> HtmlElement:
    weeks = calendar.Calendar(firstweekday=0).monthdayscalendar(year, month)
    body = []
    for week in weeks:
        cells = []
        for day in week:
            if day == 0:
                cells.append(h.Td(""))
                continue
            names = placed.get((year, month, day), [])
            cells.append(
                h.Td(
                    h.Span({"class": "meta"}, str(day)),
                    *[h.Div({"class": "cal-item"}, name) for name in names],
                )
            )
        body.append(h.Tr(*cells))
    title = datetime(year, month, 1, tzinfo=UTC).strftime("%B %Y")
    return h.Table(
        {"class": "calendar"},
        h.Caption(title),
        h.Thead(h.Tr(*[h.Th(name) for name in ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")])),
        h.Tbody(*body),
    )
