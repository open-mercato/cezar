"""Answers the settings pages save and render back.

A base branch is stored on the project by the engine. Required checks, the
tracker connection, the global prompt, org skill repos, and the memory cap
live in this directory. The run loop reads the prompt, the checks, the repos,
and the memory cap.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from stario.json import dumps

from app.config import RUNNERS
from app.integrations.clients import forge_base_issue

_CHECK = re.compile(r"[A-Za-z0-9_-]{1,80}")
_REF = re.compile(r"[A-Za-z0-9._/-]{1,80}")
KINDS = ("jira", "linear")
MEMORY_MIN = 256
MEMORY_MAX = 65_536
PROMPT_MAX = 20_000


def _load(path: Path) -> dict[str, object]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _save(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dumps(payload) + "\n", encoding="utf-8")
    path.chmod(0o600)


def checks_path(data_dir: Path, project_id: str) -> Path:
    return data_dir / "project-settings" / f"{project_id}.json"


def read_checks(data_dir: Path, project_id: str) -> list[str]:
    raw = _load(checks_path(data_dir, project_id)).get("requiredChecks")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, str)]


def write_checks(data_dir: Path, project_id: str, names: list[str]) -> None:
    current = _load(checks_path(data_dir, project_id))
    current["requiredChecks"] = names
    _save(checks_path(data_dir, project_id), current)


def read_retention(data_dir: Path, project_id: str) -> int | None:
    raw = _load(checks_path(data_dir, project_id)).get("worktreeRetention")
    if isinstance(raw, bool) or not isinstance(raw, int) or not 0 <= raw <= 1000:
        return None
    return raw


def write_retention(data_dir: Path, project_id: str, keep: int) -> None:
    current = _load(checks_path(data_dir, project_id))
    current["worktreeRetention"] = keep
    _save(checks_path(data_dir, project_id), current)


def parse_retention(raw: object) -> tuple[int | None, str | None]:
    if isinstance(raw, str) and raw.isdecimal():
        raw = int(raw)
    if isinstance(raw, bool) or not isinstance(raw, int) or not 0 <= raw <= 1000:
        return None, "worktree retention is a whole number from 0 to 1000"
    return raw, None


def parse_checks(raw: str) -> tuple[list[str] | None, str | None]:
    names = [part.strip() for part in raw.split(",") if part.strip()]
    if len(names) > 20:
        return None, "at most 20 required checks"
    for name in names:
        if _CHECK.fullmatch(name) is None:
            return None, "a check name is letters, digits, _ and -"
    return names, None


@dataclass(frozen=True, slots=True)
class TrackerConnection:
    kind: str = "jira"
    site: str = ""
    email: str = ""
    token: str = ""


def tracker_path(data_dir: Path) -> Path:
    return data_dir / "tracker-connection.json"


def read_tracker(data_dir: Path) -> TrackerConnection:
    raw = _load(tracker_path(data_dir))
    kind = raw.get("kind")
    site = raw.get("site")
    email = raw.get("email")
    token = raw.get("token")
    return TrackerConnection(
        kind if isinstance(kind, str) and kind in KINDS else "jira",
        site if isinstance(site, str) else "",
        email if isinstance(email, str) else "",
        token if isinstance(token, str) else "",
    )


def write_tracker(data_dir: Path, row: TrackerConnection) -> None:
    _save(
        tracker_path(data_dir),
        {"kind": row.kind, "site": row.site, "email": row.email, "token": row.token},
    )


def parse_tracker(
    kind: str, site: str, email: str, token: str, previous: str
) -> tuple[TrackerConnection | None, str | None]:
    if kind not in KINDS:
        return None, "tracker is jira or linear"
    site, email, token = site.strip(), email.strip(), token.strip()
    if len(site) > 200 or len(email) > 200 or len(token) > 500:
        return None, "tracker fields are too long"
    if site:
        issue = forge_base_issue(site, "jira" if kind == "jira" else "linear")
        if issue:
            return None, issue
    if kind == "jira" and site and not email:
        return None, "jira needs an email with the site"
    return TrackerConnection(kind, site, email, token or previous), None


def tracker_overrides(data_dir: Path) -> dict[str, str]:
    """Stored credentials win over the process env when the row is complete."""
    row = read_tracker(data_dir)
    if row.kind == "jira" and row.site and row.email and row.token:
        return {"jira_base": row.site, "jira_email": row.email, "jira_token": row.token}
    if row.kind == "linear" and row.token:
        overrides = {"linear_key": row.token}
        if row.site:
            overrides["linear_api"] = row.site
        return overrides
    return {}


def prompt_path(data_dir: Path) -> Path:
    return data_dir / "global-instructions.json"


def read_prompt(data_dir: Path) -> str:
    raw = _load(prompt_path(data_dir)).get("systemPrompt")
    return raw if isinstance(raw, str) else ""


def write_prompt(data_dir: Path, prompt: str) -> None:
    _save(prompt_path(data_dir), {"systemPrompt": prompt})


def parse_prompt(prompt: str) -> str | None:
    if len(prompt) > PROMPT_MAX:
        return f"global prompt is at most {PROMPT_MAX} characters"
    return None


@dataclass(frozen=True, slots=True)
class SkillRepo:
    repo: str
    ref: str


def skills_path(data_dir: Path) -> Path:
    return data_dir / "global-skills.json"


def read_skill_repos(data_dir: Path) -> list[SkillRepo]:
    raw = _load(skills_path(data_dir)).get("repos")
    if not isinstance(raw, list):
        return []
    rows: list[SkillRepo] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        repo = item.get("repo")
        ref = item.get("ref")
        if isinstance(repo, str) and isinstance(ref, str):
            rows.append(SkillRepo(repo, ref))
    return rows


def write_skill_repos(data_dir: Path, rows: list[SkillRepo]) -> None:
    _save(skills_path(data_dir), {"repos": [{"repo": row.repo, "ref": row.ref} for row in rows]})


def parse_skill_repo(repo: str, ref: str) -> tuple[SkillRepo | None, str | None]:
    repo, ref = repo.strip(), ref.strip() or "main"
    if len(repo) > 500:
        return None, "a skill repo URL is at most 500 characters"
    if _REF.fullmatch(ref) is None:
        return None, "a ref is letters, digits, and . _ / -"
    if repo.startswith("/") or repo.startswith("file://"):
        if repo.startswith("-") or ".." in repo.split("/"):
            return None, "a local skill repo is an absolute path"
        return SkillRepo(repo, ref), None
    parsed = urlsplit(repo)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host or parsed.username or parsed.password:
        return None, "a skill repo is an https URL without credentials, or a local path"
    if host in ("localhost", "127.0.0.1", "::1"):
        return None, "a skill repo is not a loopback address"
    return SkillRepo(repo, ref), None


def memory_path(data_dir: Path) -> Path:
    return data_dir / "resources.json"


def read_memory(data_dir: Path) -> int | None:
    """The stored cap, in megabytes.

    The form rejects anything under 256 MB. A value already on disk is still
    enforced, down to 1 MB, so a test can cross the cap without a 256 MB tree.
    """
    raw = _load(memory_path(data_dir)).get("memoryLimitMb")
    if isinstance(raw, bool) or not isinstance(raw, int) or not 1 <= raw <= 1_048_576:
        return None
    return raw


def write_memory(data_dir: Path, limit: int | None) -> None:
    _save(memory_path(data_dir), {"memoryLimitMb": limit})


def parse_memory(raw: object) -> tuple[int | None, str | None]:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None, None
    if isinstance(raw, str) and raw.isdecimal():
        raw = int(raw)
    if isinstance(raw, bool) or not isinstance(raw, int):
        return None, "memory cap is a number of megabytes, or empty for no limit"
    if not MEMORY_MIN <= raw <= MEMORY_MAX:
        return None, f"memory cap is from {MEMORY_MIN} to {MEMORY_MAX} MB, or empty"
    return raw, None


# --- agent defaults (`defaultModels`, `defaultModelsAuto`, `modelsLocked`, planner, namer) ---

AUTO_RUNNERS = ("claude", "codex", "opencode", "pi")
MODEL_MAX = 200
DEFAULT_PLANNER_MODEL = "sonnet"
DEFAULT_NAMER_MODEL = "haiku"
MODELS_LOCKED_ERROR = (
    "agent models are locked — configure the model in the native coding-agent settings"
)


@dataclass(frozen=True, slots=True)
class AgentDefaults:
    """`defaultModels`, `defaultModelsAuto`, `modelsLocked`, `plannerModel`, `namerModel`."""

    models: dict[str, str]
    auto: tuple[str, ...] = ()
    locked: bool = False
    planner_model: str = DEFAULT_PLANNER_MODEL
    namer_model: str = DEFAULT_NAMER_MODEL

    def model_for(self, runner: str) -> str:
        """The model a new task on `runner` starts with. Empty is auto: no `--model` flag."""
        if self.locked:
            return ""
        return self.models.get(runner, "")


def agent_defaults_path(data_dir: Path) -> Path:
    return data_dir / "agent-defaults.json"


def read_agent_defaults(data_dir: Path) -> AgentDefaults:
    raw = _load(agent_defaults_path(data_dir))
    models: dict[str, str] = {}
    stored = raw.get("defaultModels")
    if isinstance(stored, dict):
        for runner, value in stored.items():
            if runner in RUNNERS and isinstance(value, str) and value.strip():
                models[runner] = value.strip()[:MODEL_MAX]
    flags = raw.get("defaultModelsAuto")
    auto = tuple(r for r in AUTO_RUNNERS if isinstance(flags, dict) and flags.get(r) is True)
    planner, namer = raw.get("plannerModel"), raw.get("namerModel")
    return AgentDefaults(
        models,
        auto,
        raw.get("modelsLocked") is True,
        planner.strip() if isinstance(planner, str) and planner.strip() else DEFAULT_PLANNER_MODEL,
        namer.strip() if isinstance(namer, str) and namer.strip() else DEFAULT_NAMER_MODEL,
    )


def write_agent_defaults(data_dir: Path, value: AgentDefaults) -> None:
    body: dict[str, object] = {
        "plannerModel": value.planner_model,
        "namerModel": value.namer_model,
    }
    if value.models:
        body["defaultModels"] = dict(value.models)
    if value.auto:
        body["defaultModelsAuto"] = {runner: True for runner in value.auto}
    if value.locked:
        body["modelsLocked"] = True
    _save(agent_defaults_path(data_dir), body)


def _text(signals: dict[str, object], key: str) -> str:
    raw = signals.get(key, "")
    return raw.strip() if isinstance(raw, str) else ""


def parse_agent_defaults(signals: dict[str, object]) -> tuple[AgentDefaults | None, str | None]:
    models: dict[str, str] = {}
    auto: list[str] = []
    for runner in RUNNERS:
        text = _text(signals, f"model_{runner}")
        if len(text) > MODEL_MAX:
            return None, f"a model id is at most {MODEL_MAX} characters"
        if text:
            models[runner] = text
        elif runner in AUTO_RUNNERS and signals.get(f"auto_{runner}") is True:
            auto.append(runner)
    planner = _text(signals, "planner_model") or DEFAULT_PLANNER_MODEL
    namer = _text(signals, "namer_model") or DEFAULT_NAMER_MODEL
    if len(planner) > MODEL_MAX or len(namer) > MODEL_MAX:
        return None, f"a model id is at most {MODEL_MAX} characters"
    locked = signals.get("locked") is True
    return AgentDefaults(models, tuple(auto), locked, planner, namer), None


def models_locked(config_locked: bool, data_dir: Path) -> bool:
    """`CEZ_AGENT_MODELS_LOCKED=1` (on `Config`) or `modelsLocked` on the Agents page."""
    return config_locked or read_agent_defaults(data_dir).locked


# --- composer defaults (`composerDefaults`) ---


@dataclass(frozen=True, slots=True)
class ComposerDefaults:
    """`autonomous` and `worktree`: `None` leaves the process default (`CEZ_*_DEFAULT`)."""

    autonomous: bool | None = None
    worktree: bool | None = None


def composer_path(data_dir: Path) -> Path:
    return data_dir / "composer-defaults.json"


def read_composer_defaults(data_dir: Path) -> ComposerDefaults:
    raw = _load(composer_path(data_dir))
    auto, tree = raw.get("autonomous"), raw.get("worktree")
    return ComposerDefaults(
        auto if isinstance(auto, bool) else None, tree if isinstance(tree, bool) else None
    )


def write_composer_defaults(data_dir: Path, value: ComposerDefaults) -> None:
    body: dict[str, object] = {}
    if value.autonomous is not None:
        body["autonomous"] = value.autonomous
    if value.worktree is not None:
        body["worktree"] = value.worktree
    _save(composer_path(data_dir), body)


def parse_tri(raw: object) -> tuple[bool | None, str | None]:
    """`inherit` (or empty), `on`, `off`."""
    text = raw.strip().lower() if isinstance(raw, str) else ""
    if text in ("", "inherit"):
        return None, None
    if text in ("on", "off"):
        return text == "on", None
    return None, "a composer default is inherit, on, or off"


def tri_word(value: bool | None) -> str:
    return "inherit" if value is None else ("on" if value else "off")


# --- the skill a new task preselects (`defaultSkill`, `askSkill`), per project ---

SKILL_MAX = 200


def read_skill_defaults(data_dir: Path, project_id: str) -> tuple[str, str]:
    raw = _load(checks_path(data_dir, project_id))
    default, ask = raw.get("defaultSkill"), raw.get("askSkill")
    return (
        default.strip() if isinstance(default, str) else "",
        ask.strip() if isinstance(ask, str) else "",
    )


def write_skill_defaults(data_dir: Path, project_id: str, default: str, ask: str) -> None:
    current = _load(checks_path(data_dir, project_id))
    for key, value in (("defaultSkill", default), ("askSkill", ask)):
        if value:
            current[key] = value
        else:
            current.pop(key, None)
    _save(checks_path(data_dir, project_id), current)


def parse_skill_defaults(default: str, ask: str) -> tuple[tuple[str, str] | None, str | None]:
    default, ask = default.strip(), ask.strip()
    if len(default) > SKILL_MAX or len(ask) > SKILL_MAX:
        return None, f"a skill name is at most {SKILL_MAX} characters"
    return (default, ask), None
