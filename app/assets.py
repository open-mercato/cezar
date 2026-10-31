from pathlib import Path

from stario import Assets

ASSETS = Assets(Path(__file__).resolve().parents[1] / "static", url_prefix="/static")
STYLE_CSS = ASSETS.href("css/style.css")
DATASTAR_JS = ASSETS.href("js/datastar.js")
# mermaid.min.js defines `mermaid`. diagram.js and thread.js call it as `app.*`.
SCRIPTS: tuple[str, ...] = tuple(
    ASSETS.href(f"js/{name}") for name in ("mermaid.min.js", "diagram.js", "thread.js", "graph.js")
)
