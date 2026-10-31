"""Outbound webhook destination policy.

The same classes as the TypeScript helper: a denied address is never a
target, a private address needs local consent, and hosted mode requires
public https. DNS is injected so a test does not resolve a name. A metadata
hostname is refused before any lookup.
"""

from __future__ import annotations

import socket
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

AddressClass = str  # "public" | "private" | "denied"
Lookup = Callable[[str], list[tuple[str, int]]]

_METADATA = frozenset(
    {
        "metadata",
        "metadata.google.internal",
        "metadata.goog",
        "instance-data",
        "instance-data.ec2.internal",
    }
)
_DENIED4 = (
    ("0.0.0.0", 8),
    ("100.64.0.0", 10),
    ("169.254.0.0", 16),
    ("192.0.0.0", 24),
    ("192.0.2.0", 24),
    ("192.88.99.0", 24),
    ("198.18.0.0", 15),
    ("198.51.100.0", 24),
    ("203.0.113.0", 24),
    ("224.0.0.0", 4),
    ("240.0.0.0", 4),
)
_PRIVATE4 = (("10.0.0.0", 8), ("127.0.0.0", 8), ("172.16.0.0", 12), ("192.168.0.0", 16))


class DestinationPolicyError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class DestinationPolicy:
    mode: str = "local"
    allow_local_network: bool = False
    server_ports: tuple[int, ...] = ()


@dataclass(frozen=True, slots=True)
class ValidatedDestination:
    url: str
    hostname: str
    address: str
    family: int
    private: bool


def classify_address(address: str) -> AddressClass:
    text = address.strip().removeprefix("[").removesuffix("]")
    if "%" in text:
        return "denied"
    try:
        packed = socket.inet_pton(socket.AF_INET, text)
    except OSError:
        packed = b""
    if packed:
        return _classify4(_v4(text))
    try:
        socket.inet_pton(socket.AF_INET6, text)
    except OSError:
        return "denied"
    value = _ipv6(text)
    if value in (0, _ipv6("fd00:ec2::254")):
        return "denied"
    if value == 1:
        return "private"
    if _in6(value, "::ffff:0:0", 96) or _in6(value, "::", 96):
        embedded = value & 0xFFFFFFFF
        dotted = ".".join(str((embedded >> shift) & 255) for shift in (24, 16, 8, 0))
        return _classify4(_v4(dotted))
    if _in6(value, "fc00::", 7):
        return "private"
    if (
        not _in6(value, "2000::", 3)
        or _in6(value, "2001::", 23)
        or _in6(value, "2001:db8::", 32)
        or _in6(value, "2002::", 16)
        or _in6(value, "3fff::", 20)
    ):
        return "denied"
    return "public"


def validate_destination(
    url: str,
    policy: DestinationPolicy,
    lookup: Lookup | None = None,
) -> ValidatedDestination:
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise DestinationPolicyError("invalid_url")
    if parsed.username or parsed.password or parsed.fragment or "#" in url:
        raise DestinationPolicyError("invalid_url")
    if policy.mode == "hosted" and parsed.scheme != "https":
        raise DestinationPolicyError("https_required")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if port in policy.server_ports:
        raise DestinationPolicyError("server_port")
    hostname = parsed.hostname.removeprefix("[").removesuffix("]").lower().rstrip(".")
    if hostname in _METADATA:
        raise DestinationPolicyError("metadata_hostname")
    family = _ip_family(hostname)
    try:
        if family:
            answers = [(hostname, family)]
        else:
            answers = (lookup or _lookup)(hostname)
    except DestinationPolicyError:
        raise
    except OSError as exc:
        if getattr(exc, "errno", None) in (socket.EAI_NONAME, socket.EAI_NODATA):
            raise DestinationPolicyError("dns_not_found") from exc
        raise DestinationPolicyError("dns_temporarily_unavailable") from exc
    if not answers or len(answers) > 64:
        raise DestinationPolicyError("invalid_dns")
    classes = [classify_address(address) for address, _family in answers]
    if "denied" in classes:
        raise DestinationPolicyError("denied_address")
    if len(set(classes)) != 1:
        raise DestinationPolicyError("mixed_dns")
    private = classes[0] == "private"
    if private and policy.mode == "hosted":
        raise DestinationPolicyError("public_destination_required")
    if private and not policy.allow_local_network:
        raise DestinationPolicyError("local_consent_required")
    address, found = answers[0]
    return ValidatedDestination(url, hostname, address, found, private)


def retry_after_seconds(raw: str | None) -> int | None:
    """Delta-seconds only. A date, a newline, or a suffix is not a delay."""
    if raw is None or len(raw.encode()) >= 16384 or "\r" in raw or "\n" in raw:
        return None
    value = raw.strip(" \t")
    if not value or not value.replace(".", "", 1).isdigit() or value.count(".") > 1:
        return None
    if value.startswith(".") or value.endswith("."):
        return None
    return int(float(value))


def _lookup(hostname: str) -> list[tuple[str, int]]:
    rows = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    found: list[tuple[str, int]] = []
    for family, _type, _proto, _canon, sockaddr in rows:
        address = str(sockaddr[0])
        number = 4 if family == socket.AF_INET else 6
        if (address, number) not in found:
            found.append((address, number))
    return found


def _ip_family(hostname: str) -> int:
    try:
        socket.inet_pton(socket.AF_INET, hostname)
        return 4
    except OSError:
        pass
    try:
        socket.inet_pton(socket.AF_INET6, hostname)
        return 6
    except OSError:
        return 0


def _v4(address: str) -> int:
    value = 0
    for octet in address.split("."):
        value = value * 256 + int(octet)
    return value


def _classify4(value: int) -> AddressClass:
    if any(_in4(value, network, bits) for network, bits in _DENIED4):
        return "denied"
    if any(_in4(value, network, bits) for network, bits in _PRIVATE4):
        return "private"
    return "public"


def _in4(address: int, network: str, bits: int) -> bool:
    shift = 32 - bits
    return address >> shift == _v4(network) >> shift


def _ipv6(address: str) -> int:
    text = address.lower()
    if "." in text:
        colon = text.rfind(":")
        tail = _v4(text[colon + 1 :])
        text = text[: colon + 1] + format(tail >> 16, "x") + ":" + format(tail & 0xFFFF, "x")
    if text.count("::") > 1:
        return 0
    left, sep, right = text.partition("::")
    head = [part for part in left.split(":") if part] if left else []
    tail = [part for part in right.split(":") if part] if sep else []
    if sep:
        missing = 8 - len(head) - len(tail)
        words = head + ["0"] * missing + tail
    else:
        words = head
    if len(words) != 8:
        return 0
    value = 0
    for word in words:
        value = (value << 16) + int(word, 16)
    return value


def _in6(address: int, network: str, bits: int) -> bool:
    shift = 128 - bits
    return address >> shift == _ipv6(network) >> shift
