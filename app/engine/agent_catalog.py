"""Agent config files, the same ids and precedence strings as `catalog.ts`.

Paths are relative to the repo or to an agent home. A client names an id, never
a path. Hosted mode does not serve a file that lives outside the repo.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

_CLAUDE = "https://code.claude.com/docs/en/settings"
_CLAUDE_MEM = "https://code.claude.com/docs/en/memory"
_CLAUDE_MCP = "https://code.claude.com/docs/en/mcp"
_CODEX = "https://developers.openai.com/codex/config-reference"
_CODEX_MD = "https://developers.openai.com/codex/guides/agents-md"
_OPENCODE = "https://opencode.ai/docs/config/"
_OPENCODE_RULES = "https://opencode.ai/docs/rules/"
_CURSOR = "https://cursor.com/docs/cli/reference/configuration"
_COPILOT = "https://docs.github.com/en/copilot/how-tos/copilot-cli"
_COPILOT_MCP = "https://docs.github.com/en/copilot/how-tos/copilot-cli#mcp-servers"
_COPILOT_DOC = (
    "https://docs.github.com/en/copilot/customizing-copilot/"
    "adding-repository-custom-instructions-for-github-copilot"
)
_PRIVATE = (
    "https://github.com/open-mercato/cezar/blob/main/.ai/specs/2026-10-07-private-project-mcp.md"
)
_HOT = (
    "Edits to most keys — including permissions and hooks — "
    "apply to a running session without a restart."
)


@dataclass(frozen=True, slots=True)
class ConfigFile:
    id: str
    runners: tuple[str, ...]
    kind: str
    scope: str
    home: str
    parts: tuple[str, ...]
    label: str
    format: str
    tracked: str
    precedence: str
    docs_url: str
    seeded: bool = False
    holds_mcp: bool = False
    private: bool = False
    hot_reload: str = ""


def _file(
    ident: str,
    runners: tuple[str, ...],
    kind: str,
    scope: str,
    home: str,
    parts: tuple[str, ...],
    label: str,
    fmt: str,
    tracked: str,
    precedence: str,
    docs: str,
    **flags: bool | str,
) -> ConfigFile:
    return ConfigFile(
        id=ident,
        runners=runners,
        kind=kind,
        scope=scope,
        home=home,
        parts=parts,
        label=label,
        format=fmt,
        tracked=tracked,
        precedence=precedence,
        docs_url=docs,
        seeded=bool(flags.get("seeded", False)),
        holds_mcp=bool(flags.get("holds_mcp", False)),
        private=bool(flags.get("private", False)),
        hot_reload=str(flags.get("hot", "")),
    )


FILES: tuple[ConfigFile, ...] = (
    _file(
        "claude.user.settings",
        ("claude",),
        "settings",
        "user",
        "claude",
        ("settings.json",),
        "~/.claude/settings.json",
        "json",
        "outside-repo",
        "Lowest priority. Project and local settings override it key by key — "
        "except permission rules, which merge across all scopes.",
        _CLAUDE,
        hot=_HOT,
    ),
    _file(
        "claude.project.settings",
        ("claude",),
        "settings",
        "project",
        "",
        (".claude", "settings.json"),
        ".claude/settings.json",
        "json",
        "tracked",
        "Overrides user settings key by key (permission rules merge). Local settings override it.",
        _CLAUDE,
        hot=_HOT,
    ),
    _file(
        "claude.local.settings",
        ("claude",),
        "settings",
        "local",
        "",
        (".claude", "settings.local.json"),
        ".claude/settings.local.json",
        "json",
        "gitignored",
        "Highest of the file scopes — overrides project and user (permission rules merge). "
        "Git-ignored; copied into each run’s worktree so it takes effect immediately.",
        _CLAUDE,
        seeded=True,
        hot=_HOT,
    ),
    _file(
        "claude.project.mcp",
        ("claude",),
        "mcp",
        "project",
        "",
        (".mcp.json",),
        ".mcp.json",
        "json",
        "tracked",
        "Project-scoped MCP servers (key: mcpServers), shared via version control. "
        "Each requires approval before use; user- and local-scoped servers live in "
        "~/.claude.json, which cezar does not edit.",
        _CLAUDE_MCP,
        holds_mcp=True,
    ),
    _file(
        "claude.user.memory",
        ("claude",),
        "memory",
        "user",
        "claude",
        ("CLAUDE.md",),
        "~/.claude/CLAUDE.md",
        "markdown",
        "outside-repo",
        "Not overridden — every CLAUDE.md that loads is concatenated, this user file first.",
        _CLAUDE_MEM,
    ),
    _file(
        "claude.project.memory",
        ("claude",),
        "memory",
        "project",
        "",
        ("CLAUDE.md",),
        "CLAUDE.md",
        "markdown",
        "tracked",
        "Concatenated after the user file, not replacing it. Claude does not read AGENTS.md — "
        "import it here with @AGENTS.md. Runs read the committed copy.",
        _CLAUDE_MEM,
    ),
    _file(
        "claude.local.memory",
        ("claude",),
        "memory",
        "local",
        "",
        ("CLAUDE.local.md",),
        "CLAUDE.local.md",
        "markdown",
        "gitignored",
        "Loads alongside CLAUDE.md, concatenated last. Git-ignored; copied into each run’s "
        "worktree so it takes effect immediately.",
        _CLAUDE_MEM,
        seeded=True,
    ),
    _file(
        "codex.user.config",
        ("codex",),
        "settings",
        "user",
        "codex",
        ("config.toml",),
        "~/.codex/config.toml",
        "toml",
        "outside-repo",
        "User-level defaults. A trusted project’s .codex/config.toml overrides these; some keys "
        "(provider, auth, telemetry) cannot be overridden at project scope. MCP servers live "
        "here under [mcp_servers.<id>].",
        _CODEX,
        holds_mcp=True,
    ),
    _file(
        "codex.project.config",
        ("codex",),
        "settings",
        "project",
        "",
        (".codex", "config.toml"),
        ".codex/config.toml",
        "toml",
        "tracked",
        "Applies only in projects you have trusted. Some keys (provider, auth, telemetry) "
        "cannot be overridden here. MCP servers go under [mcp_servers.<id>]. "
        "Runs read the committed copy.",
        _CODEX,
        holds_mcp=True,
    ),
    _file(
        "codex.user.memory",
        ("codex",),
        "memory",
        "user",
        "codex",
        ("AGENTS.md",),
        "~/.codex/AGENTS.md",
        "markdown",
        "outside-repo",
        "Global instructions, read first (an AGENTS.override.md beside it wins if present). "
        "Project AGENTS.md files are concatenated after and override it.",
        _CODEX_MD,
    ),
    _file(
        "opencode.user.config",
        ("opencode",),
        "settings",
        "user",
        "opencode",
        ("opencode.json",),
        "~/.config/opencode/opencode.json",
        "jsonc",
        "outside-repo",
        "Global config. Merged with the project config, not replaced — later configs override "
        'earlier ones only for conflicting keys. MCP servers live under the "mcp" key.',
        _OPENCODE,
        holds_mcp=True,
    ),
    _file(
        "opencode.project.config",
        ("opencode",),
        "settings",
        "project",
        "",
        ("opencode.json",),
        "opencode.json",
        "jsonc",
        "tracked",
        "Merged over the global config per conflicting key (not a wholesale replace). "
        'MCP servers live under the "mcp" key. Runs read the committed copy.',
        _OPENCODE,
        holds_mcp=True,
    ),
    _file(
        "opencode.user.memory",
        ("opencode",),
        "memory",
        "user",
        "opencode",
        ("AGENTS.md",),
        "~/.config/opencode/AGENTS.md",
        "markdown",
        "outside-repo",
        "Global rules. First match wins across scopes: if a project AGENTS.md exists, "
        "this global file is not read at all.",
        _OPENCODE_RULES,
    ),
    _file(
        "copilot.user.config",
        ("copilot",),
        "settings",
        "user",
        "copilot",
        ("config.json",),
        "~/.copilot/config.json",
        "json",
        "outside-repo",
        "The CLI's own persisted settings, including the model chosen with /model. "
        "A --model flag or COPILOT_MODEL overrides it for one run; cezar always passes "
        "--model, so this is what a run would get otherwise.",
        _COPILOT,
    ),
    _file(
        "copilot.user.mcp",
        ("copilot",),
        "mcp",
        "user",
        "copilot",
        ("mcp-config.json",),
        "~/.copilot/mcp-config.json",
        "json",
        "outside-repo",
        "The MCP servers every session starts with. --additional-mcp-config AUGMENTS this "
        "file for one run rather than replacing it; --disable-mcp-server turns one off.",
        _COPILOT_MCP,
        holds_mcp=True,
    ),
    _file(
        "copilot.project.settings",
        ("copilot",),
        "settings",
        "project",
        "",
        (".github", "copilot", "settings.json"),
        ".github/copilot/settings.json",
        "json",
        "tracked",
        "Repository settings, read over the user config. Runs read the committed copy.",
        _COPILOT,
    ),
    _file(
        "copilot.local.settings",
        ("copilot",),
        "settings",
        "local",
        "",
        (".github", "copilot", "settings.local.json"),
        ".github/copilot/settings.local.json",
        "json",
        "gitignored",
        "The personal layer over the repository settings. Not committed, so a run only "
        "sees it if the file is in the worktree.",
        _COPILOT,
    ),
    _file(
        "copilot.user.memory",
        ("copilot",),
        "memory",
        "user",
        "copilot",
        ("copilot-instructions.md",),
        "~/.copilot/copilot-instructions.md",
        "markdown",
        "outside-repo",
        "Personal instructions applied to every repository.",
        _COPILOT_DOC,
    ),
    _file(
        "copilot.project.memory",
        ("copilot",),
        "memory",
        "project",
        "",
        (".github", "copilot-instructions.md"),
        ".github/copilot-instructions.md",
        "markdown",
        "tracked",
        "Repository instructions, read alongside AGENTS.md rather than instead of it. "
        "--no-custom-instructions turns both off. Runs read the committed copy.",
        _COPILOT_DOC,
    ),
    _file(
        "cursor.user.settings",
        ("cursor",),
        "settings",
        "user",
        "cursor",
        ("cli-config.json",),
        "~/.cursor/cli-config.json",
        "json",
        "outside-repo",
        "Global Cursor Agent CLI settings (permissions, display, model, sandbox). "
        "All non-permission keys live here.",
        _CURSOR,
    ),
    _file(
        "cursor.project.settings",
        ("cursor",),
        "settings",
        "project",
        "",
        (".cursor", "cli.json"),
        ".cursor/cli.json",
        "json",
        "tracked",
        "Project-level permissions only — Cursor docs: all other CLI settings must stay "
        "in the global cli-config.json.",
        _CURSOR,
    ),
    _file(
        "cursor.user.mcp",
        ("cursor",),
        "mcp",
        "user",
        "cursor",
        ("mcp.json",),
        "~/.cursor/mcp.json",
        "json",
        "outside-repo",
        "User-scoped MCP servers for Cursor Agent CLI (`agent mcp …`).",
        _CURSOR,
        holds_mcp=True,
    ),
    _file(
        "cursor.project.mcp",
        ("cursor",),
        "mcp",
        "project",
        "",
        (".cursor", "mcp.json"),
        ".cursor/mcp.json",
        "json",
        "tracked",
        "Project-scoped MCP servers for Cursor Agent CLI, shared via version control.",
        _CURSOR,
        holds_mcp=True,
    ),
    _file(
        "cezar.private.mcp",
        ("claude", "codex", "opencode", "junie", "copilot"),
        "mcp",
        "local",
        "",
        (".ai", "cezar", "mcp.local.json"),
        ".ai/cezar/mcp.local.json",
        "json",
        "gitignored",
        "Private MCP servers for this project only — same shape as .mcp.json "
        "(key: mcpServers). Lives in cezar's git-ignored data dir, never committed.",
        _PRIVATE,
        holds_mcp=True,
        private=True,
    ),
    _file(
        "project.agents",
        ("codex", "opencode", "copilot"),
        "memory",
        "project",
        "",
        ("AGENTS.md",),
        "AGENTS.md",
        "markdown",
        "tracked",
        "Read by Codex, OpenCode and Copilot CLI (Claude ignores it). Codex concatenates "
        "it root-down; OpenCode uses the first match; Copilot reads it alongside "
        ".github/copilot-instructions.md. Runs read the committed copy.",
        _OPENCODE_RULES,
    ),
)


def homes(root: Path | None = None) -> dict[str, Path]:
    base = root or Path.home()
    return {
        "claude": base / ".claude",
        "codex": base / ".codex",
        "opencode": base / ".config" / "opencode",
        "cursor": base / ".cursor",
        "copilot": base / ".copilot",
    }


def find_file(file_id: str) -> ConfigFile | None:
    return next((item for item in FILES if item.id == file_id), None)


def resolve_path(item: ConfigFile, repo: Path, home_root: Path | None = None) -> Path:
    if item.home:
        return homes(home_root)[item.home].joinpath(*item.parts)
    return repo.joinpath(*item.parts)


def read_bytes(path: Path) -> tuple[str, str | None]:
    if not path.is_file():
        return "", None
    raw = path.read_bytes()
    return raw.decode("utf-8", errors="replace"), hashlib.sha256(raw).hexdigest()


def user_mcp(path: Path) -> dict[str, object]:
    """Server names from Claude's user state file. The file body is not returned.

    A missing file is an empty readable list. A file over 1 MiB, or one that
    does not parse, is not readable.
    """
    shown = str(path)
    try:
        size = path.stat().st_size
    except OSError:
        return {"path": shown, "servers": [], "readable": True}
    if size > 1_048_576:
        return {"path": shown, "servers": [], "readable": False}
    try:
        import json

        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError:
        return {"path": shown, "servers": [], "readable": False}
    servers = loaded.get("mcpServers") if isinstance(loaded, dict) else None
    names: list[str] = []
    if isinstance(servers, dict):
        names = sorted(key for key in servers if isinstance(key, str))
    return {"path": shown, "servers": names, "readable": True}


def describe(item: ConfigFile, repo: Path, *, editable: bool) -> dict[str, object]:
    content, version = read_bytes(resolve_path(item, repo))
    body: dict[str, object] = {
        "id": item.id,
        "runners": list(item.runners),
        "kind": item.kind,
        "scope": item.scope,
        "label": item.label,
        "path": item.label if item.home else str(Path(*item.parts)),
        "format": item.format,
        "tracked": item.tracked,
        "seeded": item.seeded,
        "holdsMcp": item.holds_mcp,
        "private": item.private,
        "precedence": item.precedence,
        "docsUrl": item.docs_url,
        "exists": version is not None,
        "size": len(content.encode()),
        "version": version,
        "writable": editable and item.tracked != "outside-repo",
    }
    if item.hot_reload:
        body["hotReload"] = item.hot_reload
    return body
