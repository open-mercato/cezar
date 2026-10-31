"""Server-drawn graph editor. Add, move, and connect nodes, then save YAML."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import yaml
from litewriter import LiteWriter
from stario import App, Context, Relay, Writer, h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.live import read_form, stream
from app.common.shell import Chrome, frame, load_chrome
from app.config import Config
from app.engine.catalog import WORKFLOWS_DIR
from app.engine.engine import CHANGED, Engine
from app.engine.graph import graph_issues
from app.engine.graph_edit import add_node, blank, connect, dump, move_node
from app.features.workflows.urls import (
    EDITOR,
    EDITOR_ADD,
    EDITOR_CONNECT,
    EDITOR_LIVE,
    EDITOR_MOVE,
    EDITOR_SAVE,
    EDITOR_START,
    WorkflowsView,
)
from app.store.db import get_project

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,64}$")


@dataclass(frozen=True, slots=True)
class EditorPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(EDITOR, self.show)
        app.add(EDITOR_LIVE, self.live)
        app.add(EDITOR_START, self.start)
        app.add(EDITOR_ADD, self.add)
        app.add(EDITOR_MOVE, self.move)
        app.add(EDITOR_CONNECT, self.connect)
        app.add(EDITOR_SAVE, self.save)

    def _view(self, query: object) -> WorkflowsView:
        view = WorkflowsView.from_query(query)  # type: ignore[arg-type]
        if not view.project:
            view = replace(view, project=self.engine.boot_project_id)
        return view

    async def show(self, c: Context, w: Writer) -> None:
        name = c.match.params.get("name", "")
        if not _NAME.fullmatch(name):
            w.text("unknown workflow", 404)
            return
        w.html(self._render(self._view(c.req.query), name, uuid.uuid7().hex, ""))

    async def live(self, c: Context, w: Writer) -> None:
        name = c.match.params.get("name", "")
        view = self._view(c.req.query)
        if not _NAME.fullmatch(name):
            w.text("unknown workflow", 404)
            return
        await stream(c, w, self.relay, lambda tab: self._render(view, name, tab, ""))

    async def start(self, c: Context, w: Writer) -> None:
        await self._mutate(c, w, lambda doc, _signals, name: blank(name), replace=True)

    async def add(self, c: Context, w: Writer) -> None:
        def edit(doc: dict[str, Any], signals: dict[str, object], _name: str) -> str | None:
            node_id = str(signals.get("node_id", "")).strip()
            kind = str(signals.get("node_type", "agent"))
            return add_node(doc, node_id, kind)

        await self._mutate(c, w, edit)

    async def move(self, c: Context, w: Writer) -> None:
        def edit(doc: dict[str, Any], signals: dict[str, object], _name: str) -> str | None:
            return move_node(
                doc,
                str(signals.get("move_id", "")),
                _num(signals.get("x")),
                _num(signals.get("y")),
            )

        await self._mutate(c, w, edit)

    async def connect(self, c: Context, w: Writer) -> None:
        def edit(doc: dict[str, Any], signals: dict[str, object], _name: str) -> str | None:
            return connect(doc, str(signals.get("from_id", "")), str(signals.get("to_id", "")))

        await self._mutate(c, w, edit)

    async def save(self, c: Context, w: Writer) -> None:
        await self._mutate(c, w, lambda _doc, _signals, _name: None)

    async def _mutate(self, c: Context, w: Writer, edit, *, replace: bool = False) -> None:
        name = c.match.params.get("name", "")
        view = self._view(c.req.query)
        signals, tab = await read_form(c, w)
        if signals is None or tab is None or not _NAME.fullmatch(name):
            return
        path = _path(self, view, name)
        if path is None:
            w.text("unknown project", 400)
            return
        if replace:
            doc: dict[str, Any] = edit({}, signals, name)
            error = ""
        else:
            doc = _load(path)
            if not doc:
                self.relay.publish(f"tab.{tab}", {"_error": "start a graph first"})
                w.text("start a graph first", 409)
                return
            error = edit(doc, signals, name) or ""
        if error:
            self.relay.publish(f"tab.{tab}", {"_error": error})
            w.text(error, 400)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(dump(doc), encoding="utf-8")
        self.relay.publish(CHANGED, {})
        w.empty()

    def _render(self, view: WorkflowsView, name: str, tab: str, error: str) -> HtmlElement:
        path = _path(self, view, name)
        doc = _load(path) if path is not None and path.is_file() else {}
        chrome = load_chrome(self.db, self.config, "Workflow editor", "workflows", view.project)
        return render_editor(name, doc, view, chrome, tab, error)


def render_editor(
    name: str,
    doc: dict[str, Any],
    view: WorkflowsView,
    chrome: Chrome,
    tab: str,
    error: str,
) -> HtmlElement:
    raw_nodes = doc.get("nodes")
    raw_edges = doc.get("edges")
    raw_layout = doc.get("layout")
    nodes: list[Any] = raw_nodes if isinstance(raw_nodes, list) else []
    edges: list[Any] = raw_edges if isinstance(raw_edges, list) else []
    layout: dict[str, Any] = raw_layout if isinstance(raw_layout, dict) else {}
    issues = graph_issues(doc) if nodes else []
    cards = []
    options = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id", ""))
        raw_place = layout.get(node_id)
        place = raw_place if isinstance(raw_place, dict) else {}
        x_raw = place.get("x", 40)
        y_raw = place.get("y", 40)
        x = x_raw if isinstance(x_raw, int) else 40
        y = y_raw if isinstance(y_raw, int) else 40
        options.append(h.Option({"value": node_id}, node_id))
        cards.append(
            h.Div(
                {
                    "id": f"node-{node_id}",
                    "class": "graph-node",
                    "style": f"left:{x}px;top:{y}px",
                    "data-id": node_id,
                    "data-x": str(x),
                    "data-y": str(y),
                },
                data.on("pointerdown", "app.graph.down(el, evt)"),
                data.on("pointerup", "app.graph.drop(el, evt)"),
                h.Strong(node_id),
                h.Span(str(node.get("type", ""))),
            )
        )
    query = view.query()
    body: list[HtmlElement] = [
        h.H1(f"Graph · {name}"),
        h.P(
            {"class": "sub"},
            "Add a node, drag or type its position, connect a port, then save the YAML.",
        ),
    ]
    if not nodes:
        body.append(
            h.Form(
                data.on("submit", at.post(EDITOR_START.href(name, query=query)), prevent=True),
                h.Button({"class": "btn btn-primary", "type": "submit"}, "Start graph"),
            )
        )
    else:
        body.extend(
            [
                h.Div({"id": "graph-canvas", "class": "graph-canvas"}, *cards),
                h.Ul(
                    {"id": "graph-edges"},
                    *[
                        h.Li(f"{edge.get('from')} → {edge.get('to')}")
                        for edge in edges
                        if isinstance(edge, dict)
                    ],
                ),
                *[h.P({"class": "error"}, issue) for issue in issues],
                h.Form(
                    {"class": "composer"},
                    data.on("submit", at.post(EDITOR_ADD.href(name, query=query)), prevent=True),
                    h.Label(
                        {"class": "field"},
                        h.Span("Node id"),
                        h.Input({"id": "node-id", "required": True}, data.bind("node_id")),
                    ),
                    h.Label(
                        {"class": "field"},
                        h.Span("Type"),
                        h.Select(
                            data.bind("node_type"),
                            h.Option({"value": "agent"}, "agent"),
                            h.Option({"value": "check"}, "check"),
                            h.Option({"value": "loop"}, "loop"),
                            h.Option({"value": "end"}, "end"),
                        ),
                    ),
                    h.Button({"class": "btn", "type": "submit"}, "Add node"),
                ),
                h.Form(
                    {"class": "composer"},
                    data.on("submit", at.post(EDITOR_MOVE.href(name, query=query)), prevent=True),
                    h.Label(
                        {"class": "field"},
                        h.Span("Node"),
                        h.Select({"id": "move-id"}, data.bind("move_id"), *options),
                    ),
                    h.Label(
                        {"class": "field"},
                        h.Span("X"),
                        h.Input(
                            {"id": "move-x", "type": "number", "min": "0"},
                            data.bind("x"),
                        ),
                    ),
                    h.Label(
                        {"class": "field"},
                        h.Span("Y"),
                        h.Input(
                            {"id": "move-y", "type": "number", "min": "0"},
                            data.bind("y"),
                        ),
                    ),
                    h.Button({"class": "btn", "type": "submit"}, "Move"),
                ),
                h.Form(
                    {"class": "composer"},
                    data.on(
                        "submit",
                        at.post(EDITOR_CONNECT.href(name, query=query)),
                        prevent=True,
                    ),
                    h.Label(
                        {"class": "field"},
                        h.Span("From"),
                        h.Select({"id": "from-id"}, data.bind("from_id"), *options),
                    ),
                    h.Label(
                        {"class": "field"},
                        h.Span("To"),
                        h.Select({"id": "to-id"}, data.bind("to_id"), *options),
                    ),
                    h.Button({"class": "btn", "type": "submit"}, "Connect"),
                ),
                h.Form(
                    data.on("submit", at.post(EDITOR_SAVE.href(name, query=query)), prevent=True),
                    h.Button(
                        {"id": "save-graph", "class": "btn btn-primary", "type": "submit"},
                        "Save YAML",
                    ),
                ),
            ]
        )
    return frame(
        chrome,
        EDITOR_LIVE.href(name, query=query),
        {
            "tab": tab,
            "node_id": "",
            "node_type": "agent",
            "move_id": "",
            "x": 0,
            "y": 0,
            "from_id": "",
            "to_id": "",
            "_error": error,
        },
        h.Main(
            {"id": "graph-editor"},
            *body,
            h.P(
                {"class": "error", "role": "alert"},
                data.show("$_error"),
                data.text("$_error"),
            ),
        ),
    )


def _path(page: EditorPage, view: WorkflowsView, name: str) -> Path | None:
    project = get_project(page.db, view.project)
    if project is None:
        return None
    return Path(project.root) / WORKFLOWS_DIR / f"{name}.yaml"


def _load(path: Path | None) -> dict[str, Any]:
    if path is None or not path.is_file():
        return {}
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError, yaml.YAMLError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _num(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.lstrip("-").isdigit():
        return int(value)
    return 0
