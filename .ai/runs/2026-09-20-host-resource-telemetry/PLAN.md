# Execution plan — host resource telemetry (the Machine card)

Tracking plan: `.ai/runs/2026-09-20-host-resource-telemetry/PLAN.md`
Source spec: `.ai/specs/2026-09-20-host-resource-telemetry.md` (spec PR
[#1035](https://github.com/open-mercato/cezar/pull/1035), spec v2.1 `fded0afc`)
Replaces/complements: none. **Sequencing:** #1034 (dispatch admission cap) is still open and
touches `packages/web/src/routes/settings/resources-section.tsx`, `docs/reference.md` and
`BACKWARD_COMPATIBILITY.md` §2 — this branch rebases on `main` after #1034 merges.

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` (same commit as the Step's code) and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids and `Exec` cells are immutable once the plan is committed — per-Step commits touch only `Status` and `Commit`. One deliberate deviation from the loop contract: a Step's own SHA cannot be written inside the Step's own commit (self-reference), so the `Commit` cells are filled by a single trailing `docs(runs): record step commits` commit at run end; `Status` is still flipped 1:1 with the Step's commit, which is what resumption parses.

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 1 | 1.1 | Contract: `hostUsageSchema` + export, serialization test | inline | done | 2dabe956 |
| 1 | 1.2 | `core/host-usage.ts`: read-through sampler with the staleness rule | inline | done | 972081b2 |
| 1 | 1.3 | Sampler unit tests (baseline, delta, staleness, start/stop, swap/load) | inline | done | a4c3a636 |
| 1 | 1.4 | `GET /workspace/host-usage` route + parity/BC inventory entries | inline | done | 703887c5 |
| 1 | 1.5 | `host` WS topic + hub tests | inline | done | 5f4ba58f |
| 2 | 2.1 | Web `api/host-usage.ts`: query key, cache, subscription, remote warm-up | inline | done | c74abdfe |
| 2 | 2.2 | Machine card UI (CPU bar + sparkline, RAM bar, swap/load, freshness) | inline | done | 37143423 |
| 2 | 2.3 | Docs: `docs/reference.md` + `BACKWARD_COMPATIBILITY.md` §2 note | inline | done | 303408ca |
| 2 | 2.4 | Gate fix: health-topic registration pin survives the second topic | inline | done | 6858a563 |
| 2 | 2.5-review-fix | Review fixes: drop raw gate logs, platform-gate the swap reader, card error state | inline | done | 6ac4abc0 |

## Goal

Settings → Resources gains a **Machine card**: live host CPU (value, bar, 60 s sparkline), memory
(used/total bar), swap and load when the OS exposes them, and a client-measured freshness line —
fed by one demand-driven WS topic (`host`) for local cockpits and by
`GET /api/v1/workspace/host-usage` for remote ones. The sampler runs only while the card is on
screen.

## Scope

- `packages/contract/src/host.ts` (new) + `index.ts` export.
- `packages/cezar/src/core/host-usage.ts` (new) + tests.
- `packages/cezar/src/server/server.ts`: the workspace route and the `host` topic.
- `packages/cezar/src/server/route-parity.test.ts`, `bc-route-inventory.test.ts` fixtures and
  `BACKWARD_COMPATIBILITY.md` §2.
- `packages/web/src/api/host-usage.ts` (new), `queries.ts` (key + reconcile entry),
  `global-events.tsx` (reconcile key), `routes/settings/resources-section.tsx` (the card).
- `docs/reference.md`.

## Non-goals

Sidebar glance widget, per-core CPU, disk/network/GPU/temperature, process counts, cgroup-aware
numbers, historical charts, persistence, alerts, any change to `health` or existing payloads, any
new env var.

## Risks

- **Contract drift** between the zod schema and the route: covered by `contract-parity` (compile
  time) and the new route's typed-client call.
- **Sampler cost**: zero timers without a subscriber; the read-through path adds one `os.cpus()`
  read per route hit, never a loop.
- **Staleness honesty**: a CPU reading is only produced from a capture no older than
  `HOST_SAMPLE_STALE_MS`; the card shows `sampling…` rather than an aged number.
- **Sequencing vs #1034** (shared `resources-section.tsx` + docs inventory): rebase needed; no
  behavioural overlap.

## Implementation Plan

### Phase 1 — server

1.1 **Contract.** New `packages/contract/src/host.ts` with `hostUsageSchema` (`sampledAt`,
optional `cpuPct` 0–100, `cpuCount`, memory total/used/available, optional swap total/used,
optional `loadAvg`), type via `z.infer`, exported from `index.ts`. Test: schema accepts a
minimal sample (no optional keys) and a full one, and rejects a 101 % `cpuPct`.

1.2 **Sampler.** `packages/cezar/src/core/host-usage.ts`: `HOST_SAMPLE_INTERVAL_MS = 2_000`,
`HOST_SAMPLE_STALE_MS = 3 × interval`; injectable CPU-times source; `os.totalmem/freemem`;
`/proc/meminfo` swap (`SwapTotal − SwapFree`, omitted when unreadable or zero); `loadavg` omitted
on win32; `availableParallelism`; `currentHostUsage()` (pure read of the last sample);
`sampleHostUsage()` (read-through: returns the cached sample only when it carries `cpuPct` and is
fresher than the stale bound, otherwise reads memory/load now and computes a CPU delta only from
a capture within the stale window); `onHostUsage(listener)` (0→1 primes the baseline and starts
an `unref()`ed timer, 1→0 stops it). Nothing throws.

1.3 **Sampler tests.** Baseline priming (first read/tick has no `cpuPct`), delta normalization
and clamping, zero-delta omission, staleness rule (a capture older than the bound yields no
`cpuPct`, a warm-up read 2.5 s later does), swap absent/unreadable/zero, Windows load omitted,
start/stop symmetry, no timer after the last unsubscribe, and `sampleHostUsage()` never mutating
a *fresh* cached sample.

1.4 **Route.** `GET /workspace/host-usage` in the workspace chained family next to
`/workspace/config`; `contract-parity.workspace.test.ts` type assertion; the workspace-only list
in `route-parity.test.ts`; `BACKWARD_COMPATIBILITY.md` §2 inventory bullet. Test: the route
answers 200 with the contract shape and is workspace-only (never mirrored under `/p/`).

1.5 **Topic.** Register `host` in `createApp` behind `deps.socketHub?` with the default
trusted-only access. Tests: snapshot-before-first-tick has no `cpuPct`, 0→1 start / 1→0 stop,
per-tick publishing, untrusted connection refused, and the hub reuses one publisher for two
subscribers.

### Phase 2 — cockpit

2.1 **Web module.** `packages/web/src/api/host-usage.ts`: `workspaceQueryKeys.hostUsage`,
`useHostUsage()` (cache read), `useHostUsageSubscription()` used by the card only — local mode
subscribes via `subscribeTopic('host', …)` inside an effect returning the unsubscribe and folds
frames into the query cache; remote mode never opens a socket, fetches the route on mount, and
fires **one** warm-up fetch ~2.5 s later when the answer carried no `cpuPct` (cleared on
unmount). `global-events.tsx` gains `workspaceQueryKeys.hostUsage` in its reconcile list. Tests:
subscribe-on-mount/unsubscribe-on-unmount, warm-up fired exactly once and cleared, no socket and
no interval in remote.

2.2 **Machine card.** Rendered above "Max parallel tasks" (its own `machine-card.tsx` component,
imported by `resources-section.tsx` — keeps that file readable and shrinks the #1034 conflict
surface): CPU value + bar +
60 s sparkline (30 component-state samples), RAM used/total bar via `formatMem`, swap/load rows
only when present, `updated Xs ago` from receipt time, host-level caveat, `sampling…` before the
first `cpuPct`, tokens `--pending` / `text-pending-strong`, sparkline `role="img"` with an
aria-label. Tests: live rendering, first-tick state, remote `last known`, missing swap/load rows.

2.3 **Docs.** `docs/reference.md` Resources paragraph: live host totals, the remote warm-up
fetch, the container/cgroup caveat.

2.4 **Gate fix (found by the full gate).** `health-topic.test.ts` asserted the app registers
exactly ONE topic (`toEqual(['health'])`); with `host` as the app's second topic that assertion
had to state its real claim — health is registered exactly once, and `host` is registered too.
The health behavior it guards (single registration, `loopbackReadable: true`) is unchanged.

2.5 **Review fixes** (`om-auto-review-pr`, findings MINOR-1/2/3 + NIT-1/2): the raw gate/e2e logs
are dropped from the run folder (the summaries keep the numbers and every claim is
reproducible); `createHostSampler`'s injected `platform` now gates the DEFAULT swap reader, not
just `loadAvg`; the card renders `Host totals are unavailable right now.` when the route rejects
(with a test); the freshness placeholder is shortened; the read-pair helper is marked
`@internal`.

## Verification

- Per Step: the targeted unit suite(s) for the touched package, `npm run typecheck` when types
  cross a boundary.
- Checkpoints every 5 Steps: checkpoint file + PR comment (+ screenshots once UI exists).
- Final gate: `npm run typecheck`, `npm test` (compared against the `origin/main` baseline —
  Node v26 pre-existing failures), `npm run test:unit`, `npm run build`, `npm run test:package`,
  plus `om-auto-qa-pr` UI verification with screenshots.
