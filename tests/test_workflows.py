from pathlib import Path

from app.engine.catalog import load_workflows
from app.engine.model import Step, Workflow
from app.engine.prompts import chain_step_note
from app.engine.workflows import (
    QUICK_TASK,
    newer_catalog_workflow,
    parse_workflow,
    retryable_exit,
    skill_stack_of,
    skills_to_steps,
    steps_issue,
)


def test_quick_task_is_one_agent_step():
    assert QUICK_TASK.steps[0].prompt == "{{task}}"
    assert steps_issue(QUICK_TASK.steps) is None


def test_steps_and_skills_are_exclusive():
    workflow, issue = parse_workflow(
        {"name": "both", "steps": [{"id": "a", "prompt": "x"}], "skills": ["a"]},
        source="file",
    )
    assert workflow is None
    assert issue is not None and "either" in issue


def test_skills_shorthand_becomes_agent_steps():
    workflow, issue = parse_workflow({"name": "stack", "skills": ["alpha", "alpha"]}, source="file")
    assert issue is None
    assert workflow is not None
    assert [step.id for step in workflow.steps] == ["alpha", "alpha-2"]
    assert skill_stack_of(workflow.steps) == ("alpha", "alpha")


def test_a_richer_chain_is_not_a_skill_stack():
    steps = skills_to_steps(["alpha"])
    richer = (Step(id="a", name="A", prompt="custom", skill="alpha"),)
    assert skill_stack_of(steps) == ("alpha",)
    assert skill_stack_of(richer) is None


def test_agent_and_check_are_exclusive():
    _workflow, issue = parse_workflow(
        {"name": "x", "steps": [{"id": "a", "prompt": "p", "command": "true"}]},
        source="file",
    )
    assert issue is not None and "either" in issue


def test_secrets_are_refused_on_an_agent_step():
    _workflow, issue = parse_workflow(
        {"name": "x", "steps": [{"id": "a", "prompt": "p", "secrets": ["TOKEN"]}]},
        source="file",
    )
    assert issue is not None and "secrets" in issue


def test_retry_must_name_an_earlier_step():
    _workflow, issue = parse_workflow(
        {
            "name": "x",
            "steps": [
                {"id": "implement", "prompt": "{{task}}"},
                {"id": "verify", "command": "true", "onFail": {"retry": "verify", "max": 2}},
            ],
        },
        source="file",
    )
    assert issue is not None and "earlier" in issue


def test_duplicate_step_ids_are_rejected():
    assert steps_issue((Step(id="a", prompt="x"), Step(id="a", command="true"))) is not None


def test_retry_on_rejects_zero_and_any_failure_retries_without_a_list():
    _workflow, issue = parse_workflow(
        {
            "name": "x",
            "steps": [
                {"id": "implement", "prompt": "{{task}}"},
                {
                    "id": "verify",
                    "command": "true",
                    "onFail": {"retry": "implement", "retryOn": [0]},
                },
            ],
        },
        source="file",
    )
    assert issue is not None and "0" in issue
    assert retryable_exit((), 2) is True
    assert retryable_exit((1,), 1) is True
    assert retryable_exit((1,), 2) is False


def test_legacy_runner_id_is_rejected():
    _workflow, issue = parse_workflow(
        {"name": "x", "steps": [{"id": "a", "prompt": "p", "runner": "claude-cli"}]},
        source="file",
    )
    assert issue is not None and "runner" in issue


def test_a_graph_without_a_start_node_is_rejected():
    workflow, issue = parse_workflow({"name": "g", "version": 2, "nodes": []}, source="file")
    assert workflow is None
    assert issue is not None and "start node" in issue


def test_on_fail_max_defaults_to_two():
    workflow, issue = parse_workflow(
        {
            "name": "x",
            "steps": [
                {"id": "implement", "prompt": "{{task}}"},
                {"id": "verify", "command": "true", "onFail": {"retry": "implement"}},
            ],
        },
        source="file",
    )
    assert issue is None
    assert workflow is not None
    assert workflow.steps[1].retry_max == 2


def test_chain_note_is_only_for_two_or_more_agent_steps():
    single = (Step(id="task", name="Do", prompt="{{task}}"), Step(id="verify", command="true"))
    assert chain_step_note(single, 0) is None
    chain = (
        Step(id="one", name="First", prompt="{{task}}"),
        Step(id="two", name="Second", prompt="{{task}}"),
    )
    first = chain_step_note(chain, 0) or ""
    second = chain_step_note(chain, 1) or ""
    assert "step 1 of 2" in first
    assert "earlier step" not in first
    assert "step 2 of 2" in second
    assert "earlier step" in second
    assert "CEZ:DONE" in second


def test_a_valid_file_overrides_quick_task_and_a_bad_file_does_not(tmp_path: Path):
    directory = tmp_path / ".ai" / "cezar" / "workflows"
    directory.mkdir(parents=True)
    (directory / "quick-task.yaml").write_text(
        "name: quick-task\nsteps:\n  - id: custom\n    prompt: '{{task}}'\n",
        encoding="utf-8",
    )
    workflows, issues = load_workflows(tmp_path)
    assert issues == []
    found = next(item for item in workflows if item.name == "quick-task")
    assert found.source == "file"
    assert found.steps[0].id == "custom"

    (directory / "quick-task.yaml").write_text("name: quick-task\nsteps: nope\n", encoding="utf-8")
    workflows, issues = load_workflows(tmp_path)
    assert issues
    found = next(item for item in workflows if item.name == "quick-task")
    assert found.source == "built-in"


def test_a_deleted_file_does_not_replace_a_queued_snapshot_with_the_builtin():
    snapshot = Workflow(
        name="quick-task",
        description="custom",
        source="file",
        path="quick-task.yaml",
        steps=(Step(id="custom", prompt="{{task}}"),),
    )
    assert newer_catalog_workflow(snapshot, [QUICK_TASK]) is None
    updated = Workflow(
        name="quick-task",
        description="",
        source="file",
        steps=(Step(id="newer", prompt="{{task}}"),),
    )
    assert newer_catalog_workflow(snapshot, [updated]) == updated
    planned = Workflow(name="(planned)", description="", source="built-in", steps=snapshot.steps)
    assert newer_catalog_workflow(planned, [updated]) is None
