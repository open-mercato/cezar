"""Argv each backend is spawned with. Matched to the TypeScript runners.

Claude maps a bash allowlist onto `Bash(<prefix>:*)`. Pi has no prefix form, so a
non-empty allowlist drops Bash entirely (fail closed). Copilot does not translate
allowlists: its argv is `--allow-all-tools`, and a partial map would look like a sandbox.
"""

from __future__ import annotations

import os

CLAUDE_HEADLESS_GUIDANCE = (
    "You are running Claude Code through cezar's headless integration. "
    "Permission prompts cannot be answered in the cezar cockpit. If a tool call is denied, "
    "do not suggest Shift+Tab, /permissions, changing Claude permission settings, or replying "
    "Continue to retry it. Report the exact blocked tool and path or command, stop retrying "
    "that operation, and explain that the task's actual Open in… action is the workaround: "
    "continue in an interactive claude --resume <session id> shell in the task worktree and "
    "approve the prompt there. Do not use filesystem workarounds or claim that cezar can "
    "approve the request."
)

_PI_TOOLS = {
    "Read": "read",
    "Bash": "bash",
    "Edit": "edit",
    "Write": "write",
    "Grep": "grep",
    "Glob": "find",
}


def build_allowed_tools(
    allowed: tuple[str, ...] | list[str], bash_allowlist: tuple[str, ...] | list[str]
) -> list[str]:
    out: list[str] = []
    for tool in allowed:
        if tool == "Bash" and any(item.strip() for item in bash_allowlist):
            for prefix in bash_allowlist:
                cleaned = prefix.strip()
                if cleaned:
                    out.append(f"Bash({cleaned}:*)")
        else:
            out.append(tool)
    return out


def claude_system_prompt(system_prompt: str) -> str:
    if system_prompt.strip():
        return f"{system_prompt}\n\n---\n\n{CLAUDE_HEADLESS_GUIDANCE}"
    return CLAUDE_HEADLESS_GUIDANCE


def build_claude_args(
    *,
    system_prompt: str,
    model: str,
    allowed_tools: tuple[str, ...] | list[str],
    bash_allowlist: tuple[str, ...] | list[str],
    session_id: str = "",
    resume: bool = False,
    approval_gate: bool = False,
    extra_dirs: tuple[str, ...] = (),
) -> list[str]:
    args = [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits" if approval_gate else "dontAsk",
        "--append-system-prompt",
        claude_system_prompt(system_prompt),
    ]
    if session_id:
        args.extend(["--resume" if resume else "--session-id", session_id])
    allowed = build_allowed_tools(allowed_tools, bash_allowlist)
    if allowed:
        args.extend(["--allowedTools", ",".join(allowed)])
    if model:
        args.extend(["--model", model])
    for directory in extra_dirs:
        args.extend(["--add-dir", directory])
    return args


def build_cursor_args(*, user_prompt: str, system_prompt: str, model: str) -> list[str]:
    prompt = f"{system_prompt}\n\n---\n\n{user_prompt}" if system_prompt else user_prompt
    args = ["-p", "--force", "--trust", "--output-format", "stream-json"]
    if model.strip():
        args.extend(["--model", model.strip()])
    args.append(prompt)
    return args


def build_pi_args(
    *,
    system_prompt: str,
    model: str,
    allowed_tools: tuple[str, ...] | list[str],
    bash_allowlist: tuple[str, ...] | list[str],
    session_id: str = "",
    resume: bool = False,
) -> list[str]:
    args = ["--mode", "rpc"]
    if session_id:
        args.extend(["--session" if resume else "--session-id", session_id])
    if system_prompt:
        args.extend(["--append-system-prompt", system_prompt])
    if model:
        args.extend(["--model", model])
    restricted = bool(bash_allowlist) and any(item.strip() for item in bash_allowlist)
    names: list[str] = []
    for tool in allowed_tools:
        if tool == "Bash" and restricted:
            continue
        names.append(_PI_TOOLS.get(tool, tool.lower()))
    unique = list(dict.fromkeys(names))
    if unique:
        args.extend(["--tools", ",".join(unique)])
    return args


def build_codex_args() -> list[str]:
    return ["app-server"]


def codex_sandbox(*, network_off: bool) -> str:
    return "workspace-write" if network_off else "danger-full-access"


def build_opencode_args(port: int) -> list[str]:
    return ["serve", "--hostname", "127.0.0.1", "--port", str(port)]


def build_junie_args(cwd: str) -> list[str]:
    return ["--acp=true", "-p", cwd]


def build_copilot_args(*, model: str, extra_dirs: tuple[str, ...] = ()) -> list[str]:
    args = ["--acp", "--allow-all-tools", "--no-auto-update"]
    if model:
        args.extend(["--model", model])
    for directory in extra_dirs:
        if os.path.isdir(directory):
            args.extend(["--add-dir", directory])
    return args
