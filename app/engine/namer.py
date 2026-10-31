"""Task title and branch name. Same switch as the TypeScript namer.

`CEZ_AUTONAME=0` disables it. Under `CEZ_DRY_RUN=1` it stays off unless
`CEZ_AUTONAME=1`, and then the answer is the canned JSON from
`scripts/mock-claude.mjs`. A live run asks the Claude binary once. A junk
answer keeps the heuristic title and `cez/<id8>`.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

_MAX = 80
_NUMBER = re.compile(r"(?:^|\D)(\d{1,7})(?:\D|$)")

NAMER_SYSTEM = (
    "You are a task-naming assistant for an AI coding agent cockpit. "
    'Respond with ONLY a JSON object: {"title": string, "pr"?: number, "issue"?: number}. '
    "Rules: title is a terse lowercase gerund phrase of at most 40 characters."
)
NAMER_BRANCH = (
    ' Also set "branch": a git branch name that follows the user\'s branch naming '
    "instructions. Use only letters, digits, -, _, . and /. Keep it under 80 characters."
)


@dataclass(frozen=True, slots=True)
class NameResult:
    title: str
    branch: str = ""
    pr_number: int | None = None


def auto_naming_active(*, dry_run: bool) -> bool:
    if os.environ.get("CEZ_AUTONAME") == "0":
        return False
    if dry_run and os.environ.get("CEZ_AUTONAME") != "1":
        return False
    return True


def build_namer_prompt(task: str, naming: str) -> str:
    lines = ["[cez-namer] Name this task.", "", "Task:", task.strip()[:500]]
    if naming.strip():
        lines.extend(["", "Branch naming instructions:", naming.strip()[:2000]])
    return "\n".join(lines)


def mock_namer_answer(prompt: str) -> str:
    """The dry-run reply in `packages/cezar/scripts/mock-claude.mjs`."""
    numbered = _NUMBER.search(prompt)
    body: dict[str, object] = {"title": "implementing cr fixes"}
    if numbered:
        body["pr"] = int(numbered.group(1))
    if "Branch naming instructions:" in prompt:
        body["branch"] = "feature/implementing cr fixes"
    return json.dumps(body)


def compose_name_result(raw_text: str, task: str, naming: str) -> NameResult | None:
    parsed = _json_object(raw_text)
    if parsed is None:
        return None
    title = parsed.get("title")
    if not isinstance(title, str) or not title.strip():
        return None
    if re.search(r"[.!?][A-Z]", title):
        return None
    pr = _ref(parsed.get("pr"), task)
    issue = _ref(parsed.get("issue"), task)
    ref = pr if pr is not None else issue
    summary = _title(title, ref)
    if not summary or summary == str(ref or ""):
        return None
    branch = ""
    if naming.strip():
        raw_branch = parsed.get("branch")
        branch = sanitize_branch(raw_branch if isinstance(raw_branch, str) else "") or ""
    return NameResult(title=summary, branch=branch, pr_number=pr)


def sanitize_branch(raw: str) -> str | None:
    name = re.sub(r"\s+", "-", raw.strip().strip("`"))
    name = re.sub(r"[^A-Za-z0-9._/-]", "", name)
    name = re.sub(r"\.\.+", ".", name).replace("@{", "")
    name = re.sub(r"-{2,}", "-", name)
    name = re.sub(r"/{2,}", "/", name)
    name = re.sub(r"\.lock(?=/|$)", "", name)
    parts = [part.strip(".-") for part in name.split("/")]
    name = "/".join(part for part in parts if part)
    if len(name) > _MAX:
        name = name[:_MAX].rstrip("./-")
    if not name or name.startswith("-"):
        return None
    return name


async def propose_name(
    task: str, naming: str, *, dry_run: bool, cwd: Path, binary: str, model: str = ""
) -> NameResult | None:
    if not naming.strip() or not auto_naming_active(dry_run=dry_run):
        return None
    prompt = build_namer_prompt(task, naming)
    text = (
        mock_namer_answer(prompt)
        if dry_run
        else await _ask_claude(binary, cwd, prompt, naming, model)
    )
    if not text:
        return None
    return compose_name_result(text, task, naming)


async def propose_title(
    task: str, turn: str, *, dry_run: bool, cwd: Path, binary: str, model: str = ""
) -> str | None:
    """Live title refresh. Branch naming is not asked again."""
    if not auto_naming_active(dry_run=dry_run):
        return None
    body = task.strip()
    if turn.strip():
        body = f"{body}\n\nLatest turn:\n{turn.strip()[:1000]}"
    prompt = build_namer_prompt(body, "")
    text = (
        mock_namer_answer(prompt) if dry_run else await _ask_claude(binary, cwd, prompt, "", model)
    )
    if not text:
        return None
    named = compose_name_result(text, task, "")
    if named is None:
        return None
    return named.title


async def _ask_claude(binary: str, cwd: Path, prompt: str, naming: str, model: str) -> str:
    import asyncio

    from app.engine.agents import AgentSpec
    from app.engine.runners.protocol import ProtocolRunner

    system = NAMER_SYSTEM + (NAMER_BRANCH if naming.strip() else "")
    runner = ProtocolRunner("claude", binary)
    spec = AgentSpec(
        user_prompt=prompt,
        system_prompt=system,
        cwd=str(cwd),
        runner="claude",
        model=model,
        cancel=asyncio.Event(),
        timeout_ms=20_000,
    )
    chunks: list[str] = []
    try:
        async for event in runner.stream(spec):
            if event.type == "text" and event.text:
                chunks.append(event.text)
            if event.type == "error":
                return ""
    except OSError:
        return ""
    return "\n".join(chunks)


def _json_object(raw_text: str) -> dict[str, object] | None:
    start = raw_text.find("{")
    end = raw_text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        loaded = json.loads(raw_text[start : end + 1])
    except json.JSONDecodeError:
        return None
    if isinstance(loaded, dict):
        return loaded
    return None


def _ref(value: object, task: str) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return None
    if re.search(rf"(^|\D){value}(\D|$)", task):
        return value
    return None


def _title(title: str, ref: int | None) -> str:
    text = re.sub(r"\.+$", "", title.strip())
    text = re.sub(r"\s+", " ", text)
    if ref is not None:
        text = re.sub(rf"^#?{ref}\s*[:—-]?\s*", "", text)
    if text:
        text = text[0].lower() + text[1:]
    if len(text) > 40:
        text = text[:39].rstrip() + "…"
    if ref is not None:
        text = f"{ref}: {text}".strip()
        if text.endswith(":"):
            return text
    return text
