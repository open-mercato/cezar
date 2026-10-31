"""Mark mermaid fences for the vendored client renderer.

The diagram itself is drawn by `static/js/mermaid.min.js`. This module only
finds the fences.
"""

from __future__ import annotations

import re

from stario import h
from stario.datastar import data
from stario.markup import HtmlElement

_FENCE = re.compile(r"```mermaid\s*\n(.*?)```", re.S)


def diagrams(text: str) -> list[HtmlElement]:
    return [
        h.Pre(
            {"class": "mermaid"},
            data.ignore_morph(),
            data.init("app.diagram.render(el)"),
            source.strip(),
        )
        for source in _FENCE.findall(text)
        if source.strip()
    ]
