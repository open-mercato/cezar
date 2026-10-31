"""Org skill repos: a bare clone, then `git show` of the files under `skills/`.

A local path clones without the network. Anything git refuses is skipped, and
local skills keep working.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

from app.engine.model import Skill
from app.features.settings.store import read_skill_repos

_ENV = {
    "GIT_ALLOW_PROTOCOL": "https:http:ssh:git:file",
    "GIT_TERMINAL_PROMPT": "0",
}
# Same hardening as the TypeScript cache (#428): no remote-helper transports.
_HARDENING = [
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.fd.allow=never",
    "-c",
    "protocol.file.allow=user",
]


def org_skill(data_dir: Path, name: str) -> Skill | None:
    for source in read_skill_repos(data_dir):
        bare = _bare(data_dir, source.repo)
        if bare is None:
            continue
        found = _read(bare, source.ref, name)
        if found is not None:
            return found
    return None


def list_team_skills(data_dir: Path) -> list[Skill]:
    """Skills already cloned. Does not fetch."""
    return _collect(data_dir, refresh=False)


def refresh_team_skills(data_dir: Path) -> list[Skill]:
    """Clone missing sources and `git fetch` ones already on disk.

    Tests point `repo` at a local path, so this does not touch the network.
    A fetch that fails still lists whatever the existing clone has.
    """
    return _collect(data_dir, refresh=True)


def _collect(data_dir: Path, *, refresh: bool) -> list[Skill]:
    found: list[Skill] = []
    seen: set[str] = set()
    for source in read_skill_repos(data_dir):
        bare = _bare(data_dir, source.repo, refresh=refresh)
        if bare is None:
            continue
        for skill in _listed(bare, source.ref):
            if skill.name in seen:
                continue
            seen.add(skill.name)
            found.append(skill)
    return found


def _bare(data_dir: Path, repo: str, *, refresh: bool = False) -> Path | None:
    digest = hashlib.sha256(repo.encode()).hexdigest()[:16]
    dest = data_dir / "skill-cache" / digest
    if (dest / "HEAD").is_file():
        if refresh:
            _git(["-C", str(dest), "fetch", "origin", "+refs/heads/*:refs/heads/*"])
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    # clone writes progress to stderr. An empty stdout is still a success.
    ok, _out = _git(["clone", "--bare", repo, str(dest)])
    if not ok or not (dest / "HEAD").is_file():
        return None
    return dest


def _listed(bare: Path, ref: str) -> list[Skill]:
    if not ref or ref.startswith("-") or ".." in ref.split("/"):
        return []
    ok, sha = _git(["-C", str(bare), "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"])
    if not ok or not sha:
        return []
    ok, listed = _git(["-C", str(bare), "ls-tree", "-r", "--name-only", sha, "--"])
    if not ok:
        return []
    skills: list[Skill] = []
    for path in listed.splitlines():
        if not _is_skill_file(path):
            continue
        ok, body = _git(["-C", str(bare), "show", f"{sha}:{path}"])
        if not ok:
            continue
        skill_name, text = _name_and_body(path, body)
        skills.append(Skill(skill_name, "", text, f"{bare}:{path}"))
    return skills


def _read(bare: Path, ref: str, name: str) -> Skill | None:
    if not ref or ref.startswith("-") or ".." in ref.split("/"):
        return None
    ok, sha = _git(["-C", str(bare), "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"])
    if not ok or not sha:
        return None
    ok, listed = _git(["-C", str(bare), "ls-tree", "-r", "--name-only", sha, "--"])
    if not ok:
        return None
    for path in listed.splitlines():
        if not _is_skill_file(path):
            continue
        ok, body = _git(["-C", str(bare), "show", f"{sha}:{path}"])
        if not ok:
            continue
        skill_name, text = _name_and_body(path, body)
        if skill_name == name:
            return Skill(name, "", text, f"{bare}:{path}")
    return None


def _is_skill_file(path: str) -> bool:
    parts = path.split("/")
    return path.endswith(".md") and "skills" in parts[:-1]


def _name_and_body(path: str, raw: str) -> tuple[str, str]:
    parts = path.split("/")
    if parts[-1] == "SKILL.md" and len(parts) >= 2 and parts[-2] != "skills":
        title = parts[-2]
    else:
        title = Path(path).stem
    body = raw
    if raw.startswith("---"):
        end = raw.find("\n---", 3)
        if end >= 0:
            body = raw[end + 4 :].lstrip("\n")
    return title, body.strip()


def refresh_sources(
    data_dir: Path, repos: list[tuple[str, str]], *, dry_run: bool
) -> dict[str, object]:
    """Clone or fetch each configured skills repo and list the skills it holds.

    A dry run still clones a local path or `file://` URL. Anything else is
    skipped, so a dry run does not talk to a network remote.
    """
    found: list[dict[str, str]] = []
    skipped: list[str] = []
    for repo, ref in repos:
        local = _local_repo(repo)
        if not local and dry_run:
            skipped.append(repo)
            continue
        source = repo.removeprefix("file://") if local else repo
        existed = (_cache(data_dir, source) / "HEAD").is_file()
        bare = _bare(data_dir, source)
        if bare is None:
            skipped.append(repo)
            continue
        if existed:
            _git(["-C", str(bare), "fetch", "--all", "--prune"])
        found.extend(_catalog(bare, ref))
    return {"skills": found, "skipped": skipped, "network": False}


def cached_sources(data_dir: Path, repos: list[tuple[str, str]]) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    for repo, ref in repos:
        source = repo.removeprefix("file://") if _local_repo(repo) else repo
        bare = _cache(data_dir, source)
        if (bare / "HEAD").is_file():
            found.extend(_catalog(bare, ref))
    return found


def _local_repo(repo: str) -> bool:
    return repo.startswith("/") or repo.startswith("file://")


def _cache(data_dir: Path, repo: str) -> Path:
    digest = hashlib.sha256(repo.encode()).hexdigest()[:16]
    return data_dir / "skill-cache" / digest


def _catalog(bare: Path, ref: str) -> list[dict[str, str]]:
    if not ref or ref.startswith("-") or ".." in ref.split("/"):
        return []
    ok, sha = _git(["-C", str(bare), "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"])
    if not ok or not sha:
        return []
    ok, listed = _git(["-C", str(bare), "ls-tree", "-r", "--name-only", sha, "--"])
    if not ok:
        return []
    rows: list[dict[str, str]] = []
    for path in listed.splitlines():
        if not _is_skill_file(path):
            continue
        ok, body = _git(["-C", str(bare), "show", f"{sha}:{path}"])
        if not ok:
            continue
        name, _text = _name_and_body(path, body)
        rows.append({"name": name, "path": f"{bare}:{path}"})
    return rows


def _git(args: list[str]) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            ["git", *_HARDENING, *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
            env=os.environ | _ENV,
        )
    except OSError, subprocess.TimeoutExpired:
        return False, ""
    return result.returncode == 0, result.stdout.strip()
