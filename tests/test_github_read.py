"""GitHub read routes: dry-run catalog, and `gh` only when dry-run is off."""

import os
from pathlib import Path

import pytest
from stario.testing import TestClient
from tests.conftest import init_repo

from app.integrations.github_read import derive_pr_status, github_checks
from app.main import bootstrap


def test_reference_status_answers_a_review_before_it_answers_failing_checks():
    assert derive_pr_status(state="OPEN", is_draft=True, checks="failing") == "draft"
    assert derive_pr_status(state="OPEN", checks="pending") == "checks-pending"
    assert (
        derive_pr_status(
            state="OPEN",
            checks="passing",
            review_decision="CHANGES_REQUESTED",
            changes_requested_at="2026-01-02T00:00:00Z",
            head_committed_at="2026-01-01T00:00:00Z",
        )
        == "changes-requested"
    )
    assert (
        derive_pr_status(
            state="OPEN",
            checks="failing",
            review_decision="CHANGES_REQUESTED",
            changes_requested_at="2026-01-01T00:00:00Z",
            head_committed_at="2026-01-02T00:00:00Z",
        )
        == "checks-failing"
    )
    # A merge commit is not the author's answer. The first parent is.
    assert (
        derive_pr_status(
            state="OPEN",
            checks="passing",
            review_decision="CHANGES_REQUESTED",
            changes_requested_at="2026-01-02T00:00:00Z",
            head_committed_at="2026-01-03T00:00:00Z",
            head_parent_count=2,
            head_first_parent_at="2026-01-01T00:00:00Z",
        )
        == "changes-requested"
    )
    assert derive_pr_status(state="MERGED") == "merged"
    assert derive_pr_status(state="OPEN", checks="passing", review_decision="APPROVED") == "ready"


async def test_dry_run_catalog_covers_checks_search_status_comments_and_changes(repo: Path):
    async with TestClient(
        bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321"
    ) as client:
        missing = await client.get("/api/v1/github/checks")
        assert missing.status_code == 400
        bad = await client.get("/api/v1/github/checks?prs=12,abc")
        assert bad.status_code == 400
        checks = await client.get("/api/v1/github/checks?prs=128,124,99999")
        assert checks.status_code == 200
        body = checks.json()
        assert body["available"] is True
        assert body["checks"]["128"] == "passing"
        assert body["checks"]["124"] == "failing"
        assert body["checks"]["99999"] is None

        found = await client.get("/api/v1/github/search?kind=pr&q=128")
        assert found.json()["items"][0]["number"] == 128
        issue = await client.get("/api/v1/github/search?kind=issue&q=Login")
        assert [row["number"] for row in issue.json()["items"]] == [142]
        empty = await client.get("/api/v1/github/search?kind=pr&q=nothing-matches-this")
        assert empty.json()["items"] == []
        assert (await client.get("/api/v1/github/search?kind=commit&q=128")).status_code == 400
        assert (await client.get("/api/v1/github/search?kind=pr&q=")).status_code == 400
        long = "a" * 257
        assert (await client.get(f"/api/v1/github/search?kind=pr&q={long}")).status_code == 400

        status = await client.get("/api/v1/github/ref-status?prs=128,124&issues=142,99999")
        ref = status.json()
        assert ref["prs"]["128"] == "ready"
        assert ref["prs"]["124"] == "draft"
        assert ref["issues"]["142"] == "open"
        assert "99999" not in ref["prs"]
        assert (await client.get("/api/v1/github/ref-status")).status_code == 400

        comments = await client.get("/api/v1/github/comments/issue/142")
        thread = comments.json()
        assert thread["comments"][0]["createdAt"] <= thread["comments"][1]["createdAt"]
        kinds = [event["kind"] for event in thread["events"]]
        assert "committed" in kinds and "labeled" in kinds and "cross-referenced" in kinds
        commits = [event for event in thread["events"] if event["kind"] == "committed"]
        assert len(commits) > 1
        assert all(len(event["sha"]) == 40 for event in commits)
        assert any(event["checks"] is None for event in commits)
        ids = [event["id"] for event in thread["events"]]
        assert len(ids) == len(set(ids))
        assert all(item.startswith("evt-") for item in ids)
        pr = (await client.get("/api/v1/github/comments/pr/137")).json()
        assert any(event["kind"] == "merged" for event in pr["events"])
        assert any(row["kind"] == "review" for row in pr["comments"])
        assert not any(event["kind"] == "merged" for event in thread["events"])
        assert (await client.get("/api/v1/github/comments/banana/1")).status_code == 400

        changes = await client.get("/api/v1/github/prs/128/changes")
        diff = changes.json()
        assert diff["available"] is True
        assert any(row["status"] == "renamed" and row.get("previousPath") for row in diff["files"])
        assert any(row.get("patchUnavailableReason") == "binary" for row in diff["files"])
        assert diff["truncated"] is True
        scoped = await client.get("/api/v1/p/default/github/prs/128/changes")
        assert scoped.json() == diff
        assert (await client.get("/api/v1/github/prs/0/changes")).status_code == 400
        assert (await client.get("/api/v1/github/prs/1/changes?refresh=true")).status_code == 400
        assert (await client.get("/api/v1/github/prs/1/changes?refresh=1")).status_code == 200


async def test_checks_call_gh_only_when_dry_run_is_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    repo = tmp_path / "repo"
    init_repo(repo)
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "args"
    (bindir / "gh").write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        f"pathlib.Path({str(log)!r}).write_text('\\n'.join(sys.argv[1:]))\n"
        "if 'search' in sys.argv:\n"
        '    print(\'[{"number": 7, "title": "from gh", "url": "https://github.com/acme/shop/pull/7"}]\')\n'
        "else:\n"
        '    print(\'{"statusCheckRollup":[{"state":"SUCCESS"}]}\')\n',
        encoding="utf-8",
    )
    (bindir / "gh").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}")
    dry = github_checks(repo, [7], dry_run=True)
    assert dry["checks"][7] is None
    assert not log.exists()
    live = github_checks(repo, [7], dry_run=False)
    assert live["available"] is True
    assert live["checks"][7] == "passing"
    assert "pr" in log.read_text(encoding="utf-8")
    assert "7" in log.read_text(encoding="utf-8")
    from app.integrations.github_read import github_search

    found = github_search(repo, "pr", "from", dry_run=False)
    assert found["available"] is True
    assert found["items"][0]["title"] == "from gh"
    assert "search" in log.read_text(encoding="utf-8")


async def test_repo_routes_read_the_local_checkout(repo: Path):
    readme = repo / "README.md"
    async with TestClient(
        bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321"
    ) as client:
        page = await client.get("/api/v1/repo")
        assert page.status_code == 200
        assert page.json()["info"]["branch"] == "main"
        assert any(row["subject"] == "init" for row in page.json()["log"])
        tree = await client.get("/api/v1/repo/tree")
        assert "README.md" in tree.json()["paths"]
        assert tree.json()["truncated"] is False
        shown = await client.get("/api/v1/repo/files?path=README.md")
        assert shown.json()["content"].startswith("hi")
        sha = page.json()["log"][0]["hash"]
        commit = await client.get(f"/api/v1/repo/commit/{sha}?structured=1")
        assert commit.status_code == 200
        assert commit.json()["subject"] == "init"
        readme.write_text("hi\nmore\n", encoding="utf-8")
        changed = await client.get("/api/v1/repo/changes")
        assert changed.status_code == 200
        assert any(row["path"] == "README.md" for row in changed.json()["files"])
        (repo / ".gitignore").write_text(".env\n", encoding="utf-8")
        secret = repo / ".env"
        secret.write_text("TOKEN=secret\n", encoding="utf-8")
        hidden = await client.get("/api/v1/repo/files?path=.env")
        assert hidden.status_code == 404
        assert "TOKEN" not in hidden.text
        missing = await client.get("/api/v1/repo/files")
        assert missing.status_code == 400
        created = await client.post("/api/v1/repo/branch", json={"name": "feature", "from": "main"})
        assert created.status_code == 200
        assert created.json() == {"branch": "feature", "created": True}
        refused = await client.post("/api/v1/repo/branch", json={"name": "-evil"})
        assert refused.status_code == 409
        assert readme.read_text(encoding="utf-8") == "hi\nmore\n"
