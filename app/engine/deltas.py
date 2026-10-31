"""Coalesce `item.delta` onto the live wire.

Raw deltas are not persisted. A flush about 40 ms after the first delta in a
window emits one combined delta per item and field. The final text still rides
`item.completed` from the runner, which is what replay reads.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

FLUSH_S = 0.04
MAX_BUFFER = 64_000

LiveEmit = Callable[[str, str, str, str], None]
Spawn = Callable[..., asyncio.Task[Any]]


class DeltaCoalescer:
    def __init__(self, flush_s: float = FLUSH_S, spawn: Spawn | None = None) -> None:
        self.flush_s = flush_s
        self.spawn: Spawn = spawn or asyncio.create_task
        self.pending: dict[tuple[str, str, str], str] = {}
        self.full: dict[tuple[str, str], str] = {}
        self._timer: asyncio.Task[None] | None = None
        self._emit: LiveEmit | None = None

    def push(self, run_id: str, item_id: str, field: str, delta: str, emit: LiveEmit) -> None:
        if not delta:
            return
        self._emit = emit
        key = (run_id, item_id, field)
        self.pending[key] = self.pending.get(key, "") + delta
        full_key = (run_id, item_id)
        self.full[full_key] = self.full.get(full_key, "") + delta
        if len(self.pending[key]) >= MAX_BUFFER:
            self.flush()
            return
        if self._timer is None or self._timer.done():
            self._timer = self.spawn(self._wait())

    async def _wait(self) -> None:
        try:
            await asyncio.sleep(self.flush_s)
        except asyncio.CancelledError:
            return
        self.flush()

    def flush(self) -> None:
        timer = self._timer
        self._timer = None
        if timer is not None and not timer.done():
            timer.cancel()
        pending, self.pending = self.pending, {}
        emit = self._emit
        if emit is None:
            return
        for (run_id, item_id, field), delta in pending.items():
            if delta:
                emit(run_id, item_id, field, delta)

    def take_full(self, run_id: str, item_id: str) -> str:
        return self.full.pop((run_id, item_id), "")
