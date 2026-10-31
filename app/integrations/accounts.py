"""Local agent accounts.

Claude and Codex get a directory under the data dir and the runner injects
`CLAUDE_CONFIG_DIR` or `CODEX_HOME`. The other runners have no such variable,
so they stay on the default login. A hosted cockpit refuses new accounts
unless `CEZ_REMOTE_AGENT_ACCOUNTS=1`.
"""

from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Config, agent_accounts_enabled

_RUNNERS = ("claude", "codex", "opencode", "cursor", "pi", "junie", "copilot")
_HOMES = {"claude": "CLAUDE_CONFIG_DIR", "codex": "CODEX_HOME"}
_HOSTED = (
    "agent accounts are disabled in hosted mode; "
    "set CEZ_REMOTE_AGENT_ACCOUNTS=1 only behind an authenticated perimeter"
)


def accounts_path(config: Config) -> Path:
    return config.data_dir / "agent-accounts.json"


def list_accounts(config: Config) -> list[dict[str, str]]:
    rows = _load(config)
    return [
        {"id": row["id"], "name": row["name"], "runner": row["runner"], "home": row["home"]}
        for row in rows
    ]


def add_account(config: Config, name: str, runner: str) -> str | None:
    if not agent_accounts_enabled(config):
        return _HOSTED
    cleaned = name.strip()
    if not cleaned or len(cleaned) > 80:
        return "name must be 1 to 80 characters"
    if runner not in _RUNNERS:
        return "unknown runner"
    rows = _load(config)
    account_id = uuid.uuid4().hex
    home = ""
    if runner in _HOMES:
        directory = config.data_dir / "agent-homes" / account_id
        directory.mkdir(parents=True, exist_ok=True)
        home = str(directory)
    rows.append({"id": account_id, "name": cleaned, "runner": runner, "home": home})
    _save(config, rows)
    return None


def profile_home_for(config: Config, account_id: str, runner: str) -> str | None:
    """The home to inject, `""` when this runner cannot carry one, or None if unknown."""
    if not account_id:
        return ""
    for row in _load(config):
        if row["id"] == account_id:
            if runner not in _HOMES:
                return ""
            return row["home"]
    return None


# What each agent drops into its home on first login (`PROFILE_DIR_MARKERS` in
# `core/agent-profiles.ts`). Any one says the directory is the agent's.
_DIR_MARKERS = {
    "claude": (".claude.json", "settings.json", "projects", "sessions"),
    "codex": ("auth.json", "config.toml"),
}
_READ_CAP = 2 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class AccountState:
    """The account's folder and login, from the files alone. No agent CLI is run."""

    exists: bool
    looks_valid: bool
    signed_in: bool
    status: str  # "default login", "folder missing", "not signed in", "signed in"


def account_state(row: dict[str, str]) -> AccountState:
    runner, home = row["runner"], row["home"]
    if runner not in _HOMES or not home:
        return AccountState(True, True, False, "default login")
    directory = Path(home)
    try:
        entries = {entry.name for entry in directory.iterdir()}
    except OSError:
        return AccountState(False, False, False, "folder missing")
    valid = any(marker in entries for marker in _DIR_MARKERS[runner])
    signed_in = _signed_in(runner, directory)
    return AccountState(True, valid, signed_in, "signed in" if signed_in else "not signed in")


def get_account(config: Config, account_id: str) -> dict[str, str] | None:
    return next((row for row in _load(config) if row["id"] == account_id and account_id), None)


def account_details(row: dict[str, str]) -> tuple[list[tuple[str, str]], str]:
    """`(labelled fields, reason)` for who the account is signed in as.

    Named fields only, never a pass-through: `auth.json` also holds the tokens.
    """
    runner, home = row["runner"], row["home"]
    if runner not in _HOMES or not home:
        return [], "This account uses the default login; cezar reads no details for it."
    directory = Path(home)
    fields: list[tuple[str, str]] = []
    if runner == "claude":
        state = _read_json(directory / ".claude.json")
        oauth = state.get("oauthAccount") if state else None
        if isinstance(oauth, dict):
            for label, key in (
                ("Email", "emailAddress"),
                ("Name", "displayName"),
                ("Organization", "organizationName"),
                ("Role", "organizationRole"),
                ("Seat", "seatTier"),
                ("Billing", "billingType"),
            ):
                _push(fields, label, oauth.get(key))
    else:
        auth = _read_json(directory / "auth.json")
        tokens = auth.get("tokens") if auth else None
        id_token = tokens.get("id_token") if isinstance(tokens, dict) else None
        claims = _jwt_claims(id_token) if isinstance(id_token, str) else None
        if claims:
            _push(fields, "Email", claims.get("email"))
            _push(fields, "Name", claims.get("name"))
            openai = claims.get("https://api.openai.com/auth")
            if isinstance(openai, dict):
                _push(fields, "Plan", openai.get("chatgpt_plan_type"))
        key = auth.get("OPENAI_API_KEY") if auth else None
        if not fields and isinstance(key, str) and key:
            fields.append(("Login", "API key"))
    if not fields:
        return [], "Not signed in on this account yet."
    return fields, ""


def _signed_in(runner: str, directory: Path) -> bool:
    if runner == "claude":
        if (directory / ".credentials.json").is_file():
            return True
        state = _read_json(directory / ".claude.json")
        return bool(state) and isinstance(state.get("oauthAccount"), dict)
    auth = _read_json(directory / "auth.json")
    if not auth:
        return False
    key = auth.get("OPENAI_API_KEY")
    return isinstance(auth.get("tokens"), dict) or (isinstance(key, str) and key != "")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > _READ_CAP:
            return {}
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _push(fields: list[tuple[str, str]], label: str, value: object) -> None:
    if isinstance(value, str) and value.strip():
        fields.append((label, value.strip()))


def _jwt_claims(token: str) -> dict[str, Any] | None:
    parts = token.split(".")
    if len(parts) != 3 or not parts[1]:
        return None
    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        loaded = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except ValueError:
        return None
    return loaded if isinstance(loaded, dict) else None


# --- which account a project uses, per runner ---------------------------------------------------


def selections_path(config: Config) -> Path:
    return config.data_dir / "agent-selections.json"


def read_selections(config: Config) -> dict[str, dict[str, str]]:
    """`{project id: {runner: account id}}`. Absence means the default login."""
    try:
        loaded = json.loads(selections_path(config).read_text(encoding="utf-8"))
    except OSError, ValueError:
        return {}
    if not isinstance(loaded, dict):
        return {}
    out: dict[str, dict[str, str]] = {}
    for project, runners in loaded.items():
        if isinstance(project, str) and isinstance(runners, dict):
            kept = {
                str(runner): account
                for runner, account in runners.items()
                if isinstance(account, str) and account
            }
            if kept:
                out[project] = kept
    return out


def select_account(config: Config, project_id: str, runner: str, account_id: str) -> str | None:
    """Choose the account `runner` uses in a project; `""` goes back to the default login."""
    if not agent_accounts_enabled(config):
        return _HOSTED
    if runner not in _HOMES:
        return f"{runner} cannot carry more than one account"
    if account_id:
        row = get_account(config, account_id)
        if row is None or row["runner"] != runner:
            return "unknown account"
    current = read_selections(config)
    chosen = current.get(project_id, {})
    if account_id:
        chosen[runner] = account_id
    else:
        chosen.pop(runner, None)
    if chosen:
        current[project_id] = chosen
    else:
        current.pop(project_id, None)
    path = selections_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    return None


def selected_account(config: Config, project_id: str, runner: str) -> str:
    """The account a new run in this project uses, or `""` for the default login.

    A selection naming an account that no longer exists degrades to the default, as a
    dangling id does in `selectProfile`.
    """
    if not agent_accounts_enabled(config):
        return ""
    account_id = read_selections(config).get(project_id, {}).get(runner, "")
    row = get_account(config, account_id) if account_id else None
    return account_id if row is not None and row["runner"] == runner else ""


def _load(config: Config) -> list[dict[str, str]]:
    try:
        loaded = json.loads(accounts_path(config).read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return []
    if not isinstance(loaded, list):
        return []
    rows: list[dict[str, str]] = []
    for item in loaded:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            rows.append(
                {
                    "id": str(item.get("id", "")),
                    "name": item["name"],
                    "runner": str(item.get("runner", "claude")),
                    "home": str(item.get("home", "")),
                }
            )
    return rows


def _save(config: Config, rows: list[dict[str, str]]) -> None:
    path = accounts_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
