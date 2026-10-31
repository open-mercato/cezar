"""The pure half of task dispatch: budgets, the in-flight cap, and the report a child owes.

Ported from the TypeScript functions in `packages/cezar/src/dispatch/engine.ts`. The
stateful half — creating the child run — lives on `Engine`.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.engine.model import TERMINAL

MAX_CHILDREN_IN_FLIGHT = 4
MAX_PENDING_REPORTS = 20


def usd(amount: float) -> str:
    return f"${amount:.2f}"


@dataclass(frozen=True, slots=True)
class BudgetChild:
    status: str
    cost_usd: float | None
    budget_usd: float | None


def remaining_budget(
    parent_budget: float | None,
    parent_cost: float | None,
    children: list[BudgetChild],
) -> float | None:
    """What a parent may still hand out.

    Uncapped when the parent was given no ceiling. A child in flight reserves its whole
    ceiling. A settled child is charged what it spent, except a recorded cost of zero,
    which does not release the reservation — zero can be a partial report.
    """
    if parent_budget is None:
        return None
    promised = 0.0
    for child in children:
        settled_cost = child.cost_usd if child.cost_usd is not None and child.cost_usd > 0 else None
        if child.status in TERMINAL:
            promised += settled_cost if settled_cost is not None else (child.budget_usd or 0.0)
        else:
            promised += child.budget_usd or 0.0
    return parent_budget - (parent_cost or 0.0) - promised


def carve_child_budget(
    parent_budget: float | None,
    parent_cost: float | None,
    children: list[BudgetChild],
    max_cost: float | None,
) -> tuple[float | None, str | None]:
    remaining = remaining_budget(parent_budget, parent_cost, children)
    if remaining is None:
        return max_cost, None
    if remaining <= 0:
        return None, (
            f"no budget left ({usd(parent_budget or 0)} allotted, {usd(parent_cost or 0)} spent, "
            "the rest promised to children in flight). Report what has been achieved "
            "instead of shrinking the remaining work."
        )
    if max_cost is not None and max_cost > remaining:
        return None, (
            f"the requested cap is {usd(max_cost)} but only {usd(remaining)} of the budget is left."
        )
    if max_cost is None:
        return remaining, None
    return max_cost, None


@dataclass(frozen=True, slots=True)
class DispatchOrder:
    objective: str
    title: str = ""
    kind: str = "implement"
    review_of: tuple[str, ...] = ()
    scope: str = ""
    allowed_tools: tuple[str, ...] = ()
    max_cost: float | None = None
    success_criteria: str = ""
    required_evidence: str = ""
    retry_limit: int | None = None


def child_task_envelope(order: DispatchOrder, parent_id: str, parent_branch: str) -> str:
    """The only text the child sees about why it was started."""
    lines: list[str] = []
    if order.kind == "review":
        lines.append(
            "- Kind: review — you review the work named below and give a verdict; "
            "you do not implement it"
        )
    if order.review_of:
        lines.append(f"- Review of: {', '.join(order.review_of)}")
    if order.scope:
        lines.append(f"- Scope: {order.scope}")
    if order.allowed_tools:
        lines.append(f"- Allowed tools: {', '.join(order.allowed_tools)}")
    if order.max_cost is not None:
        lines.append(f"- Max cost: {usd(order.max_cost)}")
    if order.success_criteria:
        lines.append(f"- Success criteria: {order.success_criteria}")
    if order.required_evidence:
        lines.append(f"- Required evidence: {order.required_evidence}")
    if order.retry_limit is not None:
        lines.append(f"- Retry limit: {order.retry_limit}")
    if parent_branch:
        lines.append(f"- Parent branch (your fork point): {parent_branch}")
    lines.append(f"- Ordered by: run {parent_id}")
    return f"{order.objective}\n\n## Task order\n" + "\n".join(lines)


def report_status(run_status: str) -> str:
    if run_status in ("done", "review"):
        return "done"
    if run_status == "failed":
        return "failed"
    if run_status == "cancelled":
        return "blocked"
    return "partial"


def child_report_text(
    *,
    title: str,
    run_id: str,
    status: str,
    branch: str,
    base_branch: str,
    error: str,
    cost_usd: float | None,
) -> tuple[str, str]:
    mapped = report_status(status)
    result = (
        error.strip() or "no structured report — the run settled without calling `cez task report`"
    )
    where = (
        f"{run_id}, branch {branch}" + (f" off {base_branch}" if base_branch else "")
        if branch
        else f"{run_id}, no branch — it ran in the repository working tree"
    )
    parts = [f"status {mapped} (cezar: {status})", result]
    if error.strip():
        parts.append(f"errors: {error.strip()}")
    if cost_usd is not None:
        parts.append(f"cost {usd(cost_usd)}")
    text = f'Report from task "{title}" ({where}): ' + "; ".join(parts)
    return text, mapped


def append_report(
    reports: list[dict[str, object]], entry: dict[str, object]
) -> list[dict[str, object]]:
    return [*reports, entry][-MAX_PENDING_REPORTS:]


def in_flight_refusal(in_flight: int, cap: int = MAX_CHILDREN_IN_FLIGHT) -> str | None:
    if in_flight + 1 <= cap:
        return None
    noun = "child run" if in_flight == 1 else "child runs"
    return (
        f"{in_flight} {noun} already in flight; the cap is {cap} per task. "
        "Wait for reports, then dispatch again."
    )
