from pathlib import Path

import pytest
from stario.http.config import ServerConfig
from tests.conftest import init_repo

from app.cli import main, projects_command, run_task
from app.cli_commands import (
    run_automation_command,
    run_runs_command,
    run_secrets_command,
    run_task_command,
    run_telemetry_command,
    run_tracker_connections_command,
)
from app.config import apply_overrides


def test_init_does_not_overwrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    assert main(["init", "--repo", str(repo)]) == 0
    target = repo / ".ai" / "cezar" / "workflows" / "fix-and-verify.yaml"
    target.write_text("name: mine\nsteps:\n  - id: a\n    prompt: kept\n", encoding="utf-8")
    assert main(["init"]) == 0
    assert "kept" in target.read_text(encoding="utf-8")
    assert "left untouched" in capsys.readouterr().out
    assert "worktrees/" in (repo / ".ai" / "cezar" / ".gitignore").read_text(encoding="utf-8")


async def test_headless_run_treats_review_as_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    repo = tmp_path / "repo"
    init_repo(repo)
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_DRY_RUN", "1")
    code = await run_task("ship the note", workflow="quick-task", runner="", model="")
    assert code == 0
    out = capsys.readouterr().out
    assert "done" in out
    monkeypatch.setenv("CEZ_REVIEW_GATE", "1")
    gated = await run_task("park the note", workflow="quick-task", runner="", model="")
    assert gated == 0
    assert "review" in capsys.readouterr().out
    failed = await run_task("mock:fail this", workflow="quick-task", runner="claude", model="")
    assert failed == 1


async def test_projects_list_and_add(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    repo = tmp_path / "repo"
    init_repo(repo)
    extra = tmp_path / "extra"
    extra.mkdir()
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    apply_overrides(repo=str(repo))
    assert await projects_command("list", None) == 0
    listed = capsys.readouterr().out
    assert str(repo) in listed
    assert await projects_command("add", str(extra)) == 0
    added = capsys.readouterr().out
    assert "extra" in added
    project_id = added.split("\t", 1)[0].strip()
    assert await projects_command("remove", project_id) == 0
    assert "removed" in capsys.readouterr().out
    assert await projects_command("remove", project_id) == 1
    assert await projects_command("add", str(extra)) == 0
    capsys.readouterr()
    assert await projects_command("add", str(extra)) == 1
    monkeypatch.setenv("CEZ_SINGLE_PROJECT", "1")
    refused = await projects_command("remove", project_id)
    assert refused == 1
    assert "CEZ_SINGLE_PROJECT=1" in capsys.readouterr().err


def test_serve_is_the_default_command(monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, object] = {}

    async def fake(_bootstrap: object, config: ServerConfig | None = None) -> None:
        assert config is not None
        seen["host"] = config.host
        seen["port"] = config.port

    monkeypatch.setattr("app.cli.serve", fake)
    assert main([]) == 0
    assert seen["host"] == "127.0.0.1"
    assert seen["port"] == 4321
    assert main(["serve", "--host", "127.0.0.1", "--port", "9"]) == 0
    assert seen["port"] == 9


def test_task_runs_and_automation_commands_need_a_cockpit():
    assert run_task_command([], {}, print, print) == 2
    assert run_runs_command(["list"], {}, print, print) == 2
    assert run_automation_command(["schema"], {}, print, print) == 0

    calls: list[tuple[str, str, object]] = []

    def fetch(url: str, method: str = "GET", body: object = None) -> tuple[int, object]:
        calls.append((method, url, body))
        if url.endswith("/dispatch"):
            return 201, {"id": "child-1", "branch": "cez/child"}
        if url.endswith("/runs"):
            return 200, [{"id": "parent", "title": "Parent", "status": "running"}]
        if url.endswith("/automations"):
            return 201, {"id": "auto-1", "name": "nightly"}
        if url.endswith("/check"):
            return 200, {"id": "chk-1", "matches": 0, "launched": False}
        return 500, {"error": "nope"}

    env = {"CEZ_API_URL": "http://127.0.0.1:9", "CEZ_TASK_ID": "parent"}
    lines: list[str] = []
    assert (
        run_task_command(
            ["create", "review it", "--title", "Child"], env, lines.append, lines.append, fetch
        )
        == 0
    )
    assert "child-1" in lines[-1]
    assert calls[0][0] == "POST"
    posted = calls[0][2]
    assert isinstance(posted, dict)
    assert posted["objective"] == "review it"
    assert posted["title"] == "Child"
    listed: list[str] = []
    assert run_runs_command(["list", "--json"], env, listed.append, listed.append, fetch) == 0
    assert "parent" in listed[-1]
    created: list[str] = []
    assert (
        run_automation_command(
            ["create", "--json", '{"name":"nightly","task":"tidy"}'],
            env,
            created.append,
            created.append,
            fetch,
        )
        == 0
    )
    assert created[-1] == "auto-1"
    tracked: list[str] = []
    assert (
        run_automation_command(
            ["tracker", "--json", '{"name":"issues","task":"triage"}'],
            env,
            tracked.append,
            tracked.append,
            fetch,
        )
        == 0
    )
    posted_auto = calls[-1][2]
    assert isinstance(posted_auto, dict)
    assert posted_auto["kind"] == "tracker"
    checked: list[str] = []
    assert (
        run_automation_command(
            ["check", "auto-1"],
            env,
            checked.append,
            checked.append,
            fetch,
        )
        == 0
    )
    assert checked[-1] == "chk-1"
    schema: list[str] = []
    assert run_automation_command(["schema"], {}, schema.append, schema.append) == 0
    assert "runsLaunched" in schema[-1]
    assert "filters" in schema[-1]


def test_telemetry_command_does_not_enable_sending():
    lines: list[str] = []
    errors: list[str] = []
    assert run_telemetry_command(["status"], lines.append, errors.append) == 0
    assert "does not send" in lines[-1]
    assert run_telemetry_command(["enable"], lines.append, errors.append) == 1
    assert errors[-1]


async def test_secrets_cli_never_prints_the_value(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    lines: list[str] = []
    errors: list[str] = []
    code = await run_secrets_command(
        ["set", "API_TOKEN"],
        read_value=lambda: "super-secret-value",
        log=lines.append,
        error=errors.append,
    )
    assert code == 0
    assert lines == ["API_TOKEN"]
    assert "super-secret-value" not in "\n".join([*lines, *errors])
    assert (
        await run_secrets_command(
            ["list"], read_value=lambda: "", log=lines.append, error=errors.append
        )
        == 0
    )
    assert any(line.startswith("API_TOKEN\t") for line in lines)
    assert (
        await run_secrets_command(
            ["unset", "API_TOKEN"], read_value=lambda: "", log=lines.append, error=errors.append
        )
        == 0
    )


def _recorder(answers: dict[str, tuple[int, object]]):
    calls: list[tuple[str, str, object]] = []

    def fetch(url: str, method: str = "GET", body: object = None) -> tuple[int, object]:
        calls.append((method, url, body))
        for suffix, answer in answers.items():
            if f"{method} {url}".endswith(suffix):
                return answer
        return 500, {"error": "nope"}

    return calls, fetch


def test_task_create_maps_every_dispatch_flag():
    calls, fetch = _recorder({"POST http://c/api/v1/runs/p/dispatch": (201, {"id": "kid"})})
    env = {"CEZ_API_URL": "http://c", "CEZ_TASK_ID": "p"}
    out: list[str] = []
    code = run_task_command(
        ["create", "check it", "--kind", "review", "--review-of", "a1,b2", "--review-of", "c3",
         "--scope", "app/", "--budget", "1.5", "--success", "green", "--evidence", "log",
         "--tools", "Read,Grep", "--retry-limit", "2"],
        env, out.append, out.append, fetch,
    )  # fmt: skip
    assert code == 0
    assert calls[0][2] == {
        "objective": "check it", "kind": "review", "review_of": ["a1", "b2", "c3"],
        "scope": "app/", "max_cost": 1.5, "success_criteria": "green",
        "required_evidence": "log", "allowed_tools": ["Read", "Grep"], "retry_limit": 2,
    }  # fmt: skip
    errors: list[str] = []
    assert (
        run_task_command(
            ["create", "x", "--retry-limit", "9"], env, out.append, errors.append, fetch
        )
        == 1
    )
    assert "0 to 3" in errors[-1]
    assert (
        run_task_command(["create", "x", "--budget", "nope"], env, out.append, errors.append, fetch)
        == 1
    )


def test_automation_add_builds_the_body_for_each_kind(tmp_path: Path):
    calls, fetch = _recorder({"POST http://c/api/v1/automations": (201, {"id": "a1"})})
    env = {"CEZ_API_URL": "http://c"}
    out: list[str] = []

    def add(*argv: str) -> int:
        return run_automation_command(
            ["add", "--name", "n", "--prompt", "p", *argv], env, out.append, out.append, fetch
        )

    assert add("--every", "2h", "--enable") == 0
    assert calls[-1][2] == {
        "name": "n",
        "task": "p",
        "kind": "schedule",
        "everyMinutes": 120,
        "enable": True,
    }
    assert add("--cron", "0 */4 * * *") == 0
    assert isinstance(calls[-1][2], dict) and calls[-1][2]["everyMinutes"] == 240
    assert add("--on", "issue.opened,pull_request.opened", "--label", "bug", "--label", "ui") == 0
    assert calls[-1][2] == {
        "name": "n", "task": "p", "kind": "github", "everyMinutes": 5,
        "events": ["issue.opened", "pull_request.opened"], "filters": {"anyLabels": ["bug", "ui"]},
    }  # fmt: skip
    assert (
        add("--kind", "tracker", "--to-status", "Ready", "--require-label", "cez", "--every", "10m")
        == 0
    )
    assert calls[-1][2] == {
        "name": "n", "task": "p", "kind": "tracker", "everyMinutes": 10,
        "filters": {"status": "Ready", "allLabels": ["cez"]},
    }  # fmt: skip
    prompt = tmp_path / "p.md"
    prompt.write_text("from file", encoding="utf-8")
    assert (
        run_automation_command(
            ["add", "--name", "n", "--prompt-file", str(prompt), "--every", "5m"],
            env,
            out.append,
            out.append,
            fetch,
        )
        == 0
    )
    assert isinstance(calls[-1][2], dict) and calls[-1][2]["task"] == "from file"
    before = len(calls)
    errors: list[str] = []
    for bad in (
        ["--cron", "30 9 * * 1-5"],
        ["--dispatch"],
        ["--cron", "*/5 * * * *", "--on", "issue.opened"],
        [],
    ):
        code = run_automation_command(
            ["add", "--name", "n", "--prompt", "p", *bad], env, out.append, errors.append, fetch
        )
        assert code == 1
    assert len(calls) == before
    assert "interval" in errors[0]
    assert "no effect" in errors[1]


def test_automation_add_at_uses_the_deferred_start_routes():
    calls, fetch = _recorder(
        {
            "POST http://c/api/v1/deferred-start/preview": (
                200,
                {"available": True, "previewRevision": "rev", "notBefore": "x"},
            ),
            "POST http://c/api/v1/deferred-start": (
                201,
                {"scheduled": {"automationId": "once-1", "notBefore": "2099-01-01T09:30:00Z"}},
            ),
        }
    )  # fmt: skip
    out: list[str] = []
    code = run_automation_command(
        ["add", "--name", "n", "--prompt", "p", "--at", "2099-01-01 09:30"],
        {"CEZ_API_URL": "http://c"},
        out.append,
        out.append,
        fetch,
    )
    assert code == 0
    assert "once-1" in out[-1]
    assert calls[0][2] == {
        "task": {"task": "p"},
        "start": {"kind": "at", "date": "2099-01-01", "hour": 9, "minute": 30},
    }
    created = calls[1][2]
    assert (
        isinstance(created, dict)
        and created["previewRevision"] == "rev"
        and len(str(created["idempotencyKey"])) >= 8
    )


def test_automation_lifecycle_commands_call_the_existing_routes():
    current = {
        "id": "a1", "revision": 3, "name": "old", "task": "t", "everyMinutes": 60,
        "workflow": "quick-task", "runner": "claude", "kind": "schedule", "events": [],
        "filters": {}, "enabled": True,
    }  # fmt: skip
    calls, fetch = _recorder(
        {
            "GET http://c/api/v1/automations/a1": (200, current),
            "PUT http://c/api/v1/automations/a1": (200, {"revision": 4}),
            "POST http://c/api/v1/automations/a1/run": (201, {"runId": "r9"}),
            "POST http://c/api/v1/automations/a1/enable": (200, {}),
            "POST http://c/api/v1/automations/a1/pause": (200, {}),
            "DELETE http://c/api/v1/automations/a1": (200, {"deleted": True}),
        }
    )  # fmt: skip
    env = {"CEZ_API_URL": "http://c"}
    out: list[str] = []
    errors: list[str] = []
    assert (
        run_automation_command(
            ["update", "a1", "--json", '{"name":"new"}'], env, out.append, errors.append, fetch
        )
        == 0
    )
    put = calls[-1]
    assert put[0] == "PUT" and isinstance(put[2], dict)
    assert put[2]["name"] == "new" and put[2]["expectedRevision"] == 3 and put[2]["task"] == "t"
    assert run_automation_command(["show", "a1"], env, out.append, errors.append, fetch) == 0
    assert '"revision":3' in out[-1].replace(" ", "")
    assert run_automation_command(["run", "a1"], env, out.append, errors.append, fetch) == 0
    assert "r9" in out[-1]
    for verb in ("enable", "pause", "delete"):
        assert run_automation_command([verb, "a1"], env, out.append, errors.append, fetch) == 0
    assert [call[0] for call in calls[-3:]] == ["POST", "POST", "DELETE"]
    assert run_automation_command(["delete"], env, out.append, errors.append, fetch) == 1
    assert run_automation_command(["pause", "zz"], env, out.append, errors.append, fetch) == 1


def test_tracker_connections_list_and_remove(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    from app.config import Config

    folder = Config.from_env().data_dir / "tracker-connections"
    folder.mkdir(parents=True)
    ident = "a" * 64
    (folder / f"{ident}.env").write_text(
        "CONNECTION_ID=x\nPROJECT_ROOT=/work/app\nLINEAR_API_KEY=lin_secret\n", encoding="utf-8"
    )
    (folder / f"{'b' * 64}.env").write_text("junk\n", encoding="utf-8")
    out: list[str] = []
    errors: list[str] = []
    assert run_tracker_connections_command(["list"], out.append, errors.append) == 0
    assert out[0] == "ID\tROOT\tPROVIDER\tSTATUS"
    assert f'{ident}\t"/work/app"\tlinear\tvalid' in out
    assert f'{"b" * 64}\t"unknown"\tunknown\tinvalid' in out
    assert "lin_secret" not in "\n".join(out)
    assert run_tracker_connections_command(["remove", "../x"], out.append, errors.append) == 1
    assert run_tracker_connections_command(["remove", ident], out.append, errors.append) == 0
    assert not (folder / f"{ident}.env").exists()
    assert run_tracker_connections_command([], out.append, errors.append) == 1


async def test_projects_tag_and_rm_alias(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    repo = tmp_path / "repo"
    init_repo(repo)
    extra = tmp_path / "extra"
    init_repo(extra)
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    assert await projects_command("add", str(extra)) == 0
    added = capsys.readouterr().out.split("\t")[0]
    assert await projects_command("tag", added, ["web", "Web", " api "]) == 0
    assert capsys.readouterr().out.strip() == f"{added}\t[web api]"
    assert await projects_command("tag", added, []) == 0
    assert "(no tags)" in capsys.readouterr().out
    assert await projects_command("tag", "missing", ["x"]) == 1
    assert await projects_command("rm", added) == 0
    assert f"removed {added}" in capsys.readouterr().out
