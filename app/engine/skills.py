"""Markdown skills. Local directories win, in the same order the TypeScript loader starts with.

Global skills are `~/.agents/skills` and `~/.claude/skills`. A team repo is read
from the on-disk cache (`~/.cache/cez/team-skills`) when that directory already
exists. Nothing here clones or fetches.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from app.engine.model import Skill

SKILL_ROOTS = (
    Path(".ai") / "cezar" / "skills",
    Path(".ai") / "skills",
    Path(".agents") / "skills",
    Path(".claude") / "skills",
    Path(".codex") / "skills",
    Path(".cursor") / "skills",
    Path(".opencode") / "skills",
)

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,64}$")


def valid_skill_name(name: str) -> bool:
    return _NAME.fullmatch(name) is not None


def global_skill_dirs(home: Path) -> tuple[Path, Path]:
    return (home / ".agents" / "skills", home / ".claude" / "skills")


def team_skill_cache(cache: Path) -> Path:
    return cache / "team-skills"


def load_skills(repo: Path, *, home: Path | None = None, cache: Path | None = None) -> list[Skill]:
    found: dict[str, Skill] = {}
    bases = [repo / root for root in SKILL_ROOTS]
    bases.extend(global_skill_dirs(home if home is not None else Path.home()))
    if cache is None:
        cache = Path.home() / ".cache" / "cez"
    bases.append(team_skill_cache(cache))
    for base in bases:
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.md")):
            if not path.is_file():
                continue
            skill = _read_skill(path)
            if skill.name not in found:
                found[skill.name] = skill
    return sorted(found.values(), key=lambda item: item.name)


def find_skill(
    repo: Path, name: str, *, home: Path | None = None, cache: Path | None = None
) -> Skill | None:
    return next(
        (item for item in load_skills(repo, home=home, cache=cache) if item.name == name), None
    )


def write_skill(repo: Path, name: str, description: str, body: str) -> Path:
    directory = repo / SKILL_ROOTS[0]
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.md"
    header = yaml.safe_dump({"name": name, "description": description}, sort_keys=False)
    path.write_text(f"---\n{header}---\n\n{body.strip()}\n", encoding="utf-8")
    return path


def _read_skill(path: Path) -> Skill:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return Skill(path.stem, "", "", str(path))
    meta, body = _frontmatter(raw)
    name = meta.get("name")
    description = meta.get("description")
    return Skill(
        name.strip() if isinstance(name, str) and name.strip() else path.stem,
        description.strip() if isinstance(description, str) else "",
        body.strip(),
        str(path),
    )


def _frontmatter(text: str) -> tuple[dict[str, object], str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    try:
        loaded = yaml.safe_load(text[3:end])
    except yaml.YAMLError:
        return {}, text[end + 4 :]
    body = text[end + 4 :].lstrip("\n")
    if isinstance(loaded, dict):
        return loaded, body
    return {}, body
