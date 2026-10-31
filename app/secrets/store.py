"""Project and workspace secrets.

Same rules as the TypeScript store: AES-256-GCM, metadata in the clear,
values never returned by the list API, and a project file that refuses
another root. The 32-byte data key lives in the OS keychain when one is
available. `CEZ_SECRETS_KEYCHAIN=0`, a pytest process, or a machine without
`secret-tool` keeps it in a `0600` file instead. The directory is
`$PROJECT_DATA_DIR/secrets`, not `~/.cezar/secrets`.
"""

from __future__ import annotations

import json
import os
import re
from base64 import b64decode, b64encode
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.clock import stamp

SECRET_VALUE_MAX_BYTES = 16 * 1024
MIN_SECRET_LEN = 12
AUDIENCES = ("checks", "cezar")
_NAME = re.compile(r"^[A-Z_][A-Z0-9_]{0,127}$")
_REFUSED = frozenset(
    {
        "PATH",
        "HOME",
        "SHELL",
        "USER",
        "TMPDIR",
        "TEMP",
        "TMP",
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "BASH_ENV",
        "ENV",
    }
)
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$")


class SecretsError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class SecretMeta:
    name: str
    audiences: tuple[str, ...]
    updated_at: str


def name_issue(name: str) -> str | None:
    if _NAME.match(name) is None:
        return (
            "a name is 1–128 characters: uppercase letters, digits and "
            "underscores, not starting with a digit"
        )
    if name.startswith("CEZ_"):
        return "CEZ_* names are reserved for cezar"
    if name.startswith("DYLD_"):
        return "DYLD_* names change how programs load and are refused"
    if name in _REFUSED:
        return f"{name} changes how the check's shell runs and is refused"
    return None


def value_issue(value: str) -> str | None:
    if value == "":
        return "a value is not empty; remove the name instead of storing nothing"
    if len(value.encode()) > SECRET_VALUE_MAX_BYTES:
        return f"a value is at most {SECRET_VALUE_MAX_BYTES} bytes"
    if any(ch in value for ch in ("\r", "\n", "\0")):
        return "a value is one line, without NUL"
    return None


class SecretStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def key_backend(self) -> str:
        from app.secrets.keychain import os_keychain

        return "keychain" if os_keychain() is not None else "file"

    def list(self, scope: str, *, root: str = "") -> tuple[list[SecretMeta], str]:
        secrets, skipped = self._read(scope, root)
        if secrets is None:
            return [], skipped
        rows: list[SecretMeta] = []
        for name, entry in sorted(secrets.items()):
            raw_audiences = entry.get("audiences")
            audiences = raw_audiences if isinstance(raw_audiences, list) else []
            rows.append(
                SecretMeta(
                    name,
                    tuple(item for item in audiences if isinstance(item, str)),
                    str(entry.get("updatedAt", "")),
                )
            )
        return rows, skipped

    def set(
        self,
        scope: str,
        name: str,
        value: str,
        *,
        root: str = "",
        audiences: tuple[str, ...] = ("checks",),
    ) -> None:
        issue = name_issue(name) or value_issue(value)
        if issue:
            raise SecretsError(issue)
        admitted = tuple(dict.fromkeys(item for item in audiences if item in AUDIENCES))
        if not admitted:
            raise SecretsError("a secret names at least one audience (checks, cezar)")
        self._prepare()
        file_id = _file_id(scope)
        if file_id is None:
            raise SecretsError("invalid project id")
        existing, _skipped = self._read(scope, root)
        secrets: dict[str, dict[str, object]] = {} if existing is None else dict(existing)
        now = stamp()
        previous = secrets.get(name, {})
        created = previous.get("createdAt") if isinstance(previous, dict) else None
        secrets[name] = {
            "audiences": list(admitted),
            "createdAt": created or now,
            "updatedAt": now,
            **_encrypt(self._key(), f"cezar-secret\0{file_id}\0{name}", value),
        }
        self._write(file_id, root if scope != "workspace" else "", secrets)

    def unset(self, scope: str, name: str, *, root: str = "") -> bool:
        existing, _skipped = self._read(scope, root)
        if existing is None or name not in existing:
            return False
        secrets = dict(existing)
        del secrets[name]
        file_id = _file_id(scope)
        if file_id is None:
            return False
        self._write(file_id, root if scope != "workspace" else "", secrets)
        return True

    def resolve(
        self,
        audience: str,
        *,
        project_id: str = "",
        root: str = "",
        bindings: tuple[tuple[str, str], ...] | None = None,
    ) -> tuple[dict[str, str], list[str]]:
        notes: list[str] = []
        sources: list[tuple[str, dict[str, dict[str, object]]]] = []
        for label, scope, scope_root in (
            ("workspace", "workspace", ""),
            ("project", project_id, root),
        ):
            if scope == "":
                continue
            loaded, skipped = self._read(scope, scope_root)
            if skipped:
                notes.append(f"{label} secrets skipped — {skipped}")
            sources.append((scope, loaded or {}))

        values: dict[str, str] = {}
        key = self._key() if any(secrets for _scope, secrets in sources) else b""

        def plain_for(scope: str, name: str, entry: dict[str, object]) -> str | None:
            file_id = _file_id(scope)
            if file_id is None or not key:
                return None
            return _decrypt_entry(key, file_id, name, entry)

        if bindings is None:
            for scope, secrets in sources:
                for name, entry in secrets.items():
                    audiences = entry.get("audiences")
                    if isinstance(audiences, list) and audience in audiences:
                        plain = plain_for(scope, name, entry)
                        if plain is not None:
                            values[name] = plain
            return values, notes
        for name, alias in bindings:
            found = next(
                (
                    (scope, secrets[name])
                    for scope, secrets in reversed(sources)
                    if isinstance(secrets.get(name), dict)
                ),
                None,
            )
            if found is None:
                notes.append(f"secret {name} is not stored for this project or workspace")
                continue
            scope, entry = found
            audiences = entry.get("audiences")
            admitted = audiences if isinstance(audiences, list) else []
            if audience not in admitted:
                joined = ", ".join(str(item) for item in admitted)
                notes.append(f"secret {name} is not available to {audience} (audiences: {joined})")
                continue
            plain = plain_for(scope, name, entry)
            if plain is None:
                notes.append(f"secret {name} could not be decrypted")
                continue
            values[alias or name] = plain
        return values, notes

    def _read(self, scope: str, root: str) -> tuple[dict[str, dict[str, object]] | None, str]:
        file_id = _file_id(scope)
        if file_id is None:
            return None, ""
        path = self.directory / f"{file_id}.json"
        if not path.is_file():
            return None, ""
        try:
            _assert_mode(self.directory, 0o077, directory=True)
            _assert_mode(path, 0o077, directory=False)
            text = path.read_text(encoding="utf-8")
        except SecretsError as exc:
            return None, str(exc)
        except OSError:
            return None, "the store is unreadable"
        try:
            loaded = json.loads(text)
        except json.JSONDecodeError:
            return None, "the store file is corrupt — not JSON"
        if not isinstance(loaded, dict) or loaded.get("version") != 1:
            return None, "the store file is corrupt — not a shape this cezar writes"
        recorded = loaded.get("root")
        owner = str(Path(root).resolve()) if root else ""
        if scope != "workspace" and isinstance(recorded, str) and owner and recorded != owner:
            return None, f"the store belongs to another project root ({recorded})"
        secrets = _secret_map(loaded.get("secrets"))
        if secrets is None:
            return None, "the store file is corrupt — not a shape this cezar writes"
        return secrets, ""

    def _write(self, file_id: str, root: str, secrets: dict[str, dict[str, object]]) -> None:
        self._prepare()
        body = {"version": 1, "secrets": secrets}
        if root:
            body["root"] = str(Path(root).resolve())
        path = self.directory / f"{file_id}.json"
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)
        os.chmod(path, 0o600)

    def _prepare(self) -> None:
        self.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(self.directory, 0o700)
        ignore = self.directory / ".gitignore"
        if not ignore.exists():
            ignore.write_text(
                "# Managed private secrets; never commit this directory.\n*\n",
                encoding="utf-8",
            )
            os.chmod(ignore, 0o600)

    def _key(self) -> bytes:
        self._prepare()
        from app.secrets.keychain import KeychainLocked, os_keychain

        ring = os_keychain()
        if ring is not None:
            try:
                stored = ring.get()
            except KeychainLocked as exc:
                raise SecretsError("the keychain is locked") from exc
            if stored is not None and len(stored) == 32:
                return stored
            raw = os.urandom(32)
            try:
                ring.set(raw)
            except KeychainLocked as exc:
                raise SecretsError("the keychain is locked") from exc
            return raw
        path = self.directory / ".key"
        if path.is_file():
            raw = b64decode(path.read_text(encoding="utf-8").strip())
            if len(raw) == 32:
                return raw
        raw = os.urandom(32)
        path.write_text(b64encode(raw).decode() + "\n", encoding="utf-8")
        os.chmod(path, 0o600)
        return raw


def redact(text: str, values: list[str]) -> str:
    cleaned = text
    for value in values:
        if len(value) >= MIN_SECRET_LEN:
            cleaned = cleaned.replace(value, "●" * 8)
    return cleaned


def command_allowed(command: str, allowlist: tuple[str, ...]) -> bool:
    """Whether an agent Bash rule would admit `command`.

    Check steps do not call this. The TypeScript check shell is `bash -lc`
    for every command, allowlist or not. An empty list is unrestricted. A
    non-empty list matches a command that equals a prefix or starts with it.
    """
    prefixes = [item.strip() for item in allowlist if item.strip()]
    if not prefixes:
        return True
    text = command.strip()
    return any(text == prefix or text.startswith(prefix + " ") for prefix in prefixes)


def _encrypt(key: bytes, aad: str, value: str) -> dict[str, str]:
    nonce = os.urandom(12)
    box = AESGCM(key)
    encrypted = box.encrypt(nonce, value.encode(), aad.encode())
    tag = encrypted[-16:]
    data = encrypted[:-16]
    return {
        "iv": b64encode(nonce).decode(),
        "data": b64encode(data).decode(),
        "tag": b64encode(tag).decode(),
    }


def _decrypt_entry(key: bytes, file_id: str, name: str, entry: dict[str, object]) -> str | None:
    try:
        nonce = b64decode(str(entry["iv"]))
        data = b64decode(str(entry["data"]))
        tag = b64decode(str(entry["tag"]))
    except KeyError, ValueError:
        return None
    try:
        plain = AESGCM(key).decrypt(nonce, data + tag, f"cezar-secret\0{file_id}\0{name}".encode())
    except Exception:
        return None
    return plain.decode()


def _secret_map(value: object) -> dict[str, dict[str, object]] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, dict[str, object]] = {}
    for key, entry in value.items():
        if isinstance(key, str) and isinstance(entry, dict):
            out[key] = entry
    return out


def _file_id(scope: str) -> str | None:
    if scope == "workspace":
        return "workspace"
    if _ID.match(scope) and scope != "workspace":
        return scope
    return None


def _assert_mode(path: Path, forbidden: int, *, directory: bool) -> None:
    mode = path.stat().st_mode
    if directory and not path.is_dir():
        raise SecretsError("the store directory is unusable")
    if not directory and not path.is_file():
        raise SecretsError("the store file is unusable — it must be a regular 0600 file")
    if mode & forbidden:
        raise SecretsError("the store file is unusable — it must be a regular 0600 file")
