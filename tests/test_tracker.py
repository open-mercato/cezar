"""Tracker connection, association, search, and watch against a local server."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from stario.testing import TestClient
from tests.conftest import init_repo

from app.main import bootstrap


class JiraHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/rest/api/3/project"):
            body = [{"id": "10001", "key": "CEZ", "name": "Cezar"}]
        elif self.path.startswith("/rest/api/3/search"):
            title = "Login drops the session" if "Login" in self.path else "Open work"
            body = {
                "issues": [
                    {
                        "key": "CEZ-1",
                        "fields": {
                            "summary": title,
                            "status": {"name": "Open"},
                            "created": "2026-01-01T00:00:00.000+0000",
                            "updated": "2026-01-02T00:00:00.000+0000",
                        },
                    }
                ]
            }
        else:
            self.send_response(404)
            self.end_headers()
            return
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format: str, *args: object) -> None:
        return


def _serve() -> tuple[ThreadingHTTPServer, int]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), JiraHandler)
    port = httpd.server_address[1]
    import threading

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


async def test_dry_run_refuses_to_store_tracker_credentials(repo: Path):
    async with TestClient(
        bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321"
    ) as client:
        saved = await client.put(
            "/api/v1/tracker/connection",
            json={
                "kind": "jira",
                "origin": "https://acme.atlassian.net",
                "email": "ada@example.com",
                "token": "secret-token",
            },
        )
        assert saved.status_code == 409
        view = await client.get("/api/v1/tracker/connection")
        assert view.json()["demo"] is True
        assert view.json()["connection"] is None
        listed = await client.get("/api/v1/tracker")
        assert listed.json()["available"] is False


async def test_a_recorded_jira_server_associates_searches_and_watches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    httpd, port = _serve()
    repo = tmp_path / "repo"
    init_repo(repo)
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("CEZ_DRY_RUN", "0")
    origin = f"http://127.0.0.1:{port}"
    try:
        async with TestClient(
            bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321"
        ) as client:
            bad = await client.put(
                "/api/v1/tracker/connection",
                json={"kind": "jira", "origin": "http://10.1.1.1", "email": "a@b.co", "token": "x"},
            )
            assert bad.status_code == 400
            saved = await client.put(
                "/api/v1/tracker/connection",
                json={
                    "kind": "jira",
                    "origin": origin,
                    "email": "ada@example.com",
                    "token": "secret-token",
                },
            )
            assert saved.status_code == 200
            body = saved.json()
            assert body["connection"]["kind"] == "jira"
            assert "secret-token" not in json.dumps(body)
            view = await client.get("/api/v1/tracker/connection")
            assert view.json()["connection"]["id"] == body["connection"]["id"]
            assert "token" not in json.dumps(view.json())
            candidates = await client.get("/api/v1/tracker/candidates")
            assert candidates.json()["candidates"] == [{"id": "10001", "name": "Cezar"}]
            linked = await client.put(
                "/api/v1/tracker/association",
                json={"kind": "jira", "externalId": "10001", "sourceId": "CEZ"},
            )
            assert linked.status_code == 200
            association = linked.json()["association"]
            assert association["externalName"] == "Cezar"
            assert association["source"]["webUrl"] == origin
            missing = await client.put(
                "/api/v1/tracker/association",
                json={"kind": "jira", "externalId": "nope", "sourceId": "CEZ"},
            )
            assert missing.status_code == 404
            found = await client.get("/api/v1/tracker/search?q=Login")
            assert found.json()["items"][0]["title"] == "Login drops the session"
            opened = await client.post(
                "/api/v1/tracker/watch",
                json={"association": association, "query": "", "state": "active", "labels": []},
            )
            assert opened.status_code == 200
            watch_id = opened.json()["id"]
            snap = await client.get(f"/api/v1/tracker/watch/{watch_id}")
            assert snap.status_code == 200
            assert snap.json()["version"] == 1
            assert snap.json()["result"]["items"][0]["id"] == "CEZ-1"
            refreshed = await client.post(f"/api/v1/tracker/watch/{watch_id}")
            assert refreshed.json()["version"] == 2
            stale = await client.post(
                "/api/v1/tracker/watch",
                json={
                    "association": {**association, "externalId": "other"},
                    "query": "",
                    "state": "active",
                    "labels": [],
                },
            )
            assert stale.status_code == 409
    finally:
        httpd.shutdown()
