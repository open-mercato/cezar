from app.engine.dispatch_logic import (
    MAX_CHILDREN_IN_FLIGHT,
    BudgetChild,
    DispatchOrder,
    append_report,
    carve_child_budget,
    child_report_text,
    child_task_envelope,
    in_flight_refusal,
    remaining_budget,
)


def test_an_uncapped_parent_never_refuses_for_cost():
    assert remaining_budget(None, 0, []) is None
    budget, reason = carve_child_budget(None, 0, [], 2)
    assert reason is None
    assert budget == 2


def test_in_flight_children_reserve_their_ceiling_and_a_zero_cost_does_not_release_it():
    children = [
        BudgetChild("running", None, 3),
        BudgetChild("review", 0, 3),
        BudgetChild("done", 1, 3),
    ]
    # 10 - 2 spent - 3 reserved - 3 still reserved (zero cost) - 1 actual = 1
    assert remaining_budget(10, 2, children) == 1


def test_carve_refuses_an_empty_budget_and_a_cap_above_what_is_left():
    _budget, empty = carve_child_budget(1, 1, [], None)
    assert empty is not None and "no budget left" in empty
    _budget, over = carve_child_budget(5, 0, [], 9)
    assert over is not None and "$9.00" in over and "$5.00" in over
    budget, reason = carve_child_budget(5, 1, [], None)
    assert reason is None
    assert budget == 4


def test_the_in_flight_cap_is_four():
    assert MAX_CHILDREN_IN_FLIGHT == 4
    assert in_flight_refusal(3) is None
    refusal = in_flight_refusal(4)
    assert refusal is not None and "cap is 4" in refusal


def test_the_child_sees_the_order_and_who_asked():
    text = child_task_envelope(
        DispatchOrder(objective="audit the parser", kind="review", review_of=("cez/abc",)),
        "parent",
        "cez/parent",
    )
    assert text.startswith("audit the parser")
    assert "Kind: review" in text
    assert "Ordered by: run parent" in text
    assert "cez/parent" in text


def test_a_settled_child_reports_review_as_done_and_cancel_as_blocked():
    done, status = child_report_text(
        title="audit",
        run_id="abc",
        status="review",
        branch="cez/abc",
        base_branch="main",
        error="",
        cost_usd=0,
    )
    assert status == "done"
    assert 'Report from task "audit"' in done
    _text, blocked = child_report_text(
        title="audit",
        run_id="abc",
        status="cancelled",
        branch="",
        base_branch="",
        error="stopped",
        cost_usd=None,
    )
    assert blocked == "blocked"


def test_pending_reports_keep_the_newest_twenty():
    reports = append_report([{"n": index} for index in range(20)], {"n": 20})
    assert len(reports) == 20
    assert reports[0]["n"] == 1
    assert reports[-1]["n"] == 20
