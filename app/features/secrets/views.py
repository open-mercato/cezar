from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.features.secrets.urls import SECRETS_SAVE
from app.features.settings.nav import settings_nav
from app.secrets.store import SecretMeta


def render(rows: list[SecretMeta], chrome: Chrome, tab: str, error: str) -> HtmlElement:
    items = [
        h.Li(h.Strong(row.name), h.Span({"class": "meta"}, ", ".join(row.audiences) or "checks"))
        for row in rows
    ]
    if not items:
        items.append(h.Li({"class": "muted"}, "No project secrets yet."))
    return frame(
        chrome,
        None,
        {"tab": tab, "name": "", "value": "", "_error": error},
        h.Main(
            {"id": "secrets"},
            settings_nav(),
            h.H1("Secrets"),
            h.P(
                {"class": "sub"},
                "Values are encrypted and injected into check steps. Agents do not receive them.",
            ),
            h.Ul({"class": "task-list"}, *items),
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(SECRETS_SAVE.href()), prevent=True),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Name"),
                    h.Input({"required": True, "maxlength": "128"}, data.bind("name")),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Value"),
                    h.Input({"required": True, "type": "password"}, data.bind("value")),
                ),
                h.P(
                    {"class": "error", "role": "alert"},
                    data.show("$_error"),
                    data.text("$_error"),
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Save secret",
                ),
            ),
        ),
    )
