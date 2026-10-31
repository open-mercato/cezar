"""GitHub, tracker, and commit detail screens; PR adoption; account status and selection.

Every `gh` call here is either the dry-run catalog or `tests/fakes/gh_detail.py` first on PATH.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from stario.testing import TestClient
from tests.conftest import init_repo

from app.config import Config
from app.features.commit.urls import REPO_COMMIT, TASK_COMMIT_DETAIL
from app.features.github.urls import GITHUB_ISSUE, GITHUB_PR, GITHUB_PRS
from app.features.places.urls import GITHUB, REPO, TRACKER
from app.features.task.urls import TASK, TASK_PR_ADOPT
from app.features.tasks.urls import TASKS_CREATE
from app.features.tracker.urls import TRACKER_ITEM
from app.integrations.pr_adopt import (
    PrTarget,
    adopt_named,
    find_branch_pr,
    parse_pr_ref,
    pick_branch_pr,
)
from app.main import bootstrap

FAKES = Path(__file__).parent / "fakes"


@pytest.fixture
def fake_gh(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    binary = tmp_path / "ghbin"
    binary.mkdir()
    shutil.copy(FAKES / "gh_detail.py", binary / "gh")
    log = tmp_path / "gh.log"
    monkeypatch.setenv("PATH", f"{binary}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("FAKE_GH_LOG", str(log))
    return log


async def test_the_pull_request_list_and_detail_follow_the_view(client, fake_gh):
    listed = await client.get(GITHUB_PRS.href())
    assert listed.status_code == 200
    assert 'href="/github/prs/128"' in listed.text
    assert "Fix flaky auth test in CI" in listed.text
    assert f'href="{GITHUB_PRS.href()}"' in (await client.get(GITHUB.href())).text

    detail = await client.get(GITHUB_PR.href("128"))
    assert detail.status_code == 200
    assert "Fix flaky auth test in CI" in detail.text
    assert 'id="pr-body"' in detail.text
    assert 'id="pr-changes"' not in detail.text

    changes = await client.get(GITHUB_PR.href("128", query={"pane": "changes"}))
    assert changes.status_code == 200
    assert 'id="pr-changes"' in changes.text
    assert '<span class="d-add">+new\n</span>' in changes.text
    assert '<span class="d-del">-old\n</span>' in changes.text
    assert "src/old-name.ts → src/new-name.ts" in changes.text
    assert "No patch: binary" in changes.text
    assert 'id="pr-body"' not in changes.text
    # An unknown pane falls back to the conversation.
    assert 'id="pr-body"' in (await client.get(GITHUB_PR.href("128", query={"pane": "bogus"}))).text
    # Nothing here reached the real gh: dry-run answers from the catalog.
    assert not fake_gh.exists()


async def test_pull_request_and_issue_numbers_are_checked(client):
    assert (await client.get(GITHUB_PR.href("abc"))).status_code == 400
    assert (await client.get(GITHUB_PR.href("0"))).status_code == 400
    assert (await client.get(GITHUB_ISSUE.href("-1"))).status_code == 400
    assert (await client.get(GITHUB_PR.href("99999"))).status_code == 404
    assert (await client.get(GITHUB_ISSUE.href("99999"))).status_code == 404
    issue = await client.get(GITHUB_ISSUE.href("142"))
    assert issue.status_code == 200
    assert "Login form drops session on refresh" in issue.text
    assert "Repro: log in, hit reload." in issue.text


async def test_the_issue_list_links_to_issue_detail(client, monkeypatch):
    def issues(_config, owner, repo):
        return {"available": True, "issues": [{"number": 7, "title": f"{owner}/{repo} pane"}]}

    monkeypatch.setattr("app.features.places.handlers.github_issues", issues)
    page = await client.get(GITHUB.href(query={"owner": "acme", "repo": "app"}))
    assert 'href="/github/issues/7"' in page.text


async def test_detail_screens_read_gh_when_dry_run_is_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fake_gh: Path
):
    root = tmp_path / "repo"
    init_repo(root)
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_REPO", str(root))
    monkeypatch.setenv("CEZ_DRY_RUN", "0")
    async with TestClient(
        bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321"
    ) as client:
        pull = await client.get(GITHUB_PR.href("7"))
        assert pull.status_code == 200
        assert "PR 7 title" in pull.text and "body of 7" in pull.text
        changes = await client.get(GITHUB_PR.href("7", query={"pane": "changes"}))
        assert '<span class="d-add">+new\n</span>' in changes.text
        assert (await client.get(GITHUB_PR.href("404"))).status_code == 404
        issue = await client.get(GITHUB_ISSUE.href("3"))
        assert issue.status_code == 200
        assert (await client.get(GITHUB_ISSUE.href("4"))).status_code == 404
    assert "pr view 7" in fake_gh.read_text(encoding="utf-8")


async def test_the_tracker_item_page(client, monkeypatch):
    def listed(_config, _root, *, state="active", query=""):
        return {
            "available": True,
            "items": [
                {
                    "kind": "issue",
                    "id": "CEZ-1",
                    "title": "Fix the door",
                    "status": "Open",
                    "labels": ["bug"],
                    "body": "It sticks.",
                    "url": "https://example.test/browse/CEZ-1",
                }
            ],
        }

    monkeypatch.setattr("app.features.tracker.handlers.list_issues", listed)
    page = await client.get(TRACKER_ITEM.href("CEZ-1"))
    assert page.status_code == 200
    assert "Fix the door" in page.text and "It sticks." in page.text
    assert (await client.get(TRACKER_ITEM.href("CEZ-2"))).status_code == 404
    assert (await client.get(TRACKER_ITEM.href("search"))).status_code == 404

    monkeypatch.setattr("app.features.places.handlers.list_issues", listed)
    monkeypatch.setattr(
        "app.features.places.handlers.jira_issue",
        lambda _config, key: {"available": True, "key": key, "summary": "Fix the door"},
    )
    found = await client.get(TRACKER.href(query={"key": "CEZ-1", "kind": "jira"}))
    assert 'href="/tracker/CEZ-1"' in found.text
    assert 'id="tracker-items"' in found.text


async def test_the_tracker_item_page_reports_an_unconfigured_tracker(client):
    page = await client.get(TRACKER_ITEM.href("CEZ-1"))
    assert page.status_code == 200
    assert "tracker is not configured" in page.text


def _head(repo: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


async def test_commit_detail_from_the_repository(client, repo: Path):
    sha = _head(repo)
    log = await client.get(REPO.href(query={"pane": "commits"}))
    assert f'href="/git/commits/{sha[:7]}"' in log.text
    full = await client.get(REPO_COMMIT.href(sha))
    assert full.status_code == 200
    assert "init" in full.text and "README.md" in full.text
    assert '<span class="d-add">+hi\n</span>' in full.text
    assert (await client.get(REPO_COMMIT.href(sha[:7]))).status_code == 200
    assert (await client.get(REPO_COMMIT.href("zzzz"))).status_code == 400
    assert (await client.get(REPO_COMMIT.href("deadbeef"))).status_code == 404


async def _finished_task(client: TestClient, text: str = "write a note") -> dict:
    created = await client.post(
        TASKS_CREATE.href(),
        json={"tab": "t1", "task": text, "workflow": "quick-task", "runner": "claude"},
    )
    assert created.status_code == 200
    run = (await client.get("/api/v1/runs")).json()[0]
    for _ in range(100):
        run = (await client.get(f"/api/v1/runs/{run['id']}")).json()
        if run["status"] in ("done", "review", "failed"):
            break
        await asyncio.sleep(0.05)
    return run


async def test_a_task_commit_links_to_its_detail(client):
    run = await _finished_task(client)
    worktree = Path(run["worktreePath"])
    (worktree / "note.txt").write_text("from the task\n", encoding="utf-8")
    subprocess.run(["git", "add", "note.txt"], cwd=worktree, check=True)
    subprocess.run(["git", "commit", "-m", "task commit"], cwd=worktree, check=True)
    sha = _head(worktree)
    pane = await client.get(TASK.href(run["id"], query={"pane": "commits"}))
    assert f'href="/tasks/{run["id"]}/commits/{sha[:7]}"' in pane.text
    detail = await client.get(TASK_COMMIT_DETAIL.href(run["id"], sha))
    assert detail.status_code == 200
    assert "task commit" in detail.text and "note.txt" in detail.text
    assert (await client.get(TASK_COMMIT_DETAIL.href(run["id"], "--help"))).status_code in (
        400,
        404,
    )
    assert (await client.get(TASK_COMMIT_DETAIL.href(run["id"], "zzzz"))).status_code == 400
    assert (await client.get(TASK_COMMIT_DETAIL.href("0" * 32, sha))).status_code == 404


def test_pr_references_are_parsed_strictly():
    assert parse_pr_ref("12") is not None and parse_pr_ref("#12").number == 12  # type: ignore[union-attr]
    url = parse_pr_ref("https://github.com/Acme/Shop/pull/5/")
    assert url is not None and (url.number, url.repo) == (5, "github.com/acme/shop")
    for bad in ("", "0", "abc", "12; rm", "https://github.com/acme/shop/issues/5", "-1"):
        assert parse_pr_ref(bad) is None
    mixed = [
        {"state": "CLOSED", "headRepositoryOwner": {"login": "acme"}},
        {"state": "OPEN", "headRepositoryOwner": {"login": "someone"}},
        {"state": "OPEN", "headRepositoryOwner": {"login": "Acme"}, "number": 2},
    ]
    assert pick_branch_pr(mixed, "acme") == mixed[2]
    assert pick_branch_pr(mixed[:2], "acme") is None


def test_adopting_checks_the_pull_request_against_the_task(fake_gh, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_GH_BRANCH", "cez/abcd1234")
    target = PrTarget("github.com/acme/shop", "cez/abcd1234", "main")
    ref = parse_pr_ref
    ok = adopt_named(tmp_path, target, ref("7"), dry_run=False)  # type: ignore[arg-type]
    assert ok == ("https://github.com/acme/shop/pull/7", 7)
    for number, words in ((8, "not open"), (9, "not from branch"), (10, "does not target")):
        refused = adopt_named(tmp_path, target, ref(str(number)), dry_run=False)  # type: ignore[arg-type]
        assert isinstance(refused, str) and words in refused
    missing = adopt_named(tmp_path, target, ref("404"), dry_run=False)  # type: ignore[arg-type]
    assert isinstance(missing, str) and "not found" in missing
    other = adopt_named(
        tmp_path,
        target,
        ref("https://github.com/other/repo/pull/7"),  # type: ignore[arg-type]
        dry_run=False,
    )
    assert isinstance(other, str) and "github.com/other/repo" in other
    assert find_branch_pr(tmp_path, target, dry_run=False) == (
        "https://github.com/acme/shop/pull/7",
        7,
    )
    fork = PrTarget("github.com/acme/shop", "evil:cez/abcd1234", "main")
    assert find_branch_pr(tmp_path, fork, dry_run=False) is None
    calls = fake_gh.read_text(encoding="utf-8")
    assert "--repo github.com/acme/shop" in calls


async def test_adopting_a_pull_request_on_a_task(client):
    run = await _finished_task(client)
    assert run["branch"]
    page = await client.get(TASK.href(run["id"]))
    assert 'id="adopt-pr"' in page.text
    url = TASK_PR_ADOPT.href(run["id"])
    assert (await client.post(url, json={"tab": "t1", "adopt_pr": "abc"})).status_code == 400
    assert (await client.post(url, json={"tab": "t1", "adopt_pr": "x" * 400})).status_code == 400
    assert (await client.post(url, json={"adopt_pr": "5"})).status_code == 400
    missing = TASK_PR_ADOPT.href("0" * 32)
    assert (await client.post(missing, json={"tab": "t1", "adopt_pr": "5"})).status_code == 404
    status_before = run["status"]
    adopted = await client.post(url, json={"tab": "t1", "adopt_pr": "#12"})
    assert adopted.status_code == 200
    after = (await client.get(f"/api/v1/runs/{run['id']}")).json()
    assert after["pullRequestUrl"].endswith("/pull/12")
    assert after["status"] == status_before
    assert 'id="adopt-pr"' not in (await client.get(TASK.href(run["id"]))).text
    # Adopting again keeps the first answer.
    again = await client.post(url, json={"tab": "t1", "adopt_pr": "13"})
    assert again.status_code == 200
    assert (await client.get(f"/api/v1/runs/{run['id']}")).json()["pullRequestUrl"].endswith("/12")


async def test_adopting_without_a_number_finds_the_branch_pr(client):
    run = await _finished_task(client, "find my pr")
    adopted = await client.post(TASK_PR_ADOPT.href(run["id"]), json={"tab": "t1", "adopt_pr": ""})
    assert adopted.status_code == 200
    assert (await client.get(f"/api/v1/runs/{run['id']}")).json()["pullRequestUrl"]


# --- agent accounts -------------------------------------------------------------------------


def _jwt(claims: dict) -> str:
    import base64

    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'none'})}.{part(claims)}.sig"


async def test_accounts_show_login_state_and_details(client):
    await client.post("/settings/accounts", json={"tab": "t1", "name": "Work", "runner": "claude"})
    await client.post("/settings/accounts", json={"tab": "t1", "name": "Ada", "runner": "codex"})
    await client.post("/settings/accounts", json={"tab": "t1", "name": "Pi", "runner": "pi"})
    config = Config.from_env()
    from app.integrations.accounts import list_accounts

    rows = {row["name"]: row for row in list_accounts(config)}
    page = await client.get("/settings/accounts")
    assert "Work · claude" in page.text and "Ada · codex" in page.text
    assert page.text.count(">not signed in<") == 2
    assert "default login" in page.text

    work = Path(rows["Work"]["home"])
    (work / ".claude.json").write_text(
        json.dumps({"oauthAccount": {"emailAddress": "w@example.com", "displayName": "W"}}),
        encoding="utf-8",
    )
    ada = Path(rows["Ada"]["home"])
    token = _jwt(
        {"email": "ada@example.com", "https://api.openai.com/auth": {"chatgpt_plan_type": "pro"}}
    )
    (ada / "auth.json").write_text(
        json.dumps({"tokens": {"id_token": token, "refresh_token": "SECRET-REFRESH"}}),
        encoding="utf-8",
    )
    page = await client.get("/settings/accounts")
    assert page.text.count(">signed in<") == 2 and "not signed in" not in page.text
    assert "w@example.com" not in page.text  # identity only on the details page

    detail = await client.get(f"/settings/accounts/{rows['Work']['id']}")
    assert detail.status_code == 200
    assert "w@example.com" in detail.text and "Looks like an agent folder" in detail.text
    codex = await client.get(f"/settings/accounts/{rows['Ada']['id']}")
    assert "ada@example.com" in codex.text and "pro" in codex.text
    assert "SECRET-REFRESH" not in codex.text
    shutil.rmtree(ada)
    gone = await client.get(f"/settings/accounts/{rows['Ada']['id']}")
    assert "folder missing" in gone.text
    assert (await client.get("/settings/accounts/nope")).status_code == 404


async def test_a_project_account_selection_applies_to_new_runs(client):
    await client.post("/settings/accounts", json={"tab": "t1", "name": "Work", "runner": "claude"})
    from app.integrations.accounts import list_accounts, read_selections

    config = Config.from_env()
    account = list_accounts(config)[0]
    project = (await client.get("/api/v1/projects")).json()["projects"][0]["id"]
    url = f"/settings/accounts/selection/{project}/claude"
    page = await client.get("/settings/accounts")
    assert 'id="account-selection"' in page.text
    assert f'data-project="{project}"' in page.text

    assert (await client.post(url, json={"tab": "t1", "account": "nope"})).status_code == 400
    bad_runner = f"/settings/accounts/selection/{project}/pi"
    assert (await client.post(bad_runner, json={"account": account["id"]})).status_code == 400
    unknown = "/settings/accounts/selection/missing/claude"
    assert (await client.post(unknown, json={"account": account["id"]})).status_code == 404
    other = await client.post(
        "/settings/accounts", json={"tab": "t1", "name": "Ada", "runner": "codex"}
    )
    assert other.status_code == 200
    codex_id = next(row["id"] for row in list_accounts(config) if row["runner"] == "codex")
    assert (await client.post(url, json={"account": codex_id})).status_code == 400

    chosen = await client.post(url, json={"tab": "t1", "account": account["id"]})
    assert chosen.status_code == 200
    assert "selected" in chosen.text and 'id="account-selection"' in chosen.text
    assert read_selections(config) == {project: {"claude": account["id"]}}

    run = await _finished_task(client, "uses the work login")
    assert run["accountId"] == account["id"]
    explicit = await client.post(
        "/api/v1/runs", json={"task": "default", "workflow": "quick-task", "accountId": ""}
    )
    assert explicit.status_code in (200, 201)

    cleared = await client.post(url, json={"tab": "t1", "account": ""})
    assert cleared.status_code == 200
    assert read_selections(config) == {}
    after = await _finished_task(client, "back to default")
    assert not after.get("accountId")
