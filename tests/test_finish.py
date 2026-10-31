from pathlib import Path

from app.engine.deferred import DeferredBuffer
from app.engine.fs_browse import browse
from app.engine.model import Run
from app.engine.retention import select_index_prune, select_reclaimable
from app.engine.terminal_hub import TerminalHub
from app.features.places.urls import INBOX, SETTINGS_PRIVACY


def _run(status: str, when: str, **kwargs: object) -> Run:
    return Run(
        id=str(kwargs.pop("id", "a" * 32)),
        project_id="p",
        title="t",
        task="task",
        workflow="quick-task",
        status=status,
        runner="claude",
        created_at=when,
        workflow_def={},
        finished_at=when if status in ("done", "failed", "cancelled") else "",
        worktree_path=str(kwargs.pop("worktree_path", "/tmp/wt")),
        **kwargs,  # type: ignore[arg-type]
    )


def test_worktree_retention_keeps_the_newest_finished_directories():
    older = _run("done", "2026-01-01T00:00:00Z", id="a" * 32)
    newer = _run("done", "2026-02-01T00:00:00Z", id="b" * 32)
    review = _run("review", "2026-03-01T00:00:00Z", id="c" * 32)
    assert select_reclaimable([older, newer, review], 1) == [older.id]
    assert select_reclaimable([older, newer], 0) == []
    assert select_reclaimable([older, newer], 5) == []


def test_archived_runs_use_their_own_cap():
    older = _run("done", "2026-01-01T00:00:00Z", id="a" * 32, archived=True)
    newer = _run("done", "2026-02-01T00:00:00Z", id="b" * 32, archived=True)
    live = _run("running", "2026-03-01T00:00:00Z", id="c" * 32, worktree_path="")
    pruned = select_index_prune([newer, older, live], keep=1, archived_keep=1)
    assert pruned == [older.id]


def test_the_run_index_keeps_live_rows_past_the_cap():
    rows = [
        _run("done", f"2026-01-{index:02d}T00:00:00Z", id=f"{index:032x}") for index in range(1, 4)
    ]
    live = _run("running", "2026-02-01T00:00:00Z", id="d" * 32, worktree_path="")
    # Newest first, matching list_runs.
    ordered = [live, *reversed(rows)]
    pruned = select_index_prune(ordered, keep=2)
    assert live.id not in pruned
    assert rows[0].id in pruned


def test_browse_stays_inside_the_root_and_hides_escaping_links(tmp_path: Path):
    root = tmp_path / "root"
    (root / "proj").mkdir(parents=True)
    (root / "proj" / ".git").mkdir()
    (root / "note.txt").write_text("x", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "escape").symlink_to(outside)
    listed = browse(root)
    assert listed["ok"] is True
    names = [item["name"] for item in listed["dirs"]]  # type: ignore[index]
    assert names == ["proj"]
    assert listed["dirs"][0]["isRepo"] is True  # type: ignore[index]
    escaped = browse(root, str(root / "escape"))
    assert escaped["ok"] is False
    assert escaped["error"] == "path is outside the browsable root"
    assert browse(root, "../outside")["ok"] is False
    assert browse(root, str(root / "note.txt"))["status"] == 404


def test_a_restart_only_remembers_that_a_deferred_message_was_lost(tmp_path: Path):
    run_id = "a" * 32
    folder = tmp_path / "runs"
    folder.mkdir()
    (folder / f"{run_id}.deferred").write_text("2", encoding="utf-8")
    notes = DeferredBuffer(folder).lost_on_startup()
    assert notes[0][0] == run_id
    assert "restarted" in notes[0][1]
    assert "2 messages" in notes[0][1]
    assert not (folder / f"{run_id}.deferred").exists()


async def test_a_pty_reports_the_size_it_was_given(tmp_path: Path):
    hub = TerminalHub()
    session_id = await hub.open(tmp_path)
    try:
        assert hub.resize(session_id, 30, 100)
        probe = (
            "python3 -c 'import fcntl,struct,termios; "
            'print(struct.unpack("HHHH", fcntl.ioctl(1, termios.TIOCGWINSZ, bytes(8)))[:2])'
            "'\n"
        )
        assert await hub.write(session_id, probe)
        text = ""
        for _ in range(40):
            text = hub.output(session_id) or ""
            if "30, 100" in text or "(30, 100)" in text:
                break
            import asyncio

            await asyncio.sleep(0.05)
        assert "30" in text and "100" in text
    finally:
        await hub.close(session_id)


async def test_a_staged_upload_is_written_into_the_worktree(client):
    import asyncio

    uploaded = await client.post(
        "/api/v1/workspace/uploads",
        json={"mediaType": "text/plain", "data": "aGVsbG8=", "name": "note.txt"},
    )
    assert uploaded.status_code == 201
    created = await client.post(
        "/api/v1/runs",
        json={
            "task": "attach this",
            "workflow": "quick-task",
            "images": [{"uploadId": uploaded.json()["uploadId"], "name": "note.txt"}],
        },
    )
    assert created.status_code == 201
    run_id = created.json()["id"]
    status = "queued"
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status in ("review", "failed", "done"):
            break
        await asyncio.sleep(0.05)
    assert status == "done"
    page = await client.get(f"/tasks/{run_id}?pane=files")
    assert "note.txt" in page.text


async def test_the_ported_screens_render(client):
    for path, needle in (
        (INBOX.href(), "Inbox"),
        ("/github", "GitHub"),
        ("/tracker", "Tracker"),
        ("/git", "Repository"),
        ("/workflows/quick-task", "quick-task"),
        (SETTINGS_PRIVACY.href(), "intentionally not ported"),
        ("/settings/agents", "claude"),
        ("/settings/webhooks", "Webhooks"),
        ("/settings/worktrees", "worktree"),
        ("/secrets", "Secrets"),
    ):
        page = await client.get(path)
        assert page.status_code == 200, path
        assert needle in page.text
    missing = await client.get("/does-not-exist")
    assert missing.status_code == 404
    assert "Inbox" in (await client.get("/tasks")).text


def test_browse_root_env_is_documented():
    example = Path(".env.example").read_text(encoding="utf-8")
    assert "CEZ_BROWSE_ROOT" in example
    assert "CEZ_WORKTREE_RETENTION" in example
