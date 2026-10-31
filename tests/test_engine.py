import asyncio
import dataclasses
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from litewriter import LiteWriter
from stario import App, Relay
from tests.conftest import init_repo

from app.clock import now, stamp
from app.config import RUNNERS, Config
from app.engine.agents import AgentEvent, AgentSpec, DryRunAgent, usage_from_line
from app.engine.engine import Engine, rebaseline_automations
from app.engine.gitignore_data import DATA_GITIGNORE_ENTRIES, ensure_data_gitignore
from app.engine.gitwork import diff_against, is_safe_git_ref, log_count, prune_orphans
from app.engine.model import Automation, Run, Settings, Step, Workflow
from app.store.db import get_run, insert_run, list_runs, save_run, schema


def config_for(tmp_path: Path, repo: Path, **overrides: object) -> Config:
    data = tmp_path / "state"
    data.mkdir(exist_ok=True)
    values: dict[str, object] = {
        "app_name": "cezar",
        "version": "test",
        "data_dir": data,
        "db_path": data / "app.sqlite3",
        "repo_root": repo,
        "dry_run": True,
        "dispatch_enabled": True,
        "tick_seconds": 0.05,
        "check_timeout_seconds": 30,
        "runner_bins": {runner: runner for runner in RUNNERS},
        "listen_host": "127.0.0.1",
        "listen_port": 4321,
    }
    values.update(overrides)
    return Config(**values)  # type: ignore[arg-type]


class RecordingAgent:
    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.systems: list[str] = []
        self.calls = 0

    async def stream(self, spec: AgentSpec):
        self.prompts.append(spec.user_prompt)
        self.systems.append(spec.system_prompt)
        self.calls += 1
        if "mock:fail" in spec.user_prompt:
            yield AgentEvent("error", "boom")
            return
        if self.calls >= 2:
            Path(spec.cwd, "done.txt").write_text("ok\n", encoding="utf-8")
        yield AgentEvent("text", "CEZ:DONE")
        yield AgentEvent("turn-end")


class GateAgent:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.count = 0

    async def stream(self, spec: AgentSpec):
        self.count += 1
        self.started.set()
        await self.release.wait()
        yield AgentEvent("turn-end")


@pytest.fixture
async def world(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        yield engine, repo


async def _start(engine: Engine, task: str = "do the thing") -> Run:
    from app.store.db import get_project

    project = get_project(engine.db, engine.boot_project_id)
    assert project is not None
    run, reason = engine.plan_run(
        project=project, task=task, workflow_name="quick-task", runner="claude"
    )
    assert run is not None, reason
    await engine.enqueue(run)
    return run


async def test_mock_write_creates_the_named_file(world):
    engine, _repo = world
    run = await _start(engine, "mock:write notes/out.txt")
    await engine.execute(run.id)
    stored = get_run(engine.db, run.id)
    assert stored is not None and stored.status == "done"
    written = Path(stored.worktree_path) / "notes" / "out.txt"
    assert written.is_file()
    assert "mock:write notes/out.txt" in written.read_text(encoding="utf-8")
    direct = Path(stored.worktree_path) / "plain.txt"
    spec = AgentSpec(
        user_prompt="mock:write plain.txt",
        system_prompt="",
        cwd=stored.worktree_path,
        runner="claude",
        model="",
        cancel=asyncio.Event(),
    )
    async for _event in DryRunAgent().stream(spec):
        pass
    assert direct.is_file()


async def test_a_graph_check_reviews_on_pass_and_fails_on_an_unwired_failure(world):
    from app.engine.workflows import parse_workflow

    engine, _repo = world
    project = __import__("app.store.db", fromlist=["get_project"]).get_project(
        engine.db, engine.boot_project_id
    )
    assert project is not None

    def run_graph(command: str):
        workflow, issue = parse_workflow(
            {
                "name": "g",
                "version": 2,
                "nodes": [
                    {"id": "start", "type": "start"},
                    {"id": "tests", "type": "check", "command": command},
                    {"id": "ok", "type": "end", "status": "success"},
                ],
                "edges": [
                    {"from": "start", "to": "tests"},
                    {"from": "tests.pass", "to": "ok"},
                ],
            },
            source="file",
        )
        assert workflow is not None, issue
        return workflow

    passed, reason = engine.plan_run(
        project=project,
        task="graph",
        workflow_name="g",
        runner="claude",
        workflow=run_graph("true"),
    )
    assert passed is not None, reason
    await engine.enqueue(passed)
    await engine.execute(passed.id)
    assert (get_run(engine.db, passed.id) or passed).status == "done"

    failed, reason = engine.plan_run(
        project=project,
        task="graph",
        workflow_name="g",
        runner="claude",
        workflow=run_graph("false"),
    )
    assert failed is not None, reason
    await engine.enqueue(failed)
    await engine.execute(failed.id)
    done = get_run(engine.db, failed.id)
    assert done is not None and done.status == "failed"


async def test_queued_messages_are_folded_into_the_prompt_and_not_written_back(world):
    engine, repo = world
    run = await _start(engine, "original task")
    message, reason = await engine.queue_message(run.id, "also this")
    assert reason is None and message is not None
    await engine.execute(run.id)
    stored = get_run(engine.db, run.id)
    assert stored is not None
    assert stored.task == "original task"
    assert stored.queued_messages[0]["text"] == "also this"
    written = (repo / ".ai" / "cezar" / "worktrees" / run.id / "CEZAR_DRY_RUN.txt").read_text(
        encoding="utf-8"
    )
    assert "original task" in written
    assert "also this" in written


def test_dry_run_is_opt_in_like_the_typescript_app(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("CEZ_DRY_RUN", raising=False)
    assert Config.from_env().dry_run is False
    monkeypatch.setenv("CEZ_DRY_RUN", "1")
    assert Config.from_env().dry_run is True


def test_option_like_refs_are_refused():
    assert is_safe_git_ref("main")
    assert not is_safe_git_ref("--upload-pack=touch")
    assert not is_safe_git_ref("")


def test_usage_frame_is_read_and_other_lines_are_not():
    assert usage_from_line('{"type":"result","usage":{"input_tokens":3,"output_tokens":4}}') == (
        3,
        4,
    )
    assert usage_from_line("hello") is None


async def test_a_stale_schedule_does_not_launch_a_backlog(world):
    engine, _repo = world
    stale = Automation(
        id="ab" * 16,
        project_id=engine.boot_project_id,
        name="nightly",
        task="check deps",
        workflow="quick-task",
        runner="claude",
        every_minutes=60,
        enabled=True,
        next_at=(now() - timedelta(days=2)).isoformat(),
        created_at=stamp(),
    )
    await engine.create_automation(stale)
    await engine.db.write(rebaseline_automations)
    await engine._launch_due()
    assert list_runs(engine.db, None, None) == []
    assert await engine.set_automation_enabled(stale.id, True) is None
    assert list_runs(engine.db, None, None) == []
    fresh = Automation(
        id="cd" * 16,
        project_id=engine.boot_project_id,
        name="soon",
        task="check deps soon",
        workflow="quick-task",
        runner="claude",
        every_minutes=60,
        enabled=True,
        next_at=(now() - timedelta(minutes=1)).isoformat(),
        created_at=stamp(),
    )
    await engine.create_automation(fresh)
    await engine._launch_due()
    launched = [run for run in list_runs(engine.db, None, None) if run.task == "check deps soon"]
    assert len(launched) == 1


class SpecCapture:
    def __init__(self) -> None:
        self.specs: list[AgentSpec] = []

    async def stream(self, spec: AgentSpec):
        self.specs.append(spec)
        yield AgentEvent("text", "CEZ:DONE")
        yield AgentEvent("turn-end")


async def _live(engine: Engine, repo: Path, *, session: str, **fields: object) -> Run:
    run = Run(
        id=uuid.uuid4().hex,
        project_id=engine.boot_project_id,
        title="live",
        task="live",
        workflow="quick-task",
        status="running",
        runner="claude",
        created_at=stamp(),
        worktree_path=str(repo),
        session_runner=session,
        **({"workflow_def": {}} | fields),  # type: ignore[arg-type]
    )
    await engine.db.write(insert_run, run)
    return run


async def test_a_restart_requeues_queued_work_and_the_scheduler_runs_it(world):
    engine, _repo = world
    queued = await _start(engine, "queued work")
    await engine.recover()
    assert (get_run(engine.db, queued.id) or queued).status == "queued"
    await engine.tick()
    await asyncio.gather(*list(engine._tasks.values()))
    assert (get_run(engine.db, queued.id) or queued).status == "done"


async def test_a_restart_resumes_a_running_agent_with_its_session_and_handoff(world):
    engine, repo = world
    run = await _live(engine, repo, session="claude")
    await engine.recover()
    stored = get_run(engine.db, run.id) or run
    assert stored.status == "queued"
    assert stored.error == ""
    capture = SpecCapture()
    engine.agent = capture
    await engine.execute(run.id)
    assert capture.specs[0].resume is True
    assert capture.specs[0].session_id == run.id
    assert capture.specs[0].handoff_file.endswith(f"{run.id}.handoff.md")
    assert "CEZ_HANDOFF_FILE" in capture.specs[0].user_prompt
    assert "restarted" in capture.specs[0].user_prompt
    assert (get_run(engine.db, run.id) or run).status == "done"


async def test_a_restart_requeues_a_running_workflow_that_never_opened_a_session(world):
    engine, repo = world
    run = await _live(engine, repo, session="", step_index=0, started_at=stamp())
    await engine.recover()
    stored = get_run(engine.db, run.id) or run
    assert stored.status == "queued"
    assert stored.error == "" and stored.mode == "workflow"
    assert stored.started_at == run.started_at
    # It starts over as a whole run: the scheduler picks it up and it finishes.
    await engine.tick()
    await asyncio.gather(*list(engine._tasks.values()))
    assert (get_run(engine.db, run.id) or run).status == "done"


async def test_a_restart_fails_a_graph_run_that_never_opened_a_session(world):
    engine, repo = world
    graph = {"nodes": [], "edges": []}
    run = await _live(engine, repo, session="", workflow_def={"name": "g", "graph": graph})
    await engine.recover()
    stored = get_run(engine.db, run.id) or run
    assert stored.status == "failed" and stored.error == "interrupted by restart"


async def test_a_restart_fails_a_running_agent_whose_runner_cannot_resume(world):
    engine, repo = world
    engine.config = dataclasses.replace(engine.config, dry_run=False)
    cursor = await _live(engine, repo, session="cursor")
    codex_without_thread = await _live(engine, repo, session="codex")
    codex_with_thread = await _live(engine, repo, session="codex", codex_thread="t-1")
    await engine.recover()
    assert (get_run(engine.db, cursor.id) or cursor).error == "interrupted by restart"
    assert (get_run(engine.db, codex_without_thread.id) or cursor).status == "failed"
    assert (get_run(engine.db, codex_with_thread.id) or cursor).status == "queued"


async def test_a_restart_fails_a_graph_parent_that_was_awaiting_children(world):
    engine, repo = world
    graph = {"nodes": [], "edges": []}
    parent = await _live(engine, repo, session="claude", workflow_def={"name": "g", "graph": graph})
    child = await _live(engine, repo, session="", parent_id=parent.id)
    child.status = "queued"
    await engine.db.write(save_run, child)
    await engine.recover()
    stored = get_run(engine.db, parent.id) or parent
    assert stored.status == "failed" and stored.error == "interrupted by restart"
    assert (get_run(engine.db, child.id) or child).status == "queued"


async def test_a_restart_keeps_a_waiting_run_waiting(world):
    engine, repo = world
    asking = await _live(engine, repo, session="claude")
    asking.status = "waiting"
    asking.ask = "which one?"
    parked = await _live(engine, repo, session="")
    parked.status = "waiting"
    parked.graph_park = {"node": "gate", "kind": "gate.human"}
    await engine.db.write(save_run, asking)
    await engine.db.write(save_run, parked)
    await engine.recover()
    kept = get_run(engine.db, asking.id) or asking
    assert kept.status == "waiting" and kept.ask == "which one?"
    held = get_run(engine.db, parked.id) or parked
    assert held.status == "waiting" and held.graph_park["node"] == "gate"


async def test_success_is_done_until_the_review_gate_is_on(world, monkeypatch):
    engine, repo = world
    run = await _start(engine, "write the note")
    await engine.execute(run.id)
    done = get_run(engine.db, run.id)
    assert done is not None
    assert done.status == "done"
    assert done.branch == f"cez/{run.id[:8]}"
    assert log_count(repo) == 1
    diff = diff_against(Path(done.worktree_path), done.base_sha)
    assert "CEZAR_DRY_RUN.txt" in diff.text
    assert "CEZAR_DRY_RUN" not in (repo / "README.md").read_text(encoding="utf-8")
    assert await engine.finish(run.id) == "no open session"

    monkeypatch.setenv("CEZ_REVIEW_GATE", "true")
    ignored = await _start(engine, "true is not the switch")
    await engine.execute(ignored.id)
    assert (get_run(engine.db, ignored.id) or ignored).status == "done"

    monkeypatch.setenv("CEZ_REVIEW_GATE", "1")
    gated = await _start(engine, "park this diff")
    await engine.execute(gated.id)
    parked = get_run(engine.db, gated.id)
    assert parked is not None and parked.status == "review"
    assert await engine.finish(gated.id) is None
    assert (get_run(engine.db, gated.id) or parked).status == "done"
    assert log_count(repo) == 1

    project = __import__("app.store.db", fromlist=["get_project"]).get_project(
        engine.db, engine.boot_project_id
    )
    assert project is not None
    auto, reason = engine.plan_run(
        project=project,
        task="skip the gate",
        workflow_name="quick-task",
        runner="claude",
        autonomous=True,
    )
    assert auto is not None, reason
    await engine.enqueue(auto)
    await engine.execute(auto.id)
    assert (get_run(engine.db, auto.id) or auto).status == "done"
    (repo / ".ai" / "cezar" / "config.json").write_text('{"reviewGate": false}\n', encoding="utf-8")
    forced = await _start(engine, "the file wins")
    await engine.execute(forced.id)
    assert (get_run(engine.db, forced.id) or forced).status == "done"


async def test_instructions_are_applied_to_the_prompt_and_the_branch(world, monkeypatch):
    engine, repo = world
    folder = repo / ".ai" / "cezar"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "instructions.json").write_text(
        '{"systemPrompt": "be brief", "branchNaming": "start with feature/"}\n',
        encoding="utf-8",
    )
    run = await _start(engine, "Fix the login")
    await engine.execute(run.id)
    stored = get_run(engine.db, run.id)
    assert stored is not None
    assert stored.branch.startswith("cez/")
    written = (Path(stored.worktree_path) / "CEZAR_DRY_RUN.txt").read_text(encoding="utf-8")
    assert written.startswith("be brief\n\n---\n")
    monkeypatch.setenv("CEZ_AUTONAME", "1")
    named = await _start(engine, "Fix the login")
    await engine.execute(named.id)
    stored = get_run(engine.db, named.id)
    assert stored is not None
    assert stored.branch == "feature/implementing-cr-fixes"
    assert stored.title == "implementing cr fixes"
    monkeypatch.setenv("CEZ_AUTONAME", "0")
    quiet = await _start(engine, "Fix the login again")
    await engine.execute(quiet.id)
    assert (get_run(engine.db, quiet.id) or quiet).branch.startswith("cez/")


async def test_a_finished_task_is_written_to_the_webhook_outbox(world, monkeypatch):
    from app.integrations.hooks import save_receiver

    engine, _repo = world
    quiet = await _start(engine, "no listeners")
    await engine.execute(quiet.id)
    assert not (engine.config.data_dir / "webhook-outbox").exists()
    save_receiver(engine.config.data_dir, "Ops", "https://example.com/hook")
    monkeypatch.setenv("CEZ_WEBHOOKS", "1")
    run = await _start(engine, "tell the channel")
    await engine.execute(run.id)
    body = (engine.config.data_dir / "webhook-outbox" / "outbox.ndjson").read_text(encoding="utf-8")
    assert "Task finished" in body
    assert '"status": "delivered"' in body


async def test_a_bad_base_does_not_run_in_the_main_tree(world):
    engine, repo = world
    from dataclasses import replace

    from app.store.db import get_project, save_project

    project = get_project(engine.db, engine.boot_project_id)
    assert project is not None
    await engine.db.write(save_project, replace(project, base_branch="no-such-branch"))
    run = await _start(engine, "should fail")
    await engine.execute(run.id)
    failed = get_run(engine.db, run.id)
    assert failed is not None and failed.status == "failed"
    assert not (repo / "CEZAR_DRY_RUN.txt").exists()


async def test_a_directory_that_is_not_a_git_repo_runs_in_place(tmp_path: Path):
    repo = tmp_path / "plain"
    repo.mkdir()
    cfg = config_for(tmp_path, repo)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        run = await _start(engine, "notes")
        await engine.execute(run.id)
        done = get_run(engine.db, run.id)
        assert done is not None
        assert done.status == "done"
        assert done.in_place is True
        assert (repo / "CEZAR_DRY_RUN.txt").exists()


async def test_cez_done_does_not_skip_the_next_agent_step(world):
    engine, _repo = world
    agent = RecordingAgent()
    engine.agent = agent
    run = await _start(engine, "chain the work")
    definition = Workflow(
        name="chain",
        description="",
        source="built-in",
        steps=(
            Step(id="one", name="First", prompt="{{task}}"),
            Step(id="two", name="Second", prompt="{{task}}"),
        ),
    )
    run.workflow = definition.name
    run.workflow_def = definition.to_json()
    await engine.db.write(save_run, run)
    await engine.execute(run.id)
    assert agent.calls == 2
    assert "step 1 of 2" in agent.prompts[0]
    assert "step 2 of 2" in agent.prompts[1]
    assert "chain the work" in agent.prompts[0]
    assert (get_run(engine.db, run.id) or run).status == "done"


async def test_a_check_retries_an_earlier_step_then_fails_when_max_is_spent(world):
    engine, _repo = world
    agent = RecordingAgent()
    engine.agent = agent
    run = await _start(engine, "make it pass")
    definition = Workflow(
        name="fix",
        description="",
        source="built-in",
        steps=(
            Step(id="implement", name="Implement", prompt="{{task}}"),
            Step(
                id="verify",
                name="Verify",
                command="test -f done.txt",
                retry="implement",
                retry_max=2,
            ),
        ),
    )
    run.workflow_def = definition.to_json()
    await engine.db.write(save_run, run)
    await engine.execute(run.id)
    assert agent.calls == 2
    assert (get_run(engine.db, run.id) or run).status == "done"
    assert "Failing output" in agent.prompts[1]

    class Never(RecordingAgent):
        async def stream(self, spec: AgentSpec):
            self.prompts.append(spec.user_prompt)
            self.calls += 1
            yield AgentEvent("text", "still missing")
            yield AgentEvent("turn-end")

    never_agent = Never()
    engine.agent = never_agent
    again = await _start(engine, "never")
    never = Workflow(
        name="fix",
        description="",
        source="built-in",
        steps=(
            Step(id="implement", name="Implement", prompt="{{task}}"),
            Step(
                id="verify",
                name="Verify",
                command="test -f missing.txt",
                retry="implement",
                retry_max=2,
            ),
        ),
    )
    again.workflow_def = never.to_json()
    await engine.db.write(save_run, again)
    await engine.execute(again.id)
    failed = get_run(engine.db, again.id)
    assert failed is not None
    assert failed.status == "failed"
    assert "after 3 attempts" in failed.error


async def test_retry_on_skips_codes_the_agent_cannot_fix(world):
    engine, _repo = world
    agent = RecordingAgent()
    engine.agent = agent
    run = await _start(engine, "once")
    definition = Workflow(
        name="gated",
        description="",
        source="built-in",
        steps=(
            Step(id="implement", name="Implement", prompt="{{task}}"),
            Step(
                id="verify",
                name="Verify",
                command="exit 2",
                retry="implement",
                retry_max=2,
                retry_on=(1,),
            ),
        ),
    )
    run.workflow_def = definition.to_json()
    await engine.db.write(save_run, run)
    await engine.execute(run.id)
    assert agent.calls == 1
    assert (get_run(engine.db, run.id) or run).status == "failed"


async def test_a_check_receives_a_secret_and_a_bash_allowlist_blocks_other_commands(world):
    from app.secrets.store import SecretStore
    from app.store.db import list_events

    engine, _repo = world
    project = __import__("app.store.db", fromlist=["get_project"]).get_project(
        engine.db, engine.boot_project_id
    )
    assert project is not None
    store = SecretStore(engine.config.data_dir / "secrets")
    store.set(project.id, "BUILD_TOKEN", "super-secret-value", root=project.root)
    run = await _start(engine, "secret")
    definition = Workflow(
        name="secret",
        description="",
        source="built-in",
        steps=(
            Step(id="implement", prompt="{{task}}"),
            Step(
                id="verify",
                command='printf %s "$BUILD_TOKEN"',
                secret_bindings=(("BUILD_TOKEN", "BUILD_TOKEN"),),
            ),
        ),
    )
    run.workflow_def = definition.to_json()
    await engine.db.write(save_run, run)
    await engine.execute(run.id)
    done = get_run(engine.db, run.id)
    assert done is not None and done.status == "done"
    texts = [event.text for event in list_events(engine.db, run.id)]
    assert "super-secret-value" not in "\n".join(texts)
    assert any("●" in text for text in texts)
    blocked = await _start(engine, "blocked")
    blocked.workflow_def = Workflow(
        name="blocked",
        description="",
        source="built-in",
        steps=(Step(id="nope", command="true", bash_allowlist=("npm",)),),
    ).to_json()
    await engine.db.write(save_run, blocked)
    await engine.execute(blocked.id)
    allowed = get_run(engine.db, blocked.id)
    assert allowed is not None and allowed.status == "done"


async def test_an_ask_waits_and_the_answer_continues(world):
    engine, _repo = world
    run = await _start(engine, "mock:ask the name")
    await engine.execute(run.id)
    waiting = get_run(engine.db, run.id)
    assert waiting is not None and waiting.status == "waiting"
    assert "Which name" in waiting.ask
    assert await engine.deliver(run.id, "use the short one") is None
    await engine.execute(run.id)
    assert (get_run(engine.db, run.id) or waiting).status == "done"


async def test_cancel_stops_a_check_without_waiting_for_it(world):
    engine, _repo = world
    run = await _start(engine, "sleep")
    definition = Workflow(
        name="slow",
        description="",
        source="built-in",
        steps=(Step(id="verify", command="sleep 30"),),
    )
    run.workflow_def = definition.to_json()
    await engine.db.write(save_run, run)
    task = asyncio.create_task(engine.execute(run.id))
    for _ in range(50):
        current = get_run(engine.db, run.id)
        if current and current.status == "running":
            break
        await asyncio.sleep(0.02)
    await engine.cancel(run.id)
    await asyncio.wait_for(task, timeout=3)
    assert (get_run(engine.db, run.id) or run).status == "cancelled"


async def test_only_one_run_occupies_a_slot_when_max_parallel_is_one(world):
    engine, _repo = world
    gate = GateAgent()
    engine.agent = gate
    engine.app = App()
    await engine.save_workspace(Settings(max_parallel=1))
    first = await _start(engine, "first")
    second = await _start(engine, "second")
    await engine.tick()
    await asyncio.wait_for(gate.started.wait(), timeout=2)
    assert (get_run(engine.db, second.id) or second).status == "queued"
    gate.release.set()
    for _ in range(50):
        if (
            first.id not in engine._tasks
            and (get_run(engine.db, first.id) or first).status == "done"
        ):
            break
        await asyncio.sleep(0.02)
    await engine.tick()
    for _ in range(50):
        if (get_run(engine.db, second.id) or second).status == "done":
            break
        await asyncio.sleep(0.02)
    assert (get_run(engine.db, second.id) or second).status == "done"
    assert gate.count == 2
    assert gate.count == 2


async def test_dispatch_caps_children_and_reports_when_one_settles(world):
    engine, _repo = world
    parent = await _start(engine, "commander")
    parent.status = "running"
    parent.branch = "main"
    await engine.db.write(save_run, parent)
    from app.engine.dispatch_logic import DispatchOrder

    for index in range(4):
        child_id, reason = await engine.dispatch(
            parent.id, DispatchOrder(objective=f"child {index}")
        )
        assert reason is None, reason
        assert child_id
    _refused_id, reason = await engine.dispatch(parent.id, DispatchOrder(objective="one more"))
    assert reason is not None and "cap is 4" in reason
    child = next(run for run in list_runs(engine.db, None, None) if run.parent_id == parent.id)
    await engine.execute(child.id)
    parent_after = get_run(engine.db, parent.id)
    assert parent_after is not None
    assert parent_after.pending_reports
    assert "Report from task" in str(parent_after.pending_reports[0]["text"])
    parent_after.budget_usd = 1
    await engine.db.write(save_run, parent_after)
    _over, refused = await engine.dispatch(
        parent.id, DispatchOrder(objective="too expensive", max_cost=100)
    )
    assert refused is not None and "$100.00" in refused


async def test_dispatch_is_off_when_the_flag_says_so(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo, dispatch_enabled=False)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        parent = await _start(engine, "commander")
        parent.status = "running"
        parent.branch = "main"
        await engine.db.write(save_run, parent)
        from app.engine.dispatch_logic import DispatchOrder

        child_id, reason = await engine.dispatch(parent.id, DispatchOrder(objective="nope"))
        assert child_id is None
        assert reason is not None and "CEZ_DISPATCH=0" in reason


async def test_a_missing_backend_fails_the_run_instead_of_spawning(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    # An absolute path that cannot exist, so a real `claude` on PATH is never used.
    missing = {runner: str(tmp_path / "no-such-bin" / runner) for runner in RUNNERS}
    cfg = config_for(tmp_path, repo, dry_run=False, runner_bins=missing)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        run = await _start(engine, "real")
        await engine.execute(run.id)
        failed = get_run(engine.db, run.id)
        assert failed is not None
        assert "not found" in failed.error


def test_gitignore_appends_missing_entries_and_keeps_user_lines(tmp_path: Path):
    path = tmp_path / ".ai" / "cezar"
    path.mkdir(parents=True)
    (path / ".gitignore").write_text("# mine\nkeep-me\n", encoding="utf-8")
    ensure_data_gitignore(tmp_path)
    text = (path / ".gitignore").read_text(encoding="utf-8")
    assert text.startswith("# mine\nkeep-me\n")
    for entry in DATA_GITIGNORE_ENTRIES:
        assert entry in text.splitlines()
    ensure_data_gitignore(tmp_path)
    assert (path / ".gitignore").read_text(encoding="utf-8") == text


def test_orphan_worktrees_go_and_known_runs_stay(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    orphan = "ab" * 16
    keep = "cd" * 16
    root = repo / ".ai" / "cezar" / "worktrees"
    (root / orphan).mkdir(parents=True)
    (root / keep).mkdir()
    removed = prune_orphans(repo, {keep})
    assert orphan in removed
    assert not (root / orphan).exists()
    assert (root / keep).exists()
