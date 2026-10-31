from datetime import UTC, datetime, timedelta

from stario import h
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.engine.model import STATUSES, Run
from app.features.dashboard.urls import DASHBOARD, DASHBOARD_LIVE
from app.features.tasks.urls import TASKS


def render(
    runs: list[Run],
    chrome: Chrome,
    tab: str,
    *,
    show_tokens: bool,
    show_cost: bool,
    days: int = 7,
) -> HtmlElement:
    counts = {status: sum(1 for run in runs if run.status == status) for status in STATUSES}
    tokens = sum(run.tokens_used for run in runs)
    cost = sum(run.cost_usd for run in runs)
    cards = [
        h.A(
            {
                "class": "count",
                "id": f"count-{status}",
                "href": TASKS.href(query={"status": status, "project": chrome.project_id}),
            },
            h.B(str(counts[status])),
            status,
        )
        for status in STATUSES
    ]
    usage: list[HtmlElement] = []
    if show_tokens:
        usage.append(
            h.Div({"class": "count", "id": "token-total"}, h.B(str(tokens)), "tokens reported")
        )
    if show_cost:
        usage.append(
            h.Div({"class": "count", "id": "cost-total"}, h.B(f"${cost:.2f}"), "cost reported")
        )
    hidden = _hidden_note(show_tokens, show_cost)
    return frame(
        chrome,
        DASHBOARD_LIVE.href(),
        {"tab": tab},
        h.Main(
            {"id": "dashboard"},
            h.H1("Dashboard"),
            h.P({"class": "sub"}, "Counts across every project in this cockpit."),
            h.Div({"class": "counts"}, *cards),
            h.Div({"class": "counts"}, *usage) if usage else None,
            _period_nav(days),
            usage_series(runs, days=days, show_tokens=show_tokens, show_cost=show_cost),
            h.P({"id": "usage-hidden", "class": "muted"}, hidden) if hidden else None,
            h.P(
                {"class": "muted"},
                "Lifetime input and output tokens grouped by the day the task was created.",
            ),
        ),
    )


def usage_series(runs: list[Run], *, days: int, show_tokens: bool, show_cost: bool) -> HtmlElement:
    """One UTC day per row. Tokens follow creation; completed follows finish.

    TypeScript builds the same window in the browser's offset. This page is
    server-rendered, so the days are UTC.
    """
    today = datetime.now(UTC).date()
    window = [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]
    incoming = dict.fromkeys(window, 0)
    outgoing = dict.fromkeys(window, 0)
    cost = dict.fromkeys(window, 0.0)
    started = dict.fromkeys(window, 0)
    completed = dict.fromkeys(window, 0)
    for run in runs:
        created = _day(run.created_at)
        if created is not None and created in started:
            incoming[created] += run.input_tokens
            outgoing[created] += run.output_tokens
            cost[created] += run.cost_usd
            started[created] += 1
        finished = _day(run.finished_at) if run.status == "done" else None
        if finished is not None and finished in completed:
            completed[finished] += 1
    head = [h.Th("Date"), h.Th("Tasks")]
    if show_tokens:
        head.extend((h.Th("Input tokens"), h.Th("Output tokens")))
    if show_cost:
        head.append(h.Th("Cost"))
    head.append(h.Th("Completed"))
    body = []
    for day in window:
        cells = [h.Td(day.isoformat()), h.Td(str(started[day]))]
        if show_tokens:
            cells.extend(
                (
                    h.Td({"class": "in-tokens"}, str(incoming[day])),
                    h.Td({"class": "out-tokens"}, str(outgoing[day])),
                )
            )
        if show_cost:
            cells.append(h.Td(f"{cost[day]:.2f}"))
        cells.append(h.Td(str(completed[day])))
        body.append(h.Tr(*cells))
    return h.Table(
        {"id": "usage-series"},
        h.Caption(f"Last {days} days"),
        h.Thead(h.Tr(*head)),
        h.Tbody(*body),
    )


def _period_nav(days: int) -> HtmlElement:
    links = []
    for label, period, count in (("Last 7 days", "7d", 7), ("Last 30 days", "30d", 30)):
        attrs = {"href": DASHBOARD.href(query={"period": period})}
        if days == count:
            attrs["aria-current"] = "page"
        links.append(h.A(attrs, label))
    return h.Nav({"class": "filters", "id": "usage-period"}, *links)


def _day(value: str):
    if len(value) < 10:
        return None
    try:
        return datetime.fromisoformat(value).date()
    except ValueError:
        return None


def _hidden_note(show_tokens: bool, show_cost: bool) -> str:
    if show_tokens and show_cost:
        return ""
    if not show_tokens and not show_cost:
        return "Token and cost totals are hidden."
    if not show_tokens:
        return "Token totals are hidden."
    return "Cost totals are hidden."
