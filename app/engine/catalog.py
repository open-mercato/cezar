"""Load `.ai/cezar/workflows`. A bad file is reported and skipped. A valid file wins its name."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from app.engine.model import Workflow
from app.engine.workflows import QUICK_TASK, parse_workflow

WORKFLOWS_DIR = Path(".ai") / "cezar" / "workflows"


@dataclass(frozen=True, slots=True)
class LoadIssue:
    path: str
    message: str


def load_workflows(repo: Path) -> tuple[list[Workflow], list[LoadIssue]]:
    directory = repo / WORKFLOWS_DIR
    issues: list[LoadIssue] = []
    from_files: list[Workflow] = []
    if directory.is_dir():
        for path in sorted(directory.iterdir()):
            if path.suffix.lower() not in (".yaml", ".yml") or not path.is_file():
                continue
            try:
                doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            except (OSError, yaml.YAMLError) as exc:
                issues.append(LoadIssue(str(path), str(exc)))
                continue
            workflow, issue = parse_workflow(doc, source="file", path=str(path))
            if issue or workflow is None:
                issues.append(LoadIssue(str(path), issue or "invalid workflow"))
                continue
            from_files.append(workflow)
    names = {item.name for item in from_files}
    workflows = list(from_files)
    if QUICK_TASK.name not in names:
        workflows.append(QUICK_TASK)
    workflows.sort(key=lambda item: item.name)
    return workflows, issues


def find_workflow(repo: Path, name: str) -> Workflow | None:
    workflows, _issues = load_workflows(repo)
    return next((item for item in workflows if item.name == name), None)
