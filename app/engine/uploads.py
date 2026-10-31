"""Staged message attachments.

Bytes are stored under the data directory. The list API and the message record
carry the id, never a second copy of the base64. The type list matches the
contract's attachment media types, and the base64 cap is 7_000_000 characters.
"""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from typing import cast

from stario.json import JsonValue
from stario.json import dumps as json_dumps

UPLOAD_ID = re.compile(r"^[a-f0-9]{24}$")
MAX_DATA_CHARS = 7_000_000
MAX_TOTAL_BYTES = 512 * 1024 * 1024
_TEXT = frozenset({"text/plain", "text/markdown", "text/x-markdown"})
_FILES = frozenset({"application/pdf", "application/octet-stream"})


def media_ok(media_type: str) -> bool:
    return media_type.startswith("image/") or media_type in _TEXT or media_type in _FILES


def write_upload(
    directory: Path, media_type: str, data: str, name: str = ""
) -> tuple[dict[str, str] | None, str | None]:
    if not media_ok(media_type):
        return None, "unsupported attachment type — send other files as application/octet-stream"
    if not data or len(data) > MAX_DATA_CHARS:
        return None, "attachment data is empty or larger than 7000000 characters"
    try:
        raw = base64.b64decode(data, validate=True)
    except ValueError, TypeError:
        return None, "attachment data is not base64"
    directory.mkdir(parents=True, exist_ok=True)
    used = sum(path.stat().st_size for path in directory.glob("*.bin") if path.is_file())
    if used + len(raw) > MAX_TOTAL_BYTES:
        return None, "the upload store is full"
    from secrets import token_hex

    upload_id = token_hex(12)
    (directory / f"{upload_id}.bin").write_bytes(raw)
    meta = {"id": upload_id, "mediaType": media_type, "name": _safe_name(name)}
    (directory / f"{upload_id}.json").write_text(
        json_dumps(cast(JsonValue, meta)), encoding="utf-8"
    )
    return meta, None


def read_upload(directory: Path, upload_id: str) -> tuple[dict[str, str], bytes] | None:
    if not UPLOAD_ID.fullmatch(upload_id):
        return None
    meta_path = directory / f"{upload_id}.json"
    blob = directory / f"{upload_id}.bin"
    if not meta_path.is_file() or not blob.is_file():
        return None
    try:
        loaded = json.loads(meta_path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return None
    if not isinstance(loaded, dict):
        return None
    meta = {str(key): str(value) for key, value in loaded.items() if isinstance(value, str)}
    return meta, blob.read_bytes()


def delete_upload(directory: Path, upload_id: str) -> bool:
    found = read_upload(directory, upload_id)
    if found is None:
        return False
    (directory / f"{upload_id}.json").unlink(missing_ok=True)
    (directory / f"{upload_id}.bin").unlink(missing_ok=True)
    return True


def materialize(store: Path, dest: Path, images: list[dict[str, object]]) -> list[str]:
    """Write staged or inline attachments into the worktree and return their paths.

    The agent is told the path. Image bytes also stay on the run so Claude can
    send them as content blocks.
    """
    dest.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for index, image in enumerate(images):
        upload_id = image.get("uploadId")
        if isinstance(upload_id, str):
            found = read_upload(store, upload_id)
            if found is None:
                continue
            meta, raw = found
            name = _safe_name(meta.get("name") or upload_id) or f"attachment-{index}"
        else:
            data = image.get("data")
            if not isinstance(data, str) or not data:
                continue
            try:
                raw = base64.b64decode(data, validate=True)
            except ValueError, TypeError:
                continue
            media = str(image.get("mediaType") or "application/octet-stream")
            suffix = ".png" if media.startswith("image/") else ".bin"
            name = _safe_name(str(image.get("name") or f"attachment-{index}{suffix}"))
        path = dest / name
        path.write_bytes(raw)
        paths.append(str(path))
    return paths


def _safe_name(name: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name)[:100]
    return cleaned
