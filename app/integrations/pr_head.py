"""Fork a run's worktree from a pull request's head (`automations/pr-head.ts`).

A `checkout: "pr-head"` GitHub automation verifies the PR it matched, not the base branch. Before
the run exists, the PR is read from GitHub, its head is fetched into a namespaced ref
(`refs/cezar/pr/<n>`, never a branch), and the run forks from the fetched sha. A closed PR and
an unadmitted fork are skipped, an unreachable head fails the launch, and only a resolved head
starts a run.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from stario.json import loads as json_loads

from app.engine.git_remotes import remote_for_repo
from app.engine.gitwork import git
from app.integrations.github_poll import REPO_RE, GhError

Gh = Callable[[list[str]], str]
_SHA = re.compile(r"^[0-9a-f]{40}$")


def pr_head_ref(number: int) -> str:
    return f"refs/cezar/pr/{number}"


@dataclass(frozen=True, slots=True)
class PrHeadResolution:
    kind: str  # ok, skipped, failed
    reason: str = ""
    head: dict[str, object] = field(default_factory=dict)
    note: str = ""


def _failed(what: str, detail: str = "") -> PrHeadResolution:
    tail = f" — {detail.strip()[:1000]}" if detail.strip() else ""
    return PrHeadResolution("failed", f"pr-head-unavailable: {what}{tail}")


def resolve_pr_head(
    root: Path,
    repo: str,
    number: int,
    *,
    allow_fork_heads: bool,
    dry_run: bool,
    gh: Gh,
) -> PrHeadResolution:
    """`gh` is already bound to the right host. Never raises."""
    if not REPO_RE.match(repo) or number <= 0:
        return _failed(f"invalid pull request {repo}#{number}")
    ref = pr_head_ref(number)
    if dry_run:
        ok, out, err = git(root, ["rev-parse", "HEAD"])
        if not ok:
            return _failed("could not read the fixture head", err)
        sha = out.strip()
        pinned, _out, err = git(root, ["update-ref", ref, sha])
        if not pinned:
            return _failed(f"could not write {ref}", err)
        return PrHeadResolution(
            "ok",
            head={
                "number": number,
                "repo": repo,
                "headRepo": repo,
                "headRef": f"fixture-pr-{number}",
                "headSha": sha,
                "baseRef": "main",
                "ref": ref,
                "url": f"https://github.com/{repo}/pull/{number}",
                "untrusted": False,
            },
        )
    remote, _host = remote_for_repo(root, repo)
    try:
        body = json_loads(gh(["api", f"repos/{repo}/pulls/{number}"]))
    except GhError as exc:
        return _failed("could not read the pull request", str(exc))
    except ValueError:
        return _failed("unexpected pull request payload")
    parsed = _payload(body)
    if parsed is None:
        return _failed("unexpected pull request payload")
    state, url, sha, head_ref, head_repo, base_ref = parsed
    if state != "open":
        return PrHeadResolution("skipped", "pr-not-open")
    untrusted = (head_repo or "(deleted fork)").lower() != repo.lower()
    if untrusted and not allow_fork_heads:
        return PrHeadResolution("skipped", "fork-head")
    # `refs/pull/N/head` lives on the PR's repo, not necessarily `origin`.
    fetched, _out, err = git(
        root, ["fetch", "--no-tags", remote, f"+refs/pull/{number}/head:{ref}"], timeout=120
    )
    if not fetched:
        return _failed(f"could not fetch refs/pull/{number}/head", err)
    resolved, out, err = git(root, ["rev-parse", "--verify", f"{ref}^{{commit}}"])
    if not resolved:
        return _failed(f"could not resolve {ref}", err)
    head_sha = out.strip()
    note = ""
    if head_sha != sha:
        note = (
            f"pull request #{number} moved while launching — testing the fetched head "
            f"{head_sha[:12]} (the API reported {sha[:12]})"
        )
    return PrHeadResolution(
        "ok",
        head={
            "number": number,
            "repo": repo,
            "headRepo": head_repo or "(deleted fork)",
            "headRef": head_ref,
            "headSha": head_sha,
            "baseRef": base_ref,
            "ref": ref,
            "url": url,
            "untrusted": untrusted,
        },
        note=note,
    )


def _payload(body: object) -> tuple[str, str, str, str, str, str] | None:
    if not isinstance(body, dict):
        return None
    head, base = body.get("head"), body.get("base")
    if not isinstance(head, dict) or not isinstance(base, dict):
        return None
    state, url = body.get("state"), body.get("html_url")
    sha, ref, base_ref = head.get("sha"), head.get("ref"), base.get("ref")
    repo = head.get("repo")
    name = repo.get("full_name") if isinstance(repo, dict) else ""
    if not (isinstance(state, str) and isinstance(url, str) and isinstance(sha, str)):
        return None
    if not (isinstance(ref, str) and ref and isinstance(base_ref, str) and base_ref):
        return None
    if not _SHA.match(sha):
        return None
    return state, url, sha, ref, name if isinstance(name, str) else "", base_ref


def prune_pr_head_refs(root: Path, still_needed: set[int]) -> None:
    """Delete every `refs/cezar/pr/<n>` no remaining run needs. Never raises."""
    ok, out, _err = git(root, ["for-each-ref", "--format=%(refname)", "refs/cezar/pr/"])
    if not ok:
        return
    for line in out.splitlines():
        match = re.fullmatch(r"refs/cezar/pr/([1-9][0-9]*)", line.strip())
        if match and int(match.group(1)) not in still_needed:
            git(root, ["update-ref", "-d", line.strip()])
