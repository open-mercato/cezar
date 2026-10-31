"""Playwright walk of the Datastar cockpit. Not part of `uv run pytest`.

```bash
uv sync --group e2e
uv run --group e2e playwright install chromium
uv run --group e2e pytest e2e -q
```
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright
from tests.conftest import init_repo

from browser_launch import launch_chromium


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_healthy(port: int) -> None:
    import urllib.request

    deadline = time.time() + 20
    last = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError as exc:
            last = str(exc)
        time.sleep(0.1)
    raise AssertionError(last or "cockpit did not listen")


def test_a_new_task_reaches_done(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    port = _free_port()
    env = os.environ.copy()
    env.update(
        {
            "CEZ_DRY_RUN": "1",
            "CEZ_REPO": str(repo),
            "PROJECT_DATA_DIR": str(tmp_path / "data"),
            "STARIO_HOST": "127.0.0.1",
            "STARIO_PORT": str(port),
        }
    )
    process = subprocess.Popen(
        [sys.executable, "-m", "app.main"],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        _wait_healthy(port)
        with sync_playwright() as playwright:
            browser = launch_chromium(playwright)
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{port}/tasks/new", wait_until="networkidle")
            page.locator("textarea").fill("write a note from the browser")
            page.get_by_role("button", name="Start").click()
            page.wait_for_url("**/tasks/*", timeout=15_000)
            page.get_by_text("done", exact=True).wait_for(timeout=15_000)
            assert "write a note from the browser" in page.content()
            browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def _fake_claude(path: Path) -> None:
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "from pathlib import Path\n"
        "line = sys.stdin.readline()\n"
        "Path('touched.txt').write_text('ok\\n')\n"
        "print(json.dumps({'type': 'result', 'result': 'done'}))\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _fake_gh(path: Path) -> None:
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import os, sys\n"
        "open(os.environ['GH_LOG'], 'a', encoding='utf-8').write(' '.join(sys.argv[1:]) + '\\n')\n"
        "if sys.argv[1:3] == ['pr', 'create']:\n"
        "    print('https://github.com/acme/app/pull/12')\n"
        "raise SystemExit(0)\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def test_review_commit_push_draft_pr_and_instructions(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    bare = tmp_path / "origin.git"
    subprocess.run(
        ["git", "init", "--bare", "-b", "main", str(bare)], check=True, capture_output=True
    )
    subprocess.run(["git", "remote", "add", "origin", str(bare)], cwd=repo, check=True)
    subprocess.run(
        ["git", "push", "-u", "origin", "main"], cwd=repo, check=True, capture_output=True
    )
    bindir = tmp_path / "bin"
    bindir.mkdir()
    _fake_claude(bindir / "claude")
    _fake_gh(bindir / "gh")
    log = tmp_path / "gh.log"
    port = _free_port()
    env = os.environ.copy()
    env.update(
        {
            "CEZ_DRY_RUN": "0",
            "CEZ_REVIEW_GATE": "1",
            "CEZ_AUTONAME": "0",
            "CEZ_REPO": str(repo),
            "PROJECT_DATA_DIR": str(tmp_path / "data"),
            "STARIO_HOST": "127.0.0.1",
            "STARIO_PORT": str(port),
            "CEZ_CLAUDE_BIN": str(bindir / "claude"),
            "GH_LOG": str(log),
            "PATH": f"{bindir}{os.pathsep}{env.get('PATH', '')}",
        }
    )
    process = subprocess.Popen(
        [sys.executable, "-m", "app.main"],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        _wait_healthy(port)
        with sync_playwright() as playwright:
            browser = launch_chromium(playwright)
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{port}/tasks/new", wait_until="networkidle")
            page.locator("textarea").fill("change the readme")
            page.get_by_role("button", name="Start").click()
            page.wait_for_url("**/tasks/*", timeout=15_000)
            page.get_by_role("button", name="Commit").wait_for(timeout=15_000)
            page.get_by_role("button", name="Commit").click()
            page.get_by_role("button", name="Push").click()
            page.get_by_role("button", name="Draft PR").click()
            page.wait_for_timeout(800)
            page.goto(page.url, wait_until="domcontentloaded")
            assert "https://github.com/acme/app/pull/12" in page.content()
            assert "pr create" in log.read_text(encoding="utf-8")
            page.goto(
                f"http://127.0.0.1:{port}/settings/instructions",
                wait_until="domcontentloaded",
            )
            page.locator("#system-prompt-input").fill("be brief")
            page.locator("#branch-naming-input").fill("start with feature/")
            with page.expect_response(
                lambda response: (
                    response.request.method == "POST"
                    and response.url.endswith("/settings/instructions")
                )
            ):
                page.get_by_role("button", name="Save").click()
            stored = (repo / ".ai" / "cezar" / "instructions.json").read_text(encoding="utf-8")
            assert "be brief" in stored
            assert "start with feature/" in stored
            browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
