"""Prompt text the executor prepends. The chain note is the guard from the TypeScript runner."""

from __future__ import annotations

from app.engine.model import Step

# The dry-run agent answers this exact sentence with CEZ:DONE. Rewording it
# without that check makes an autonomous run take the full continuation cap.
AUTONOMOUS_NUDGE = (
    "Continue working autonomously until the task is fully complete. "
    "Do not ask me for confirmation or clarification — make reasonable assumptions and proceed. "
    "When everything is done, end the session with your done signal."
)
MONITORING_WAKE_NUDGE = (
    "Re-check the downstream work you were monitoring. Continue toward the task goal; "
    "emit CEZ:MONITORING again only if it is still pending."
)
COMPACTION_NUDGE = (
    "Your context was automatically compacted, which ended your turn before the work was "
    "finished. Nothing is being asked of you. Re-read your handoff file and notes for where "
    "you got to, then carry on — and end the turn with CEZ:DONE, CEZ:ASK or CEZ:MONITORING "
    "when you genuinely need to stop."
)
MAX_AUTO_CONTINUES = 40
MAX_COMPACTION_CONTINUES = 3
MAX_AUTO_RESUMES = 12
AUTO_RESUME_GRACE_S = 30
REPO_LOCK_DISABLED_NOTE = (
    "repository-root lock disabled by CEZ_DISABLE_REPO_LOCK=1 (shared checkout is unsafe)"
)


def substitute_task(prompt: str, task: str) -> str:
    return prompt.replace("{{task}}", task)


def chain_step_note(steps: tuple[Step, ...] | list[Step], index: int) -> str | None:
    if index < 0 or index >= len(steps):
        return None
    step = steps[index]
    if step.kind != "agent":
        return None
    agent_steps = [item for item in steps if item.kind == "agent"]
    total = len(agent_steps)
    if total <= 1:
        return None
    position = sum(1 for item in steps[:index] if item.kind == "agent") + 1
    if step.name:
        label = f'"{step.name}"'
    elif step.skill:
        label = f'the "{step.skill}" skill'
    else:
        label = "this step"
    sentences = [
        f"This run is a chain of {total} agent steps; you are running step {position} of {total}.",
        f"Your job in THIS step is {label} — do its work in full.",
    ]
    if position > 1:
        sentences.append(
            "An earlier step in this same run may already have reported its own work done "
            "(in its report, or in this run's handoff file); that does not mean "
            f"step {position}'s work is done."
        )
    sentences.append(
        f"Only end this turn with CEZ:DONE once step {position}'s own goal is achieved, "
        "not just the run's overall task."
    )
    return " ".join(sentences)


def failure_appendix(output: str) -> str:
    return (
        "A verification command failed after the previous attempt. "
        f"Fix the cause. Failing output:\n\n{output}"
    )


def pending_reports_block(reports: list[dict[str, object]]) -> str | None:
    if not reports:
        return None
    lines: list[str] = []
    for entry in reports:
        title = str(entry.get("title", ""))
        from_id = str(entry.get("from_id", ""))
        at = str(entry.get("at", ""))
        text = str(entry.get("text", ""))
        lines.append(f'- "{title}" ({from_id}, {at}): {text}')
    return "## Reports from your dispatched tasks\n" + "\n".join(lines)


def build_user_prompt(
    steps: tuple[Step, ...] | list[Step],
    index: int,
    task: str,
    *,
    check_failure: str = "",
    pending_note: str = "",
    reports: list[dict[str, object]] | None = None,
) -> str:
    step = steps[index]
    parts: list[str] = []
    note = chain_step_note(steps, index)
    if note:
        parts.append(note)
    block = pending_reports_block(reports or [])
    if block:
        parts.append(block)
    template = step.prompt or "{{task}}"
    parts.append(substitute_task(template, task))
    if check_failure:
        parts.append(failure_appendix(check_failure))
    if pending_note:
        parts.append(pending_note)
    return "\n\n".join(parts)


RESTART_CONTINUATION = (
    "The cezar process restarted while you were working on this task. Read the handoff file "
    "(CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off."
)
