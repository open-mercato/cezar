"""Edits a version-2 workflow graph and writes its YAML.

The engine ignores `layout`. Positions are for the node editor only.
"""

from __future__ import annotations

import re
from typing import Any

import yaml

_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,32}$")
_KINDS = frozenset({"agent", "check", "end", "loop"})


def blank(name: str) -> dict[str, Any]:
    return {
        "version": 2,
        "name": name,
        "description": "A graph edited in the cockpit.",
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "implement", "type": "agent", "prompt": "{{task}}"},
            {"id": "ok", "type": "end", "status": "success"},
        ],
        "edges": [
            {"from": "start", "to": "implement"},
            {"from": "implement", "to": "ok"},
        ],
        "layout": {
            "start": {"x": 40, "y": 80},
            "implement": {"x": 280, "y": 80},
            "ok": {"x": 520, "y": 80},
        },
    }


def add_node(doc: dict[str, Any], node_id: str, kind: str) -> str | None:
    if _ID.fullmatch(node_id) is None:
        return "node id must be letters, digits, _ or -"
    if kind not in _KINDS:
        return "node type must be agent, check, loop, or end"
    nodes = _nodes(doc)
    if any(str(node.get("id")) == node_id for node in nodes):
        return "that node already exists"
    node: dict[str, Any] = {"id": node_id, "type": kind}
    if kind == "agent":
        node["prompt"] = "{{task}}"
    elif kind == "check":
        node["command"] = "true"
    elif kind == "loop":
        node["max"] = 3
    elif kind == "end":
        node["status"] = "success"
    nodes.append(node)
    doc["nodes"] = nodes
    layout = _layout(doc)
    layout[node_id] = {"x": 40, "y": 80 + 140 * (len(nodes) - 1)}
    doc["layout"] = layout
    return None


def move_node(doc: dict[str, Any], node_id: str, x: int, y: int) -> str | None:
    if not any(str(node.get("id")) == node_id for node in _nodes(doc)):
        return "no such node"
    if not 0 <= x <= 4000 or not 0 <= y <= 4000:
        return "position is out of range"
    layout = _layout(doc)
    layout[node_id] = {"x": x, "y": y}
    doc["layout"] = layout
    return None


def connect(doc: dict[str, Any], source: str, target: str) -> str | None:
    nodes = _nodes(doc)
    ids = {str(node.get("id")) for node in nodes}
    if source not in ids or target not in ids:
        return "connect two nodes that exist"
    if source == target:
        return "a node cannot connect to itself"
    edges = [edge for edge in _edges(doc) if str(edge.get("from")) != source]
    edges.append({"from": source, "to": target})
    doc["edges"] = edges
    return None


def dump(doc: dict[str, Any]) -> str:
    return yaml.safe_dump(doc, sort_keys=False)


def _nodes(doc: dict[str, Any]) -> list[dict[str, Any]]:
    raw = doc.get("nodes")
    if not isinstance(raw, list):
        doc["nodes"] = []
        return doc["nodes"]
    return [item for item in raw if isinstance(item, dict)]


def _edges(doc: dict[str, Any]) -> list[dict[str, Any]]:
    raw = doc.get("edges")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _layout(doc: dict[str, Any]) -> dict[str, Any]:
    raw = doc.get("layout")
    return raw if isinstance(raw, dict) else {}
