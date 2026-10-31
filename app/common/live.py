"""Shared page plumbing: read the tab id from signals and stream a live page."""

import inspect
from collections.abc import Callable
from typing import Any

from stario import Context, Relay, Writer
from stario.datastar import SSE, read_signals
from stario.exceptions import RequestBodyError

from app.engine.engine import CHANGED


async def read_form(c: Context, w: Writer) -> tuple[dict[str, Any], str] | tuple[None, None]:
    """Signals and the validated tab id, or a 400 already written and (None, None)."""
    try:
        signals = await read_signals(c.req)
    except RequestBodyError:
        w.text("invalid input", 400)
        return None, None
    tab = str(signals.get("tab", ""))
    if not (tab.isalnum() and len(tab) <= 32):
        w.text("tab must be a short id", 400)
        return None, None
    return signals, tab


async def read_tab(c: Context, w: Writer) -> str | None:
    return (await read_form(c, w))[1]


async def stream(
    c: Context, w: Writer, relay: Relay[dict[str, str]], render: Callable[[str], Any]
) -> None:
    """Patch the page on every CHANGED and relay per-tab signals; `render(tab)` may be async."""
    tab = await read_tab(c, w)
    if tab is None:
        return

    async def paint() -> Any:
        html = render(tab)
        return await html if inspect.isawaitable(html) else html

    async with relay.subscribe(CHANGED, f"tab.{tab}", latest=True) as events:
        sse = SSE(w)
        sse.patch_elements(await paint())
        async for subject, payload in c.alive(events):
            if subject == CHANGED:
                sse.patch_elements(await paint())
            else:
                sse.patch_signals(payload)
