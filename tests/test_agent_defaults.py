"""Settings keys that change agent behaviour, and the env vars that shape the agent's world.

`defaultModels`, `modelsLocked`, `plannerModel`, `namerModel`, `defaultSkill`, `askSkill`,
`composerDefaults`, `CEZ_CODEX_REASONING`, `CEZ_AGENT_TMPDIR`, `CEZ_SHARED_CACHE_DIR`.
"""

import asyncio
import dataclasses
import os
from pathlib import Path

import pytest
from litewriter import LiteWriter
from stario import Relay
from tests.conftest import init_repo
from tests.test_engine import SpecCapture, _start, config_for, world  # noqa: F401

from app.config import Config
from app.engine import agent_tmp, namer, planner
from app.engine.engine import Engine
from app.engine.model import Step
from app.engine.runners.protocol import ProtocolRunner, _codex_frames
from app.features.settings import store
from app.store.db import get_project, get_run, schema

# ---- settings store -------------------------------------------------------------------------


def test_agent_defaults_round_trip_and_default(tmp_path: Path):
    assert store.read_agent_defaults(tmp_path) == store.AgentDefaults({})
    parsed, issue = store.parse_agent_defaults(
        {
            "model_claude": " opus ",
            "model_codex": "",
            "auto_codex": True,
            "auto_cursor": True,
            "planner_model": "",
            "namer_model": "haiku-2",
            "locked": False,
        }
    )
    assert issue is None and parsed is not None
    assert parsed.models == {"claude": "opus"}
    assert parsed.auto == ("codex",)
    store.write_agent_defaults(tmp_path, parsed)
    again = store.read_agent_defaults(tmp_path)
    assert again == parsed
    assert again.planner_model == "sonnet" and again.namer_model == "haiku-2"
    assert again.model_for("claude") == "opus" and again.model_for("codex") == ""
    locked = dataclasses.replace(again, locked=True)
    assert locked.model_for("claude") == ""
    too_long, issue = store.parse_agent_defaults({"model_pi": "x" * 201})
    assert too_long is None and issue


def test_composer_defaults_and_skill_defaults(tmp_path: Path):
    assert store.read_composer_defaults(tmp_path) == store.ComposerDefaults()
    assert store.parse_tri("on") == (True, None)
    assert store.parse_tri("off") == (False, None)
    assert store.parse_tri("inherit") == (None, None)
    assert store.parse_tri("maybe")[1]
    store.write_composer_defaults(tmp_path, store.ComposerDefaults(True, False))
    assert store.read_composer_defaults(tmp_path) == store.ComposerDefaults(True, False)
    store.write_skill_defaults(tmp_path, "p1", "code-review", "explain")
    assert store.read_skill_defaults(tmp_path, "p1") == ("code-review", "explain")
    store.write_checks(tmp_path, "p1", ["lint"])
    assert store.read_checks(tmp_path, "p1") == ["lint"]
    store.write_skill_defaults(tmp_path, "p1", "", "")
    assert store.read_skill_defaults(tmp_path, "p1") == ("", "")


# ---- Config ---------------------------------------------------------------------------------


def test_config_reads_the_three_new_env_vars(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path))
    for name in ("CEZ_CODEX_REASONING", "CEZ_AGENT_MODELS_LOCKED", "CEZ_AGENT_TMPDIR"):
        monkeypatch.delenv(name, raising=False)
    config = Config.from_env()
    assert (config.codex_reasoning, config.agent_models_locked, config.agent_tmpdir) == (
        "auto",
        False,
        True,
    )
    monkeypatch.setenv("CEZ_CODEX_REASONING", " Concise ")
    monkeypatch.setenv("CEZ_AGENT_MODELS_LOCKED", "1")
    monkeypatch.setenv("CEZ_AGENT_TMPDIR", "0")
    config = Config.from_env()
    assert (config.codex_reasoning, config.agent_models_locked, config.agent_tmpdir) == (
        "concise",
        True,
        False,
    )
    monkeypatch.setenv("CEZ_CODEX_REASONING", "loud")
    monkeypatch.setenv("CEZ_AGENT_MODELS_LOCKED", "true")
    assert Config.from_env().codex_reasoning == "auto"
    assert Config.from_env().agent_models_locked is False


# ---- Codex reasoning ------------------------------------------------------------------------


def test_codex_turn_start_carries_the_reasoning_summary():
    for value in ("auto", "none", "detailed"):
        frames = _codex_frames(
            "hi", False, reasoning=value, thread_id="", resume=False, mcp_config={}
        )
        turn = next(frame for frame in frames if frame["method"] == "turn/start")
        assert turn["params"]["summary"] == value
    assert ProtocolRunner("codex", "codex", codex_reasoning="concise").codex_reasoning == "concise"


# ---- default models and the lock ------------------------------------------------------------


async def test_a_new_task_takes_the_runner_default_model(world):  # noqa: F811
    engine, _repo = world
    store.write_agent_defaults(
        engine.config.data_dir, store.AgentDefaults({"claude": "opus", "codex": "gpt-x"})
    )
    project = get_project(engine.db, engine.boot_project_id)
    assert project is not None
    claude, _ = engine.plan_run(
        project=project, task="a", workflow_name="quick-task", runner="claude"
    )
    codex, _ = engine.plan_run(
        project=project, task="b", workflow_name="quick-task", runner="codex"
    )
    cursor, _ = engine.plan_run(
        project=project, task="c", workflow_name="quick-task", runner="cursor"
    )
    picked, _ = engine.plan_run(
        project=project, task="d", workflow_name="quick-task", runner="claude", model="haiku"
    )
    assert claude and codex and cursor and picked
    assert (claude.model, codex.model, cursor.model, picked.model) == ("opus", "gpt-x", "", "haiku")


async def test_locked_models_ignore_presets_and_refuse_a_pick(world, monkeypatch):  # noqa: F811
    engine, _repo = world
    data = engine.config.data_dir
    store.write_agent_defaults(data, store.AgentDefaults({"claude": "opus"}, locked=True))
    project = get_project(engine.db, engine.boot_project_id)
    assert project is not None
    run, _ = engine.plan_run(
        project=project, task="a", workflow_name="quick-task", runner="claude", model="haiku"
    )
    assert run is not None and run.model == ""
    assert engine.model_lock_error("haiku") == store.MODELS_LOCKED_ERROR
    assert engine.model_lock_error("") is None
    # The env var locks it too, and the page's own flag is not needed.
    store.write_agent_defaults(data, store.AgentDefaults({"claude": "opus"}))
    assert engine.model_lock_error("haiku") is None
    engine.config = dataclasses.replace(engine.config, agent_models_locked=True)
    assert engine.model_lock_error("haiku") == store.MODELS_LOCKED_ERROR


async def test_the_agents_page_saves_defaults_and_the_composer_and_api_follow(client, repo: Path):
    page = await client.get("/settings/agents")
    assert page.status_code == 200 and "Planner model" in page.text
    saved = await client.post(
        "/settings/agents",
        json={
            "tab": "t1",
            "model_claude": "opus",
            "planner_model": "sonnet-x",
            "namer_model": "haiku-x",
            "locked": False,
        },
        follow_redirects=False,
    )
    assert saved.status_code == 303
    assert "claude=opus" in (await client.get("/settings/agents")).text
    bad = await client.post("/settings/agents", json={"tab": "t1", "model_pi": "x" * 300})
    assert bad.status_code == 400
    new = await client.get("/tasks/new")
    assert 'value="opus"' in new.text or "opus" in new.text
    created = await client.post(
        "/api/v1/runs", json={"task": "write a note", "workflow": "quick-task"}
    )
    assert created.status_code in (200, 201)
    assert created.json()["model"] == "opus"
    await client.post(
        "/settings/agents",
        json={"tab": "t1", "model_claude": "opus", "locked": True},
        follow_redirects=False,
    )
    refused = await client.post(
        "/api/v1/runs", json={"task": "again", "workflow": "quick-task", "model": "haiku"}
    )
    assert refused.status_code == 409
    assert "locked" in refused.json()["error"]
    form = await client.post(
        "/tasks?project=repo",
        json={"tab": "t1", "task": "x", "workflow": "quick-task", "runner": "claude", "model": "m"},
    )
    assert form.status_code == 409


# ---- planner and namer models ---------------------------------------------------------------


def test_the_planner_passes_its_model_to_the_runner(tmp_path: Path):
    seen: list[list[str]] = []

    def spawn(args: list[str], prompt: str) -> tuple[int, str]:
        seen.append(args)
        return 1, ""

    planner.plan_chain(
        tmp_path, "do it", binary="claude", dry_run=False, model="sonnet", spawn=spawn
    )
    planner.plan_chain(tmp_path, "do it", binary="codex", dry_run=False, spawn=spawn)
    assert seen == [["claude", "--model", "sonnet"], ["codex"]]


async def test_the_namer_asks_with_the_namer_model(world, monkeypatch):  # noqa: F811
    engine, repo = world
    asked: list[str] = []

    async def fake(binary: str, cwd: Path, prompt: str, naming: str, model: str) -> str:
        asked.append(model)
        return '{"title": "adding a thing"}'

    monkeypatch.setattr(namer, "_ask_claude", fake)
    title = await namer.propose_title(
        "add a thing", "done", dry_run=False, cwd=repo, binary="claude", model="haiku-9"
    )
    assert title == "adding a thing" and asked == ["haiku-9"]
    store.write_agent_defaults(
        engine.config.data_dir, store.AgentDefaults({}, namer_model="haiku-engine")
    )
    assert engine._namer_model() == "haiku-engine"


# ---- composer defaults, default skill, ask skill --------------------------------------------


async def test_composer_defaults_set_autonomy_and_worktree(world):  # noqa: F811
    engine, _repo = world
    project = get_project(engine.db, engine.boot_project_id)
    assert project is not None
    plain, _ = engine.plan_run(
        project=project, task="a", workflow_name="quick-task", runner="claude"
    )
    assert plain is not None and (plain.autonomous, plain.in_place) == (False, False)
    store.write_composer_defaults(engine.config.data_dir, store.ComposerDefaults(True, False))
    tuned, _ = engine.plan_run(
        project=project, task="b", workflow_name="quick-task", runner="claude"
    )
    assert tuned is not None and (tuned.autonomous, tuned.in_place) == (True, True)
    explicit, _ = engine.plan_run(
        project=project,
        task="c",
        workflow_name="quick-task",
        runner="claude",
        autonomous=False,
        in_place=False,
    )
    assert explicit is not None and (explicit.autonomous, explicit.in_place) == (False, False)


async def test_the_tasks_page_saves_composer_and_skill_defaults(client, repo: Path):
    skills = repo / ".claude" / "skills"
    skills.mkdir(parents=True)
    (skills / "explain.md").write_text("---\nname: explain\ndescription: explain\n---\nExplain.\n")
    (skills / "ship.md").write_text("---\nname: ship\ndescription: ship it\n---\nShip.\n")
    saved = await client.post(
        "/settings/tasks",
        json={
            "tab": "t1",
            "branch": "main",
            "checks": "",
            "default_skill": "ship",
            "ask_skill": "explain",
            "composer_autonomous": "on",
            "composer_worktree": "off",
        },
        follow_redirects=False,
    )
    assert saved.status_code == 303
    data = Path(os.environ["PROJECT_DATA_DIR"])
    assert store.read_composer_defaults(data) == store.ComposerDefaults(True, False)
    bad = await client.post(
        "/settings/tasks",
        json={"tab": "t1", "branch": "main", "checks": "", "composer_autonomous": "sometimes"},
    )
    assert bad.status_code == 400
    page = await client.get("/tasks/new")
    assert "Default (ship)" in page.text
    assert '"autonomous":true' in page.text.replace(" ", "")
    assert '"worktree":false' in page.text.replace(" ", "")

    async def start(task: str, **extra: object) -> dict:
        response = await client.post(
            "/tasks?project=repo",
            json={"tab": "t1", "task": task, "workflow": "quick-task", "runner": "claude"} | extra,
        )
        assert response.status_code == 200, response.text
        runs = (await client.get("/api/v1/runs")).json()
        return max(runs, key=lambda run: run["createdAt"])

    assert (await start("tidy the header"))["workflow"] == "ship"
    # TypeScript has no question heuristic: `askSkill` is stored, never picked from the text.
    assert (await start("why is the header red?"))["workflow"] == "ship"
    assert (await start("tidy again", skill="none"))["workflow"] == "quick-task"
    assert (await start("tidy again", skill="explain"))["workflow"] == "explain"
    missing = await client.post(
        "/tasks?project=repo",
        json={
            "tab": "t1",
            "task": "x",
            "workflow": "quick-task",
            "runner": "claude",
            "skill": "nope",
        },
    )
    assert missing.status_code == 400


# ---- the agent temp directory and the shared cache ------------------------------------------


def test_agent_tmp_env_makes_probes_and_reaps(tmp_path: Path):
    env = agent_tmp.agent_tmp_env(tmp_path, "run-1", enabled=True)
    path = tmp_path / "tmp" / "run-1"
    assert env == {"TMPDIR": str(path), "TEMP": str(path), "TMP": str(path)}
    assert path.is_dir() and not list(path.iterdir())
    assert agent_tmp.agent_tmp_env(tmp_path, "run-2", enabled=False) == {}
    assert not (tmp_path / "tmp" / "run-2").exists()
    (tmp_path / "tmp" / "stale").mkdir()
    (tmp_path / "keep").mkdir()
    assert agent_tmp.sweep_agent_tmp_dirs(tmp_path, ["run-1"]) == ["stale"]
    assert path.is_dir() and (tmp_path / "keep").is_dir()
    agent_tmp.remove_agent_tmp_dir(tmp_path, "run-1")
    assert not path.exists()
    for bad in ("..", ".", "a/b", ""):
        assert not agent_tmp.safe_run_id(bad)
    agent_tmp.remove_agent_tmp_dir(tmp_path, "..")
    assert (tmp_path / "keep").is_dir()


def test_an_unwritable_temp_directory_names_the_escape_hatch(tmp_path: Path):
    (tmp_path / "tmp").write_text("a file where the directory should be")
    with pytest.raises(agent_tmp.AgentTempDirError) as caught:
        agent_tmp.agent_tmp_env(tmp_path, "run-1", enabled=True)
    assert "CEZ_AGENT_TMPDIR=0" in str(caught.value)
    assert agent_tmp.agent_tmp_env(tmp_path, "run-1", enabled=False) == {}


async def test_an_agent_step_gets_its_own_tmpdir_that_goes_with_the_run(world):  # noqa: F811
    engine, _repo = world
    run = await _start(engine, "use the temp dir")
    capture = SpecCapture()
    seen: list[bool] = []
    original = capture.stream

    async def watching(spec):
        env = dict(spec.env)
        seen.append(Path(env["TMPDIR"]).is_dir())
        async for event in original(spec):
            yield event

    capture.stream = watching  # type: ignore[method-assign]
    engine.agent = capture
    await engine.execute(run.id)
    spec = capture.specs[0]
    expected = engine.config.data_dir / "tmp" / run.id
    assert dict(spec.env)["TMPDIR"] == str(expected)
    assert dict(spec.env)["TEMP"] == dict(spec.env)["TMP"] == str(expected)
    assert seen == [True]
    assert (get_run(engine.db, run.id) or run).status == "done"
    assert not expected.exists()


async def test_the_tmpdir_opt_out_and_the_failing_probe(world):  # noqa: F811
    engine, _repo = world
    engine.config = dataclasses.replace(engine.config, agent_tmpdir=False)
    run = await _start(engine, "host tmp")
    capture = SpecCapture()
    engine.agent = capture
    await engine.execute(run.id)
    assert "TMPDIR" not in dict(capture.specs[0].env)

    engine.config = dataclasses.replace(engine.config, agent_tmpdir=True)
    (engine.config.data_dir / "tmp").write_text("blocked")
    blocked = await _start(engine, "blocked tmp")
    capture = SpecCapture()
    engine.agent = capture
    await engine.execute(blocked.id)
    stored = get_run(engine.db, blocked.id)
    assert stored is not None and stored.status == "failed"
    assert "agent temp directory is not writable" in stored.error
    assert capture.specs == []


async def test_startup_sweeps_the_temp_directories_of_runs_that_are_gone(world):  # noqa: F811
    engine, _repo = world
    live = await _start(engine, "still queued")
    root = engine.config.data_dir / "tmp"
    (root / live.id).mkdir(parents=True)
    (root / "crashed").mkdir()
    await engine.recover()
    assert (root / live.id).is_dir() and not (root / "crashed").exists()


async def test_a_check_step_sees_the_projects_shared_cache_dir(world):  # noqa: F811
    engine, repo = world
    run = await _start(engine, "check")
    stored = get_run(engine.db, run.id) or run
    stored.worktree_path = str(repo)
    step = Step(id="probe", name="probe", command='printf %s "$CEZ_SHARED_CACHE_DIR"')
    code, output = await engine._run_check(stored, step, asyncio.Event())
    expected = engine.config.data_dir / "cache" / engine.boot_project_id
    assert code == 0 and output.strip() == str(expected)
    assert expected.is_dir() and oct(expected.stat().st_mode & 0o777) == "0o700"
    assert agent_tmp.shared_cache_dir(engine.config.data_dir, "../escape") is None


# ---- ProtocolRunner is built with the reasoning setting --------------------------------------


async def test_the_engine_hands_codex_the_configured_reasoning(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo, dry_run=False, codex_reasoning="detailed")
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        runner = engine._agent_for("codex")
        assert isinstance(runner, ProtocolRunner) and runner.codex_reasoning == "detailed"
