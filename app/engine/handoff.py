"""Per-task handoff journal.

`.ai/cezar/runs/<id>.handoff.md`, next to the run and outside the worktree.
Seeding and heartbeats are best-effort. The agent is told the path through
`CEZ_HANDOFF_FILE`.
"""

from __future__ import annotations

from pathlib import Path

HANDOFF_INSTRUCTIONS = (
    "CEZ_HANDOFF_FILE is this task's rolling handoff. Keep the Progress log and "
    "Resume notes current; cezar also writes a heartbeat there."
)
MAX_HEARTBEATS = 100


def handoff_path(data_dir: Path, run_id: str) -> Path:
    return data_dir / "runs" / f"{run_id}.handoff.md"


def seed_handoff(
    data_dir: Path,
    *,
    run_id: str,
    title: str,
    workflow: str,
    task: str,
    branch: str = "",
    worktree: str = "",
) -> Path:
    path = handoff_path(data_dir, run_id)
    if path.is_file():
        return path
    lines = [
        f"# Handoff — {title}",
        "",
        f"**Task id:** {run_id}",
        f"**Workflow:** {workflow}",
    ]
    if branch:
        lines.append(f"**Branch:** {branch}")
    if worktree:
        lines.append(f"**Worktree:** {worktree}")
    lines.extend(
        [
            "",
            "## Goal",
            "",
            task.strip() or "(given as attachments only)",
            "",
            "## Progress log",
            "",
            "## Resume notes",
            "",
        ]
    )
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines), encoding="utf-8")
    except OSError:
        return path
    return path


def append_heartbeat(data_dir: Path, run_id: str, note: str, *, at: str) -> None:
    path = handoff_path(data_dir, run_id)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    line = f"- {at} — {note}\n"
    marker = "## Progress log\n"
    idx = text.find(marker)
    if idx >= 0:
        head = text[: idx + len(marker)]
        tail = text[idx + len(marker) :].lstrip("\n")
        merged = f"{head}\n{line}{tail}"
    else:
        merged = text + ("" if text.endswith("\n") else "\n") + line
    try:
        path.write_text(_bound(merged), encoding="utf-8")
    except OSError:
        return


def _bound(text: str) -> str:
    marker = "## Progress log\n"
    idx = text.find(marker)
    if idx < 0:
        return text
    start = idx + len(marker)
    rest = text[start:]
    boundary = rest.find("\n## ")
    end = len(text) if boundary < 0 else start + boundary
    section = text[start:end]
    beats = [line for line in section.splitlines() if line.startswith("- ")]
    if len(beats) <= MAX_HEARTBEATS:
        return text
    drop = set(beats[MAX_HEARTBEATS:])
    kept = [line for line in section.splitlines() if line not in drop or not line.startswith("- ")]
    return text[:start] + "\n".join(kept) + text[end:]
