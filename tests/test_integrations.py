import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from stario.testing import TestClient

from app.integrations.clients import forge_base_issue
from app.main import bootstrap


def serve(handler: type[BaseHTTPRequestHandler]) -> tuple[ThreadingHTTPServer, int]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, int(httpd.server_address[1])


def test_forge_base_urls_reject_private_and_non_vendor_hosts():
    assert forge_base_issue("https://api.github.com", "github") is None
    assert forge_base_issue("https://acme.ghe.com", "github") is None
    assert forge_base_issue("http://169.254.169.254/", "github") is not None
    assert forge_base_issue("https://evil.example", "github") is not None
    assert forge_base_issue("https://api.linear.app/graphql", "linear") is None
    assert forge_base_issue("https://evil.example/graphql", "linear") is not None
    assert forge_base_issue("http://127.0.0.1:9", "jira") is None
    assert forge_base_issue("http://example.atlassian.net", "jira") is not None


async def test_unconfigured_forges_do_not_call_out(client):
    github = await client.get("/api/v1/github/issues", params={"owner": "a", "repo": "b"})
    assert github.json()["available"] is False
    jira = await client.get("/api/v1/jira/issue/CEZ-1")
    assert jira.json()["available"] is False
    linear = await client.post("/api/v1/linear/issue", json={"id": "abc"})
    assert linear.json()["reason"] == "linear is not configured"


async def test_github_jira_and_linear_read_a_recorded_server(repo, monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path.startswith("/repos/acme/app/issues"):
                body = [{"number": 7, "title": "Fix the gate", "html_url": "https://example/7"}]
            elif self.path.startswith("/rest/api/3/issue/CEZ-1"):
                body = {
                    "key": "CEZ-1",
                    "fields": {"summary": "Ship it", "status": {"name": "Doing"}},
                }
            else:
                body = {}
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            json.loads(self.rfile.read(length) or b"{}")
            body = {
                "data": {
                    "issue": {
                        "identifier": "CEZ-9",
                        "title": "Graph",
                        "url": "https://linear/9",
                    }
                }
            }
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, format: str, *args: object) -> None:
            return

    httpd, port = serve(Handler)
    base = f"http://127.0.0.1:{port}"
    monkeypatch.setenv("CEZ_GITHUB_TOKEN", "gh-test")
    monkeypatch.setenv("CEZ_GITHUB_API", base)
    monkeypatch.setenv("CEZ_JIRA_BASE", base)
    monkeypatch.setenv("CEZ_JIRA_EMAIL", "a@example.com")
    monkeypatch.setenv("CEZ_JIRA_TOKEN", "jira-test")
    monkeypatch.setenv("CEZ_LINEAR_API_KEY", "lin-test")
    monkeypatch.setenv("CEZ_LINEAR_API", base + "/graphql")
    try:
        async with TestClient(
            bootstrap, request_timeout=15, base_url="http://127.0.0.1:4321"
        ) as client:
            github = await client.get(
                "/api/v1/github/issues", params={"owner": "acme", "repo": "app"}
            )
            assert github.json()["issues"][0]["number"] == 7
            jira = await client.get("/api/v1/jira/issue/CEZ-1")
            assert jira.json()["summary"] == "Ship it"
            assert jira.json()["status"] == "Doing"
            linear = await client.post("/api/v1/linear/issue", json={"id": "abc"})
            assert linear.json()["identifier"] == "CEZ-9"
    finally:
        httpd.shutdown()
