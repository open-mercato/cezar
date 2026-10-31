"""The serve-startup skills promo.

`packages/cezar/src/skills-banner.ts`. `CEZ_NO_BANNER=1` and a dismissed flag in
`.ai/cezar/ui-state.json` both silence it. A missing file shows the banner.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from app.config import no_banner

SKILLS_BANNER_LINES: tuple[str, ...] = (
    "  Make the most of parallel coding with our AI skills",
    "  open-mercato/skills: reusable agent skills for PR creation, code review,",
    "  CI stabilisation, spec writing and more.",
    "  cezar already loads them — Skills → Refresh in the cockpit gets the latest.",
    "  To use them outside cezar:  npx skills add open-mercato/skills --skill '*'",
)


def should_show_skills_banner(repo: Path) -> bool:
    if no_banner():
        return False
    path = repo / ".ai" / "cezar" / "ui-state.json"
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return True
    if not isinstance(loaded, dict):
        return True
    return loaded.get("dismissedSkillsBanner") is not True


def print_skills_banner(repo: Path, log: Callable[[str], None] = print) -> None:
    if not should_show_skills_banner(repo):
        return
    for line in SKILLS_BANNER_LINES:
        log(line)
    log("")
