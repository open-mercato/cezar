from app.engine.graph import advance, enter_graph, graph_issues

EXAMPLE = {
    "nodes": [
        {"id": "start", "type": "start"},
        {"id": "implement", "type": "agent", "prompt": "{{task}}"},
        {"id": "tests", "type": "check", "command": "npm test"},
        {"id": "retry", "type": "loop", "max": 2},
        {"id": "fix", "type": "agent", "prompt": "attempt {{nodes.retry.iteration}}"},
        {"id": "ok", "type": "end", "status": "success"},
        {"id": "gave-up", "type": "end", "status": "failed"},
    ],
    "edges": [
        {"from": "start", "to": "implement"},
        {"from": "implement.done", "to": "tests"},
        {"from": "tests.pass", "to": "ok"},
        {"from": "tests.fail", "to": "retry"},
        {"from": "retry.repeat", "to": "fix"},
        {"from": "retry.exhausted", "to": "gave-up"},
        {"from": "fix", "to": "tests"},
    ],
}


def test_a_sound_graph_is_accepted_and_walks_to_success():
    assert graph_issues(EXAMPLE) == []
    loops: dict[str, int] = {}
    first = enter_graph(EXAMPLE, loops)
    assert first.kind == "node" and first.node is not None
    assert first.node["id"] == "implement"
    nxt = advance(EXAMPLE, "implement", "done", loops)
    assert nxt.node is not None and nxt.node["id"] == "tests"
    end = advance(EXAMPLE, "tests", "pass", loops)
    assert end.kind == "end" and end.status == "success" and end.end_node == "ok"


def test_a_loop_repeats_until_max_then_takes_exhausted():
    loops: dict[str, int] = {}
    assert advance(EXAMPLE, "tests", "fail", loops).node["id"] == "fix"  # type: ignore[index]
    assert advance(EXAMPLE, "tests", "fail", loops).node["id"] == "fix"  # type: ignore[index]
    third = advance(EXAMPLE, "tests", "fail", loops)
    assert third.status == "failed" and third.end_node == "gave-up"
    assert loops["retry"] == 3


def test_an_unwired_failure_port_fails_and_a_pass_succeeds():
    graph = {
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "c", "type": "check", "command": "x"},
        ],
        "edges": [{"from": "start", "to": "c"}],
    }
    assert advance(graph, "c", "fail", {}).status == "failed"
    assert advance(graph, "c", "pass", {}).status == "success"


def test_a_cycle_without_a_loop_repeat_is_rejected():
    edges = [
        edge if edge["from"] != "tests.fail" else {"from": "tests.fail", "to": "fix"}
        for edge in EXAMPLE["edges"]
    ]
    issues = " ".join(graph_issues({**EXAMPLE, "edges": edges}))
    assert "repeat port" in issues


def test_an_agent_without_a_prompt_and_a_graph_with_no_start_are_rejected():
    bare = {
        "nodes": [{"id": "start", "type": "start"}, {"id": "a", "type": "agent"}],
        "edges": [{"from": "start", "to": "a"}],
    }
    assert graph_issues(bare) == ['agent node "a" needs a prompt or a skill']
    empty = {
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "end", "type": "end", "status": "success"},
        ],
        "edges": [],
    }
    assert "at least one agent or check" in " ".join(graph_issues(empty))
