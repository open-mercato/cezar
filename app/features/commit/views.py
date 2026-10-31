from stario import h
from stario.markup import HtmlElement

from app.common.diff import diff_block
from app.common.shell import Chrome, frame


def detail(
    sha: str, text: str, back_href: str, back_label: str, chrome: Chrome, tab: str
) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "commit"},
            h.H1(f"Commit {sha[:12]}"),
            h.Nav({"class": "filters"}, h.A({"href": back_href}, back_label)),
            diff_block(text),
        ),
    )


def missing(sha: str, reason: str, back_href: str, back_label: str, chrome: Chrome, tab: str):
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "commit"},
            h.H1("Commit"),
            h.Nav({"class": "filters"}, h.A({"href": back_href}, back_label)),
            h.P({"class": "sub"}, reason),
        ),
    )
