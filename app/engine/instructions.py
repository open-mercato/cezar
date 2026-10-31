"""Run instructions from `.ai/cezar/instructions.json`, then `config.json`.

`systemPrompt` is prepended to the agent prompt. `branchNaming` is handed to
the namer in `app.engine.namer`.
"""

from __future__ import annotations

import json
from pathlib import Path


def run_instructions(root: Path) -> tuple[str, str]:
    prompt, naming = _pair(root / ".ai" / "cezar" / "instructions.json")
    fallback_prompt, fallback_naming = _pair(root / ".ai" / "cezar" / "config.json")
    return prompt or fallback_prompt, naming or fallback_naming


def _pair(path: Path) -> tuple[str, str]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return "", ""
    if not isinstance(loaded, dict):
        return "", ""
    prompt = loaded.get("systemPrompt")
    naming = loaded.get("branchNaming")
    return (
        prompt.strip() if isinstance(prompt, str) else "",
        naming.strip() if isinstance(naming, str) else "",
    )
