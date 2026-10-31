"""The tracker poll path: list read, labels, status filter, and the launched run.

A local server stands in for Jira and Linear. Nothing here reaches a real tracker.
"""

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from litewriter import LiteWriter
from stario import Relay
from tests.conftest import init_repo
from tests.test_engine import config_for

from app.clock import stamp
from app.engine.engine import Engine
from app.engine.model import Automation
from app.integrations import tracker, tracker_poll
from app.store.db import get_run, schema

REQUESTS: list[str] = []


class TrackerHandler(BaseHTTPRequestHandler):
    def _send(self, body: object) -> None:
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        REQUESTS.append(self.path)
        if self.path.startswith("/rest/api/3/search"):
            fields = parse_qs(urlsplit(self.path).query).get("fields", [""])[0].split(",")
            issues = [
                ("CEZ-1", "Fix the login", "To Do", ["backend", "urgent"]),
                ("CEZ-2", "Polish the header", "To Do", ["frontend"]),
                ("CEZ-3", "Already started", "In Progress", ["backend"]),
            ]
            self._send(
                {
                    "issues": [
                        {
                            "key": key,
                            "fields": {
                                "summary": title,
                                "status": {"name": status},
                                **({"labels": labels} if "labels" in fields else {}),
                            },
                        }
                        for key, title, status, labels in issues
                    ]
                }
            )
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        size = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(size) or b"{}")
        query = str(body.get("query", ""))
        REQUESTS.append(query)
        if "labels" not in query:
            self._send({"data": {"issues": {"nodes": [{"id": "x", "identifier": "ENG-0"}]}}})
            return
        self._send(
            {
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "u1",
                                "identifier": "ENG-1",
                                "title": "Ship the thing",
                                "url": "https://linear.app/acme/issue/ENG-1",
                                "state": {"name": "Todo"},
                                "labels": {"nodes": [{"name": "backend"}, {"name": "ready"}]},
                            },
                            {
                                "id": "u2",
                                "identifier": "ENG-2",
                                "title": "Unlabeled",
                                "url": "https://linear.app/acme/issue/ENG-2",
                                "state": {"name": "Todo"},
                                "labels": {"nodes": []},
                            },
                        ]
                    }
                }
            }
        )

    def log_message(self, format: str, *args: object) -> None:
        return


@pytest.fixture
def server():
    REQUESTS.clear()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), TrackerHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def association(kind: str, origin: str) -> dict[str, object]:
    return {
        "kind": kind,
        "source": {"id": "CEZ", "webUrl": origin},
        "externalId": "10001",
        "externalName": "Cezar",
    }


async def make_engine(tmp_path: Path, **overrides: object):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo, dry_run=False, **overrides)
    return repo, cfg


async def test_jira_issues_carry_their_labels_into_the_poll(tmp_path: Path, server: str):
    repo, cfg = await make_engine(tmp_path)
    assert tracker.save_connection(
        cfg, repo, {"kind": "jira", "origin": server, "email": "a@b.co", "token": "t"}
    )
    tracker.write_association(repo, association("jira", server))

    everything, reason = tracker_poll.poll(cfg, repo, {"status": "To Do"})
    assert reason == ""
    assert [item.id for item in everything] == ["CEZ-1", "CEZ-2"]
    assert everything[0].labels == ("backend", "urgent")
    assert "labels" in REQUESTS[-1]

    backend, _ = tracker_poll.poll(cfg, repo, {"status": "to do", "allLabels": ["Backend"]})
    assert [item.id for item in backend] == ["CEZ-1"]
    both, _ = tracker_poll.poll(cfg, repo, {"status": "To Do", "allLabels": ["backend", "urgent"]})
    assert [item.id for item in both] == ["CEZ-1"]
    none, _ = tracker_poll.poll(cfg, repo, {"status": "To Do", "allLabels": ["backend", "ui"]})
    assert none == []


async def test_linear_issues_carry_their_labels_into_the_poll(tmp_path: Path, server: str):
    repo, cfg = await make_engine(tmp_path, linear_api=f"{server}/graphql")
    assert tracker.save_connection(cfg, repo, {"kind": "linear", "key": "lin_api_key"})
    tracker.write_association(repo, association("linear", server))

    found, reason = tracker_poll.poll(cfg, repo, {"status": "Todo", "allLabels": ["backend"]})
    assert reason == ""
    assert [item.id for item in found] == ["ENG-1"]
    assert found[0].labels == ("backend", "ready")
    assert found[0].key == "tracker:ENG-1:todo"
    assert "labels(first: 50)" in REQUESTS[-1]


async def test_an_unconfigured_tracker_reports_why(tmp_path: Path):
    repo, cfg = await make_engine(tmp_path)
    found, reason = tracker_poll.poll(cfg, repo, {"status": "To Do"})
    assert found == [] and reason


async def test_a_tracker_automation_launches_one_run_per_matching_issue(
    tmp_path: Path, server: str
):
    repo, cfg = await make_engine(tmp_path)
    assert tracker.save_connection(
        cfg, repo, {"kind": "jira", "origin": server, "email": "a@b.co", "token": "t"}
    )
    tracker.write_association(repo, association("jira", server))
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        item = Automation(
            id=uuid.uuid4().hex,
            project_id=engine.boot_project_id,
            name="triage",
            task="Handle {{tracker.id}}: {{tracker.title}}",
            workflow="quick-task",
            runner="claude",
            every_minutes=5,
            enabled=False,
            next_at=stamp(),
            created_at=stamp(),
            kind="tracker",
            filters={"status": "To Do", "allLabels": ["backend"]},
        )
        await engine.create_automation(item)
        entry = await engine.poller.check(item, "execute")
        assert entry["matches"] == 1 and entry["launched"] == 1
        rows = entry["candidates"]
        assert isinstance(rows, list)
        run = get_run(engine.db, str(rows[0]["runId"]))
        assert run is not None
        assert run.task.startswith("Handle CEZ-1: Fix the login")
        assert run.automation["event"] == "issue.status_changed"
        again = await engine.poller.check(item, "execute")
        assert again["launched"] == 0
