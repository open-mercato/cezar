"""Jira and Linear connection, association, search, and a watch snapshot.

Credentials are a `0600` dotenv file under the data directory. The HTTP
response never includes the token. `CEZ_DRY_RUN=1` refuses to save them.
Reads go to the stored Jira origin or the configured Linear API, and both
must be the vendor https host or a loopback recorded server.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from base64 import b64encode
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.request import Request

from app.config import Config
from app.integrations.clients import _open, forge_base_issue

_JIRA_ORIGIN = re.compile(r"^https://[a-z0-9][a-z0-9-]*\.atlassian\.net/?$", re.IGNORECASE)
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass
class Watch:
    id: str
    root: str
    association: dict[str, Any]
    query: str
    state: str
    labels: list[str]
    version: int = 0
    checking: bool = False
    checked_at: str | None = None
    result: dict[str, Any] | None = None


@dataclass
class TrackerWatches:
    entries: dict[str, Watch] = field(default_factory=dict)

    def open(
        self,
        root: str,
        body: dict[str, Any],
        result: dict[str, Any],
    ) -> dict[str, str] | str:
        association = body.get("association")
        if not isinstance(association, dict):
            return "invalid watch"
        query = str(body.get("query", "")).strip()
        state = str(body.get("state", "active"))
        labels = body.get("labels")
        if not isinstance(labels, list) or any(not isinstance(item, str) for item in labels):
            return "invalid watch"
        if len(query) > 256 or len(labels) > 20:
            return "invalid watch"
        watch = Watch(
            id=str(uuid.uuid4()),
            root=str(Path(root).resolve()),
            association=association,
            query=query,
            state=state,
            labels=sorted({item.strip() for item in labels if item.strip()}),
            version=1,
            result=result,
        )
        self.entries[watch.id] = watch
        return {"id": watch.id, "topic": f"tracker:{watch.id}"}

    def snapshot(self, root: str, watch_id: str) -> dict[str, Any] | None:
        watch = self.entries.get(watch_id)
        if watch is None or watch.root != str(Path(root).resolve()):
            return None
        return _snapshot(watch)

    def refresh(self, root: str, watch_id: str, result: dict[str, Any]) -> dict[str, Any] | None:
        watch = self.entries.get(watch_id)
        if watch is None or watch.root != str(Path(root).resolve()):
            return None
        watch.version += 1
        watch.result = result
        return _snapshot(watch)


def connection_view(config: Config, root: Path) -> dict[str, Any]:
    if config.dry_run:
        return {"connection": None, "demo": True}
    record, error = _read(config, root)
    if error:
        return {"connection": None, "demo": False, "error": error}
    if record is None:
        return {"connection": None, "demo": False}
    return {"connection": {"id": record["id"], "kind": record["kind"]}, "demo": False}


def save_connection(config: Config, root: Path, body: dict[str, Any]) -> dict[str, Any] | None:
    if config.dry_run:
        return None
    issue = _credential_issue(body)
    if issue:
        return None
    record = {
        "id": str(uuid.uuid4()),
        "projectRoot": str(root.resolve()),
        "kind": body["kind"],
        "credentials": body,
    }
    _write(config, root, record)
    return {"connection": {"id": record["id"], "kind": record["kind"]}, "demo": False}


def delete_connection(config: Config, root: Path) -> bool:
    if config.dry_run:
        return False
    path = _env_path(config, root)
    try:
        path.unlink()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return True


def read_association(root: Path) -> dict[str, Any] | None:
    path = root / ".ai" / "cezar" / "tracker.json"
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return None
    if not isinstance(loaded, dict) or loaded.get("kind") not in ("jira", "linear"):
        return None
    source = loaded.get("source")
    if not isinstance(source, dict):
        return None
    return {
        "kind": loaded["kind"],
        "source": {"id": str(source.get("id", "")), "webUrl": str(source.get("webUrl", ""))},
        "externalId": str(loaded.get("externalId", "")),
        "externalName": str(loaded.get("externalName", "")),
        **({"connectionId": loaded["connectionId"]} if loaded.get("connectionId") else {}),
    }


def write_association(root: Path, association: dict[str, Any]) -> bool:
    path = root / ".ai" / "cezar" / "tracker.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(association, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    return True


def clear_association(root: Path) -> bool:
    path = root / ".ai" / "cezar" / "tracker.json"
    try:
        path.unlink()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return True


def resolve_association(config: Config, root: Path, body: dict[str, Any]) -> dict[str, Any]:
    kind = body.get("kind")
    external_id = body.get("externalId")
    if kind not in ("jira", "linear") or not isinstance(external_id, str) or not external_id:
        return {"available": False, "code": "invalid_response", "reason": "invalid association"}
    record, error = _read(config, root)
    if config.dry_run:
        return {
            "available": False,
            "code": "not_configured",
            "reason": "demo mode cannot save credentials",
        }
    if error or record is None or record["kind"] != kind:
        return {
            "available": False,
            "code": "credentials_missing",
            "reason": "tracker is not configured",
        }
    found = _find_candidate(config, root, record, external_id)
    if found is None:
        return {"available": False, "code": "not_found", "reason": "that project was not found"}
    if isinstance(found, str):
        return {"available": False, "code": "unavailable", "reason": found}
    association = {
        "kind": kind,
        "source": found["source"],
        "externalId": found["id"],
        "externalName": found["name"],
        "connectionId": record["id"],
    }
    return {"available": True, "association": association}


def list_issues(
    config: Config, root: Path, *, query: str = "", state: str = "active"
) -> dict[str, Any]:
    record, error = _read(config, root)
    association = read_association(root)
    if config.dry_run or record is None or association is None:
        code = "not_configured" if record is None or config.dry_run else "credentials_missing"
        if error:
            return {"available": False, "code": "unavailable", "reason": error}
        return {"available": False, "code": code, "reason": "tracker is not configured"}
    items, reason = _fetch_issues(config, record, association, query=query, state=state)
    if reason:
        return {"available": False, "code": "unavailable", "reason": reason}
    return {"available": True, "items": items, "association": association}


def automation_options(config: Config, root: Path) -> dict[str, Any]:
    """What a tracker automation can be built from: the association, its events, its statuses."""
    record, error = _read(config, root)
    association = read_association(root)
    if config.dry_run or record is None:
        return {
            "available": False,
            "code": "unavailable" if error else "not_configured",
            "reason": error or "tracker is not configured",
        }
    if association is None:
        return {
            "available": False,
            "code": "no_association",
            "reason": "choose a Jira project or Linear team for this project first",
        }
    statuses = _statuses(config, record, association)
    if isinstance(statuses, str):
        return {"available": False, "code": "unavailable", "reason": statuses}
    return {
        "available": True,
        "association": association,
        "events": ["issue.status_changed"],
        "statuses": statuses,
    }


def _statuses(
    config: Config, record: dict[str, Any], association: dict[str, Any]
) -> list[dict[str, str]] | str:
    creds = record["credentials"]
    if record["kind"] == "jira":
        origin = str(creds["origin"]).rstrip("/")
        project = _query(str(association["externalId"]))
        loaded = _get(f"{origin}/rest/api/3/project/{project}/statuses", _jira_headers(creds))
        if isinstance(loaded, dict) and loaded.get("available") is False:
            return str(loaded.get("reason", "jira is unavailable"))
        if not isinstance(loaded, list):
            return "jira returned an unexpected payload"
        seen: dict[str, str] = {}
        for kind in loaded:
            for status in _mapping(kind).get("statuses") or []:
                row = _mapping(status)
                if row.get("id") and row.get("name"):
                    seen.setdefault(str(row["id"]), str(row["name"]))
        return [{"id": ident, "name": name} for ident, name in seen.items()]
    loaded = _post(
        config.linear_api,
        {
            "query": (
                "query($team: ID) { workflowStates(filter: { team: { id: { eq: $team } } }) "
                "{ nodes { id name } } }"
            ),
            "variables": {"team": association["externalId"]},
        },
        {"authorization": str(creds["key"]), "content-type": "application/json"},
    )
    if isinstance(loaded, dict) and loaded.get("available") is False:
        return str(loaded.get("reason", "linear is unavailable"))
    nodes = _mapping(_mapping(_mapping(loaded).get("data")).get("workflowStates")).get("nodes")
    if not isinstance(nodes, list):
        return "linear returned an unexpected payload"
    return [
        {"id": str(item["id"]), "name": str(item["name"])}
        for item in nodes
        if isinstance(item, dict) and item.get("id") and item.get("name")
    ]


def candidates(config: Config, root: Path) -> dict[str, Any]:
    record, error = _read(config, root)
    if record is None:
        return {
            "available": False,
            "code": "not_configured" if not error else "unavailable",
            "reason": error or "tracker is not configured",
        }
    found = _candidate_list(config, record)
    if isinstance(found, str):
        return {"available": False, "code": "unavailable", "reason": found}
    rows = [{"id": row["id"], "name": row["name"]} for row in found]
    return {"available": True, "candidates": rows}


def _find_candidate(
    config: Config, root: Path, record: dict[str, Any], external_id: str
) -> dict[str, Any] | str | None:
    del root
    found = _candidate_list(config, record)
    if isinstance(found, str):
        return found
    for row in found:
        if row["id"] == external_id:
            return row
    return None


def _candidate_list(config: Config, record: dict[str, Any]) -> list[dict[str, Any]] | str:
    creds = record["credentials"]
    if record["kind"] == "jira":
        origin = str(creds["origin"]).rstrip("/")
        loaded = _get(f"{origin}/rest/api/3/project", _jira_headers(creds))
        if isinstance(loaded, dict) and loaded.get("available") is False:
            return str(loaded.get("reason", "jira is unavailable"))
        if not isinstance(loaded, list):
            return "jira returned an unexpected payload"
        rows = []
        for item in loaded:
            if isinstance(item, dict) and item.get("id") and item.get("name"):
                rows.append(
                    {
                        "id": str(item["id"]),
                        "name": str(item["name"]),
                        "source": {"id": str(item.get("key") or item["id"]), "webUrl": origin},
                    }
                )
        return rows
    loaded = _post(
        config.linear_api,
        {"query": "query { teams { nodes { id name } } }"},
        {"authorization": str(creds["key"]), "content-type": "application/json"},
    )
    if isinstance(loaded, dict) and loaded.get("available") is False:
        return str(loaded.get("reason", "linear is unavailable"))
    teams = _mapping(_mapping(loaded).get("data")).get("teams")
    nodes = _mapping(teams).get("nodes")
    if not isinstance(nodes, list):
        return "linear returned an unexpected payload"
    web = "https://linear.app"
    return [
        {
            "id": str(item["id"]),
            "name": str(item["name"]),
            "source": {"id": str(item["id"]), "webUrl": web},
        }
        for item in nodes
        if isinstance(item, dict) and item.get("id") and item.get("name")
    ]


def _fetch_issues(
    config: Config,
    record: dict[str, Any],
    association: dict[str, Any],
    *,
    query: str,
    state: str,
) -> tuple[list[dict[str, Any]], str]:
    if record["kind"] == "jira":
        origin = str(record["credentials"]["origin"]).rstrip("/")
        jql = f'project = "{association["externalId"]}"'
        if state == "active":
            jql += " AND resolution = Unresolved"
        if query.strip():
            jql += f' AND text ~ "{query.strip()}"'
        loaded = _get(
            f"{origin}/rest/api/3/search?jql={_query(jql)}&fields={_JIRA_FIELDS}",
            _jira_headers(record["credentials"]),
        )
        if isinstance(loaded, dict) and loaded.get("available") is False:
            return [], str(loaded.get("reason", "jira is unavailable"))
        issues = loaded.get("issues") if isinstance(loaded, dict) else None
        if not isinstance(issues, list):
            return [], "jira returned an unexpected payload"
        return [_jira_item(origin, item) for item in issues if isinstance(item, dict)], ""
    term = query.strip()
    loaded = _post(
        config.linear_api,
        {
            "query": (
                "query($term: String) { issues(filter: { title: { contains: $term } }) "
                "{ nodes { id identifier title url createdAt updatedAt state { name } "
                "labels(first: 50) { nodes { name } } } } }"
            ),
            "variables": {"term": term},
        },
        {"authorization": str(record["credentials"]["key"]), "content-type": "application/json"},
    )
    if isinstance(loaded, dict) and loaded.get("available") is False:
        return [], str(loaded.get("reason", "linear is unavailable"))
    issues = _mapping(_mapping(loaded).get("data")).get("issues")
    nodes = _mapping(issues).get("nodes")
    if not isinstance(nodes, list):
        return [], "linear returned an unexpected payload"
    return [_linear_item(item) for item in nodes if isinstance(item, dict)], ""


# The fields `jira.ts` asks for, minus the ones a list row does not show.
_JIRA_FIELDS = "project,summary,created,updated,labels,status"


def _names(raw: object) -> list[str]:
    """Jira labels are strings, Linear labels are `{name}` nodes."""
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        name = item if isinstance(item, str) else _mapping(item).get("name")
        if isinstance(name, str) and name:
            out.append(name)
    return out


def _jira_item(origin: str, item: dict[str, Any]) -> dict[str, Any]:
    fields = _mapping(item.get("fields"))
    status = _mapping(fields.get("status"))
    key = str(item.get("key", ""))
    return {
        "kind": "issue",
        "id": key,
        "title": str(fields.get("summary", "")),
        "author": "",
        "createdAt": str(fields.get("created", "")),
        "updatedAt": str(fields.get("updated", "")),
        "labels": _names(fields.get("labels")),
        "body": "",
        "bodyTruncated": False,
        "unsupportedContent": False,
        "url": f"{origin}/browse/{key}",
        "status": str(status.get("name", "")),
    }


def _linear_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "issue",
        "id": str(item.get("identifier") or item.get("id") or ""),
        "title": str(item.get("title", "")),
        "author": "",
        "createdAt": str(item.get("createdAt", "")),
        "updatedAt": str(item.get("updatedAt", "")),
        "labels": _names(_mapping(item.get("labels")).get("nodes")),
        "body": "",
        "bodyTruncated": False,
        "unsupportedContent": False,
        "url": str(item.get("url", "")),
        "status": str(_mapping(item.get("state")).get("name", "")),
    }


def _credential_issue(body: dict[str, Any]) -> str | None:
    kind = body.get("kind")
    if kind == "jira":
        origin = body.get("origin")
        email = body.get("email")
        token = body.get("token")
        if not isinstance(origin, str) or not (_JIRA_ORIGIN.match(origin) or _loopback(origin)):
            return "Use an HTTPS Jira Cloud site origin"
        if not isinstance(email, str) or _EMAIL.match(email) is None:
            return "invalid email"
        if not isinstance(token, str) or not token.strip() or len(token) > 8192:
            return "invalid token"
        return None
    if kind == "linear":
        key = body.get("key")
        if not isinstance(key, str) or not key.strip() or len(key) > 8192:
            return "invalid token"
        return None
    return "invalid tracker credentials"


def _loopback(origin: str) -> bool:
    return forge_base_issue(origin, "jira") is None and origin.startswith("http://")


def _jira_headers(creds: dict[str, Any]) -> dict[str, str]:
    token = b64encode(f"{creds['email']}:{creds['token']}".encode()).decode()
    return {"authorization": f"Basic {token}", "accept": "application/json"}


def _get(url: str, headers: dict[str, str]) -> Any:
    issue = forge_base_issue(url, "jira")
    if issue and "127.0.0.1" not in url and "localhost" not in url:
        return {"available": False, "reason": issue}
    return _open(Request(url, headers=headers, method="GET"))


def _post(url: str, body: dict[str, Any], headers: dict[str, str]) -> Any:
    kind = "linear" if "graphql" in url or "linear" in url else "jira"
    issue = forge_base_issue(url, kind)
    if issue:
        return {"available": False, "reason": issue}
    return _open(Request(url, data=json.dumps(body).encode(), headers=headers, method="POST"))


def _mapping(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _query(value: str) -> str:
    from urllib.parse import quote

    return quote(value)


def _snapshot(watch: Watch) -> dict[str, Any]:
    return {
        "version": watch.version,
        "checking": watch.checking,
        "checkedAt": watch.checked_at,
        "result": watch.result,
    }


def _env_path(config: Config, root: Path) -> Path:
    digest = hashlib.sha256(str(root.resolve()).encode()).hexdigest()
    return config.data_dir / "tracker-connections" / f"{digest}.env"


def connection_inventory(config: Config) -> list[dict[str, str | None]]:
    """Every stored credential file: its id, project root and provider, never the secret."""
    folder = config.data_dir / "tracker-connections"
    rows: list[dict[str, str | None]] = []
    if not folder.is_dir():
        return rows
    for path in sorted(folder.glob("*.env")):
        digest = path.stem
        try:
            values = dict(
                line.split("=", 1)
                for line in path.read_text(encoding="utf-8").splitlines()
                if "=" in line and not line.lstrip().startswith("#")
            )
        except OSError, ValueError:
            rows.append({"id": digest, "root": None, "provider": None, "status": "invalid"})
            continue
        provider = "jira" if "JIRA_API_TOKEN" in values else "linear"
        has_key = "JIRA_API_TOKEN" in values or "LINEAR_API_KEY" in values
        rows.append(
            {
                "id": digest,
                "root": values.get("PROJECT_ROOT") or None,
                "provider": provider if has_key else None,
                "status": "valid" if has_key and values.get("PROJECT_ROOT") else "invalid",
            }
        )
    return rows


def remove_connection_id(config: Config, digest: str) -> bool:
    """Delete one credential file by its 64-hex id. The vendor token is not revoked."""
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        return False
    path = config.data_dir / "tracker-connections" / f"{digest}.env"
    try:
        path.unlink()
    except OSError:
        return False
    return True


def _read(config: Config, root: Path) -> tuple[dict[str, Any] | None, str]:
    path = _env_path(config, root)
    if not path.is_file():
        return None, ""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None, "Cannot read project credentials."
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.strip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip("'\"")
    kind = "jira" if "JIRA_API_TOKEN" in values else "linear"
    if kind == "jira":
        credentials = {
            "kind": "jira",
            "origin": values.get("JIRA_BASE_URL", ""),
            "email": values.get("JIRA_EMAIL", ""),
            "token": values.get("JIRA_API_TOKEN", ""),
        }
    else:
        credentials = {"kind": "linear", "key": values.get("LINEAR_API_KEY", "")}
    return {
        "id": values.get("CONNECTION_ID", ""),
        "projectRoot": values.get("PROJECT_ROOT", ""),
        "kind": kind,
        "credentials": credentials,
    }, ""


def _write(config: Config, root: Path, record: dict[str, Any]) -> None:
    path = _env_path(config, root)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(path.parent, 0o700)
    creds = record["credentials"]
    if creds["kind"] == "jira":
        fields = {
            "JIRA_BASE_URL": creds["origin"],
            "JIRA_EMAIL": creds["email"],
            "JIRA_API_TOKEN": creds["token"],
        }
    else:
        fields = {"LINEAR_API_KEY": creds["key"]}
    lines = [
        "# Managed by cezar. Rotate credentials in project Settings; do not edit this file.",
        "RECORD_VERSION=1",
        f"CONNECTION_ID={record['id']}",
        f"PROJECT_ROOT={record['projectRoot']}",
    ]
    lines.extend(f"{key}={value}" for key, value in fields.items())
    temporary = path.with_suffix(".env.tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    os.chmod(path, 0o600)
