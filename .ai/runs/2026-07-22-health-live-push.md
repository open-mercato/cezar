# Execution plan — health: stop polling `/api/health`, push over the live stream

## Goal

Kill the per-tab 5-second `GET /api/health` poll and the >1 s per-request cost. Push health/status
updates to clients over the existing persistent stream instead, keep a cheap liveness endpoint for
ops tooling, and make the rich `/api/health` fast even on the initial load.

## Why it is slow (investigation)

`GET /api/health` (`src/server/server.ts` `app.get('/api/health')`) runs, on **every** request:

- `detectEnvironment()` (`src/core/backend-detect.ts`) — spawns **5 subprocesses** in parallel:
  `claude --version`, `codex --version`, `opencode --version`, `gh auth token`, `git --version`,
  each with a 10 s timeout. `claude --version` and `gh auth token` are the dominant cost and push
  the response past 1 s on a cold PATH.
- `getRepoInfo(bootRoot)` — 2–4 more `git` subprocesses.

`web/app/src/api/queries.ts` `useHealth()` polls this every **5000 ms** (`refetchInterval`), per open
tab (`#369` — only the branch chip actually changes over the run's life). So N tabs × (5 CLI + up to
4 git) subprocess spawns every 5 s against a server that shares the laptop's CPU with the agents.

The installed CLIs do **not** change over the server's lifetime — that whole probe set is effectively
static. The only genuinely dynamic bit is the repo branch (a `git checkout` in a terminal), which is
exactly what `#369` cites as the reason for the poll.

## Design decision — SSE, not a new WebSocket stack

The brief says "WS". This app has **no WebSocket infrastructure**; its persistent client→server push
primitive is the **SSE stream** `GET /api/workspace/events` (`web/app/src/api/global-events.tsx`),
one connection per app carrying `run` / `run-deleted` / `todos` / `usage` / `ping`, with mature
reconnect/visibility/bfcache handling and an explicit "one connection for the whole workspace"
architecture. Introducing a parallel WebSocket transport would duplicate all of that and contradict
the repo's stated design. So we honor the **intent** — push instead of poll over one persistent
connection — by adding a `health` event to the existing SSE stream. Documented in the PR body.

Two independent fixes, both needed:

1. **Cheap `/api/health`** — cache the static host probes (single-flight, TTL) so even the initial
   load and the once-per-connection snapshot are fast. The response shape stays byte-identical
   (BACKWARD_COMPATIBILITY.md §2).
2. **Push instead of poll** — one server-side monitor recomputes the (now cheap) health snapshot on
   an interval and broadcasts a `health` SSE event **only when it changes**; clients fold it into the
   `health` query cache and drop their `refetchInterval`. One server timer replaces N client polls.

Plus a dedicated **cheap liveness endpoint** `GET /api/live` (no probes) for load-balancer/ops checks.

## Scope

- `src/core/backend-detect.ts` — add a cached, single-flight `detectEnvironmentCached()`.
- `src/server/server.ts` — extract a shared `buildHealth()`; `/api/health` uses the cached probes;
  add `HealthMonitor` (injectable via `ServerDeps`); emit `health` on `/api/workspace/events`; add
  `GET /api/live`.
- `BACKWARD_COMPATIBILITY.md` — inventory `/api/live`; note the additive `health` SSE event.
- `web/app/src/api/events.ts` — parse the `health` event.
- `web/app/src/api/global-events.tsx` — fold `health` into the query cache.
- `web/app/src/api/queries.ts` — drop `useHealth`'s `refetchInterval`.
- Tests alongside each.

## Non-goals

- No new WebSocket transport/dependency.
- No change to the `/api/health` response shape or its CORS-open contract.
- No per-project health stamping (health stays workspace/boot-level, single-mount, as today).
- No `.git/HEAD` filesystem watcher (a single cheap server-side interval is the honest, simpler fix).

## Risks

- **Probe cache staleness**: a CLI installed after boot takes up to the TTL (30 s) to appear in
  health. Acceptable and documented; far cheaper than probing every request.
- **BC route-inventory guard**: `src/server/bc-route-inventory.test.ts` fails if `/api/live` is not
  added to the §2 inventory — handled in Phase 3.
- **SSE event evolution**: adding a `health` event name is additive and inert to older consumers
  (§2 explicitly allows this); renaming an existing one would be breaking — we add, never rename.
- **Monitor lifecycle**: the interval must be ref-counted to connected streams and `unref`'d so an
  idle server does no work and never holds the process open.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server — make health cheap

- [ ] 1.1 Add single-flight TTL `detectEnvironmentCached()` in `backend-detect.ts` (keep `detectEnvironment` for boot/install callers)
- [ ] 1.2 Extract a shared `buildHealth()` in `server.ts`; route uses cached probes

### Phase 2: Server — push health over the SSE stream

- [ ] 2.1 Add `HealthMonitor` (ref-counted, diff-gated, `unref`'d interval), injectable via `ServerDeps`
- [ ] 2.2 Emit an initial `health` on connect + relay changes on `GET /api/workspace/events`

### Phase 3: Server — liveness endpoint + BC docs

- [ ] 3.1 Add `GET /api/live` (cheap, no probes); update BACKWARD_COMPATIBILITY.md §2

### Phase 4: Client — subscribe to push, drop the poll

- [ ] 4.1 Parse the `health` event in `events.ts` (`GlobalEvent` + workspace/legacy parsers)
- [ ] 4.2 Fold `health` into the query cache in `global-events.tsx`
- [ ] 4.3 Remove `useHealth`'s `refetchInterval` in `queries.ts`

### Phase 5: Tests + validation

- [ ] 5.1 Server tests: `/api/live`, probe cache single-flight, `HealthMonitor` diff/emit, stream emits `health`
- [ ] 5.2 Client tests: `health` parse, cache fold, `useHealth` no longer polls
- [ ] 5.3 Full validation gate green (`npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`)
