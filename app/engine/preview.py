"""Design Mode proxy.

Local only, and only for an `http://` loopback address. The second listener
forwards that server and injects a marker before `</body>` on HTML responses.
Hosted mode and `CEZ_DESIGN_MODE=0` refuse. The picker is the marker; it does
not rewrite the page's scripts beyond that.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from urllib.error import URLError
from urllib.request import Request, urlopen

from app.http.loopback import is_loopback_host
from app.integrations.clients import forge_base_issue

MARKER = b"<!-- cezar-design -->"


def design_proxy_issue(url: str, *, enabled: bool) -> str | None:
    if not enabled:
        return "design mode is off"
    issue = forge_base_issue(url, "preview")
    if issue and "private" not in issue and "https" not in issue:
        return issue
    from urllib.parse import urlsplit

    parsed = urlsplit(url)
    if parsed.scheme != "http":
        return "design mode only mirrors loopback http"
    if not is_loopback_host(parsed.hostname):
        return "design mode only mirrors loopback http"
    return None


async def start_proxy(upstream: str) -> tuple[str, Callable[[], Awaitable[None]]]:
    base = upstream.rstrip("/")

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 2)
        except asyncio.IncompleteReadError, TimeoutError, asyncio.LimitOverrunError:
            writer.close()
            return
        line = header.split(b"\r\n", 1)[0].decode(errors="replace")
        parts = line.split(" ")
        path = parts[1] if len(parts) > 1 else "/"
        if not path.startswith("/"):
            path = "/"
        body, content_type, status = await asyncio.to_thread(_fetch, base + path)
        if b"text/html" in content_type and b"</body>" in body.lower():
            body = body.replace(b"</body>", MARKER + b"</body>", 1)
            body = body.replace(b"</BODY>", MARKER + b"</BODY>", 1)
        payload = (
            f"HTTP/1.1 {status} OK\r\n"
            f"Content-Type: {content_type.decode() or 'text/plain'}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n"
        ).encode() + body
        writer.write(payload)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    sockets = server.sockets or []
    port = sockets[0].getsockname()[1] if sockets else 0

    async def close() -> None:
        server.close()
        await server.wait_closed()

    return f"http://127.0.0.1:{port}", close


def _fetch(url: str) -> tuple[bytes, bytes, int]:
    try:
        with urlopen(Request(url, method="GET"), timeout=2) as response:
            raw_type = response.headers.get("content-type", "application/octet-stream")
            content_type = raw_type.split(";", 1)[0].strip().encode()
            return response.read(1_000_000), content_type, 200
    except URLError, TimeoutError, OSError:
        return b"upstream unavailable", b"text/plain", 502
