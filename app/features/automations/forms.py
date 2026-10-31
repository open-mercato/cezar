"""The automation form and its detail and log pages."""

from __future__ import annotations

from collections.abc import Mapping

from stario import h
from stario.datastar import at, data
from stario.datastar.format import SignalValue
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.engine.model import Automation, Workflow
from app.features.automations.data import EVENT_LABELS, FILTER_LABELS
from app.features.automations.urls import (
    AUTOMATION,
    AUTOMATION_CHECK,
    AUTOMATION_LIVE,
    AUTOMATION_LOG,
    AUTOMATION_LOG_LIVE,
    AUTOMATION_RETRY,
    AUTOMATION_UPDATE,
    AUTOMATIONS,
    AUTOMATIONS_CREATE,
    AUTOMATIONS_DELETE,
    AUTOMATIONS_ENABLE,
    AUTOMATIONS_NEW,
    AUTOMATIONS_PAUSE,
    AUTOMATIONS_RUN,
    AutomationsView,
    LogView,
)
from app.features.task.urls import TASK


def _field(label: str, *control: HtmlElement) -> HtmlElement:
    return h.Label({"class": "field"}, h.Span(label), *control)


def _text_field(label: str, signal: str, **attrs: str) -> HtmlElement:
    return _field(label, h.Input(attrs, data.bind(signal)))


def _tracker_fields(options: Mapping[str, object]) -> HtmlElement:
    """Tracker status choices come from the tracker integration; without a connection, typed."""
    statuses = options.get("statuses")
    if options.get("available") is True and isinstance(statuses, list) and statuses:
        status = _field(
            "Target status",
            h.Select(
                data.bind("t_status"),
                h.Option({"value": ""}, "Choose a status"),
                *[
                    h.Option({"value": str(row.get("name", ""))}, str(row.get("name", "")))
                    for row in statuses
                    if isinstance(row, dict)
                ],
            ),
        )
        note = h.P({"class": "sub"}, "Statuses come from the connected tracker.")
    else:
        status = _text_field("Target status", "t_status", maxlength="200")
        reason = options.get("reason") or "tracker options are not available"
        note = h.P({"class": "sub"}, f"{reason}. Type the status name.")
    return h.Fieldset(
        {"class": "field"},
        data.show("$kind == 'tracker'"),
        h.Legend("Tracker"),
        note,
        status,
        _text_field("Text search", "t_query", maxlength="200"),
        _text_field("Has all labels (comma separated)", "t_allLabels"),
        _text_field(
            "Most items per poll (1-100)", "f_maxRecords", type="number", min="1", max="100"
        ),
    )


def _github_fields() -> HtmlElement:
    return h.Fieldset(
        {"class": "field"},
        data.show("$kind == 'github'"),
        h.Legend("GitHub events"),
        h.Div(
            {"class": "filters"},
            *[
                h.Label(
                    h.Input({"type": "checkbox", "value": event}, data.bind("events")),
                    f" {label}",
                )
                for event, label in EVENT_LABELS.items()
            ],
        ),
        _text_field(
            "Repository (owner/name; empty uses this project's)", "f_repo", maxlength="200"
        ),
        *[
            _text_field(f"{label} (comma separated)", f"f_{key}")
            for key, label in FILTER_LABELS.items()
        ],
        _text_field("Look back (days, 1-90)", "f_lookbackDays", type="number", min="1", max="90"),
        _text_field(
            "Most items per poll (1-100)", "f_maxRecords", type="number", min="1", max="100"
        ),
        h.Label(
            {"class": "inline"},
            h.Input({"type": "checkbox"}, data.bind("f_prHead")),
            " Fork the worktree from the pull request's head (pull_request events, not closed)",
        ),
        h.Label(
            {"class": "inline"},
            h.Input({"type": "checkbox"}, data.bind("f_allowForkHeads")),
            " Admit heads from forks (untrusted code, checks run without credentials)",
        ),
    )


def automation_form(
    action: str, submit: str, workflows: list[Workflow], options: Mapping[str, object]
) -> HtmlElement:
    return h.Form(
        {"class": "composer", "id": "automation-form"},
        data.on("submit", at.post(action), prevent=True),
        data.indicator("_saving"),
        _text_field("Name", "name", required="", maxlength="80"),
        _field("Task", h.Textarea({"required": True, "maxlength": "20000"}, data.bind("task"))),
        _field(
            "Trigger",
            h.Select(
                data.bind("kind"),
                h.Option({"value": "schedule"}, "On a schedule"),
                h.Option({"value": "github"}, "When something happens on GitHub"),
                h.Option({"value": "tracker"}, "When a tracker issue reaches a status"),
            ),
        ),
        _text_field(
            "Every N minutes (the schedule, or how often to poll)",
            "every",
            type="number",
            min="1",
            max="10080",
            required="",
        ),
        _github_fields(),
        _tracker_fields(options),
        _field(
            "Workflow",
            h.Select(
                data.bind("workflow"),
                *[h.Option({"value": item.name}, item.name) for item in workflows],
            ),
        ),
        h.P({"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error")),
        h.Button(
            {"class": "btn btn-primary", "type": "submit"},
            data.attr("disabled", "$_saving"),
            submit,
        ),
    )


def render_new(
    chrome: Chrome,
    view: AutomationsView,
    signals: Mapping[str, SignalValue],
    workflows: list[Workflow],
    options: Mapping[str, object],
    tab: str,
) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab, **signals},
        h.Main(
            {"id": "automation-new"},
            h.P(h.A({"href": AUTOMATIONS.href(query=view.query())}, "Automations")),
            h.H1("New automation"),
            h.P({"class": "sub"}, "It stays paused until you enable it."),
            automation_form(
                AUTOMATIONS_CREATE.href(query={**view.query(), "then": "detail"}),
                "Add paused automation",
                workflows,
                options,
            ),
        ),
    )


def describe_trigger(item: Automation) -> str:
    if item.kind == "github":
        return "GitHub: " + ", ".join(item.events)
    if item.kind == "tracker":
        return f"Tracker issue enters {item.filters.get('status', '?')}"
    return "On a schedule"


def _filter_lines(item: Automation) -> list[HtmlElement]:
    lines = []
    for key, value in item.filters.items():
        text = ", ".join(str(v) for v in value) if isinstance(value, list) else str(value)
        lines.append(h.Li(h.Strong(f"{key}: "), text))
    return lines


def toggle_button(item: Automation) -> HtmlElement:
    pause = item.enabled
    return h.Button(
        {"type": "button", "class": "btn"},
        data.on(
            "click", at.post((AUTOMATIONS_PAUSE if pause else AUTOMATIONS_ENABLE).href(item.id))
        ),
        "Pause" if pause else "Enable",
    )


def render_summary(item: Automation) -> HtmlElement:
    toggle = toggle_button(item)
    last = (
        h.A({"href": TASK.href(item.last_run_id)}, "last run")
        if item.last_run_id
        else h.Span({"class": "muted"}, "no run yet")
    )
    polls = item.kind != "schedule"
    return h.Div(
        {"id": "automation-summary", "class": "card-block"},
        h.H1(item.name),
        h.P(
            {"class": "sub"},
            f"{describe_trigger(item)} · every {item.every_minutes} min · "
            f"{'enabled' if item.enabled else 'paused'} · next {item.next_at} · revision "
            f"{item.revision}",
        ),
        h.P(item.task),
        h.Ul(*_filter_lines(item)) if item.filters else h.Span(),
        h.P(last, " · ", h.A({"href": AUTOMATION_LOG.href(item.id)}, "execution log")),
        h.Div(
            {"class": "actions"},
            toggle,
            h.Button(
                {"type": "button", "class": "btn"},
                data.on("click", at.post(AUTOMATIONS_RUN.href(item.id))),
                "Run now",
            ),
            *(
                [
                    h.Button(
                        {"type": "button", "class": "btn"},
                        data.on(
                            "click",
                            at.post(AUTOMATION_CHECK.href(item.id, query={"mode": "preview"})),
                        ),
                        "Check now",
                    ),
                    h.Button(
                        {"type": "button", "class": "btn"},
                        data.on(
                            "click",
                            at.post(AUTOMATION_CHECK.href(item.id, query={"mode": "execute"})),
                        ),
                        "Check and launch",
                    ),
                ]
                if polls
                else []
            ),
            h.Button(
                {"type": "button", "class": "btn btn-danger"},
                data.on("click", at.post(AUTOMATIONS_DELETE.href(item.id))),
                "Delete",
            ),
        ),
    )


def render_detail(
    chrome: Chrome,
    view: AutomationsView,
    item: Automation,
    signals: Mapping[str, SignalValue],
    workflows: list[Workflow],
    options: Mapping[str, object],
    tab: str,
) -> HtmlElement:
    return frame(
        chrome,
        AUTOMATION_LIVE.href(item.id),
        {"tab": tab, **signals},
        h.Main(
            {"id": "automation"},
            h.P(h.A({"href": AUTOMATIONS.href(query=view.query())}, "Automations")),
            render_summary(item),
            h.H2("Edit"),
            h.P(
                {"class": "sub"},
                "Changing the trigger starts it over: items that already exist do not fire.",
            ),
            automation_form(AUTOMATION_UPDATE.href(item.id), "Save changes", workflows, options),
        ),
    )


def _candidate_row(automation_id: str, entry_id: str, row: object) -> HtmlElement:
    if not isinstance(row, dict):
        return h.Tr()
    run_id = str(row.get("runId") or "")
    status = str(row.get("status", ""))
    label = str(row.get("label", ""))
    url = str(row.get("url") or "")
    return h.Tr(
        h.Td(h.A({"href": url, "rel": "noreferrer"}, label) if url.startswith("http") else label),
        h.Td(str(row.get("event", ""))),
        h.Td({"class": "error" if status == "launch-error" else ""}, status),
        h.Td(h.A({"href": TASK.href(run_id)}, "run") if run_id else str(row.get("error") or "")),
    )


def _entry(automation_id: str, entry: dict[str, object], open_id: str) -> HtmlElement:
    entry_id = str(entry.get("id", ""))
    rows = entry.get("candidates")
    items = rows if isinstance(rows, list) else []
    failed = any(isinstance(r, dict) and r.get("status") == "launch-error" for r in items)
    attrs = {"class": "card-block", "id": f"entry-{entry_id}"}
    if entry_id == open_id:
        attrs["open"] = ""
    return h.Details(
        attrs,
        h.Summary(
            f"{entry.get('at', '')} · {entry.get('mode', '')} · {entry.get('status', '')} · "
            f"{entry.get('matches', 0)} match(es), {entry.get('launched', 0)} launched"
        ),
        h.P({"class": "sub"}, str(entry.get("message", ""))),
        h.Table(
            h.Thead(h.Tr(*[h.Th(name) for name in ("Item", "Event", "Result", "Run")])),
            h.Tbody(*[_candidate_row(automation_id, entry_id, row) for row in items]),
        )
        if items
        else h.Span(),
        h.Button(
            {"type": "button", "class": "btn"},
            data.on("click", at.post(AUTOMATION_RETRY.href(automation_id, entry_id))),
            "Retry failed launches",
        )
        if failed
        else h.Span(),
    )


def render_log(
    chrome: Chrome,
    item: Automation,
    entries: list[dict[str, object]],
    log_view: LogView,
    tab: str,
) -> HtmlElement:
    return frame(
        chrome,
        AUTOMATION_LOG_LIVE.href(item.id, query=log_view.query()),
        {"tab": tab},
        h.Main(
            {"id": "automation-log"},
            h.P(h.A({"href": AUTOMATION.href(item.id)}, item.name)),
            h.H1("Execution log"),
            h.Div(
                {"class": "actions"},
                *(
                    [
                        h.Button(
                            {"type": "button", "class": "btn"},
                            data.on(
                                "click",
                                at.post(AUTOMATION_CHECK.href(item.id, query={"mode": "preview"})),
                            ),
                            "Check now",
                        ),
                        h.Button(
                            {"type": "button", "class": "btn"},
                            data.on(
                                "click",
                                at.post(AUTOMATION_CHECK.href(item.id, query={"mode": "execute"})),
                            ),
                            "Check and launch",
                        ),
                    ]
                    if item.kind != "schedule"
                    else []
                ),
            ),
            h.Div(
                {"id": "log-entries"},
                *[_entry(item.id, entry, log_view.entry) for entry in entries],
            )
            if entries
            else h.P({"id": "log-entries", "class": "muted"}, "Nothing has run yet."),
        ),
    )


def render_log_entries(
    automation_id: str, entries: list[dict[str, object]], log_view: LogView
) -> HtmlElement:
    if not entries:
        return h.P({"id": "log-entries", "class": "muted"}, "Nothing has run yet.")
    return h.Div(
        {"id": "log-entries"}, *[_entry(automation_id, entry, log_view.entry) for entry in entries]
    )


def new_link(view: AutomationsView) -> HtmlElement:
    return h.P(
        h.A(
            {"class": "btn", "href": AUTOMATIONS_NEW.href(query=view.query())},
            "New automation (GitHub, tracker or schedule)",
        )
    )
