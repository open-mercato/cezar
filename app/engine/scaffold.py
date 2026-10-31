"""`cezar init` — example workflow and skill. Existing files are left untouched."""

from __future__ import annotations

from pathlib import Path

from app.engine.gitignore_data import ensure_data_gitignore

FIX_AND_VERIFY = (
    "name: fix-and-verify\n"
    "description: Implement the task, then run your test command; "
    "on failure the agent retries with the failing output.\n"
    "steps:\n"
    "  - id: implement\n"
    "    name: Implement\n"
    '    prompt: "{{task}}"\n'
    "  - id: verify\n"
    "    name: Verify\n"
    "    command: \"echo 'replace me with: npm test / yarn test / pytest'\"\n"
    "    onFail:\n"
    "      retry: implement\n"
    "      max: 2\n"
)

PROJECT_CONVENTIONS = """---
name: project-conventions
description: House rules the agent should follow in this repo.
---

# Project conventions

- Describe your stack, style and testing conventions here.
- Reference this skill from a workflow step via `skill: project-conventions`.
"""


def init_project(repo: Path) -> list[str]:
    """Return the lines a CLI should print. Never overwrites an existing file."""
    workflows = repo / ".ai" / "cezar" / "workflows"
    skills = repo / ".ai" / "cezar" / "skills"
    workflows.mkdir(parents=True, exist_ok=True)
    skills.mkdir(parents=True, exist_ok=True)
    ensure_data_gitignore(repo)
    notes = ["  + .ai/cezar/.gitignore"]
    examples = (
        (workflows / "fix-and-verify.yaml", FIX_AND_VERIFY),
        (skills / "project-conventions.md", PROJECT_CONVENTIONS),
    )
    for path, content in examples:
        if path.exists():
            notes.append(f"  = {path} (exists, left untouched)")
            continue
        path.write_text(content, encoding="utf-8")
        notes.append(f"  + {path}")
    return notes
