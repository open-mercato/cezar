import json
from pathlib import Path

from app.features.editors import store
from app.integrations.github_review import merge_pr, review_pr
from app.integrations.outbox import Delivery, Outbox, OutboxError, Owner, deliver_once
from app.integrations.slack_render import render_slack


def test_slack_escapes_markup_and_names_a_test_ping():
    ping = render_slack(json.dumps({"type": "webhook.test"}), receiver_name="Ops <a>")
    assert "&lt;a&gt;" in ping
    assert "Test message" in ping
    failed = render_slack(
        json.dumps(
            {
                "type": "task.failed",
                "task": {
                    "id": "abc",
                    "title": "Ship <it>",
                    "status": "failed",
                    "previousStatus": "running",
                },
                "source": {"projectId": "demo"},
                "data": {"message": "boom & more"},
            }
        )
    )
    assert "Ship &lt;it&gt;" in failed
    assert "boom &amp; more" in failed
    asked = render_slack(
        json.dumps(
            {
                "type": "task.attention_required",
                "occurredAt": "2026-10-19T12:00:00Z",
                "task": {
                    "id": "abcdefgh-task",
                    "title": "Task title",
                    "status": "waiting",
                    "previousStatus": "running",
                },
                "source": {"projectId": "project", "mode": "local"},
                "data": {
                    "questions": [
                        {
                            "question": "Which?",
                            "options": [{"label": "Yes", "description": "Proceed"}],
                        }
                    ]
                },
                "links": {
                    "issue": "https://example.com/issues/1?q=a|b",
                    "cockpit": "https://cockpit.example/task",
                },
            }
        )
    )
    assert "Which?" in asked
    assert "a%7Cb|Issue" in asked
    assert "cockpit.example" not in asked


def test_the_outbox_rejects_a_foreign_installation_and_retries_then_fails(tmp_path: Path):
    box = Outbox(tmp_path, "install-a")
    box.open()
    box.append('{"type":"webhook.test"}')
    assert box.high_water == 1
    other = Outbox(tmp_path, "install-b")
    try:
        other.open()
    except OutboxError as exc:
        assert "mismatch" in str(exc)
    else:
        raise AssertionError("foreign installation was accepted")
    calls: list[str] = []

    def fail(body: str) -> None:
        calls.append(body)
        raise RuntimeError("down")

    fresh = Outbox(tmp_path, "install-a")
    fresh.open()
    assert deliver_once(fresh, dry_run=True, send=fail, now_ms=1_000) == "delivered"
    assert calls == []
    again = Outbox(tmp_path / "retry", "install-a")
    again.open()
    again.append("payload")
    first = deliver_once(again, dry_run=False, send=fail, now_ms=1_000_000, jitter=1)
    waiting = again.peek()
    assert first == "retry"
    assert waiting is not None and waiting.next_attempt_at == str(1_000_000 + 6_000)
    expired = Outbox(tmp_path / "expire", "install-a")
    expired.open()
    expired.append("payload", expires_at=1_000_000 + 1_000)
    assert deliver_once(expired, dry_run=False, send=fail, now_ms=1_000_000) == "failed"
    assert expired.peek() is None


def test_a_dead_owner_is_replaced_through_its_successor_slot(tmp_path: Path):
    from app.integrations.outbox import replay

    first = Owner(tmp_path, "token-a", pid=10)
    assert first.acquire(alive=True) is True
    second = Owner(tmp_path, "token-b", pid=11)
    assert second.acquire(alive=False) is True
    assert first.valid() is False and second.valid() is True
    assert (tmp_path / "owner-next-token-a.json").is_file()
    box = Outbox(tmp_path, "install-a")
    box.open()
    row = box.append("payload", event_type="task.finished")
    assert deliver_once(box, dry_run=True, send=lambda _body: None, now_ms=5_000) == "delivered"
    assert replay(box, row.sequence, now_ms=5_000) is None
    pending = box.peek()
    assert pending is not None and pending.sequence == row.sequence + 1
    assert pending.event_type == "task.finished" and pending.status == "pending"
    ping = box.append("ping", event_type="webhook.test")
    box.mark(ping.sequence, status="delivered", attempts=1, completed_at=5_000)
    assert replay(box, ping.sequence, now_ms=5_000) == "Payload is unavailable for replay"


def test_one_live_owner_blocks_a_second_token(tmp_path: Path):
    first = Owner(tmp_path, "token-a", pid=10)
    assert first.acquire(alive=True) is True
    second = Owner(tmp_path, "token-b", pid=11)
    assert second.acquire(alive=True) is False
    first.release()
    assert second.acquire(alive=False) is True
    assert second.valid() is True


def test_a_failing_check_blocks_merge_and_a_clean_pr_is_ready():
    from app.integrations.merge_state import normalize_merge_state

    policy = {
        "allow_squash_merge": True,
        "allow_merge_commit": True,
        "allow_rebase_merge": False,
        "squash_merge_commit_title": "PR_TITLE",
    }
    pr = {
        "number": 9,
        "title": "Ship",
        "url": "https://github.com/acme/app/pull/9",
        "state": "OPEN",
        "isDraft": False,
        "headRefName": "cez/demo",
        "baseRefName": "main",
        "headRefOid": "b" * 40,
        "mergeable": "MERGEABLE",
        "reviewDecision": "APPROVED",
        "mergeStateStatus": "CLEAN",
        "statusCheckRollup": [{"name": "ci", "conclusion": "FAILURE"}],
    }
    blocked = normalize_merge_state(pr, policy)
    assert blocked["eligibility"] == "blocked" and blocked["canMerge"] is False
    blockers = blocked["blockers"]
    assert isinstance(blockers, list) and isinstance(blockers[0], dict)
    assert blockers[0]["code"] == "checks-failing"
    pr["statusCheckRollup"] = [{"name": "ci", "state": "SUCCESS"}]
    ready = normalize_merge_state(pr, policy)
    assert ready["eligibility"] == "ready" and ready["canMerge"] is True
    assert ready["defaultMethod"] == "squash"


def test_dry_run_review_and_merge_do_not_need_gh(tmp_path: Path):
    reviewed = review_pr(4, "approve", "looks good", dry_run=True, cwd=tmp_path)
    assert reviewed["dryRun"] is True and reviewed["submitted"] is True
    merged = merge_pr(4, "squash", dry_run=True, cwd=tmp_path)
    assert merged["merged"] is True and merged["dryRun"] is True
    assert str(merged["url"]).endswith("/4")
    refused = merge_pr(4, "force", dry_run=True, cwd=tmp_path)
    assert refused["ok"] is False


def test_instructions_and_agent_config_round_trip(tmp_path: Path):
    assert store.write_instructions(tmp_path, "be brief", "cez/<slug>") is None
    assert store.read_instructions(tmp_path)["branchNaming"] == "cez/<slug>"
    assert store.write_agent_file(tmp_path, "agents-md", "# hi\n", hosted=False) is None
    found = store.read_agent_file(tmp_path, "agents-md")
    assert found is not None and found[1] == "# hi\n"
    assert store.write_agent_file(tmp_path, "agents-md", "nope", hosted=True) == (
        "agent config writes are local-only"
    )
    assert store.read_agent_file(tmp_path, "agents-md")[1] == "# hi\n"  # type: ignore[index]


async def test_the_settings_editors_render_and_save(client, repo: Path):
    page = await client.get("/settings/instructions")
    assert page.status_code == 200
    assert "Instructions" in page.text
    saved = await client.post(
        "/settings/instructions",
        json={"systemPrompt": "be brief", "branchNaming": "cez/<slug>", "tab": "t1"},
        follow_redirects=False,
    )
    assert saved.status_code == 303
    assert store.read_instructions(repo)["systemPrompt"] == "be brief"
    config = await client.get("/settings/agent-config")
    assert "AGENTS.md" in config.text
    accounts = await client.post(
        "/settings/accounts",
        json={"name": "Ada", "runner": "claude", "tab": "t1"},
        follow_redirects=False,
    )
    assert accounts.status_code == 303
    listed = await client.get("/settings/accounts")
    assert "Ada" in listed.text
    notes = await client.post(
        "/settings/notifications",
        json={"browser": True, "tab": "t1"},
        follow_redirects=False,
    )
    assert notes.status_code == 303
    assert "Browser notifications are on." in (await client.get("/settings/notifications")).text
    keys = await client.post(
        "/settings/keyboard",
        json={"submit": "enter", "tab": "t1"},
        follow_redirects=False,
    )
    assert keys.status_code == 303
    assert "enter" in (await client.get("/settings/keyboard")).text
    mark = await client.get("/settings/bookmarklets")
    assert "javascript:" in mark.text
    tools = await client.get("/settings/integrations")
    assert "Test frameworks" in tools.text
    queued = await client.post("/settings/integrations", json={"tab": "t1"}, follow_redirects=False)
    assert queued.status_code == 303
    assert "/tasks/" in queued.headers.get("location", "")
    review = await client.post(
        "/api/v1/github/prs/9/reviews",
        json={"event": "comment", "body": "nit"},
    )
    assert review.status_code == 200
    assert review.json()["dryRun"] is True
    merged = await client.post("/api/v1/github/prs/9/merge", json={"method": "squash"})
    assert merged.json()["dryRun"] is True
    assert merged.json()["merged"] is True


def test_cursor_agent_bin_uses_the_typescript_name(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_CURSOR_AGENT_BIN", "/opt/cursor-agent")
    monkeypatch.setenv("CEZ_CURSOR_BIN", "/opt/other")
    from app.config import Config

    assert Config.from_env().runner_bins["cursor"] == "/opt/cursor-agent"


def test_a_fake_gh_is_used_only_when_dry_run_is_off(tmp_path: Path, monkeypatch):
    import os
    import subprocess

    from tests.conftest import init_repo

    from app.engine.git_actions import create_draft_pr, push_branch
    from app.integrations.github_review import merge_state

    repo = tmp_path / "repo"
    init_repo(repo)
    bare = tmp_path / "origin.git"
    subprocess.run(
        ["git", "init", "--bare", "-b", "main", str(bare)],
        check=True,
        capture_output=True,
    )
    subprocess.run(["git", "remote", "add", "origin", str(bare)], cwd=repo, check=True)
    subprocess.run(
        ["git", "push", "-u", "origin", "main"],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "checkout", "-b", "cez/abcd1234"],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    (repo / "note.txt").write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "add", "note.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "note"], cwd=repo, check=True, capture_output=True)
    log = tmp_path / "gh.log"
    binary = tmp_path / "bin"
    binary.mkdir()
    fake = binary / "gh"
    fake.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$GH_LOG"\n'
        'if [ "$1" = pr ] && [ "$2" = create ]; then\n'
        "  echo https://github.com/acme/app/pull/12; exit 0\n"
        "fi\n"
        'if [ "$1" = pr ] && [ "$2" = merge ]; then\n'
        "  echo https://github.com/acme/app/pull/3; exit 0\n"
        "fi\n"
        'if [ "$1" = pr ] && [ "$2" = review ]; then exit 0; fi\n'
        'if [ "$1" = pr ] && [ "$2" = view ]; then\n'
        '  echo \'{"number":3,"title":"Draft","url":"https://github.com/acme/app/pull/3",'
        '"state":"OPEN","isDraft":false,"headRefName":"cez/abcd1234",'
        '"baseRefName":"main","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
        '"mergeable":"MERGEABLE","reviewDecision":"APPROVED","mergeStateStatus":"CLEAN",'
        '"statusCheckRollup":[{"name":"ci","state":"SUCCESS"}]}\'\n'
        "  exit 0\n"
        "fi\n"
        'if [ "$1" = repo ] && [ "$2" = view ]; then\n'
        '  echo \'{"squashMergeAllowed":true,"mergeCommitAllowed":true}\'\n'
        "  exit 0\n"
        "fi\n"
        "exit 1\n",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    monkeypatch.setenv("GH_LOG", str(log))
    monkeypatch.setenv("PATH", f"{binary}{os.pathsep}{os.environ.get('PATH', '')}")
    assert review_pr(3, "approve", "ok", dry_run=True, cwd=repo)["dryRun"] is True
    assert not log.exists()
    pushed = push_branch(repo, "cez/abcd1234", dry_run=False)
    assert pushed["ok"] is True and pushed["dryRun"] is False
    assert not log.exists()
    opened = create_draft_pr(repo, "cez/abcd1234", "Draft", dry_run=False)
    assert opened["url"] == "https://github.com/acme/app/pull/12"
    reviewed = review_pr(3, "approve", "ship it", dry_run=False, cwd=repo)
    merged = merge_pr(3, "squash", dry_run=False, cwd=repo)
    state = merge_state(3, dry_run=False, cwd=repo)
    recorded = log.read_text(encoding="utf-8")
    assert "pr create" in recorded
    assert "pr review" in recorded
    assert "pr merge" in recorded
    assert "pr view" in recorded
    assert reviewed["dryRun"] is False and reviewed["submitted"] is True
    assert merged["dryRun"] is False and merged["merged"] is True
    inner = state["mergeState"]
    assert isinstance(inner, dict)
    assert state["dryRun"] is False
    assert inner["eligibility"] == "ready" and inner["canMerge"] is True


async def test_the_main_loop_screens_show_their_data(client):
    new = await client.get("/tasks/new")
    assert new.status_code == 200
    assert "New task" in new.text and "Start" in new.text and "quick-task" in new.text
    created = await client.post(
        "/api/v1/runs",
        json={"task": "two panes", "workflow": "quick-task", "variants": 2},
    )
    assert created.status_code == 201
    first = created.json()["runs"][0]["id"]
    compared = await client.get(f"/tasks/{first}/compare")
    assert "Compare" in compared.text and ">A<" in compared.text and ">B<" in compared.text
    import asyncio

    status = ""
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{first}")).json()["status"]
        if status in ("done", "failed", "review"):
            break
        await asyncio.sleep(0.05)
    assert status == "done"
    graph = await client.get(f"/tasks/{first}?pane=graph")
    assert "Do the task" in graph.text
    browser = await client.get(f"/tasks/{first}?pane=browser")
    assert "Design Mode" in browser.text
    saved = await client.post(
        f"/tasks/{first}/notes",
        json={"tab": "t1", "notes": "remember the port"},
    )
    assert saved.status_code == 204
    notes = await client.get(f"/tasks/{first}?pane=notes")
    assert "remember the port" in notes.text


async def test_the_replay_route_copies_a_finished_payload(client, tmp_path: Path):
    import time

    from app.integrations.outbox import Outbox

    directory = tmp_path / "data" / "webhook-outbox"
    directory.mkdir(parents=True)
    (directory / "installation").write_text("install-local\n", encoding="utf-8")
    box = Outbox(directory, "install-local")
    box.open()
    row = box.append("hello", event_type="task.finished")
    box.mark(row.sequence, status="delivered", attempts=1, completed_at=int(time.time() * 1000))
    replayed = await client.post(f"/api/v1/webhooks/outbox/{row.sequence}/replay")
    assert replayed.status_code == 200
    assert replayed.json()["replayed"] is True
    ping = box.append("ping", event_type="webhook.test")
    box.mark(ping.sequence, status="delivered", attempts=1, completed_at=int(time.time() * 1000))
    # The route opens its own outbox, so re-read after the first replay, then refuse a test ping.
    fresh = Outbox(directory, "install-local")
    fresh.open()
    test_row = fresh.find(ping.sequence)
    assert test_row is not None
    refused = await client.post(f"/api/v1/webhooks/outbox/{ping.sequence}/replay")
    assert refused.status_code == 409


def test_delivery_row_shape():
    row = Delivery(sequence=1, body="x")
    assert row.status == "pending"
