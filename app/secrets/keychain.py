"""Where the 32-byte secrets data key lives.

`CEZ_SECRETS_KEYCHAIN=0` and a pytest process stay on the `0600` key file.
A test injects a fake keychain; the real process uses `secret-tool` when it
is installed and Secret Service answers. A missing store is the file, never
a boot failure. The secrets themselves stay in the file either way.
"""

from __future__ import annotations

import os
import subprocess
from base64 import b64decode, b64encode

SERVICE = "cezar"
ACCOUNT = "secrets-data-key"


class KeychainLocked(Exception):
    pass


class DataKeyring:
    def get(self) -> bytes | None:
        raise NotImplementedError

    def set(self, key: bytes) -> None:
        raise NotImplementedError


class MemoryKeyring(DataKeyring):
    def __init__(self) -> None:
        self.value: bytes | None = None
        self.locked = False

    def get(self) -> bytes | None:
        if self.locked:
            raise KeychainLocked("locked")
        return self.value

    def set(self, key: bytes) -> None:
        if self.locked:
            raise KeychainLocked("locked")
        self.value = key


_override: DataKeyring | None = None
_override_on = False


def set_keychain(ring: DataKeyring | None) -> None:
    """Tests inject a ring. `None` means "no keychain" rather than the OS one."""
    global _override, _override_on
    _override = ring
    _override_on = True


def clear_keychain_override() -> None:
    global _override, _override_on
    _override = None
    _override_on = False


def os_keychain() -> DataKeyring | None:
    from app.config import secrets_keychain_enabled

    if not secrets_keychain_enabled():
        return None
    if _override_on:
        return _override
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return None
    if _secret_tool() is None:
        return None
    return _SecretTool()


def _secret_tool() -> str | None:
    from shutil import which

    return which("secret-tool")


class _SecretTool(DataKeyring):
    def get(self) -> bytes | None:
        proc = _run(["lookup", "service", SERVICE, "account", ACCOUNT])
        if proc is None:
            return None
        if proc.returncode != 0:
            text = (proc.stderr or "").lower()
            if "locked" in text:
                raise KeychainLocked(proc.stderr.strip() or "keychain locked")
            return None
        try:
            key = b64decode(proc.stdout.strip())
        except ValueError:
            return None
        return key if len(key) == 32 else None

    def set(self, key: bytes) -> None:
        if len(key) != 32:
            raise ValueError("data key must be 32 bytes")
        proc = _run(
            ["store", "--label", "cezar secrets data key", "service", SERVICE, "account", ACCOUNT],
            text=b64encode(key).decode(),
        )
        if proc is None or proc.returncode != 0:
            detail = "" if proc is None else proc.stderr.strip()
            raise KeychainLocked(detail or "keychain store failed")


def _run(args: list[str], text: str | None = None) -> subprocess.CompletedProcess[str] | None:
    binary = _secret_tool()
    if binary is None:
        return None
    try:
        return subprocess.run(
            [binary, *args],
            input=text,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        return None
