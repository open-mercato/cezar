"""Which remote a task forks from, and which one it pushes to.

Nothing here hard-codes `origin`. The PR-target remote is `gh repo set-default`
(`remote.<name>.gh-resolved = base`), else a remote GitHub says is `origin`'s
fork parent, else `origin`, else the first remote. Push is `remote.pushDefault`,
else `origin`, else the base remote. The fork-parent lookup is one `gh api`
call, skipped under `CEZ_DRY_RUN=1` and for any host that is not GitHub.
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from app.engine.gitwork import git, is_safe_git_ref

_URL = re.compile(r"^(?:https?|ssh|git|git\+ssh)://(?:[^@/]+@)?([^/:]+)(?::\d+)?/(.+)$")
_SCP = re.compile(r"^(?:[^@/:]+@)?([^:/]+):(.+)$")

PARENT_RETRY_S = 10 * 60


@dataclass(frozen=True, slots=True)
class ParsedRemote:
    host: str
    owner: str
    repo: str


@dataclass(frozen=True, slots=True)
class TaskRemotes:
    base: str | None
    push: str | None
    names: tuple[str, ...]


ForkParentLookup = Callable[[ParsedRemote], str | None]

_cache: dict[str, tuple[str | None, float]] = {}
_lookup: ForkParentLookup | None = None


def set_fork_parent_lookup(lookup: ForkParentLookup | None) -> None:
    """Tests replace the GitHub call. `None` restores `gh api`."""
    global _lookup
    _lookup = lookup
    _cache.clear()


def parse_remote(remote: str) -> ParsedRemote | None:
    text = remote.strip().rstrip("/")
    match = _URL.match(text) or _SCP.match(text)
    if match is None:
        return None
    host, path = match.group(1), match.group(2)
    if not host or not path:
        return None
    if path.lower().endswith(".git"):
        path = path[: -len(".git")]
    parts = [part for part in path.split("/") if part]
    if len(parts) < 2:
        return None
    return ParsedRemote(host.lower(), parts[-2], parts[-1])


def split_remote_ref(ref: str, names: tuple[str, ...] | list[str]) -> tuple[str | None, str]:
    best: str | None = None
    for name in names:
        prefix = f"{name}/"
        longer = best is None or len(name) > len(best)
        if ref.startswith(prefix) and len(ref) > len(prefix) and longer:
            best = name
    if best is None:
        return None, ref
    return best, ref[len(best) + 1 :]


def is_github_host(host: str) -> bool:
    name = host.lower().rstrip(".")
    if not name or ".." in name or any(ch in name for ch in " /\\"):
        return False
    if name == "github.com" or name.endswith(".ghe.com"):
        return True
    return name in _gh_config_hosts()


def resolve_task_remotes(repo: Path) -> TaskRemotes:
    root = repo
    ok, out, _err = git(root, ["config", "--get-regexp", r"^remote\."])
    return remotes_from_config(out if ok else "")


def remotes_from_config(stdout: str) -> TaskRemotes:
    urls: dict[str, str] = {}
    gh_resolved: str | None = None
    push_default = ""
    for raw in stdout.splitlines():
        line = raw.strip()
        resolved = _remote_field(line)
        if resolved is not None:
            name, key, value = resolved
            if key == "url" and name not in urls:
                urls[name] = value
            elif key == "gh-resolved" and value == "base" and gh_resolved is None:
                gh_resolved = name
            continue
        push = _push_default(line)
        if push is not None:
            push_default = push
    names = tuple(name for name in urls if is_safe_git_ref(name))
    if not names:
        return TaskRemotes(None, None, ())
    base = gh_resolved if gh_resolved in names else None
    if base is None and "origin" in names:
        base = _fork_parent_remote(urls, names)
    if base is None:
        base = "origin" if "origin" in names else names[0]
    if push_default in names:
        push = push_default
    elif "origin" in names:
        push = "origin"
    else:
        push = base
    return TaskRemotes(base, push, names)


def _fork_parent_remote(urls: dict[str, str], names: tuple[str, ...]) -> str | None:
    if len(names) < 2 or os.environ.get("CEZ_DRY_RUN") == "1":
        return None
    origin = parse_remote(urls.get("origin", ""))
    if origin is None or not is_github_host(origin.host):
        return None
    parent = (_parent_of(origin) or "").lower()
    if not parent:
        return None
    for name in names:
        if name == "origin":
            continue
        parsed = parse_remote(urls.get(name, ""))
        slug = f"{parsed.owner}/{parsed.repo}".lower() if parsed else ""
        if parsed and parsed.host == origin.host and slug == parent:
            return name
    return None


def _parent_of(origin: ParsedRemote) -> str | None:
    if _lookup is not None:
        return _lookup(origin) or None
    key = f"{origin.host}/{origin.owner}/{origin.repo}".lower()
    hit = _cache.get(key)
    now = time.monotonic()
    if hit is not None and hit[1] > now:
        return hit[0]
    value = _gh_fork_parent(origin)
    # An answer sticks. No answer is asked again after ten minutes.
    _cache[key] = (value, now + (10**9 if value else PARENT_RETRY_S))
    return value


def _gh_fork_parent(origin: ParsedRemote) -> str | None:
    try:
        proc = subprocess.run(
            [
                "gh",
                "api",
                "--hostname",
                origin.host,
                f"repos/{origin.owner}/{origin.repo}",
                "--jq",
                '.parent.full_name // ""',
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            env={**os.environ, "GH_PROMPT_DISABLED": "1"},
        )
    except OSError, subprocess.TimeoutExpired:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def _remote_field(line: str) -> tuple[str, str, str] | None:
    # `remote.<name>.<url|gh-resolved> <value>`. The name may contain dots.
    if not line.startswith("remote."):
        return None
    rest = line[len("remote.") :]
    for key in ("gh-resolved", "url"):
        marker = f".{key} "
        at = rest.rfind(marker)
        if at > 0:
            return rest[:at], key, rest[at + len(marker) :]
    return None


def _push_default(line: str) -> str | None:
    lowered = line.lower()
    prefix = "remote.pushdefault "
    if lowered.startswith(prefix):
        return line[len(prefix) :]
    return None


def _gh_config_hosts() -> set[str]:
    configured = os.environ.get("GH_CONFIG_DIR")
    root = Path(configured) if configured else Path.home() / ".config" / "gh"
    file = root / "hosts.yml"
    try:
        text = file.read_text(encoding="utf-8")
    except OSError:
        return set()
    hosts: set[str] = set()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or line.startswith((" ", "\t", "-")):
            continue
        if stripped.endswith(":"):
            host = stripped[:-1].strip().strip("\"'")
            if host:
                hosts.add(host.lower())
    return hosts


_SAFE_HOST = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", re.IGNORECASE)


def remote_for_repo(root: Path, repo: str) -> tuple[str, str]:
    """`(remote name, host)` of the remote whose URL is `owner/name`.

    Falls back to the base remote (else `origin`) with its own host when none matches, and to
    an empty host when a URL cannot be read. The host is what `gh api --hostname` needs on
    GitHub Enterprise (`remoteForRepo` in `pr-head.ts`). A host that is not a safe hostname is
    dropped.
    """
    remotes = resolve_task_remotes(root)

    def host_of(name: str) -> tuple[str, str]:
        ok, out, _err = git(root, ["remote", "get-url", name])
        parsed = parse_remote(out.strip()) if ok else None
        return (parsed.owner + "/" + parsed.repo, parsed.host) if parsed else ("", "")

    fallback = remotes.base or "origin"
    for name in remotes.names:
        slug, host = host_of(name)
        if slug.lower() == repo.lower():
            return name, host if _SAFE_HOST.match(host) else ""
    _slug, host = host_of(fallback) if remotes.names else ("", "")
    return fallback, host if _SAFE_HOST.match(host) else ""


def enterprise_host(root: Path, repo: str) -> str:
    """The GitHub Enterprise host for `repo`, or empty for github.com and unknown hosts."""
    _name, host = remote_for_repo(root, repo)
    if not host or host.lower() == "github.com" or not is_github_host(host):
        return ""
    return host.lower()
