"""Messages accepted while a session is not open yet.

A marker file records the count so a restart can say the text itself is gone.
The buffer is delivered as the next step's note, or as a follow-up if the run
was about to enter review. A cancel or Finish reports it undelivered.
"""

from __future__ import annotations

from pathlib import Path

_SUFFIX = ".deferred"


class DeferredBuffer:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.pending: dict[str, list[str]] = {}

    def add(self, run_id: str, text: str) -> None:
        self.pending.setdefault(run_id, []).append(text)
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / f"{run_id}{_SUFFIX}").write_text(
            str(len(self.pending[run_id])), encoding="utf-8"
        )

    def take(self, run_id: str) -> list[str]:
        messages = self.pending.pop(run_id, [])
        path = self.directory / f"{run_id}{_SUFFIX}"
        if messages or path.exists():
            path.unlink(missing_ok=True)
        return messages

    def lost_on_startup(self) -> list[tuple[str, str]]:
        if not self.directory.is_dir():
            return []
        notes: list[tuple[str, str]] = []
        for path in self.directory.glob(f"*{_SUFFIX}"):
            run_id = path.name[: -len(_SUFFIX)]
            try:
                count = max(1, int(path.read_text(encoding="utf-8") or "1"))
            except OSError, ValueError:
                count = 1
            word = "a message" if count == 1 else f"{count} messages"
            notes.append(
                (
                    run_id,
                    f"{word} sent while the session was closing could not be delivered — "
                    "cezar restarted; send it again",
                )
            )
            path.unlink(missing_ok=True)
        return notes
