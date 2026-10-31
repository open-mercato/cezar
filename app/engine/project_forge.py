"""Register a GitHub checkout without leaving the machine in a dry run.

`gh` is invoked only when dry-run is off, and only through the runner the
caller passes. A dry run creates a local directory and does not call it.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path

Runner = Callable[[list[str]], tuple[int, str]]


def gh(args: list[str]) -> tuple[int, str]:
    try:
        result = subprocess.run(
            ["gh", *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)
    text = (result.stdout or result.stderr).strip()
    return result.returncode, text


def repo_name(url: str) -> str:
    tail = url.rstrip("/").split("/")[-1]
    if tail.endswith(".git"):
        tail = tail[: -len(".git")]
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in tail)
    return cleaned or "repo"


def checkout(url: str, dest_root: Path, *, dry_run: bool, runner: Runner = gh) -> dict[str, object]:
    name = repo_name(url)
    if not url.startswith("https://github.com/") and "github.com" not in url:
        return {"ok": False, "error": "url must be a GitHub repository"}
    target = dest_root / name
    if dry_run:
        target.mkdir(parents=True, exist_ok=True)
        (target / "README.md").write_text(f"# {name}\n", encoding="utf-8")
        return {"ok": True, "path": str(target), "dryRun": True}
    dest_root.mkdir(parents=True, exist_ok=True)
    code, text = runner(["repo", "clone", url, str(target)])
    if code != 0:
        return {"ok": False, "error": text or "gh repo clone failed"}
    return {"ok": True, "path": str(target), "dryRun": False}


def owners(*, dry_run: bool, runner: Runner = gh) -> dict[str, object]:
    if dry_run:
        return {"owners": [{"login": "cezar", "type": "User"}], "dryRun": True}
    code, text = runner(["api", "user", "--jq", ".login"])
    if code != 0:
        return {"owners": [], "available": False, "reason": text or "gh is not signed in"}
    login = text.splitlines()[0].strip() if text else ""
    if not login:
        return {"owners": [], "available": False, "reason": "gh returned no login"}
    return {"owners": [{"login": login, "type": "User"}], "dryRun": False}


def create_repo(
    name: str, dest_root: Path, *, dry_run: bool, owner: str = "", runner: Runner = gh
) -> dict[str, object]:
    if not name or any(ch.isspace() for ch in name):
        return {"ok": False, "error": "project name must not contain spaces"}
    target = dest_root / name
    if dry_run:
        target.mkdir(parents=True, exist_ok=True)
        return {"ok": True, "path": str(target), "dryRun": True}
    slug = f"{owner}/{name}" if owner else name
    code, text = runner(["repo", "create", slug, "--private", "--clone", f"--source={target}"])
    if code != 0:
        return {"ok": False, "error": text or "gh repo create failed"}
    return {"ok": True, "path": str(target), "dryRun": False}
