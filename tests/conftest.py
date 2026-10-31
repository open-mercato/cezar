import subprocess
from pathlib import Path

import pytest
from stario.testing import TestClient

from app.main import bootstrap

TAB = {"datastar": '{"tab": "t1"}'}


def init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-b", "main"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    # Local only. The product autosave respects commit.gpgsign, matching
    # autosaveCommit in packages/cezar/src/git-worktree.ts.
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=path, check=True)
    (path / "README.md").write_text("hi\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=path,
        check=True,
        capture_output=True,
    )


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "repo"
    init_repo(root)
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_REPO", str(root))
    monkeypatch.setenv("CEZ_DRY_RUN", "1")
    monkeypatch.setenv("CEZ_DISPATCH", "1")
    # Hermetic: a developer's or CI's own forge token must not leak into the app config.
    for name in ("CEZ_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    return root


@pytest.fixture
async def client(repo: Path):
    async with TestClient(
        bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321"
    ) as running:
        yield running
