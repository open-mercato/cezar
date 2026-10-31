"""Loopback host check from `packages/cezar/src/server/capabilities.ts` (#426).

A missing or unparseable Host is untrusted. The match is anchored, so
`127.0.0.1.evil.com` is not loopback. `is_loopback_host` is the config twin:
a missing bind host means "we defaulted to loopback".
"""

from __future__ import annotations

import re

from stario.http.context import Context, Handler, Middleware
from stario.http.writer import Writer

from app.config import Config

_OCTET = r"(?:25[0-5]|2[0-4]\d|1?\d?\d)"
_LOOPBACK_V4 = re.compile(rf"^127(?:\.{_OCTET}){{3}}$")
_LOOPBACK_V6 = "0:0:0:0:0:0:0:1"
_ZONE = re.compile(r"%[a-z0-9._~-]+$")
_BRACKETED = re.compile(r"^\[([^\]]+)\](?::\d+)?$")
_PLAIN = re.compile(r"^([^:[\]]*)(?::(\d+))?$")
_GROUP = re.compile(r"^[0-9a-f]{1,4}$")
_OCTET_STRICT = re.compile(r"^(?:0|[1-9]\d{0,2})$")

HOST_FORBIDDEN = (
    "forbidden: unexpected Host header — this request did not originate "
    "from this machine (see #426)"
)


def is_loopback_host(host: str | None) -> bool:
    if not host:
        return True
    return _is_loopback_name(_normalize(host))


def is_loopback_host_header(host: str | None) -> bool:
    if not host:
        return False
    return _is_loopback_name(_normalize(host))


def hosted_mode(config: Config) -> bool:
    return config.hosted


def loopback_host_guard(config: Config) -> Middleware:
    """The `/api` half of the request-origin guard. Hosted mode skips it."""

    def middleware(handler: Handler) -> Handler:
        async def wrapped(c: Context, w: Writer) -> None:
            if not hosted_mode(config) and not is_loopback_host_header(c.req.headers.get("host")):
                w.json({"error": HOST_FORBIDDEN}, status=403)
                return
            await handler(c, w)

        return wrapped

    return middleware


def _normalize(host: str) -> str:
    bracketed = _BRACKETED.match(host)
    if bracketed:
        return _expand_ipv6(_strip_zone(bracketed.group(1).lower())) or ""
    if host.count(":") > 1:
        return _expand_ipv6(_strip_zone(host.lower())) or ""
    plain = _PLAIN.match(host)
    if plain:
        return plain.group(1).lower().removesuffix(".")
    return ""


def _strip_zone(host: str) -> str:
    return _ZONE.sub("", host)


def _expand_ipv4(value: str) -> tuple[str, str] | None:
    octets = value.split(".")
    if len(octets) != 4 or any(_OCTET_STRICT.match(octet) is None for octet in octets):
        return None
    numbers = [int(octet) for octet in octets]
    if any(octet > 255 for octet in numbers):
        return None
    return (f"{(numbers[0] << 8) | numbers[1]:x}", f"{(numbers[2] << 8) | numbers[3]:x}")


def _expand_ipv6(host: str) -> str | None:
    halves = host.split("::")
    if len(halves) > 2:
        return None
    if len(halves) == 2:
        head = halves[0].split(":") if halves[0] else []
        tail = halves[1].split(":") if halves[1] else []
        dotted = next((i for i, group in enumerate(tail) if "." in group), -1)
        if dotted != -1:
            if dotted != len(tail) - 1:
                return None
            ipv4 = _expand_ipv4(tail[dotted])
            if ipv4 is None:
                return None
            tail = [*tail[:dotted], *ipv4]
        if len(head) + len(tail) > 7:
            return None
        groups = [*head, *["0"] * (8 - len(head) - len(tail)), *tail]
    else:
        groups = host.split(":")
        dotted = next((i for i, group in enumerate(groups) if "." in group), -1)
        if dotted != -1:
            if dotted != len(groups) - 1:
                return None
            ipv4 = _expand_ipv4(groups[dotted])
            if ipv4 is None:
                return None
            groups = [*groups[:dotted], *ipv4]
    if len(groups) != 8 or any(_GROUP.match(group) is None for group in groups):
        return None
    return ":".join(f"{int(group, 16):x}" for group in groups)


def _is_loopback_name(hostname: str) -> bool:
    if hostname in ("localhost", _LOOPBACK_V6) or _LOOPBACK_V4.match(hostname):
        return True
    mapped = re.match(r"^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$", hostname)
    if mapped is None:
        return False
    high = int(mapped.group(1), 16)
    return (high >> 8) == 0x7F
