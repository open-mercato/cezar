# Execution plan — macOS host memory and a widget that never goes stale

## Goal

Make the sidebar CPU/RAM glance and the Machine card report macOS memory the way Activity Monitor
does, and keep both live when the WS `host` topic is refused.

## Findings

1. **macOS RAM reads ~95 % on a healthy machine.** `os.freemem()` is libuv's
   `uv_get_free_memory`, which on darwin is `vm_statistics.free_count × pagesize` — only the
   *free* list. macOS keeps RAM full of reclaimable file cache (inactive, speculative, purgeable
   pages), so `total − freemem` counts that cache as used. Measured on a 48 GB M-series host:
   Node said 95.5 % used, Activity Monitor's formula said ~75 %.
   Activity Monitor: `Memory Used = App Memory + Wired + Compressed`, with
   `App Memory = anonymous (internal) pages − purgeable pages` and `Compressed = pages occupied by
   compressor`; everything else (free, file-backed cache, purgeable, speculative) is reclaimable.
   All four counts come from one `vm_stat` read (`wire_count` has no sysctl).
2. **macOS swap is never shown.** Swap is read from `/proc/meminfo` only; `sysctl vm.swapusage`
   carries the same pair on darwin.
3. **The sidebar glance freezes when the `host` topic is refused.** The hub admits a dev-proxy
   socket as untrusted when the browser sends no `Sec-Fetch-Site: same-origin`, and `host` is a
   trusted-only topic. The store records `topicUnavailable`, but the route fallback lives only in
   the Machine card: the widget shows `sampling…` forever, and after the card was visited once it
   holds that single route answer, which turns `stale` 10 s later and never refreshes.
4. **A polled route cannot produce a CPU delta on its own.** With no timer running, each route read
   is the only CPU capture, so polling it needs the sampler to stay warm between reads.

No open or merged PR addresses either issue (searched PRs for RAM/memory/host usage/CPU).

## Scope

- `packages/cezar/src/core/host-usage.ts` — darwin memory + swap readers, a `keepWarm` lease.
- `packages/cezar/src/server/server.ts` — the host-usage route keeps the sampler warm.
- `packages/web/src/api/host-usage.tsx` — refused topic → bounded route polling in the writer.
- `packages/web/src/routes/settings/machine-card.tsx` — the one-shot route read is remote-only.
- `packages/contract/src/host.ts` — doc comments only (swap is no longer Linux-only).

## Non-goals

- Changing the hub's trust rule for the `host` topic.
- Memory-pressure signals (`kern.memorystatus_level`) or admission control (#1044).
- Windows memory semantics.

## Risks

- `vm_stat` is a synchronous child process per sample (~2 ms every 2 s); a failure falls back to
  `os.freemem()`, so the default path never loses a reading.
- The route lease starts the 2 s timer for one stale window per read; it stops on its own.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: macOS memory on the server

- [ ] 1.1 Activity-Monitor memory from vm_stat on darwin, with os fallback
- [ ] 1.2 macOS swap from sysctl vm.swapusage

### Phase 2: a glance that keeps updating

- [ ] 2.1 Route reads keep the sampler warm for one stale window
- [ ] 2.2 Refused host topic polls the route from the active writer
