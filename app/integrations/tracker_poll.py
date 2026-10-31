"""Poll the project's Jira or Linear connection for automation candidates (`tracker-poller.ts`).

TypeScript reads provider history. This port reads the tracker integration's issue list, so a
candidate is "an active issue currently in the wanted status", keyed by id and status: an issue
that leaves the status and comes back is a new candidate. Filters: `status` (a status name,
case-insensitive), `allLabels` (every label), `query` (text search).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.config import Config
from app.integrations.tracker import list_issues


@dataclass(frozen=True, slots=True)
class TrackerCandidate:
    key: str
    id: str
    title: str
    url: str
    status: str
    labels: tuple[str, ...] = ()

    def to_json(self) -> dict[str, object]:
        return {
            "key": self.key,
            "id": self.id,
            "title": self.title,
            "url": self.url,
            "status": self.status,
            "labels": list(self.labels),
        }

    @classmethod
    def from_json(cls, raw: object) -> TrackerCandidate | None:
        if not isinstance(raw, dict) or not raw.get("id"):
            return None
        labels = raw.get("labels")
        return cls(
            key=str(raw.get("key", "")),
            id=str(raw["id"]),
            title=str(raw.get("title", "")),
            url=str(raw.get("url", "")),
            status=str(raw.get("status", "")),
            labels=tuple(str(item) for item in labels) if isinstance(labels, list) else (),
        )


def poll(
    config: Config, root: Path, filters: dict[str, object]
) -> tuple[list[TrackerCandidate], str]:
    """Matching candidates, and the reason the tracker could not be read ('' when it could)."""
    query = filters.get("query")
    found = list_issues(config, root, query=query if isinstance(query, str) else "")
    if found.get("available") is not True:
        return [], str(found.get("reason") or "tracker is not available")
    wanted = filters.get("status")
    labels = [str(item).lower() for item in _list(filters.get("allLabels"))]
    cap = filters.get("maxRecords")
    limit = cap if isinstance(cap, int) and not isinstance(cap, bool) and cap > 0 else 25
    out: list[TrackerCandidate] = []
    for item in found.get("items") or []:
        status = str(item.get("status", ""))
        if isinstance(wanted, str) and wanted and status.lower() != wanted.lower():
            continue
        have = {str(label).lower() for label in item.get("labels") or []}
        if any(label not in have for label in labels):
            continue
        ident = str(item.get("id", ""))
        if not ident:
            continue
        out.append(
            TrackerCandidate(
                key=f"tracker:{ident}:{status.lower()}",
                id=ident,
                title=str(item.get("title", ""))[:500],
                url=str(item.get("url", "")),
                status=status,
                labels=tuple(str(label) for label in item.get("labels") or []),
            )
        )
    return out[:limit], ""


def _list(value: object) -> list[object]:
    return value if isinstance(value, list) else []
