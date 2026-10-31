"""Workflow documents: the checks the TypeScript loader applies before a run starts.

A file lists `steps` or the portable `skills` shorthand, never both. A step is an
agent step (prompt and/or skill) or a check (`command`), never both. `onFail.retry`
may only name an earlier step. `retryOn` lists the failing exit codes worth another
attempt; `0` is rejected because a passing check never reaches the loop.
"""

from __future__ import annotations

from app.config import RUNNERS
from app.engine.model import Step, Workflow, _secret_bindings

QUICK_TASK = Workflow(
    name="quick-task",
    description="One agent run on your task — no ceremony.",
    source="built-in",
    steps=(Step(id="task", name="Do the task", prompt="{{task}}"),),
)


def retryable_exit(retry_on: tuple[int, ...] | list[int], exit_code: int) -> bool:
    """A failing check buys another attempt. With no list, any non-zero code does."""
    if not retry_on:
        return True
    return exit_code in retry_on


def skills_to_steps(skills: list[str]) -> tuple[Step, ...]:
    used: set[str] = set()
    steps: list[Step] = []
    for skill in skills:
        step_id = skill
        n = 2
        while step_id in used:
            step_id = f"{skill}-{n}"
            n += 1
        used.add(step_id)
        steps.append(Step(id=step_id, name=skill, skill=skill, prompt="{{task}}"))
    return tuple(steps)


def skill_stack_of(steps: tuple[Step, ...] | list[Step]) -> tuple[str, ...] | None:
    """The compact `skills:` form, when every step is just "apply this skill to the task"."""
    names: list[str] = []
    for step in steps:
        if step.kind != "agent" or not step.skill:
            return None
        if step.prompt not in ("", "{{task}}"):
            return None
        if step.name not in ("", step.skill):
            return None
        if step.model or step.runner or step.allowed_tools or step.bash_allowlist or step.retry:
            return None
        if step.has_secrets:
            return None
        names.append(step.skill)
    return tuple(names) if names else None


def steps_issue(steps: tuple[Step, ...] | list[Step]) -> str | None:
    ids = [step.id for step in steps]
    for index, step_id in enumerate(ids):
        if step_id in ids[:index]:
            return f'duplicate step id "{step_id}"'
    for index, step in enumerate(steps):
        if not step.retry:
            continue
        target = ids.index(step.retry) if step.retry in ids else -1
        if target < 0 or target >= index:
            return (
                f'step "{step.id}": onFail.retry must reference an earlier step '
                f'(got "{step.retry}")'
            )
    return None


def parse_workflow(
    doc: object, *, source: str, path: str = ""
) -> tuple[Workflow | None, str | None]:
    """Return a workflow or a human-readable problem. Graph files are refused, not guessed."""
    try:
        return _workflow(doc, source, path), None
    except ValueError as problem:
        return None, str(problem)


def _text(value: object, problem: str) -> str:
    """An optional string field: absent is empty, anything but a string is the problem."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    raise ValueError(problem)


def _int_field(value: object, problem: str, *, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(problem)
    if minimum is not None and value < minimum:
        raise ValueError(problem)
    return value


def _str_list(value: object, problem: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(problem)
    return tuple(value)


def _workflow(doc: object, source: str, path: str) -> Workflow:
    if not isinstance(doc, dict):
        raise ValueError("a workflow file must be a mapping")
    name = doc.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name must be a non-empty string")
    description = _text(doc.get("description"), "description must be a string").strip()
    if doc.get("version") in (2, "2"):
        return _graph_workflow(doc, name.strip(), description, source, path)
    raw_steps, skills = doc.get("steps"), doc.get("skills")
    if (raw_steps is None) == (skills is None):
        raise ValueError('a workflow lists either "steps" or "skills", not both')
    if skills is not None:
        problem = "skills must be a non-empty list of names"
        if not isinstance(skills, list) or not skills:
            raise ValueError(problem)
        if not all(isinstance(item, str) and item.strip() for item in skills):
            raise ValueError(problem)
        steps = skills_to_steps([item.strip() for item in skills])
    else:
        if not isinstance(raw_steps, list) or not raw_steps:
            raise ValueError("steps must be a non-empty list")
        steps = tuple(_parse_step(raw) for raw in raw_steps)
    issue = steps_issue(steps)
    if issue:
        raise ValueError(issue)
    return Workflow(name.strip(), description, steps, source, path)


def _parse_step(raw: object) -> Step:
    if not isinstance(raw, dict):
        raise ValueError("a step must be a mapping")
    step_id = raw.get("id")
    if not isinstance(step_id, str) or not step_id.strip():
        raise ValueError("a step id must be a non-empty string")
    where = f'step "{step_id}": '
    name = _text(raw.get("name"), where + "name must be a string")
    texts = [
        _text(raw.get(key), where + "text fields must be strings")
        for key in ("prompt", "skill", "command", "runner", "model")
    ]
    prompt, skill, command, runner, model = texts
    if runner and runner not in RUNNERS:
        raise ValueError(f'{where}unknown runner "{runner}"')
    if bool(prompt or skill) == bool(command):
        raise ValueError(
            f"{where}a step is either an agent step (prompt/skill) "
            "or a check step (command), not both"
        )
    secrets = raw.get("secrets")
    has_secrets = secrets not in (None, False)
    if has_secrets and not command:
        raise ValueError(where + "secrets is for check steps only")
    retry, retry_max, retry_on = "", 0, ()
    on_fail = raw.get("onFail")
    if on_fail is not None:
        if not command:
            raise ValueError(where + "onFail is for check steps only")
        if not isinstance(on_fail, dict):
            raise ValueError(where + "onFail must be a mapping")
        target = on_fail.get("retry")
        if not isinstance(target, str) or not target.strip():
            raise ValueError(where + "onFail.retry must name a step")
        retry = target.strip()
        maximum = on_fail.get("max")
        retry_max = (
            2
            if maximum is None
            else _int_field(maximum, where + "onFail.max must be a positive integer", minimum=1)
        )
        codes = on_fail.get("retryOn")
        if codes is not None:
            problem = where + "onFail.retryOn must be a list of exit codes"
            if not isinstance(codes, list):
                raise ValueError(problem)
            retry_on = tuple(_int_field(code, problem) for code in codes)
            if any(code <= 0 for code in retry_on):
                raise ValueError(
                    f"{where}onFail.retryOn cannot list 0 — a check that exits 0 passed"
                )
    lists = where + "tool lists must be lists of strings"
    return Step(
        id=step_id.strip(),
        name=name.strip(),
        prompt=prompt,
        skill=skill,
        command=command,
        runner=runner,
        model=model,
        retry=retry,
        retry_max=retry_max,
        retry_on=retry_on,
        has_secrets=has_secrets,
        secret_bindings=_secret_bindings(secrets),
        allowed_tools=_str_list(raw.get("allowedTools"), lists),
        bash_allowlist=_str_list(raw.get("bashAllowlist"), lists),
    )


def _graph_workflow(
    doc: dict[str, object], name: str, description: str, source: str, path: str
) -> Workflow:
    from app.engine.graph import graph_issues, rail_nodes

    nodes = doc.get("nodes")
    edges = doc.get("edges") or []
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValueError("a graph needs nodes and edges")
    graph: dict[str, object] = {"nodes": nodes, "edges": edges}
    problems = graph_issues(graph)
    if problems:
        raise ValueError(str(problems[0]))
    steps: list[Step] = []
    for node in rail_nodes(graph):  # type: ignore[arg-type]
        node_id = str(node.get("id", ""))
        label = str(node.get("name") or node_id)
        if node.get("type") == "check":
            steps.append(Step(id=node_id, name=label, command=str(node.get("command", ""))))
        else:
            steps.append(
                Step(
                    id=node_id,
                    name=label,
                    prompt=str(node.get("prompt") or ""),
                    skill=str(node.get("skill") or ""),
                )
            )
    return Workflow(name, description, tuple(steps), source, path, graph)


def newer_catalog_workflow(snapshot: Workflow, catalog: list[Workflow]) -> Workflow | None:
    """The catalog entry a queued run should start with, when the file changed underneath it.

    A deleted file falls back to the built-in `quick-task` in the catalog. A queued snapshot
    of that file keeps its own steps — switching it to the built-in would drop them.
    Ad-hoc chains such as `(planned)` are not catalog entries and are never replaced.
    """
    if snapshot.source != "file" and snapshot.name != QUICK_TASK.name:
        return None
    current = next((item for item in catalog if item.name == snapshot.name), None)
    if current is None:
        return None
    if snapshot.source == "file" and current.source != "file":
        return None
    if current.to_json() == snapshot.to_json():
        return None
    return current
