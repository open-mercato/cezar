"""Turn a task into a short workflow by asking the configured runner.

`CEZ_DRY_RUN` uses the same canned plan as `scripts/mock-claude.mjs` and does
not spawn a binary. Any other failure degrades to one step, which is what
`planChain` does when the runner cannot answer.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable

from stario.json import loads as json_loads

from app.engine.skills import load_skills

_SYSTEM = (
    "You are a planning assistant. Respond with ONLY a JSON object: "
    '{"title":string,"steps":[{"name":string,"prompt"?:string,"command"?:string,'
    '"skill"?:string}],"rationale":string}.'
)

Spawn = Callable[[list[str], str], tuple[int, str]]


def plan_chain(
    repo,
    task: str,
    *,
    binary: str,
    dry_run: bool,
    model: str = "",
    spawn: Spawn | None = None,
) -> dict[str, object]:
    from pathlib import Path

    root = Path(repo)
    names = {skill.name for skill in load_skills(root)}
    prompt = _prompt(task, root)
    if dry_run:
        text = _canned()
    else:
        argv = [binary, "--model", model] if model else [binary]
        code, text = (spawn or _spawn)(argv, f"{_SYSTEM}\n\n{prompt}")
        if code != 0 or not text.strip():
            return _fallback()
    parsed = _parse(text, names)
    if parsed is None:
        return _fallback()
    return parsed


def _prompt(task: str, root) -> str:
    catalog = load_skills(root)
    lines = [f"- {skill.name} — {skill.description}" for skill in catalog]
    if not lines:
        lines = ["(no skills available)"]
    return "\n".join(
        [
            "[cez-planner] Plan a chain of steps for this task.",
            "",
            "Task:",
            task,
            "",
            "Skill catalog (name — description):",
            *lines,
        ]
    )


def _canned() -> str:
    return (
        '{"title":"implement-verify-review","steps":['
        '{"name":"Implement","prompt":"{{task}}"},'
        '{"name":"Verify","command":"npm test"},'
        '{"name":"Review","skill":"code-review","prompt":"Review the changes for {{task}}"}'
        '],"rationale":"Implement, verify with tests, then review."}'
    )


def _parse(text: str, names: set[str]) -> dict[str, object] | None:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        loaded = json_loads(text[start : end + 1])
    except ValueError, TypeError:
        return None
    if not isinstance(loaded, dict):
        return None
    raw_steps = loaded.get("steps")
    if not isinstance(raw_steps, list) or not 1 <= len(raw_steps) <= 5:
        return None
    steps: list[dict[str, str]] = []
    for item in raw_steps:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            return None
        step: dict[str, str] = {"name": item["name"]}
        prompt = item.get("prompt")
        command = item.get("command")
        skill = item.get("skill")
        if isinstance(prompt, str) and prompt:
            step["prompt"] = prompt
        if isinstance(command, str) and command:
            step["command"] = command
        if isinstance(skill, str) and skill in names:
            step["skill"] = skill
        if "prompt" not in step and "command" not in step:
            continue
        steps.append(step)
    if not steps:
        return None
    rationale = loaded.get("rationale")
    title = loaded.get("title")
    body: dict[str, object] = {
        "steps": steps,
        "rationale": rationale if isinstance(rationale, str) else "",
        "fallback": False,
    }
    if isinstance(title, str) and title.strip():
        body["name"] = title.strip()
    return body


def _fallback() -> dict[str, object]:
    return {
        "steps": [{"name": "Do the task", "prompt": "{{task}}"}],
        "rationale": "planner unavailable — single-step plan",
        "fallback": True,
    }


def _spawn(args: list[str], prompt: str) -> tuple[int, str]:
    try:
        result = subprocess.run(
            args,
            check=False,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)
    return result.returncode, result.stdout
