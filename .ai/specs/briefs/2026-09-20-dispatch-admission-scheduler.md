# Dispatch admission cap — an opt-in ceiling on concurrently running dispatch children

- Date: 2026-09-20
- Category: feature
- Priority signal: high — dispatch (0.11) lets one parent create up to 4 children in a single turn and each starts as soon as a `maxParallel` slot frees; a fan-out can take every slot from ordinary tasks with no dispatch-specific brake.
- Risk signal: low-medium — one additive workspace resource key plus one per-run predicate in `pump()`; no new routes, no record field, no browser state, no timer; the shipped default (`null`) is byte-for-byte today's behavior.
- Routing: Next: om-auto-write-spec "Dispatch admission cap for dispatch children — brief: .ai/specs/briefs/2026-09-20-dispatch-admission-scheduler.md"

## Problem

The 0.11 dispatch engine bounds how *much* a tree may order — 4 children in flight per parent
(`dispatch/engine.ts:33,49-51`), `maxSubtasks`, a carved child budget (`engine.ts:62-79`) — but
not how many dispatch children may *run at once*. `dispatch()` → `startRun()` → `queue.push()` →
`pump()` starts a child the moment `semaphore.busy() < maxParallel` and
`busySlots() < projectMax` (`run.ts:1353-1356`); `maxParallel` is a host cap shared with ordinary
tasks, so a fan-out can occupy every slot. The shipped dispatch spec names the gap in its
"Not done (deliberately)" list as `mission-scoped concurrency`. Evidence it matters: the owner
asked for a throttle on dispatch-generated runners that needs no database and is configured from
the cockpit.

## Agreed direction

**v1 is a static, opt-in concurrency cap enforced by the engine — no lease, no admit route, no
browser loop, no held flag, no timer.**

1. New additive workspace resource `resources.dispatchMaxConcurrent` (`null`/`0` = no cap,
   otherwise `1..16`), stored in `~/.cezar/config.json` and edited in **Settings → Resources**
   (the browser is the configuration surface). It is workspace-wide, like `maxParallel`, so every
   browser, project and CLI sees the same value.
2. Enforced per-run in `pump().startable()` (`run.ts:1379-1383`): if the candidate is a dispatch
   child (`record.dispatch?.parentRunId !== undefined`) and the workspace-wide count of dispatch
   children holding a compute slot (`starting` plus `active − waiting`, the exclusion
   `busySlots()` already applies) has reached the cap, skip it and try the next queued run.
   Ordinary tasks are unaffected — they can still take free slots, which is the point of a
   dispatch-specific ceiling.
3. The counter is event-driven: `WorkspaceSemaphore` gains a `dispatchBusy()` participant sum
   (mirroring `busy()`, `semaphore.ts:175-184`), and the existing
   `releaseSlot() → semaphore.release()` workspace pump starts the next eligible child the moment
   a slot frees (`run.ts:1307-1318`). No new timer, no deadline wake, no route, no browser
   liveness dependency.
4. A `resources` change already refreshes the shared semaphore cache and pumps every project
   (`server.ts:3033`, `semaphore.ts:296`), so the cap applies without a restart. Lowering it
   below the current running count does **not** preempt anything — it gates new starts.

**Rejected, with why** (full severity-ranked review: unit `b2a52605`):

- **Browser-held lease + `dispatch.held` + `POST /runs/:id/admit` + a root-level controller.**
  The review showed the lease buys only per-child *approval* — a different capability — while the
  entire pacing goal is already event-driven through the existing pump. It also adds a liveness
  window (what happens between enabling and a browser driving it), a product contradiction in
  manual mode (fail-open breaks the promise; fail-closed dead-ends the tree per AGENTS.md), a new
  route/contract/UI surface, and a stale-chip interval. Deferred to a separate spec, if wanted.
- **Policy in `localStorage`.** A workspace-level cap is a considered choice that must agree
  across browsers and the CLI; `BACKWARD_COMPATIBILITY.md` keeps browser state (theme, last
  location) separate from workspace choices (sidebar order), and the cockpit port/host can change
  (`localhost:4321` vs `127.0.0.1:4321` are different origins), so localStorage would silently
  fork the policy. The value belongs in `resources`.
- **`minIntervalMs` time pacing.** The only knob that needs a deadline wake; it is not required
  to bound admission. Deferred; no server timer is added for it.
- **Another global concurrency cap.** `maxParallel` already caps the host; this key is
  deliberately narrower (dispatch children only) and composes with it.
- **A `held` run status or record field.** With no per-child approval there is nothing to mark:
  a capped dispatch child is simply `queued`, exactly like any other waiting run.

## Resolved unknowns

| Question | Answer (design research + review) |
|----------|-----------------------------------|
| What exactly is capped? | Dispatch children (`dispatch.parentRunId` present) that hold a compute slot (`starting` plus `active − waiting`, the `busySlots()` exclusion), counted workspace-wide. `waiting`/parked children hold no turn and are not counted — `active` includes them, so the subtraction is load-bearing. |
| Where is the cap stored? | `~/.cezar/config.json` `resources.dispatchMaxConcurrent` — additive, nullable, default `null`; visible to every browser and CLI. |
| Where is it configured? | Settings → Resources, one numeric field (empty = no cap), saved through the existing `PUT /api/v1/workspace/config`; no new route. |
| Where is it enforced? | `pump().startable()` per candidate run, before dequeue; ordinary runs keep their existing capacity path. |
| How many knobs? | One: `dispatchMaxConcurrent`. No mode, no interval, no per-tree override. |
| What happens when the cap is reached? | The child stays `queued`; the next startable run (an ordinary task, or another dispatch child once a slot frees) is considered. No new state, no chip, no action. |
| Does it compose with existing caps? | Yes: effective admissibility is still `min(maxParallel, projectMax)` plus the new dispatch ceiling; the cap can never raise concurrency. |
| Does a config change need a restart? | No — the existing `semaphore.refresh()` + workspace pump apply it on save. |
| What is the default with no config? | `null` = no cap = today's behavior, byte-for-byte. |
| Does a held/queued child still count toward the tree brakes? | Yes, unchanged: `queued` already counts in the 4-in-flight cap and reserves its carved budget. |
| What about per-child approval / manual release? | Deferred: a separate spec and an explicit owner decision, because it trades a cap for an approval workflow with its own liveness semantics. |
| Remote mode? | Config and enforcement are server-side and apply everywhere; no browser controller exists to be local-only. |

## Non-goals

- No per-child approval, lease, admit endpoint, held field, or manual release in v1.
- No minimum-interval/time-based pacing (would need a deadline wake).
- No per-tree or per-project override — the tree brakes (`4 in-flight`, `maxSubtasks`, budget)
  already bound the tree; the new key protects the host, like `maxParallel`.
- No new database, state file, `CEZ_*` env var, `RunStatus`, or route.
- No preemption: lowering the cap never cancels or pauses a running child.

## Affected areas (if known)

- `packages/cezar/src/workspace/config.ts` — `resources.dispatchMaxConcurrent` schema (nullable int, `.catch(null)`).
- `packages/cezar/src/workspace/semaphore.ts` — cache field + accessor + `dispatchBusy()` participant sum.
- `packages/cezar/src/workflows/run.ts` — the per-run predicate in `pump().startable()`.
- `packages/cezar/src/server/server.ts` — `resources` in the workspace config GET/PUT body.
- `packages/contract/src/workspace.ts` — response + update schemas for the new key.
- `packages/web/src/routes/settings/resources-section.tsx` — the Settings field.
- `docs/reference.md`, `BACKWARD_COMPATIBILITY.md` — resources documentation and §2 shape.

## Watch-outs (from the research)

- Add the predicate **inside `startable()`**, not in `capacity()`: `capacity()` is shared with
  ordinary runs, and blocking the whole queue on a dispatch cap would defeat the purpose.
- `findIndex(startable)` already skips non-startable heads without re-queueing them, so the
  dispatch child keeps its queue position while ordinary runs pass it — the usage-limit hold is
  the precedent (`run.ts:1381-1389`).
- Count only runs that hold a compute slot: `starting` plus `active` minus `waiting`
  (`waiting ⊆ active` in this codebase, `run.ts:1680-1682`; mirror `busySlots()` `:1253-1265`),
  so a parked child never consumes the dispatch budget.
- `resources` is read through the semaphore's in-memory cache, refreshed on
  `PUT /workspace/config`; do not re-read the file per pump.
- The key is additive: `null` **and** `0` both mean "no cap" (the Settings field sends `null` when
  cleared, matching `memoryLimitMb`), an older cezar ignores it through `.passthrough()`, and
  `BACKWARD_COMPATIBILITY.md` §2's resources shape plus the GET body must carry it exactly.
  (NIT-2 of the specification review: an earlier draft of this line said absent/`null` must stay
  distinguishable from a chosen `0`; the spec's reading is the right one and this line now agrees
  with it.)

## Review trail

- Doctrine/simplicity/UX review `b2a52605` (verdict **changes**, confidence 0.78): drove the v2
  shape — drop the lease/admit/controller, move the policy to `resources`, drop manual mode and
  `minIntervalMs`; all HIGH findings accepted.
- Technical review `4289c731` (verdict **changes**, confidence high): its verified-TRUE list
  confirms the v2 mechanics (synchronous dispatch→startRun, `startable()` is the only dequeue
  decision, a gate before `queue.splice` protects the slot, `forceNextPump` only nullifies account
  holds, one shared semaphore threaded to every manager, route parity derived from `app.routes`).
  One finding applies to v2 and is folded in: `waiting ⊆ active`, so the counter must subtract
  `waiting`. The remaining findings are lease-specific (admit atomicity, held chip in the
  runs-index, clientId takeover, stale held) and are recorded in the spec's Deferred section as
  constraints for any future per-child approval design; they do not apply to the v2 cap.
