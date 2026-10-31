"""The rest of stream D: owner namespaces, destination policy, lists, and repo sync."""

import json
import subprocess
from pathlib import Path

from app.integrations.destination import (
    DestinationPolicy,
    DestinationPolicyError,
    classify_address,
    retry_after_seconds,
    validate_destination,
)
from app.integrations.github_review import merge_pr
from app.integrations.hooks import save_receiver, update_receiver
from app.integrations.outbox import Owner


def test_a_foreign_pid_namespace_is_not_declared_dead(tmp_path: Path):
    first = Owner(tmp_path, "token-a", pid=10, namespace="pid:[1]")
    assert first.acquire(alive=True) is True
    second = Owner(tmp_path, "token-b", pid=11, namespace="pid:[2]")
    assert second.acquire(alive=False) is False
    assert first.valid() is True and second.valid() is False
    same = Owner(tmp_path, "token-c", pid=12, namespace="pid:[1]")
    assert same.acquire(alive=False) is True
    assert same.valid() is True


def test_a_receiver_url_change_bumps_the_delivery_revision(tmp_path: Path):
    row, reason = save_receiver(tmp_path, "Ops", "https://example.com/hook")
    assert reason is None and row is not None
    assert row["revision"] == 1 and row["deliveryRevision"] == 1
    renamed, rename_reason = update_receiver(
        tmp_path,
        str(row["id"]),
        name="Renamed",
        url="https://example.com/hook",
        expected_revision=1,
    )
    assert rename_reason is None and renamed is not None
    assert renamed["revision"] == 1 and renamed["state"] == "active"
    stale, stale_reason = update_receiver(
        tmp_path,
        str(row["id"]),
        name="Renamed",
        url="https://other.example/hook",
        expected_revision=0,
    )
    assert stale is None and stale_reason == "revision"
    edited, edit_reason = update_receiver(
        tmp_path,
        str(row["id"]),
        name="Renamed",
        url="https://other.example/hook",
        expected_revision=1,
    )
    assert edit_reason is None and edited is not None
    assert edited["revision"] == 2
    assert edited["deliveryRevision"] == 2
    assert edited["state"] == "inactive"


def test_destination_policy_refuses_denied_mixed_and_unconsented_private_addresses():
    assert classify_address("8.8.8.8") == "public"
    assert classify_address("10.1.1.1") == "private"
    assert classify_address("169.254.169.254") == "denied"
    assert classify_address("100.64.1.1") == "denied"
    assert classify_address("127.0.0.1") == "private"
    local = DestinationPolicy(allow_local_network=True)
    try:
        validate_destination("http://169.254.169.254/latest", local)
    except DestinationPolicyError as exc:
        assert exc.code == "denied_address"
    else:
        raise AssertionError("metadata address was allowed")
    try:
        validate_destination("http://10.1.1.1/hook", DestinationPolicy())
    except DestinationPolicyError as exc:
        assert exc.code == "local_consent_required"
    else:
        raise AssertionError("a private address was allowed without consent")
    try:
        validate_destination("http://127.0.0.1:9/hook", DestinationPolicy(server_ports=(9,)))
    except DestinationPolicyError as exc:
        assert exc.code == "server_port"
    else:
        raise AssertionError("the server port was allowed")
    try:
        validate_destination("https://user:secret@example.com/hook", DestinationPolicy())
    except DestinationPolicyError as exc:
        assert exc.code == "invalid_url"
    else:
        raise AssertionError("credentials in the URL were allowed")
    try:
        validate_destination("http://hooks.example/hook", DestinationPolicy(mode="hosted"))
    except DestinationPolicyError as exc:
        assert exc.code == "https_required"
    else:
        raise AssertionError("hosted mode accepted http")

    def lookup(_host: str) -> list[tuple[str, int]]:
        return [("8.8.8.8", 4), ("10.1.1.1", 4)]

    try:
        validate_destination("https://example.com/hook", DestinationPolicy(), lookup)
    except DestinationPolicyError as exc:
        assert exc.code == "mixed_dns"
    else:
        raise AssertionError("mixed DNS was allowed")
    assert retry_after_seconds("12") == 12
    assert retry_after_seconds("nope") is None
    assert retry_after_seconds("5\n0") is None


def test_expected_head_blocks_a_stale_merge(tmp_path: Path):
    moved = merge_pr(9, "squash", dry_run=True, cwd=tmp_path, expected_head="b" * 40)
    assert moved["status"] == 409 and moved["code"] == "head_moved"
    assert moved["current"] == "a" * 40
    matched = merge_pr(9, "squash", dry_run=True, cwd=tmp_path, expected_head="a" * 40)
    assert matched["merged"] is True


async def test_the_github_tab_and_tracker_searches_stay_on_a_recorded_server(client, monkeypatch):
    tab = await client.get("/api/v1/github")
    assert tab.status_code == 200
    body = tab.json()
    assert [row["number"] for row in body["issues"]] == [142, 139, 135]
    assert body["prs"][0]["number"] == 128
    assert body["prs"][1]["isDraft"] is True
    jira = await client.get("/api/v1/jira/search", params={"q": "login"})
    assert jira.json()["available"] is False
    linear = await client.get("/api/v1/linear/search", params={"q": "login"})
    assert linear.json()["available"] is False


async def test_jira_and_linear_search_read_a_recorded_server(repo, monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from stario.testing import TestClient

    from app.main import bootstrap

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            payload = {"issues": [{"key": "CEZ-3", "fields": {"summary": "Login drops"}}]}
            raw = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            self.rfile.read(length)
            raw = json.dumps(
                {
                    "data": {
                        "issues": {
                            "nodes": [
                                {"identifier": "LIN-2", "title": "Login", "url": "https://linear/2"}
                            ]
                        }
                    }
                }
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, format: str, *args: object) -> None:
            return

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    base = f"http://127.0.0.1:{port}"
    monkeypatch.setenv("CEZ_JIRA_BASE", base)
    monkeypatch.setenv("CEZ_JIRA_EMAIL", "a@example.com")
    monkeypatch.setenv("CEZ_JIRA_TOKEN", "jira-test")
    monkeypatch.setenv("CEZ_LINEAR_API_KEY", "lin-test")
    monkeypatch.setenv("CEZ_LINEAR_API", base + "/graphql")
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(repo.parent / "data-search"))
    monkeypatch.setenv("CEZ_DRY_RUN", "1")
    try:
        async with TestClient(
            bootstrap, request_timeout=15, base_url="http://127.0.0.1:4321"
        ) as running:
            jira = await running.get("/api/v1/jira/search", params={"q": "Login"})
            assert jira.json()["issues"][0]["key"] == "CEZ-3"
            linear = await running.get("/api/v1/linear/search", params={"q": "Login"})
            assert linear.json()["issues"][0]["identifier"] == "LIN-2"
    finally:
        httpd.shutdown()


async def test_repo_fetch_pull_and_push_use_a_local_bare_remote(client, repo: Path, tmp_path: Path):
    bare = tmp_path / "origin.git"
    subprocess.run(
        ["git", "init", "--bare", "-b", "main", str(bare)], check=True, capture_output=True
    )
    subprocess.run(
        ["git", "remote", "add", "origin", str(bare)], cwd=repo, check=True, capture_output=True
    )
    pushed = await client.post("/api/v1/repo/push")
    assert pushed.status_code == 200, pushed.text
    listed = subprocess.run(
        ["git", "--git-dir", str(bare), "rev-parse", "main"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert listed
    other = tmp_path / "other"
    subprocess.run(["git", "clone", str(bare), str(other)], check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=other, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=other, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=other, check=True)
    (other / "remote.txt").write_text("from the other clone\n", encoding="utf-8")
    subprocess.run(["git", "add", "remote.txt"], cwd=other, check=True)
    subprocess.run(["git", "commit", "-m", "remote"], cwd=other, check=True, capture_output=True)
    subprocess.run(
        ["git", "push", "origin", "HEAD:main"], cwd=other, check=True, capture_output=True
    )
    fetched = await client.post("/api/v1/repo/fetch")
    assert fetched.status_code == 200, fetched.text
    status = await client.get("/api/v1/repo/sync")
    assert status.json()["behind"] >= 1
    pulled = await client.post("/api/v1/repo/pull")
    assert pulled.status_code == 200, pulled.text
    assert (repo / "remote.txt").read_text(encoding="utf-8") == "from the other clone\n"
