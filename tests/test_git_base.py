"""Diff anchor and remote selection. Git itself is real; GitHub is a fake `gh`."""

import os
import subprocess
from pathlib import Path

import pytest
from tests.conftest import init_repo

from app.engine.git_diff_base import resolve_task_diff_base
from app.engine.git_remotes import (
    TaskRemotes,
    parse_remote,
    resolve_task_remotes,
    set_fork_parent_lookup,
    split_remote_ref,
)
from app.engine.gitwork import diff_against, fork_sha

STARTED = "2026-08-04T05:00:08.919Z"
Git = dict[str, tuple[bool, str]]


def _stub(answers: Git):
    calls: list[list[str]] = []

    def run(args: list[str]) -> tuple[bool, str]:
        calls.append(args)
        key = " ".join(args)
        if key.startswith("config --get-regexp") and key not in answers:
            return True, "remote.origin.url https://github.com/acme/shop.git\n"
        return answers.get(key, (False, ""))

    return run, calls


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def test_parse_remote_accepts_https_and_scp_and_refuses_a_local_path():
    https = parse_remote("https://github.com/acme/shop.git")
    scp = parse_remote("git@github.com:acme/shop.git")
    assert https is not None
    assert (https.host, https.owner, https.repo) == ("github.com", "acme", "shop")
    assert scp is not None and scp.repo == "shop"
    assert parse_remote("/home/ada/shop") is None
    assert split_remote_ref("upstream/main", ("origin", "upstream")) == ("upstream", "main")
    assert split_remote_ref("feat/x", ("origin",)) == (None, "feat/x")


def test_a_stale_local_base_measures_against_origin(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    pinned = _git(repo, "rev-parse", "HEAD")
    _git(repo, "checkout", "-q", "-b", "upstream")
    (repo / "upstream.txt").write_text("upstream\n" * 100, encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "upstream")
    upstream = _git(repo, "rev-parse", "HEAD")
    _git(repo, "remote", "add", "origin", str(repo))
    _git(repo, "update-ref", "refs/remotes/origin/main", upstream)
    _git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    _git(repo, "checkout", "-q", "-b", "cez/task", "origin/main")
    (repo / "task.txt").write_text("task\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "task")

    def run(args: list[str]) -> tuple[bool, str]:
        proc = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=False)
        return proc.returncode == 0, proc.stdout

    resolved = resolve_task_diff_base(run, pinned)
    assert resolved.base == upstream
    stat = _git(repo, "diff", "--shortstat", resolved.base)
    assert "1 insertion" in stat
    # The branch name, not the stored fork SHA: local main is still the old commit.
    named = resolve_task_diff_base(run, "main", task_branch="cez/task")
    assert named.base == upstream


def test_stubbed_freshest_and_repointed_decisions():
    no_remote = {"rev-parse --verify --quiet origin/main^{commit}": (False, "")}
    run, calls = _stub(
        {
            **no_remote,
            "rev-parse --abbrev-ref HEAD": (True, "cez/ab12cd34\n"),
            "merge-base main HEAD": (True, "deadbeefdeadbeef\n"),
        }
    )
    same = resolve_task_diff_base(run, "main", task_branch="cez/ab12cd34")
    assert same.base == "deadbeefdeadbeef"
    assert ["merge-base", "main", "HEAD"] in calls

    behind, _calls = _stub(
        {
            "rev-parse --verify --quiet origin/main^{commit}": (True, "b61ae485b61ae485\n"),
            "merge-base --is-ancestor origin/main main": (False, ""),
            "merge-base --is-ancestor main origin/main": (True, ""),
            "rev-parse --abbrev-ref HEAD": (True, "cez/ab12cd34\n"),
            "merge-base origin/main HEAD": (True, "freshfreshfresh0\n"),
        }
    )
    behind_base = resolve_task_diff_base(behind, "main", task_branch="cez/ab12cd34")
    assert behind_base.base == "freshfreshfresh0"

    ahead, ahead_calls = _stub(
        {
            "rev-parse --verify --quiet origin/main^{commit}": (True, "b61ae485b61ae485\n"),
            "merge-base --is-ancestor origin/main main": (True, ""),
            "rev-parse --abbrev-ref HEAD": (True, "cez/ab12cd34\n"),
            "merge-base main HEAD": (True, "deadbeefdeadbeef\n"),
        }
    )
    ahead_base = resolve_task_diff_base(ahead, "main", task_branch="cez/ab12cd34")
    assert ahead_base.base == "deadbeefdeadbeef"
    assert ["merge-base", "origin/main", "HEAD"] not in ahead_calls

    review, review_calls = _stub(
        {
            **no_remote,
            "rev-parse --abbrev-ref HEAD": (True, "review/pr-694\n"),
            "merge-base main HEAD": (True, "forkpointforkpoint\n"),
            f"rev-parse --verify --quiet review/pr-694@{{{STARTED}}}^{{commit}}": (
                True,
                "prtipprtipprtip0\n",
            ),
            "diff --shortstat prtipprtipprtip0": (True, ""),
            "diff --shortstat forkpointforkpoint": (
                True,
                " 9 files changed, 147 insertions(+), 22 deletions(-)\n",
            ),
        }
    )
    anchored = resolve_task_diff_base(
        review, "main", task_branch="cez/ab12cd34", run_started_at=STARTED
    )
    assert anchored.base == "prtipprtipprtip0"
    assert anchored.repointed_head is not None
    assert anchored.repointed_head.head_branch == "review/pr-694"
    bare_run, bare_calls = _stub(
        {
            **no_remote,
            "rev-parse --abbrev-ref HEAD": (True, "review/pr-694\n"),
        }
    )
    bare = resolve_task_diff_base(bare_run, "main", task_branch="cez/ab12cd34")
    assert bare.base == "HEAD"
    assert ["merge-base", "main", "HEAD"] not in bare_calls
    assert review_calls


def test_a_merged_base_keeps_the_tighter_anchor():
    run, _calls = _stub(
        {
            "rev-parse --verify --quiet origin/main^{commit}": (False, ""),
            "rev-parse --abbrev-ref HEAD": (True, "review/pr-694\n"),
            "merge-base main HEAD": (True, "mergedbasemergedb\n"),
            f"rev-parse --verify --quiet review/pr-694@{{{STARTED}}}^{{commit}}": (
                True,
                "oldtipoldtipoldti\n",
            ),
            "diff --shortstat oldtipoldtipoldti": (
                True,
                " 531 files changed, 33963 insertions(+), 7358 deletions(-)\n",
            ),
            "diff --shortstat mergedbasemergedb": (
                True,
                " 18 files changed, 657 insertions(+), 15 deletions(-)\n",
            ),
        }
    )
    anchored = resolve_task_diff_base(
        run, "main", task_branch="cez/ab12cd34", run_started_at=STARTED
    )
    assert anchored.base == "mergedbasemergedb"


def test_diff_cap_truncates_and_still_counts_the_untracked_file(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    base = _git(repo, "rev-parse", "HEAD")
    (repo / "big.txt").write_text("x\n" * 50, encoding="utf-8")
    diff = diff_against(repo, base, cap=20)
    assert diff.truncated is True
    assert "diff truncated" in diff.text
    assert len(diff.text) < 80
    assert diff.files == 1


def test_gh_resolved_and_fork_parent_choose_the_base_remote(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    repo = tmp_path / "repo"
    init_repo(repo)
    _git(repo, "remote", "add", "origin", "git@github.com:ada/shop.git")
    _git(repo, "remote", "add", "upstream", "https://github.com/acme/shop.git")
    monkeypatch.delenv("CEZ_DRY_RUN", raising=False)
    asked: list[str] = []

    def lookup(remote):
        asked.append(f"{remote.owner}/{remote.repo}")
        return "acme/shop"

    set_fork_parent_lookup(lookup)
    try:
        chosen = resolve_task_remotes(repo)
        assert chosen == TaskRemotes("upstream", "origin", ("origin", "upstream"))
        assert asked == ["ada/shop"]
        _git(repo, "config", "remote.origin.gh-resolved", "base")
        assert resolve_task_remotes(repo).base == "origin"
        monkeypatch.setenv("CEZ_DRY_RUN", "1")
        _git(repo, "config", "--unset", "remote.origin.gh-resolved")
        asked.clear()
        assert resolve_task_remotes(repo).base == "origin"
        assert asked == []
    finally:
        set_fork_parent_lookup(None)


def test_a_fake_gh_answers_the_fork_parent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    _git(repo, "remote", "add", "origin", "https://github.com/ada/shop.git")
    _git(repo, "remote", "add", "upstream", "https://github.com/acme/shop.git")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "gh-args"
    (bindir / "gh").write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$GH_ARGS\"\nprintf '%s\\n' 'acme/shop'\n",
        encoding="utf-8",
    )
    (bindir / "gh").chmod(0o755)
    monkeypatch.setenv("GH_ARGS", str(log))
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("CEZ_DRY_RUN", "0")
    set_fork_parent_lookup(None)
    try:
        assert resolve_task_remotes(repo).base == "upstream"
    finally:
        set_fork_parent_lookup(None)
    recorded = log.read_text(encoding="utf-8")
    assert "api" in recorded
    assert "--hostname" in recorded
    assert "github.com" in recorded
    assert "repos/ada/shop" in recorded


def test_fork_sha_uses_the_pr_target_remote(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    stale = _git(repo, "rev-parse", "HEAD")
    _git(repo, "checkout", "-q", "-b", "next")
    (repo / "next.txt").write_text("next\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "next")
    tip = _git(repo, "rev-parse", "HEAD")
    _git(repo, "checkout", "-q", "main")
    _git(repo, "remote", "add", "origin", "git@github.com:ada/shop.git")
    _git(repo, "remote", "add", "upstream", "https://github.com/acme/shop.git")
    _git(repo, "update-ref", "refs/remotes/upstream/main", tip)
    _git(repo, "update-ref", "refs/remotes/origin/main", stale)
    monkeypatch.delenv("CEZ_DRY_RUN", raising=False)
    set_fork_parent_lookup(lambda _remote: "acme/shop")
    try:
        assert fork_sha(repo, "main", fetch=False) == tip
    finally:
        set_fork_parent_lookup(None)


def test_push_remote_follows_pushdefault(tmp_path: Path):
    from app.engine.git_actions import push_branch

    repo = tmp_path / "repo"
    init_repo(repo)
    _git(repo, "remote", "add", "origin", str(tmp_path / "origin.git"))
    _git(repo, "remote", "add", "fork", str(tmp_path / "fork.git"))
    _git(repo, "config", "remote.pushDefault", "fork")
    pushed = push_branch(repo, "main", dry_run=True)
    assert pushed["remote"] == "fork"
    assert pushed["dryRun"] is True


def test_option_like_remote_names_are_ignored(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    _git(repo, "config", "remote.--upload-pack=evil.url", "https://github.com/acme/shop.git")
    _git(repo, "remote", "add", "origin", "git@github.com:ada/shop.git")
    assert resolve_task_remotes(repo) == TaskRemotes("origin", "origin", ("origin",))
