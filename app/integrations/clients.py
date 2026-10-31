"""GitHub, Jira, and Linear reads.

Missing credentials answer `{available: false, reason}` and do not call out.
Tests point the base URL at a local server that speaks the recorded payload.
"""

from __future__ import annotations

import base64
import json
from ipaddress import ip_address
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from app.config import Config


def github_issues(config: Config, owner: str, repo: str) -> dict[str, Any]:
    issue = forge_base_issue(config.github_api, "github")
    if issue:
        return {"available": False, "reason": issue}
    if not config.github_token:
        return {"available": False, "reason": "gh is not authenticated"}
    if not owner or not repo:
        return {"available": False, "reason": "owner and repo are required"}
    url = f"{config.github_api.rstrip('/')}/repos/{owner}/{repo}/issues?state=open"
    loaded = _get(
        url,
        {
            "authorization": f"Bearer {config.github_token}",
            "accept": "application/vnd.github+json",
        },
    )
    if isinstance(loaded, dict) and loaded.get("available") is False:
        return loaded
    if not isinstance(loaded, list):
        return {"available": False, "reason": "github returned an unexpected payload"}
    issues = []
    for item in loaded:
        if not isinstance(item, dict) or "pull_request" in item:
            continue
        issues.append(
            {
                "number": item.get("number"),
                "title": item.get("title", ""),
                "url": item.get("html_url", ""),
            }
        )
    return {"available": True, "issues": issues}


def jira_search(config: Config, query: str) -> dict[str, Any]:
    if config.jira_base:
        issue = forge_base_issue(config.jira_base, "jira")
        if issue:
            return {"available": False, "reason": issue}
    if not config.jira_base or not config.jira_email or not config.jira_token:
        return {"available": False, "reason": "jira is not configured"}
    if not query.strip():
        return {"available": False, "reason": "a search query is required"}
    token = base64.b64encode(f"{config.jira_email}:{config.jira_token}".encode()).decode()
    from urllib.parse import quote

    jql = quote(f'text ~ "{query.strip()}"')
    url = f"{config.jira_base.rstrip('/')}/rest/api/3/search?jql={jql}"
    loaded = _get(url, {"authorization": f"Basic {token}", "accept": "application/json"})
    if isinstance(loaded, dict) and loaded.get("available") is False:
        return loaded
    issues = loaded.get("issues") if isinstance(loaded, dict) else None
    if not isinstance(issues, list):
        return {"available": False, "reason": "jira returned an unexpected payload"}
    rows = []
    for item in issues:
        if not isinstance(item, dict):
            continue
        fields = _dict(item.get("fields"))
        rows.append(
            {
                "key": item.get("key", ""),
                "summary": fields.get("summary", ""),
                "url": f"{config.jira_base.rstrip('/')}/browse/{item.get('key', '')}",
            }
        )
    return {"available": True, "issues": rows}


def jira_issue(config: Config, key: str) -> dict[str, Any]:
    if config.jira_base:
        issue = forge_base_issue(config.jira_base, "jira")
        if issue:
            return {"available": False, "reason": issue}
    if not config.jira_base or not config.jira_email or not config.jira_token:
        return {"available": False, "reason": "jira is not configured"}
    if not key:
        return {"available": False, "reason": "issue key is required"}
    token = base64.b64encode(f"{config.jira_email}:{config.jira_token}".encode()).decode()
    url = f"{config.jira_base.rstrip('/')}/rest/api/3/issue/{key}"
    loaded = _get(url, {"authorization": f"Basic {token}", "accept": "application/json"})
    if isinstance(loaded, dict) and loaded.get("available") is False:
        return loaded
    if not isinstance(loaded, dict):
        return {"available": False, "reason": "jira returned an unexpected payload"}
    fields = _dict(loaded.get("fields"))
    status = _dict(fields.get("status"))
    return {
        "available": True,
        "key": loaded.get("key", key),
        "summary": fields.get("summary", ""),
        "status": status.get("name", ""),
        "url": f"{config.jira_base.rstrip('/')}/browse/{loaded.get('key', key)}",
    }


def linear_search(config: Config, query: str) -> dict[str, Any]:
    issue = forge_base_issue(config.linear_api, "linear")
    if issue:
        return {"available": False, "reason": issue}
    if not config.linear_key:
        return {"available": False, "reason": "linear is not configured"}
    if not query.strip():
        return {"available": False, "reason": "a search query is required"}
    body = {
        "query": (
            "query($term: String) { issues(filter: { title: { contains: $term } }) "
            "{ nodes { identifier title url } } }"
        ),
        "variables": {"term": query.strip()},
    }
    loaded = _post(
        config.linear_api,
        body,
        {"authorization": config.linear_key, "content-type": "application/json"},
    )
    if isinstance(loaded, dict) and loaded.get("available") is False:
        return loaded
    data = _dict(loaded.get("data") if isinstance(loaded, dict) else None)
    nodes = _dict(data.get("issues")).get("nodes")
    if not isinstance(nodes, list):
        return {"available": False, "reason": "linear returned an unexpected payload"}
    return {
        "available": True,
        "issues": [
            {
                "identifier": item.get("identifier", ""),
                "title": item.get("title", ""),
                "url": item.get("url", ""),
            }
            for item in nodes
            if isinstance(item, dict)
        ],
    }


def linear_issue(config: Config, issue_id: str) -> dict[str, Any]:
    issue = forge_base_issue(config.linear_api, "linear")
    if issue:
        return {"available": False, "reason": issue}
    if not config.linear_key:
        return {"available": False, "reason": "linear is not configured"}
    if not issue_id:
        return {"available": False, "reason": "issue id is required"}
    query = "query($id: String!) { issue(id: $id) { identifier title url } }"
    loaded = _post(
        config.linear_api,
        {"query": query, "variables": {"id": issue_id}},
        {"authorization": config.linear_key, "content-type": "application/json"},
    )
    if isinstance(loaded, dict) and loaded.get("available") is False:
        return loaded
    if not isinstance(loaded, dict):
        return {"available": False, "reason": "linear returned an unexpected payload"}
    data = _dict(loaded.get("data"))
    issue = data.get("issue")
    issue = issue if isinstance(issue, dict) else None
    if issue is None:
        return {"available": False, "reason": "linear issue was not found"}
    return {
        "available": True,
        "identifier": issue.get("identifier", ""),
        "title": issue.get("title", ""),
        "url": issue.get("url", ""),
    }


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def forge_base_issue(url: str, kind: str) -> str | None:
    """Refuse a base URL that is not the vendor host or a loopback test server.

    GitHub is `api.github.com`, `github.com`, or `*.ghe.com`. Linear is
    `api.linear.app`. Jira is any public https host. Loopback is allowed so
    the recorded-server tests can stand in. Anything else, including link-local
    and private addresses, is rejected before a request is made.
    """
    parsed = urlsplit(url)
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        return "forge URL must be an http(s) address"
    if parsed.username or parsed.password:
        return "forge URL must not carry credentials"
    host = parsed.hostname.lower().rstrip(".")
    if _loopback(host):
        return None
    if parsed.scheme != "https":
        return "forge URL must be https"
    if _private_host(host):
        return "forge URL must not target a private address"
    github_ok = host in ("api.github.com", "github.com") or host.endswith(".ghe.com")
    if kind == "github" and not github_ok:
        return "github API host must be api.github.com, github.com, or a *.ghe.com host"
    if kind == "linear" and host != "api.linear.app":
        return "linear API host must be api.linear.app"
    return None


def _loopback(host: str) -> bool:
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def _private_host(host: str) -> bool:
    if host in ("metadata.google.internal", "metadata"):
        return True
    try:
        address = ip_address(host)
    except ValueError:
        return False
    return address.is_private or address.is_link_local or address.is_reserved


def _get(url: str, headers: dict[str, str]) -> Any:
    return _open(Request(url, headers=headers, method="GET"))


def _post(url: str, body: dict[str, Any], headers: dict[str, str]) -> Any:
    return _open(Request(url, data=json.dumps(body).encode(), headers=headers, method="POST"))


def _open(request: Request) -> Any:
    try:
        with urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode())
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        return {"available": False, "reason": str(exc)}
