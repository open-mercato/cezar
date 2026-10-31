"""The automation form: signals in, a validated definition out, and the reverse."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from stario.datastar.format import SignalValue

from app.config import RUNNERS
from app.engine.catalog import load_workflows
from app.engine.model import Automation, Project
from app.integrations.github_poll import EVENTS, LIST_FILTERS, definition_issue

KINDS = ("schedule", "github", "tracker")
EVENT_LABELS = {
    "pull_request.opened": "Pull request opened",
    "issue.opened": "Issue opened",
    "issue.labeled": "Issue labeled",
    "issue.unlabeled": "Issue unlabeled",
    "pull_request.reviewed": "Pull request reviewed",
    "pull_request.review_requested": "Review requested",
    "pull_request.rereview_requested": "Re-review requested",
    "pull_request.closed": "Pull request closed",
    "pull_request.merged": "Pull request merged",
}
FILTER_LABELS = {
    "authors": "Authors",
    "assignees": "Assignees",
    "allLabels": "Has all labels",
    "anyLabels": "Has any label",
    "excludeLabels": "Has none of the labels",
    "changedLabels": "Changed label (required for label events)",
    "reviewers": "Reviewers",
}


@dataclass(frozen=True, slots=True)
class Form:
    name: str
    task: str
    workflow: str
    runner: str
    kind: str
    every: int
    events: tuple[str, ...] = ()
    filters: dict[str, object] = field(default_factory=dict)


def _text(signals: Mapping[str, object], key: str, default: str = "") -> str:
    value = signals.get(key, default)
    return value.strip() if isinstance(value, str) else ""


def _number(value: object, label: str, low: int, high: int) -> tuple[int | None, str]:
    if isinstance(value, bool):
        return None, f"{label} must be a number"
    if isinstance(value, str) and value.strip().isdecimal():
        value = int(value.strip())
    if not isinstance(value, int) or not low <= value <= high:
        return None, f"{label} must be between {low} and {high}"
    return value, ""


def _words(value: object) -> list[str]:
    if not isinstance(value, str):
        return []
    return [part.strip() for part in value.replace("\n", ",").split(",") if part.strip()]


def parse_form(
    signals: Mapping[str, object], project: Project, default_runner: str
) -> tuple[Form | None, str]:
    """A form in the cockpit's signals, or the reason it cannot be saved."""
    name, task = _text(signals, "name"), _text(signals, "task")
    if not name or len(name) > 80:
        return None, "name must be 1 to 80 characters"
    if not task or len(task) > 20_000:
        return None, "task is required"
    every, issue = _number(signals.get("every", 60), "every", 1, 10080)
    if every is None:
        return None, issue
    workflow = _text(signals, "workflow", "quick-task")
    if not any(item.name == workflow for item in load_workflows(Path(project.root))[0]):
        return None, "unknown workflow"
    runner = _text(signals, "runner") or default_runner
    if runner not in RUNNERS:
        return None, "unknown runner"
    kind = _text(signals, "kind", "schedule")
    if kind not in KINDS:
        return None, "kind must be schedule, github or tracker"
    events: tuple[str, ...] = ()
    filters: dict[str, object] = {}
    if kind == "github":
        raw = signals.get("events")
        picked = [item for item in raw if isinstance(item, str)] if isinstance(raw, list) else []
        events = tuple(item for item in EVENTS if item in picked)
        for key in LIST_FILTERS:
            if words := _words(signals.get(f"f_{key}")):
                filters[key] = words
        if repo := _text(signals, "f_repo"):
            filters["repo"] = repo
        if signals.get("f_prHead") is True:
            filters["checkout"] = "pr-head"
            if signals.get("f_allowForkHeads") is True:
                filters["allowForkHeads"] = True
    if kind == "tracker":
        for key in ("status", "query"):
            if value := _text(signals, f"t_{key}"):
                filters[key] = value
        if labels := _words(signals.get("t_allLabels")):
            filters["allLabels"] = labels
        if "status" not in filters:
            return None, "a tracker automation needs a target status"
    if kind != "schedule":
        for key, low, high in (("lookbackDays", 1, 90), ("maxRecords", 1, 100)):
            raw_value = signals.get(f"f_{key}")
            if raw_value in (None, ""):
                continue
            number, issue = _number(raw_value, key, low, high)
            if number is None:
                return None, issue
            filters[key] = number
    problem = definition_issue(kind, events, filters)
    if problem:
        return None, problem
    return Form(name, task, workflow, runner, kind, every, events, filters), ""


def signals_for(item: Automation | None, workflow: str = "quick-task") -> dict[str, SignalValue]:
    """The form's signals, filled from `item` when editing."""
    base: dict[str, SignalValue] = {
        "name": "",
        "task": "",
        "workflow": workflow,
        "runner": "",
        "kind": "schedule",
        "every": 60,
        "events": [],
        "f_repo": "",
        "f_lookbackDays": "",
        "f_maxRecords": "",
        "f_prHead": False,
        "f_allowForkHeads": False,
        "t_status": "",
        "t_query": "",
        "t_allLabels": "",
        "_error": "",
    }
    for key in LIST_FILTERS:
        base[f"f_{key}"] = ""
    if item is None:
        return base
    filters = item.filters
    base.update(
        name=item.name,
        task=item.task,
        workflow=item.workflow,
        runner=item.runner,
        kind=item.kind or "schedule",
        every=item.every_minutes,
        events=list(item.events),
    )
    for key in LIST_FILTERS:
        value = filters.get(key)
        base[f"f_{key}"] = ", ".join(str(v) for v in value) if isinstance(value, list) else ""
    for key in ("repo", "lookbackDays", "maxRecords"):
        value = filters.get(key)
        base[f"f_{key}"] = "" if value is None else str(value)
    base["f_prHead"] = filters.get("checkout") == "pr-head"
    base["f_allowForkHeads"] = filters.get("allowForkHeads") is True
    if item.kind == "tracker":
        base["t_status"] = str(filters.get("status", ""))
        base["t_query"] = str(filters.get("query", ""))
        labels = filters.get("allLabels")
        base["t_allLabels"] = ", ".join(str(v) for v in labels) if isinstance(labels, list) else ""
    return base
