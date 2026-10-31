"""Version-2 workflow graphs.

The walk matches `advance` / `enterGraph` in `packages/cezar/src/workflows/graph.ts`.
A loop's `repeat` port is the only bounded edge: every other cycle is rejected.
Fork, join, dispatch, git, and GitHub nodes are executed by the engine.
A join is only reached from its fork. Other types still fail the run.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

FAILURE_PORTS = frozenset({"failed", "fail", "exhausted", "reject", "red", "timeout", "conflict"})
_PORTS: dict[str, tuple[str, ...]] = {
    "start": ("next",),
    "end": (),
    "loop": ("repeat", "exhausted"),
    "agent": ("done", "failed"),
    "check": ("pass", "fail"),
    "if": ("true", "false"),
    "gate.human": ("approve", "reject"),
    "ask-user": ("answered",),
    "dispatch": ("done", "failed"),
    "fork": ("1", "2", "3"),
    "join": ("done", "failed"),
    "workflow": ("done", "failed"),
    "git.commit": ("done", "nothing", "failed"),
    "git.push": ("done", "failed"),
    "git.sync-base": ("done", "conflict", "failed"),
    "github.draft-pr": ("created", "failed"),
    "github.pr-comment": ("done", "failed"),
    "github.issue-comment": ("done", "failed"),
    "github.pr-update": ("done", "failed"),
    "github.wait-ci": ("green", "red", "timeout", "failed"),
    "notify.webhook": ("done", "failed"),
}


def is_failure_port(port: str) -> bool:
    return port in FAILURE_PORTS


def ports_of(node: dict[str, Any]) -> tuple[str, ...]:
    kind = str(node.get("type", ""))
    if kind == "agent" and isinstance(node.get("verdicts"), list) and node["verdicts"]:
        names = [item for item in node["verdicts"] if isinstance(item, str)]
        return tuple(dict.fromkeys([*names, "failed"]))
    if kind == "fork":
        count = node.get("branches")
        width = count if isinstance(count, int) and 2 <= count <= 4 else 3
        return tuple(str(index) for index in range(1, width + 1))
    ports = _PORTS.get(kind, ("done", "failed"))
    if kind in ("gate.human", "ask-user") and node.get("timeoutMs"):
        return (*ports, "timeout")
    return ports


def parse_edge_from(source: str, nodes: list[dict[str, Any]]) -> tuple[str, str] | None:
    best: dict[str, Any] | None = None
    for node in nodes:
        node_id = str(node.get("id", ""))
        if source == node_id or source.startswith(f"{node_id}."):
            if best is None or len(node_id) > len(str(best.get("id", ""))):
                best = node
    if best is None:
        return None
    node_id = str(best.get("id", ""))
    ports = ports_of(best)
    if source == node_id:
        return (node_id, ports[0]) if ports else None
    port = source[len(node_id) + 1 :]
    if port in ports:
        return node_id, port
    return None


@dataclass
class GraphResult:
    kind: str
    node: dict[str, Any] | None = None
    status: str = ""
    end_node: str = ""
    transitions: list[dict[str, str | None]] = field(default_factory=list)


def advance(
    graph: dict[str, Any],
    source: str,
    port: str,
    loops: dict[str, int],
) -> GraphResult:
    nodes = _nodes(graph)
    edges = _edges(graph)
    transitions: list[dict[str, str | None]] = []
    current, current_port = source, port
    for _guard in range(10_000):
        edge = None
        for candidate in edges:
            parsed = parse_edge_from(str(candidate.get("from", "")), nodes)
            if parsed == (current, current_port):
                edge = candidate
                break
        if edge is None:
            transitions.append({"from": current, "port": current_port, "to": None})
            status = "failed" if is_failure_port(current_port) else "success"
            return GraphResult("end", status=status, transitions=transitions)
        target = str(edge.get("to", ""))
        transitions.append({"from": current, "port": current_port, "to": target})
        node = next((item for item in nodes if item.get("id") == target), None)
        if node is None:
            return GraphResult("end", status="failed", transitions=transitions)
        kind = node.get("type")
        if kind == "end":
            raw_status = node.get("status")
            status = raw_status if raw_status in ("success", "failed") else "success"
            return GraphResult(
                "end", status=str(status), end_node=str(node.get("id", "")), transitions=transitions
            )
        if kind == "loop":
            count = loops.get(str(node.get("id", "")), 0) + 1
            loops[str(node.get("id", ""))] = count
            raw_max = node.get("max")
            maximum = raw_max if isinstance(raw_max, int) else 1
            current = str(node.get("id", ""))
            current_port = "repeat" if count <= maximum else "exhausted"
            continue
        if kind == "start":
            return GraphResult("end", status="failed", transitions=transitions)
        return GraphResult("node", node=node, transitions=transitions)
    return GraphResult("end", status="failed", transitions=transitions)


def enter_graph(graph: dict[str, Any], loops: dict[str, int]) -> GraphResult:
    start = next((node for node in _nodes(graph) if node.get("type") == "start"), None)
    if start is None:
        return GraphResult("end", status="failed")
    return advance(graph, str(start.get("id", "")), "next", loops)


def graph_issues(graph: dict[str, Any]) -> list[str]:
    nodes = _nodes(graph)
    issues: list[str] = []
    ids = [str(node.get("id", "")) for node in nodes]
    duplicate = next((node_id for index, node_id in enumerate(ids) if node_id in ids[:index]), "")
    if duplicate:
        issues.append(f'duplicate node id "{duplicate}"')
    starts = [node for node in nodes if node.get("type") == "start"]
    if len(starts) != 1:
        issues.append(f"a workflow graph needs exactly one start node (found {len(starts)})")
    if len(starts) == 1 and not _rail(graph):
        issues.append("a workflow needs at least one agent or check step reachable from start")
    for node in nodes:
        if node.get("type") != "agent":
            continue
        if not node.get("prompt") and not node.get("skill"):
            issues.append(f'agent node "{node.get("id")}" needs a prompt or a skill')
    wired: set[str] = set()
    for edge in _edges(graph):
        parsed = parse_edge_from(str(edge.get("from", "")), nodes)
        if parsed is None:
            issues.append(f'edge from "{edge.get("from")}": no such node or port')
            continue
        key = f"{parsed[0]}.{parsed[1]}"
        if key in wired:
            issues.append(f'port "{key}" is wired more than once')
        wired.add(key)
        if not any(node.get("id") == edge.get("to") for node in nodes):
            issues.append(f'edge from "{edge.get("from")}": no such target node "{edge.get("to")}"')
    issues.extend(_unbounded_cycles(graph))
    for node in nodes:
        text = " ".join(
            str(node.get(key, "")) for key in ("prompt", "command", "question", "message")
        )
        for ref in _node_refs(text):
            if ref not in ids:
                issues.append(f'node "{node.get("id")}" references unknown node "{ref}"')
    return issues


@dataclass(frozen=True, slots=True)
class ForkBranch:
    port: str
    agent: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ForkShape:
    branches: tuple[ForkBranch, ...]
    join: str
    wait: str


def fork_shape(graph: dict[str, Any], fork_id: str) -> ForkShape | str:
    """The fork's agents and the one join they meet at, or why it cannot run."""
    nodes = _nodes(graph)
    fork = next((node for node in nodes if node.get("id") == fork_id), None)
    if fork is None or fork.get("type") != "fork":
        return f'no fork node "{fork_id}"'
    branches: list[ForkBranch] = []
    join = ""
    for port in ports_of(fork):
        edge = _edge_from(graph, fork_id, port)
        if edge is None:
            return f'fork "{fork_id}": branch {port} is not wired to an agent'
        agent = next((node for node in nodes if node.get("id") == edge.get("to")), None)
        if agent is None or agent.get("type") != "agent":
            return f'fork "{fork_id}": branch {port} must lead to an agent node'
        if agent.get("session") or agent.get("verdicts"):
            return (
                f'agent node "{agent.get("id")}" runs as a fork branch — '
                "it cannot continue a session or declare verdicts"
            )
        agent_id = str(agent.get("id", ""))
        if any(item.agent.get("id") == agent_id for item in branches):
            return f'fork "{fork_id}": two branches lead to the same agent "{agent_id}"'
        done = _edge_from(graph, agent_id, "done")
        if done is None:
            return f'fork branch "{agent_id}": wire its done port into a join'
        for out_port in ("done", "failed"):
            out = _edge_from(graph, agent_id, out_port)
            if out is None:
                continue
            target = next((node for node in nodes if node.get("id") == out.get("to")), None)
            if target is None or target.get("type") != "join":
                return f'fork branch "{agent_id}": its {out_port} port must lead into a join'
            target_id = str(target.get("id", ""))
            if join and target_id != join:
                return f'fork "{fork_id}": every branch must meet at the same join'
            join = target_id
        branches.append(ForkBranch(port, agent))
    if not join:
        return f'fork "{fork_id}" needs a join'
    return ForkShape(tuple(branches), join, _join_wait(nodes, join))


def _join_wait(nodes: list[dict[str, Any]], join_id: str) -> str:
    join = next((node for node in nodes if node.get("id") == join_id), None)
    wait = join.get("wait") if join else "all"
    return wait if wait in ("all", "any") else "all"


def _edge_from(graph: dict[str, Any], node_id: str, port: str) -> dict[str, Any] | None:
    nodes = _nodes(graph)
    for edge in _edges(graph):
        parsed = parse_edge_from(str(edge.get("from", "")), nodes)
        if parsed == (node_id, port):
            return edge
    return None


def render_refs(text: str, outputs: dict[str, dict[str, str]]) -> str:
    rendered = text
    for node_id, fields in outputs.items():
        for key, value in fields.items():
            rendered = rendered.replace(f"{{{{nodes.{node_id}.{key}}}}}", value)
    return rendered


def _number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return None
    return None


def compare_values(actual: object, op: str, expected: object) -> bool:
    left = "" if actual is None else str(actual)
    left_num = _number(actual)
    right_num = _number(expected)
    numeric = left_num is not None and right_num is not None and left.strip() != ""
    if op in ("equals", "=="):
        return left_num == right_num if numeric else str(left) == str(expected)
    if op == "not-equals":
        return left_num != right_num if numeric else str(left) != str(expected)
    if op == "contains":
        return str(expected) in str(left)
    if not numeric or left_num is None or right_num is None:
        return False
    if op == ">":
        return left_num > right_num
    if op == ">=":
        return left_num >= right_num
    if op == "<":
        return left_num < right_num
    if op == "<=":
        return left_num <= right_num
    return False


def _nodes(graph: dict[str, Any]) -> list[dict[str, Any]]:
    raw = graph.get("nodes")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _edges(graph: dict[str, Any]) -> list[dict[str, Any]]:
    raw = graph.get("edges")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def rail_nodes(graph: dict[str, Any]) -> list[dict[str, Any]]:
    return _rail(graph)


def _rail(graph: dict[str, Any]) -> list[dict[str, Any]]:
    """Agent and check nodes reachable from start, loops followed once."""
    seen: set[str] = set()
    found: list[dict[str, Any]] = []
    loops: dict[str, int] = {}
    step = enter_graph(graph, loops)
    guard = 0
    while step.kind == "node" and step.node is not None and guard < 100:
        guard += 1
        node_id = str(step.node.get("id", ""))
        if node_id in seen:
            break
        seen.add(node_id)
        if step.node.get("type") in ("agent", "check"):
            found.append(step.node)
        port = ports_of(step.node)[0] if ports_of(step.node) else "done"
        step = advance(graph, node_id, port, loops)
    return found


def _unbounded_cycles(graph: dict[str, Any]) -> list[str]:
    nodes = _nodes(graph)
    nxt: dict[str, list[str]] = {}
    for edge in _edges(graph):
        parsed = parse_edge_from(str(edge.get("from", "")), nodes)
        if parsed is None:
            continue
        node = next((item for item in nodes if item.get("id") == parsed[0]), None)
        if node is not None and node.get("type") == "loop" and parsed[1] == "repeat":
            continue
        nxt.setdefault(parsed[0], []).append(str(edge.get("to", "")))
    state: dict[str, str] = {}

    def visit(node_id: str) -> str | None:
        if state.get(node_id) == "open":
            return node_id
        if state.get(node_id) == "done":
            return None
        state[node_id] = "open"
        for target in nxt.get(node_id, []):
            hit = visit(target)
            if hit:
                return hit
        state[node_id] = "done"
        return None

    for node_id in [str(node.get("id", "")) for node in nodes]:
        hit = visit(node_id)
        if hit:
            return [
                f'the cycle through "{hit}" does not pass a loop node\'s repeat port — '
                "it could run forever"
            ]
    return []


def _node_refs(text: str) -> list[str]:
    refs: list[str] = []
    needle = "{{nodes."
    start = 0
    while True:
        at = text.find(needle, start)
        if at < 0:
            return refs
        rest = text[at + len(needle) :]
        node_id = rest.split(".", 1)[0].split("}", 1)[0].strip()
        if node_id:
            refs.append(node_id)
        start = at + len(needle)
