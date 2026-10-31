"""One clock for stored timestamps. ISO-8601 with a UTC offset sorts lexicographically."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta


def now() -> datetime:
    return datetime.now(UTC)


def stamp(moment: datetime | None = None) -> str:
    return (moment or now()).isoformat()


def parse_stamp(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def after(minutes: int, moment: datetime | None = None) -> str:
    return stamp((moment or now()) + timedelta(minutes=minutes))
