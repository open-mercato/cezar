"""Webhook outbox, single-owner lock, and delivery retries.

The outbox is an NDJSON file. Sequence numbers must increase by one. The owner
lock is a hard link of the candidate record. A dead holder is replaced only
through an exclusive successor slot. Dry-run marks a delivery delivered and
does not call the sender. A failure waits `5s * 2^(attempt-1)`, capped at one
hour, plus up to 20% jitter, and becomes failed when that deadline passes the
72-hour expiry.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

_HOUR_MS = 3_600_000
_EXPIRY_MS = 72 * _HOUR_MS
_REPLAY_MS = 7 * 24 * _HOUR_MS


def retry_at_ms(attempt: int, now_ms: int, *, jitter: float = 0.0) -> int:
    """TypeScript `retryAt` without a Retry-After header. `jitter` is 0..1."""
    base = min(_HOUR_MS, 5_000 * 2 ** min(max(0, attempt - 1), 20))
    span = max(0.0, min(1.0, jitter))
    return now_ms + min(_HOUR_MS, int(base * (1 + span * 0.2)))


class OutboxError(Exception):
    pass


@dataclass
class Delivery:
    sequence: int
    body: str
    attempts: int = 0
    status: str = "pending"
    next_attempt_at: str = ""
    expires_at: int = 0
    completed_at: int = 0
    event_type: str = ""
    reason: str = ""
    delivery_id: str = ""
    receiver_id: str = ""
    event_id: str = ""
    url: str = ""
    format: str = ""
    receiver_name: str = ""
    delivery_revision: int = 0
    task_id: str = ""
    created_at: int = 0
    http_status: int = 0
    response: str = ""

    def to_json(self) -> dict[str, object]:
        row: dict[str, object] = {
            "sequence": self.sequence,
            "body": self.body,
            "attempts": self.attempts,
            "status": self.status,
            "nextAttemptAt": self.next_attempt_at,
            "expiresAt": self.expires_at,
            "completedAt": self.completed_at,
            "eventType": self.event_type,
            "reason": self.reason,
        }
        if self.delivery_id:
            row.update(
                {
                    "deliveryId": self.delivery_id,
                    "receiverId": self.receiver_id,
                    "eventId": self.event_id,
                    "url": self.url,
                    "format": self.format,
                    "receiverName": self.receiver_name,
                    "deliveryRevision": self.delivery_revision,
                    "taskId": self.task_id,
                    "createdAt": self.created_at,
                    "httpStatus": self.http_status,
                    "response": self.response,
                }
            )
        return row

    @classmethod
    def from_json(cls, loaded: dict, sequence: int) -> Delivery:
        return cls(
            sequence=sequence,
            body=str(loaded.get("body", "")),
            attempts=_int(loaded.get("attempts")),
            status=str(loaded.get("status", "pending")),
            next_attempt_at=str(loaded.get("nextAttemptAt", "")),
            expires_at=_int(loaded.get("expiresAt")),
            completed_at=_int(loaded.get("completedAt")),
            event_type=str(loaded.get("eventType", "")),
            reason=str(loaded.get("reason", "")),
            delivery_id=str(loaded.get("deliveryId", "")),
            receiver_id=str(loaded.get("receiverId", "")),
            event_id=str(loaded.get("eventId", "")),
            url=str(loaded.get("url", "")),
            format=str(loaded.get("format", "")),
            receiver_name=str(loaded.get("receiverName", "")),
            delivery_revision=_int(loaded.get("deliveryRevision")),
            task_id=str(loaded.get("taskId", "")),
            created_at=_int(loaded.get("createdAt")),
            http_status=_int(loaded.get("httpStatus")),
            response=str(loaded.get("response", "")),
        )


class Outbox:
    def __init__(self, directory: Path, installation_id: str) -> None:
        self.directory = directory
        self.installation_id = installation_id
        self.path = directory / "outbox.ndjson"
        self.cursor_path = directory / "cursor.json"
        self.high_water = 0
        self._rows: list[Delivery] = []
        self._offset = 0

    def open(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text(self._header(0), encoding="utf-8")
            os.chmod(self.path, 0o600)
        lines = self.path.read_text(encoding="utf-8").splitlines()
        if not lines:
            raise OutboxError("Invalid webhook outbox header")
        header = json.loads(lines[0])
        if (
            not isinstance(header, dict)
            or header.get("version") != 1
            or header.get("installationId") != self.installation_id
        ):
            raise OutboxError("Webhook outbox installation mismatch")
        high = header.get("highWater")
        self.high_water = high if isinstance(high, int) else 0
        previous = 0
        rows: list[Delivery] = []
        for line in lines[1:]:
            loaded = json.loads(line)
            if not isinstance(loaded, dict):
                raise OutboxError("Invalid webhook outbox record")
            sequence = loaded.get("sequence")
            if not isinstance(sequence, int) or sequence <= previous:
                raise OutboxError("Invalid webhook outbox order")
            previous = sequence
            self.high_water = max(self.high_water, sequence)
            rows.append(Delivery.from_json(loaded, sequence))
        self._rows = rows
        self._offset = self._read_cursor()

    def append(
        self,
        body: str,
        *,
        event_type: str = "",
        expires_at: int = 0,
        **fields: object,
    ) -> Delivery:
        sequence = self.high_water + 1
        row = Delivery(sequence=sequence, body=body, event_type=event_type, expires_at=expires_at)
        for key, value in fields.items():
            if hasattr(row, key):
                setattr(row, key, value)
        self._rows.append(row)
        self.high_water = sequence
        self._rewrite()
        return row

    def peek(self) -> Delivery | None:
        for index, row in enumerate(self._rows):
            if index < self._offset:
                continue
            if row.status == "pending":
                return row
        return None

    def due(self, now_ms: int) -> Delivery | None:
        """The next row the service may send: pending/retrying and not deferred."""
        for row in self._rows:
            if row.status not in ("pending", "retrying", "blocked_policy"):
                continue
            try:
                deferred = int(row.next_attempt_at or "0")
            except ValueError:
                deferred = 0
            if deferred <= now_ms:
                return row
        return None

    def find_delivery(self, delivery_id: str) -> Delivery | None:
        for row in self._rows:
            if row.delivery_id and row.delivery_id == delivery_id:
                return row
        return None

    def rows(self) -> list[Delivery]:
        return list(self._rows)

    def save(self) -> None:
        self._rewrite()

    def find(self, sequence: int) -> Delivery | None:
        for row in self._rows:
            if row.sequence == sequence:
                return row
        return None

    def mark(
        self,
        sequence: int,
        *,
        status: str,
        attempts: int,
        next_attempt_at: str = "",
        expires_at: int = 0,
        completed_at: int = 0,
        reason: str = "",
    ) -> None:
        row = self.find(sequence)
        if row is None:
            raise OutboxError("Invalid webhook outbox cursor")
        row.status = status
        row.attempts = attempts
        row.next_attempt_at = next_attempt_at
        if expires_at:
            row.expires_at = expires_at
        if completed_at:
            row.completed_at = completed_at
        row.reason = reason
        self._rewrite()

    def advance(self) -> None:
        pending = self.peek()
        if pending is None:
            self._offset = len(self._rows)
        else:
            self._offset = self._rows.index(pending)
        self.cursor_path.write_text(
            json.dumps({"offset": self._offset}),
            encoding="utf-8",
        )

    def _read_cursor(self) -> int:
        try:
            loaded = json.loads(self.cursor_path.read_text(encoding="utf-8"))
        except OSError, json.JSONDecodeError:
            return 0
        offset = loaded.get("offset") if isinstance(loaded, dict) else 0
        if isinstance(offset, int) and 0 <= offset <= len(self._rows):
            return offset
        return 0

    def _rewrite(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        lines = [self._header(self.high_water).rstrip("\n")]
        for row in self._rows:
            lines.append(json.dumps(row.to_json()))
        self.path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _header(self, high_water: int) -> str:
        return (
            json.dumps(
                {"version": 1, "installationId": self.installation_id, "highWater": high_water}
            )
            + "\n"
        )


def linux_pid_namespace() -> str | None:
    """`pid:[inode]` from `/proc/self/ns/pid`. None where that namespace is invisible."""
    try:
        target = os.readlink("/proc/self/ns/pid")
    except OSError:
        return None
    if target.startswith("pid:[") and target.endswith("]") and target[5:-1].isdigit():
        return target
    return None


def namespace_blocks_takeover(stored: object, own: str | None) -> bool:
    """A different PID namespace is never declared dead.

    `/proc` only answers inside this namespace, so a foreign pid looks absent
    while its owner is alive. A record written before the field existed is
    left alone too: stealing it would be the same mistake.
    """
    if not isinstance(stored, str):
        return own is not None
    return stored != own


class Owner:
    def __init__(
        self, directory: Path, token: str, pid: int, *, namespace: str | None = None
    ) -> None:
        self.path = directory / "owner.lock"
        self.token = token
        self.pid = pid
        self.namespace = linux_pid_namespace() if namespace is None else namespace
        self.held = False

    def acquire(self, *, alive: bool) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        candidate = self.path.parent / f"owner-record-{self.token}.json"
        if not candidate.exists():
            body = {"token": self.token, "pid": self.pid}
            if self.namespace is not None:
                body["pidNamespace"] = self.namespace
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            fd = os.open(candidate, flags, 0o600)
            os.write(fd, json.dumps(body).encode())
            os.close(fd)
        try:
            os.link(candidate, self.path)
        except FileExistsError:
            return self._take_over(candidate, alive=alive)
        self.held = True
        return True

    def _take_over(self, candidate: Path, *, alive: bool) -> bool:
        current = _read_owner(self.path)
        if current is None:
            raise OutboxError("Invalid webhook owner metadata")
        if current.get("token") == self.token:
            self.held = True
            return True
        if namespace_blocks_takeover(current.get("pidNamespace"), self.namespace):
            return False
        if alive:
            return False
        slot = self.path.parent / f"owner-next-{current['token']}.json"
        try:
            os.link(candidate, slot)
        except FileExistsError:
            return False
        publication = self.path.parent / f"owner-publication-{self.token}.tmp"
        try:
            os.link(candidate, publication)
        except FileExistsError:
            pass
        os.replace(publication, self.path)
        self.held = True
        return True

    def valid(self) -> bool:
        current = _read_owner(self.path)
        return current is not None and current["token"] == self.token

    def release(self) -> None:
        if self.valid():
            self.path.unlink(missing_ok=True)
        self.held = False


def deliver_once(
    outbox: Outbox,
    *,
    dry_run: bool,
    send: Callable[[str], None],
    now_ms: int,
    jitter: float = 0.0,
) -> str:
    """Try the next pending row. Returns delivered, retry, failed, or idle."""
    row = outbox.peek()
    if row is None:
        return "idle"
    if dry_run:
        outbox.mark(
            row.sequence,
            status="delivered",
            attempts=row.attempts + 1,
            completed_at=now_ms,
        )
        outbox.advance()
        return "delivered"
    try:
        send(row.body)
    except Exception:
        attempts = row.attempts + 1
        expires = row.expires_at or now_ms + _EXPIRY_MS
        deadline = retry_at_ms(attempts, now_ms, jitter=jitter)
        if deadline >= expires:
            outbox.mark(
                row.sequence,
                status="failed",
                attempts=attempts,
                expires_at=expires,
                completed_at=now_ms,
                reason="expired",
            )
            outbox.advance()
            return "failed"
        outbox.mark(
            row.sequence,
            status="pending",
            attempts=attempts,
            next_attempt_at=str(deadline),
            expires_at=expires,
        )
        return "retry"
    outbox.mark(
        row.sequence,
        status="delivered",
        attempts=row.attempts + 1,
        completed_at=now_ms,
    )
    outbox.advance()
    return "delivered"


def replay(outbox: Outbox, sequence: int, *, now_ms: int) -> str | None:
    """Copy a finished payload into a new pending row. Mirrors the 7-day rule."""
    row = outbox.find(sequence)
    if row is None:
        return "Delivery not found"
    if row.event_type == "webhook.test" or row.status not in ("delivered", "failed"):
        return "Payload is unavailable for replay"
    if not row.body or not row.completed_at:
        return "Payload is unavailable for replay"
    if now_ms - row.completed_at > _REPLAY_MS:
        return "Payload is unavailable for replay"
    outbox.append(row.body, event_type=row.event_type, expires_at=now_ms + _EXPIRY_MS)
    return None


def _int(value: object) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return 0


def _read_owner(path: Path) -> dict[str, object] | None:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return None
    if not isinstance(loaded, dict) or not isinstance(loaded.get("token"), str):
        return None
    return loaded
