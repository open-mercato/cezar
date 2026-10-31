"""When a provider usage limit lifts.

The shapes match `packages/cezar/src/core/usage-limit.ts`: Claude's
`usage limit reached|<epoch>` envelope, an explicit timestamp, a dated or
clock-only reset (`8:10pm (Europe/Warsaw)`), and a relative delay. A limit
with no recoverable instant is not a schedule. A reset more than seven days
out is ignored. A stale instant clamps to now.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_USAGE_LIMIT_WAIT = timedelta(days=7)

_CLAUDE_MARKER = re.compile(
    r"claude(?:\s+ai)?\s+usage\s+limit\s+reached\s*\|\s*(\d{9,16})",
    re.IGNORECASE,
)
_LIMIT_PHRASE = re.compile(
    r"\b(?:usage|rate|session|weekly|hourly)[\s-]?limit\b"
    r"|\brate[_-]?limit(?:_error|ed)?\b"
    r"|\bquota\s+(?:exceeded|reached)\b"
    r"|\bout\s+of\s+(?:credits|quota)\b",
    re.IGNORECASE,
)
_RESET_AT = re.compile(
    r"(?:resets?|resets?\s+at|try\s+again|retry|available\s+again|unlocks?)\b"
    r"[^\n]{0,24}?\b(\d{4}-\d{2}-\d{2}"
    r"(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)",
    re.IGNORECASE,
)
_RESET_IN = re.compile(
    r"(?:try\s+again|retry|resets?|available\s+again)\b[^\n]{0,16}?\b(?:in|after)\s+"
    r"(\d{1,7})\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b",
    re.IGNORECASE,
)
_RETRY_AFTER = re.compile(r"\bretry[-_\s]?after\b\s*[:=]?\s*(\d{1,7})\b", re.IGNORECASE)
# `resets 8:10pm (Europe/Warsaw)` and `try again at 20:10`. Dated form is read first.
_RESET_CLOCK = re.compile(
    r"(?:resets?|resets?\s+at|try\s+again|retry|available\s+again|unlocks?)\b"
    r"[^\n]{0,24}?\b(?:at\s*)?(\d{1,2})"
    r"(?:(?::(\d{2}))\s*([ap]\.?m\.?)?|\s*([ap]\.?m\.?))"
    r"(?:\s*\(([^)]+)\))?",
    re.IGNORECASE,
)
_RESET_DATED = re.compile(
    r"(?:resets?|resets?\s+at|try\s+again|retry|available\s+again|unlocks?)\b"
    r"[^\n]{0,12}?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+"
    r"(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?(\d{1,2})"
    r"(?:(?::(\d{2}))\s*([ap]\.?m\.?)?|\s*([ap]\.?m\.?))"
    r"(?:\s*\(([^)]+)\))?",
    re.IGNORECASE,
)
_MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}
_CLOCK_JUST_LIFTED = timedelta(hours=1)

_UNIT_SECONDS = {
    "s": 1,
    "sec": 1,
    "secs": 1,
    "second": 1,
    "seconds": 1,
    "m": 60,
    "min": 60,
    "mins": 60,
    "minute": 60,
    "minutes": 60,
    "h": 3600,
    "hr": 3600,
    "hrs": 3600,
    "hour": 3600,
    "hours": 3600,
}


@dataclass(frozen=True, slots=True)
class UsageLimitHit:
    reset_at: datetime
    evidence: str


def parse_usage_limit(message: str, moment: datetime) -> UsageLimitHit | None:
    if not message.strip():
        return None
    marker = _CLAUDE_MARKER.search(message)
    if marker:
        return _accept(_from_epoch(int(marker.group(1))), "claude-marker", moment)
    if _LIMIT_PHRASE.search(message) is None:
        return None
    stamped = _RESET_AT.search(message)
    if stamped:
        parsed = _parse_instant(stamped.group(1))
        if parsed is not None:
            return _accept(parsed, "timestamp", moment)
    dated = _RESET_DATED.search(message)
    if dated:
        parsed = _dated_clock(dated, moment)
        return None if parsed is None else _accept(parsed, "clock", moment)
    clock = _RESET_CLOCK.search(message)
    if clock:
        parsed = _clock_reset(clock, moment)
        if parsed is not None:
            return _accept(parsed, "clock", moment)
    delay = _RESET_IN.search(message)
    if delay:
        seconds = _seconds(int(delay.group(1)), delay.group(2))
        if seconds is not None:
            return _accept(moment + timedelta(seconds=seconds), "delay", moment)
    header = _RETRY_AFTER.search(message)
    if header:
        return _accept(moment + timedelta(seconds=int(header.group(1))), "delay", moment)
    return None


def _accept(when: datetime, evidence: str, moment: datetime) -> UsageLimitHit | None:
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    if when < moment:
        when = moment
    if when - moment > MAX_USAGE_LIMIT_WAIT:
        return None
    return UsageLimitHit(when, evidence)


def _from_epoch(value: int) -> datetime:
    seconds = value / 1000 if value >= 10**12 else value
    return datetime.fromtimestamp(seconds, UTC)


def _parse_instant(raw: str) -> datetime | None:
    text = raw.strip().replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _read_clock(
    hour_text: str, minute_text: str | None, meridiem_text: str | None
) -> tuple[int, int] | None:
    try:
        hour = int(hour_text)
        minute = 0 if minute_text is None else int(minute_text)
    except ValueError:
        return None
    if minute < 0 or minute > 59:
        return None
    meridiem = (meridiem_text or "").lower().replace(".", "")
    if meridiem:
        if hour < 1 or hour > 12:
            return None
        if meridiem == "am":
            hour = 0 if hour == 12 else hour
        elif meridiem == "pm":
            hour = 12 if hour == 12 else hour + 12
        else:
            return None
    elif hour < 0 or hour > 23:
        return None
    return hour, minute


def _zone(name: str | None) -> ZoneInfo | None:
    if not name or not name.strip():
        return None
    try:
        return ZoneInfo(name.strip())
    except ZoneInfoNotFoundError:
        return None


def _clock_reset(match: re.Match[str], moment: datetime) -> datetime | None:
    clock = _read_clock(match.group(1), match.group(2), match.group(3) or match.group(4))
    if clock is None:
        return None
    return _next_clock(clock[0], clock[1], moment, _zone(match.group(5)))


def _dated_clock(match: re.Match[str], moment: datetime) -> datetime | None:
    month = _MONTHS.get(match.group(1)[:3].lower(), 0)
    try:
        day = int(match.group(2))
    except ValueError:
        return None
    clock = _read_clock(match.group(3), match.group(4), match.group(5) or match.group(6))
    if month < 1 or clock is None or day < 1 or day > 31:
        return None
    zone = _zone(match.group(7))
    year = moment.astimezone(zone).year if zone is not None else moment.year

    def at(year_value: int) -> datetime | None:
        try:
            if datetime(year_value, month, day, tzinfo=UTC).day != day:
                return None
        except ValueError:
            return None
        if zone is not None:
            try:
                local = datetime(year_value, month, day, clock[0], clock[1], tzinfo=zone)
            except ValueError:
                return None
            return local.astimezone(UTC)
        return datetime(year_value, month, day, clock[0], clock[1], tzinfo=UTC)

    candidate = at(year)
    if candidate is None:
        return None
    if moment - candidate > timedelta(days=1):
        return at(year + 1)
    return candidate


def _next_clock(hour: int, minute: int, moment: datetime, zone: ZoneInfo | None) -> datetime | None:
    if zone is None:
        local = moment.astimezone()
        candidate = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if moment - candidate > _CLOCK_JUST_LIFTED:
            candidate += timedelta(days=1)
        return candidate.astimezone(UTC)
    local_now = moment.astimezone(zone)
    try:
        candidate = datetime(
            local_now.year, local_now.month, local_now.day, hour, minute, tzinfo=zone
        )
    except ValueError:
        return None
    utc = candidate.astimezone(UTC)
    if moment - utc > _CLOCK_JUST_LIFTED:
        nxt = local_now.date() + timedelta(days=1)
        try:
            candidate = datetime(nxt.year, nxt.month, nxt.day, hour, minute, tzinfo=zone)
        except ValueError:
            return None
        utc = candidate.astimezone(UTC)
    return utc


def _seconds(amount: int, unit: str) -> int | None:
    scale = _UNIT_SECONDS.get(unit.lower())
    if scale is None:
        return None
    return amount * scale
