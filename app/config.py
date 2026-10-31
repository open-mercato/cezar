"""Process configuration. The only module that reads the environment."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from stario.http.config import ServerConfig

VERSION = "0.1.0"

# User-selectable runners, in the same order as the TypeScript cockpit.
RUNNERS: tuple[str, ...] = ("claude", "codex", "opencode", "cursor", "pi", "junie", "copilot")

_BIN_ENV = {
    "claude": "CEZ_CLAUDE_BIN",
    "codex": "CEZ_CODEX_BIN",
    "opencode": "CEZ_OPENCODE_BIN",
    "cursor": "CEZ_CURSOR_BIN",
    "pi": "CEZ_PI_BIN",
    "junie": "CEZ_JUNIE_BIN",
    "copilot": "CEZ_COPILOT_BIN",
}

_DEFAULT_BIN = {
    "claude": "claude",
    "codex": "codex",
    "opencode": "opencode",
    "cursor": "cursor-agent",
    "pi": "pi",
    "junie": "junie",
    "copilot": "copilot",
}


def _flag(name: str, default: str) -> bool:
    return os.environ.get(name, default) == "1"


@dataclass(frozen=True, slots=True)
class Config:
    app_name: str
    version: str
    data_dir: Path
    db_path: Path
    repo_root: Path
    # Unset CEZ_DRY_RUN spawns the real CLI, matching the TypeScript app.
    # Compose sets CEZ_DRY_RUN=1 so a published container never launches an agent.
    dry_run: bool
    dispatch_enabled: bool
    tick_seconds: float
    check_timeout_seconds: float
    runner_bins: dict[str, str]
    listen_host: str
    listen_port: int
    # Claude `--permission-mode acceptEdits` when set. There is still no cockpit approval channel.
    approval_gate: bool = False
    # Codex sandbox opt-out: `workspace-write` instead of `danger-full-access`.
    codex_network_off: bool = False
    # `summary` on Codex `turn/start`: auto, concise, detailed or none. An unknown value is auto.
    codex_reasoning: str = "auto"
    # Exact "1": every agent's native model setting is authoritative, a task cannot override it.
    # The Agents settings page can turn the same lock on (`modelsLocked`).
    agent_models_locked: bool = False
    # Exact "0" keeps the host TMPDIR. Otherwise each agent run gets `<data_dir>/tmp/<run id>`.
    agent_tmpdir: bool = True
    github_token: str = ""
    github_api: str = "https://api.github.com"
    jira_base: str = ""
    jira_email: str = ""
    jira_token: str = ""
    linear_key: str = ""
    linear_api: str = "https://api.linear.app/graphql"
    design_mode: bool = True
    browse_root: str = ""
    projects_dir: Path = Path("data/projects")
    worktree_keep: int = 10
    runs_keep: int = 300
    archived_keep: int = 500
    # Exact "1" forces autonomous. Exact "0" forces it off. Anything else leaves
    # the composer on "source-dependent", which plans a normal run.
    autonomous_default: bool | None = None
    # Exact "0" runs a new task in the checkout. Unset and "1" use a worktree.
    worktree_default: bool = True
    autosave: bool = False
    autosave_interval_s: float = 90
    title_updates: bool = True
    workflow_webhooks: bool = False
    task_process_reap: bool = True
    repo_lock: bool = True
    auto_resume: bool = True
    monitoring_wake_seconds: float = 300
    # Dashboard totals. CEZ_HIDE_TOKEN_METRICS hides both; the other two hide one.
    hide_token_usage: bool = False
    hide_cost: bool = False
    hide_token_metrics: bool = False

    @property
    def hosted(self) -> bool:
        return os.environ.get("CEZ_REMOTE") == "1" or self.listen_host not in (
            "127.0.0.1",
            "localhost",
            "::1",
        )

    @classmethod
    def from_env(cls) -> Config:
        # Yard sets PROJECT_DATA_DIR=/data, a host directory that survives every deploy.
        # CEZ_HOME is the same directory when that pin is absent (an empty value does not count).
        data_dir = _data_dir()
        data_dir.mkdir(parents=True, exist_ok=True)
        repo = Path(os.environ.get("CEZ_REPO", os.getcwd())).expanduser().resolve()
        bins = {
            runner: os.environ.get(_BIN_ENV[runner], _DEFAULT_BIN[runner]) for runner in RUNNERS
        }
        # TypeScript names this CEZ_CURSOR_AGENT_BIN. CEZ_CURSOR_BIN still works.
        cursor = os.environ.get("CEZ_CURSOR_AGENT_BIN") or bins["cursor"]
        bins["cursor"] = cursor
        listen_host = os.environ.get("STARIO_HOST", "127.0.0.1")
        return cls(
            app_name=os.environ.get("APP_NAME", "cezar"),
            version=VERSION,
            data_dir=data_dir,
            db_path=data_dir / "app.sqlite3",
            repo_root=repo,
            dry_run=_flag("CEZ_DRY_RUN", "0"),
            dispatch_enabled=os.environ.get("CEZ_DISPATCH", "1") != "0",
            tick_seconds=0.2,
            check_timeout_seconds=600,
            runner_bins=bins,
            listen_host=listen_host,
            listen_port=_port(os.environ.get("STARIO_PORT", "4321")),
            approval_gate=_flag("CEZ_APPROVAL_GATE", "0"),
            codex_network_off=os.environ.get("CEZ_CODEX_NETWORK") == "0",
            codex_reasoning=_reasoning(os.environ.get("CEZ_CODEX_REASONING")),
            agent_models_locked=os.environ.get("CEZ_AGENT_MODELS_LOCKED") == "1",
            agent_tmpdir=os.environ.get("CEZ_AGENT_TMPDIR") != "0",
            github_token=os.environ.get("CEZ_GITHUB_TOKEN", os.environ.get("GITHUB_TOKEN", "")),
            github_api=os.environ.get("CEZ_GITHUB_API", "https://api.github.com"),
            jira_base=os.environ.get("CEZ_JIRA_BASE", ""),
            jira_email=os.environ.get("CEZ_JIRA_EMAIL", ""),
            jira_token=os.environ.get("CEZ_JIRA_TOKEN", ""),
            linear_key=os.environ.get("CEZ_LINEAR_API_KEY", ""),
            linear_api=os.environ.get("CEZ_LINEAR_API", "https://api.linear.app/graphql"),
            design_mode=_design_mode(listen_host),
            browse_root=os.environ.get("CEZ_BROWSE_ROOT", str(Path.home())),
            projects_dir=_projects_dir(data_dir),
            worktree_keep=_keep(os.environ.get("CEZ_WORKTREE_RETENTION"), 10),
            runs_keep=_keep(os.environ.get("CEZ_RUNS_KEEP"), 300),
            archived_keep=_keep(os.environ.get("CEZ_ARCHIVED_RUNS_KEEP"), 500),
            autonomous_default=_tri("CEZ_AUTONOMOUS_DEFAULT"),
            worktree_default=os.environ.get("CEZ_WORKTREE_DEFAULT") != "0",
            autosave=os.environ.get("CEZ_AUTOSAVE") == "1",
            title_updates=os.environ.get("CEZ_TITLE_UPDATES") != "0",
            workflow_webhooks=os.environ.get("CEZ_WORKFLOW_WEBHOOKS") == "1",
            task_process_reap=os.environ.get("CEZ_TASK_PROCESS_REAP") != "0",
            repo_lock=os.environ.get("CEZ_DISABLE_REPO_LOCK") != "1",
            hide_token_usage=_flag("CEZ_HIDE_TOKEN_USAGE", "0"),
            hide_cost=_flag("CEZ_HIDE_COST", "0"),
            hide_token_metrics=_flag("CEZ_HIDE_TOKEN_METRICS", "0"),
        )


REASONING_SUMMARIES = ("auto", "concise", "detailed", "none")


def _reasoning(raw: str | None) -> str:
    """`reasoningSummary` in `codex-app-server-runner.ts`: unset or unknown is `auto`."""
    value = (raw or "").strip().lower()
    return value if value in REASONING_SUMMARIES else "auto"


def _tri(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw == "1":
        return True
    if raw == "0":
        return False
    return None


def no_banner() -> bool:
    """`CEZ_NO_BANNER=1` silences the serve promo. Read at the call."""
    return os.environ.get("CEZ_NO_BANNER") == "1"


def terminal_enabled(hosted: bool) -> bool:
    """`terminalEnabled` in `packages/cezar/src/server/capabilities.ts`. Read at the call.

    `1` opts a hosted cockpit in, `0` turns it off everywhere, and unset (or any other
    value) follows local handoff: on locally, off when hosted.
    """
    raw = os.environ.get("CEZ_TERMINAL")
    if raw == "1":
        return True
    if raw == "0":
        return False
    return not hosted


def single_project() -> bool:
    """Exact `1`, same rule as the TypeScript registry. `true` does not count."""
    return os.environ.get("CEZ_SINGLE_PROJECT") == "1"


def followups_enabled() -> bool:
    return os.environ.get("CEZ_FOLLOWUPS") == "1"


def automations_enabled() -> bool:
    return os.environ.get("CEZ_AUTOMATIONS") != "0"


def instance_id() -> str:
    return os.environ.get("CEZ_INSTANCE_ID", "").strip()


def auth_user() -> str:
    return os.environ.get("CEZ_AUTH_USER", "cezar").strip() or "cezar"


def auth_password() -> str:
    return os.environ.get("CEZ_AUTH_PASSWORD", "").strip()


def claude_state_file() -> Path:
    """`~/.claude.json`, or `<CLAUDE_CONFIG_DIR>/.claude.json` when that home is set.

    Read at the call so a test can point it at a temporary directory.
    """
    raw = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    if raw:
        return Path(raw) / ".claude.json"
    return Path.home() / ".claude.json"


def todos_path(repo: Path) -> Path:
    raw = os.environ.get("CEZ_TODOS_FILE", "").strip()
    if raw:
        return Path(raw)
    return repo / ".ai" / "cezar" / "todos.json"


def listen_config() -> ServerConfig:
    """Listen address for `python -m app.main`. Cezar's cockpit port is 4321."""
    cfg = Config.from_env()
    return ServerConfig(host=cfg.listen_host, port=cfg.listen_port)


def apply_overrides(*, repo: str | None = None, data_dir: str | None = None) -> None:
    if repo is not None:
        os.environ["CEZ_REPO"] = repo
    if data_dir is not None:
        os.environ["PROJECT_DATA_DIR"] = data_dir


def _data_dir() -> Path:
    explicit = os.environ.get("PROJECT_DATA_DIR", "").strip()
    if explicit:
        return Path(explicit)
    home = os.environ.get("CEZ_HOME", "").strip()
    if home:
        return Path(home).expanduser()
    return Path("data")


def _projects_dir(data_dir: Path) -> Path:
    raw = os.environ.get("CEZ_PROJECTS_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    return data_dir / "projects"


def _design_mode(listen_host: str) -> bool:
    hosted = _flag("CEZ_REMOTE", "0") or listen_host not in ("127.0.0.1", "localhost", "::1")
    if hosted:
        return False
    return os.environ.get("CEZ_DESIGN_MODE", "1") == "1"


def _keep(raw: str | None, default: int) -> int:
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value >= 0 else default


def redact_secrets_enabled(source: Mapping[str, str] | None = None) -> bool:
    """On unless `CEZ_REDACT_SECRETS=0`. Read at the call so a test can flip it."""
    return _read(source, "CEZ_REDACT_SECRETS", "1") != "0"


def agent_env_full(source: Mapping[str, str] | None = None) -> bool:
    """`1`, `true`, and `yes` restore the full parent environment. `0` and `false` do not."""
    value = _read(source, "CEZ_AGENT_ENV_FULL", "").strip().lower()
    return value not in ("", "0", "false")


def env_passthrough(source: Mapping[str, str] | None = None) -> str:
    return _read(source, "CEZ_ENV_PASSTHROUGH", "")


def secrets_keychain_enabled() -> bool:
    """`CEZ_SECRETS_KEYCHAIN=0` forces the file key. Anything else may use a keychain."""
    return os.environ.get("CEZ_SECRETS_KEYCHAIN", "1") != "0"


def agent_accounts_enabled(config: Config) -> bool:
    """Hosted cockpits hide accounts unless `CEZ_REMOTE_AGENT_ACCOUNTS=1`."""
    if os.environ.get("CEZ_REMOTE_AGENT_ACCOUNTS") == "1":
        return True
    return not config.hosted


def _read(source: Mapping[str, str] | None, name: str, default: str) -> str:
    env: Mapping[str, str] = os.environ if source is None else source
    if name in env:
        return env[name]
    upper = name.upper()
    for key, value in env.items():
        if key.upper() == upper:
            return value
    return default


def _port(raw: str) -> int:
    try:
        port = int(raw)
    except ValueError:
        return 4321
    if 1 <= port <= 65535:
        return port
    return 4321
