"""A unified diff as colored lines, rendered on the server."""

from __future__ import annotations

from stario import h
from stario.markup import HtmlElement


def diff_block(text: str) -> HtmlElement:
    """One `<pre class="diff">`, each line classed by its first character."""
    lines: list[str | HtmlElement] = []
    for line in text.splitlines():
        if line.startswith("@@"):
            klass = "d-hunk"
        elif line.startswith("+") and not line.startswith("+++"):
            klass = "d-add"
        elif line.startswith("-") and not line.startswith("---"):
            klass = "d-del"
        else:
            lines.append(line + "\n")
            continue
        lines.append(h.Span({"class": klass}, line + "\n"))
    return h.Pre({"class": "diff"}, *lines)
