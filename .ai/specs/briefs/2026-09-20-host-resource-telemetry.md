# Live host resource telemetry — the Machine card (CPU, RAM, load)

- Date: 2026-09-20
- Category: feature
- Priority signal: medium — the cockpit shows live CPU/RAM per task but nothing about the machine itself; the owner asked for a live, visual machine view.
- Risk signal: low — a read-only sampler, one WS topic and one workspace route; no persistence, no DB, no env var, no change to existing payloads; the publisher runs only while the Machine card is on screen.
- Routing: Next: om-auto-write-spec "Live host resource telemetry — the Machine card — brief: .ai/specs/briefs/2026-09-20-host-resource-telemetry.md"

## Problem

`process-usage.ts` already samples each run's process tree every ~2 s and the task tables show live
CPU/Mem. Nothing aggregates the host: `health` carries version/repo/capabilities only, and the
codebase never reads `os.totalmem`, `os.freemem`, `os.loadavg` or `os.cpus()`. A user watching a
fan-out sees which task eats memory but not whether the machine is at 90% CPU or low on RAM. The
owner asked for a live, visual view of "jak wyglądają zasoby maszyny, na której pracuje Cezar".

## Agreed direction

**v1 is one server sampler, one demand-driven WS topic, one workspace route, and one UI surface:
the "Machine" card at the top of Settings → Resources.**

1. **Sampler** (`packages/cezar/src/core/host-usage.ts`): a module-level timer every
   `HOST_SAMPLE_INTERVAL_MS = 2_000`. CPU % is a delta of `os.cpus()` times normalized to 0–100;
   memory uses `os.totalmem()`/`os.freemem()` (on Linux libuv ≥1.45 already prefers `MemAvailable`);
   `/proc/meminfo` is parsed **only for swap**, which Node does not expose; `loadAvg` comes from
   `os.loadavg()`; `cpuCount` is `os.availableParallelism()` (always ≥ 1, cgroup-quota aware).
   The first sample omits `cpuPct`; every field is best-effort and nothing throws.
2. **WS topic `host`** on the existing bus. `start(publish)` primes the CPU baseline and starts the
   timer; each 2 s tick publishes the fresh sample; the returned stop clears everything.
   `snapshot()` is a **pure read of the last sample** (or a memory/load-only prime when none exists)
   — it never recomputes a CPU delta, because the hub calls `start()` before `snapshot()` and a
   freshly primed baseline would produce NaN/0% on the first frame. The topic stays trusted-only
   (default `loopbackReadable: false`); it publishes every tick while subscribed (a continuously
   varying gauge — `sampledAt` alone would defeat a change guard anyway).
3. **Route** `GET /api/v1/workspace/host-usage` returns the same cached sample (200 only; the
   required fields always exist). Remote uses it as a snapshot, refreshed by the existing
   visibility/reconnect reconcile seam — **no `refetchInterval`**.
4. **UI: the Machine card** in Settings → Resources, above the existing resource fields. It
   subscribes to the topic **in that view only** (`useEffect(...) => unsubscribe`), so leaving the
   page stops the sampler (0→1/1→0). The card shows a CPU bar + 60 s sparkline (30 samples), a
   RAM used/total bar, swap when present, load when present, and a client-measured "updated Xs
   ago". The host totals are labelled **host-level** (cgroup/container caveat in the docs).
   The sidebar glance widget is explicitly **deferred to v2**.

**Rejected, with why** (both reviews — units `906047e7` doctrine/UX and `3baaa393` technical —
returned *changes* and converged on this cut):

- **Sidebar widget + root subscription in v1.** The sidebar is hidden below `md` and its drawer is
  normally closed, so "always visible" was false; a root subscription would keep the sampler and
  frames running for an invisible widget. Deferred; a widget would move the subscription to its
  own demand scope.
- **Remote 5 s `refetchInterval`.** The WS spec's remote mode is "HTTP bootstrap + SSE
  reconnect/visibility reconciliation", not a poll; the card refreshes through the existing
  reconcile seam on mount, visibility and reconnect.
- **Fresh/delta snapshot.** The hub calls `start()` before `snapshot()` (`ws.ts:161-174`); a
  snapshot that samples CPU would race its own baseline. Pure-read snapshot + timer-owned baseline.
- **cgroup-aware memory/CPU in v1.** `/proc/meminfo`, `os.totalmem`, `os.cpus` and `os.loadavg` are
  all cgroup-unaware; parsing cgroups is platform-specific. v1 labels the card host-level and the
  caveat is documented.
- **Extending `GET /api/health`.** It is the CORS-open discovery payload with a 5 s cache; host
  metrics must not widen it.
- **Per-core, disk, network, GPU, process counts.** Deferred; disk free for worktrees is the
  strongest v2 candidate.
- **A chart library.** Sparkline + bars are ~100 lines of SVG with the existing tokens.

## Resolved unknowns

| Question | Answer |
|----------|--------|
| Metric set | `sampledAt`, optional `cpuPct` (0–100), `cpuCount`, memory total/used/available, optional swap total/used, optional `loadAvg` 1/5/15. |
| CPU math | `os.cpus()` times delta between ticks, sum busy / sum total × 100; first sample omits `cpuPct`; a zero/absent delta omits it rather than faking 0. |
| CPU count | `os.availableParallelism()` — always ≥ 1, unlike `os.cpus()` which can be empty where `/proc` is unavailable. |
| Memory | `os.totalmem()`/`os.freemem()`; `/proc/meminfo` only for swap; absent swap/load fields are omitted, never zeroed. |
| Transport | WS topic `host` (local, per-view subscription) + `GET /api/v1/workspace/host-usage` (remote snapshot and reconcile target). |
| Subscription scope | Inside the Machine card's view effect, returning the unsubscribe; sampler stops when the view leaves. |
| Remote | Route fetch on mount + the existing visibility/reconnect reconcile; no interval; the card says "last known". |
| Freshness | "Updated Xs ago" is measured client-side from receipt time (no server-clock comparison). |
| Containers | v1 is host-level and says so in the card and in `docs/reference.md`; cgroup parsing deferred. |
| Persistence | None: server keeps the last sample, the card keeps 30 samples (~60 s) for the sparkline. |
| Security | Topic trusted-only; route under the normal `/api/v1` guard; no CORS widening. |
| Cost | One `os.cpus()` + one small `/proc` read every 2 s **only while the card is on screen**; zero timers otherwise; no new dependency, no DB, no env var. |

## Non-goals

- The sidebar glance widget (v2), per-core CPU, disk/network/GPU/temperature, process counts.
- cgroup-aware/container-partitioned numbers (v1 is host-level, labelled).
- Historical charts, alerts, automations reacting to load, any persistence.
- Changes to `health` or any existing payload.

## Affected areas (if known)

- `packages/cezar/src/core/host-usage.ts` (new) + tests.
- `packages/contract/src/host.ts` (new schema) — route/WS payload.
- `packages/cezar/src/server/server.ts` — the workspace route + the `host` topic registration.
- `packages/web/src/api/` — host-usage cache/hook, the card's subscription, the reconcile key.
- `packages/web/src/routes/settings/resources-section.tsx` — the Machine card.
- `docs/reference.md`, `BACKWARD_COMPATIBILITY.md` §2.

## Watch-outs

- `snapshot()` is a pure read of the last sample; the timer owns the CPU baseline. The hub calls
  `start()` before `snapshot()` (`ws.ts:161-174`), so a sampling snapshot gives NaN/0% on the first
  frame of every subscribe.
- `/proc/meminfo` is readable inside containers but returns **host** totals; `os.loadavg()` is
  `[0,0,0]` on Windows (omit the field, hide the row — do not render a fake zero or `n/a`).
- `os.cpus()` can be empty where `/proc` is absent; use `os.availableParallelism()` for the count.
- Publish every 2 s tick while subscribed; a change guard keyed on the whole payload is inert
  because `sampledAt` changes each tick.
- Use the real design tokens (`--pending` fill, `text-pending-strong`); `text-amber-*` is banned by
  the design guardian. Reuse `formatMem` so numbers read like the task table's.
- The card fetches/subscribes **in its view**, returns the unsubscribe, and never opens a second
  socket; remote opens no WS at all.
- The route is workspace-level single-mount: add it to `route-parity`'s workspace-only list, the
  §2 inventory, and the contract-parity suite; a no-input GET is covered by the typed client call,
  not `typed-bodies`' `HasTypedInput`.
