from typing import Any

from stario import h
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.features.places.urls import TRACKER


def item(row: dict[str, Any], chrome: Chrome, tab: str) -> HtmlElement:
    labels = row.get("labels")
    names = [str(name) for name in labels] if isinstance(labels, list) else []
    url = str(row.get("url", ""))
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "tracker-item"},
            h.H1(f"{row.get('id', '')} {row.get('title', '')}"),
            h.Nav({"class": "filters"}, h.A({"href": TRACKER.href()}, "Tracker")),
            h.P(
                {"class": "meta", "id": "tracker-status"},
                " · ".join(
                    part
                    for part in (
                        str(row.get("status", "")),
                        str(row.get("author", "")),
                        str(row.get("updatedAt", "")),
                    )
                    if part
                ),
            ),
            h.P({"class": "meta"}, "Labels: " + ", ".join(names)) if names else None,
            h.P({"class": "pr-body", "id": "tracker-body"}, str(row.get("body", ""))),
            h.A({"href": url, "rel": "noreferrer"}, "Open in the tracker") if url else None,
        ),
    )


def missing(title: str, reason: str, chrome: Chrome, tab: str) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "tracker-item"},
            h.H1(title),
            h.Nav({"class": "filters"}, h.A({"href": TRACKER.href()}, "Tracker")),
            h.P({"class": "sub"}, reason),
        ),
    )
