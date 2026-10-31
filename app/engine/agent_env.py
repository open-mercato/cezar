"""Least-privilege environment for a spawned agent, and transcript redaction.

The child receives a curated allowlist plus the backend's own auth variables.
`CEZ_ENV_PASSTHROUGH=A,B` forwards those extra names. `CEZ_AGENT_ENV_FULL=1`
(also `true` or `yes`) restores the full parent environment. Both are off by
default. `CEZ_REDACT_SECRETS=0` is the only way to keep a secret-shaped token
in a stored event; redaction is on otherwise.

Claude and Codex can carry a second login by relocating their home. The other
runners have no variable that moves credentials and config together, so a
profile home for them is ignored.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping

from app.config import agent_env_full, env_passthrough, redact_secrets_enabled

REDACTED = "[REDACTED]"
MIN_SECRET_LEN = 12
SECRET_NAME_RE = re.compile(
    r"(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|_KEY_|APIKEY|API_KEY"
    r"|PRIVATE_KEY|ACCESS_KEY|_AUTH$|_AUTH_|SESSION|COOKIE|PASSPHRASE)",
    re.IGNORECASE,
)
_SECRET_ALLOW = frozenset(
    {
        "SSH_AUTH_SOCK",
        "SSH_AGENT_PID",
        "SESSION_MANAGER",
        "SESSIONNAME",
        "XDG_SESSION_ID",
        "XDG_SESSION_TYPE",
        "XDG_SESSION_CLASS",
        "XDG_SESSION_DESKTOP",
    }
)
_TOKEN_PATTERNS = (
    re.compile(r"whsec_[A-Za-z0-9+/=]{32,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9\-_]{20,}"),
    re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9\-_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"ASIA[0-9A-Z]{16}"),
    re.compile(r"AIza[0-9A-Za-z_\-]{35}"),
    re.compile(r"ya29\.[0-9A-Za-z_\-]+"),
    re.compile(r"xox[baprs]-[0-9A-Za-z\-]{10,}"),
    re.compile(r"glpat-[0-9A-Za-z_\-]{20,}"),
)

_BASE_NAMES = frozenset(
    {
        "PATH",
        "HOME",
        "SHELL",
        "USER",
        "LOGNAME",
        "PWD",
        "OLDPWD",
        "TMPDIR",
        "TEMP",
        "TMP",
        "TZ",
        "LANG",
        "LANGUAGE",
        "TERM",
        "COLORTERM",
        "NO_COLOR",
        "DISPLAY",
        "SSH_AUTH_SOCK",
        "SSH_AGENT_PID",
        "EDITOR",
        "VISUAL",
        "GIT_TERMINAL_PROMPT",
        "GIT_SSH_COMMAND",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "USERPROFILE",
    }
)
_BASE_PREFIXES = (
    "LC_",
    "XDG_",
    "NODE_",
    "NPM_CONFIG_",
    "PYTHON",
    "PIP_",
    "VIRTUAL_ENV",
    "UV_",
    "CARGO_",
    "RUSTUP_",
    "GOPATH",
    "GOROOT",
    "GOCACHE",
    "JAVA",
)
_MULTI = (
    "OPENAI_",
    "ANTHROPIC_",
    "AZURE_OPENAI_",
    "OPENROUTER_",
    "GROQ_",
    "MISTRAL_",
    "GEMINI_",
    "DEEPSEEK_",
    "XAI_",
)
_BACKEND_PREFIXES = {
    "claude": ("ANTHROPIC_", "CLAUDE_"),
    "claude-cli": ("ANTHROPIC_", "CLAUDE_"),
    "codex": ("OPENAI_", "CODEX_", "AZURE_OPENAI_"),
    "cursor": ("CURSOR_",),
    "opencode": _MULTI,
    "pi": ("PI_", *_MULTI),
    "junie": ("JUNIE_",),
    "copilot": ("COPILOT_",),
}
_GH_NAMES = frozenset(
    {"GITHUB_TOKEN", "GH_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN", "GH_CONFIG_DIR"}
)
_PROFILE_ENV = {"claude": "CLAUDE_CONFIG_DIR", "codex": "CODEX_HOME"}


def looks_secret(name: str) -> bool:
    return SECRET_NAME_RE.search(name) is not None


def profile_env(runner: str, home: str) -> dict[str, str]:
    """The one variable that relocates this runner's home, or nothing."""
    name = _PROFILE_ENV.get(runner)
    if not name or not home:
        return {}
    return {name: home}


def build_child_env(
    runner: str,
    *,
    extra: Mapping[str, str] | None = None,
    source: Mapping[str, str] | None = None,
) -> dict[str, str]:
    parent = source if source is not None else os.environ
    added = dict(extra or {})
    overridden = {key.upper() for key in added}
    if agent_env_full(parent):
        full = {key: value for key, value in parent.items() if key.upper() not in overridden}
        full.update(added)
        return full
    prefixes = _BACKEND_PREFIXES.get(runner, _BACKEND_PREFIXES["claude"])
    passthrough = {
        part.strip().upper() for part in env_passthrough(parent).split(",") if part.strip()
    }
    cloud_prefixes: list[str] = []
    cloud_names: set[str] = set()
    if runner in ("claude", "claude-cli") and _truthy(_read(parent, "CLAUDE_CODE_USE_BEDROCK")):
        cloud_prefixes.append("AWS_")
    if runner in ("claude", "claude-cli") and _truthy(_read(parent, "CLAUDE_CODE_USE_VERTEX")):
        cloud_prefixes.append("GOOGLE_CLOUD_")
        cloud_names.add("GOOGLE_APPLICATION_CREDENTIALS")
    out: dict[str, str] = {}
    for name, value in parent.items():
        if value is None or name.upper() in overridden:
            continue
        if _allow(name, prefixes, passthrough, cloud_prefixes, cloud_names):
            out[name] = value
    out.update(added)
    return out


def collect_secret_values(source: Mapping[str, str] | None = None) -> list[str]:
    env = source if source is not None else os.environ
    values: set[str] = set()
    for name, value in env.items():
        if not value or len(value) < MIN_SECRET_LEN:
            continue
        if name.upper() in _SECRET_ALLOW:
            continue
        if looks_secret(name):
            values.add(value)
    return sorted(values, key=len, reverse=True)


def redact_secrets(text: str, secret_values: list[str] | tuple[str, ...]) -> str:
    ends: list[int] | None = None

    def cover(start: int, stop: int) -> None:
        nonlocal ends
        if ends is None:
            ends = [0] * len(text)
        ends[start] = max(ends[start], stop)

    for value in {item for item in secret_values if item}:
        start = text.find(value)
        while start != -1:
            cover(start, start + len(value))
            start = text.find(value, start + 1)
    for pattern in _TOKEN_PATTERNS:
        for match in pattern.finditer(text):
            cover(match.start(), match.end())
    if ends is None:
        return text
    out: list[str] = []
    copied = 0
    start = 0
    while start < len(ends):
        stop = ends[start]
        if stop == 0:
            start += 1
            continue
        out.append(text[copied:start])
        out.append(REDACTED)
        next_at = start + 1
        while next_at < stop:
            stop = max(stop, ends[next_at])
            next_at += 1
        copied = stop
        start = stop
    out.append(text[copied:])
    return "".join(out)


def scrub(text: str, source: Mapping[str, str] | None = None) -> str:
    """Redact before a line is stored. `CEZ_REDACT_SECRETS=0` leaves it alone."""
    if not redact_secrets_enabled(source):
        return text
    return redact_secrets(text, collect_secret_values(source))


def _allow(
    name: str,
    prefixes: tuple[str, ...],
    passthrough: set[str],
    cloud_prefixes: list[str],
    cloud_names: set[str],
) -> bool:
    key = name.upper()
    if key.startswith("CEZ_"):
        return True
    if key in _GH_NAMES or key in cloud_names:
        return True
    if _prefixed(key, prefixes) or _prefixed(key, cloud_prefixes):
        return True
    if key in passthrough or key in _BASE_NAMES:
        return True
    return _prefixed(key, _BASE_PREFIXES) and not looks_secret(key)


def _prefixed(name: str, prefixes: tuple[str, ...] | list[str]) -> bool:
    return any(name.startswith(prefix) for prefix in prefixes)


def _read(source: Mapping[str, str], name: str) -> str:
    if name in source:
        return source[name]
    upper = name.upper()
    for key, value in source.items():
        if key.upper() == upper:
            return value
    return ""


def _truthy(value: str) -> bool:
    folded = value.strip().lower()
    return folded not in ("", "0", "false")
