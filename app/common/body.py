"""JSON object request bodies for the `/api/v1` handlers."""

from typing import cast

from stario import Context, Writer
from stario.datastar import read_signals
from stario.exceptions import RequestBodyError


async def optional_body(c: Context) -> dict[str, object] | None:
    try:
        loaded = await read_signals(c.req)
    except RequestBodyError:
        return None
    return cast(dict[str, object], loaded) if isinstance(loaded, dict) else None


async def json_body(c: Context, w: Writer) -> dict[str, object] | None:
    loaded = await optional_body(c)
    if loaded is None:
        w.json({"error": "invalid json"}, status=400)
    return loaded
