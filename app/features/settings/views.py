from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.config import RUNNERS
from app.engine.model import Settings
from app.features.settings.nav import settings_nav
from app.features.settings.urls import SETTINGS_LIVE, SETTINGS_SAVE


def render(settings: Settings, chrome: Chrome, tab: str) -> HtmlElement:
    return frame(
        chrome,
        SETTINGS_LIVE.href(),
        {
            "tab": tab,
            "max_parallel": settings.max_parallel,
            "default_runner": settings.default_runner,
            "theme": settings.theme,
            "accent": settings.accent,
            "_error": "",
        },
        h.Main(
            {"id": "settings"},
            h.H1("Settings"),
            h.P(
                {"class": "sub"},
                "Workspace-wide. Parallelism defaults to 2, same as the TypeScript cockpit. "
                "Telemetry is intentionally not ported and is not sent.",
            ),
            settings_nav(),
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(SETTINGS_SAVE.href()), prevent=True),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Tasks at once"),
                    h.Input(
                        {"type": "number", "min": "1", "max": "16", "required": True},
                        data.bind("max_parallel"),
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Default agent"),
                    h.Select(
                        data.bind("default_runner"),
                        *[h.Option({"value": runner}, runner) for runner in RUNNERS],
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Theme"),
                    h.Select(
                        data.bind("theme"),
                        h.Option({"value": "dark"}, "Dark"),
                        h.Option({"value": "light"}, "Light"),
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Accent"),
                    h.Select(
                        data.bind("accent"),
                        h.Option({"value": "lime"}, "Lime"),
                        h.Option({"value": "violet"}, "Violet"),
                    ),
                ),
                h.P(
                    {"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error")
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Save",
                ),
            ),
        ),
    )
