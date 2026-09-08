# Upward reporting & delivery — audit

> Topic: the CHILD → PARENT channel in the units hierarchy (spec `.ai/specs/2026-09-08-units-hierarchy.md`
> §"Reports and settle" / Q7). Analysis only, verified against HEAD `df73cfa9` on `cez/3c0a1bdb`
> (== fork point `cez/36533222`). Every line number below was re-read at that commit; where a test
> file is cited, its line numbers were re-read too. `npx vitest run packages/cezar/src/units
> packages/cezar/src/workflows/units-engine.test.ts packages/cezar/src/workflows/recover-unit.test.ts`
> → **5 files, 86 tests, all passing** — nothing here is a currently-red test; every finding is a gap
> in what is tested or specified, not a regression.

## The chain the task asked me to confirm or refute

Claim: a child that emits `CEZ:ASK` parks at `waiting`; `waiting` is not terminal so the parent is
never told; `waiting` is still in-flight so it still occupies a slot; the autonomous nudge is
deliberately disabled for a unit run that asked; meanwhile the parent gets nudged with nothing new
up to `MAX_AUTO_CONTINUES` times.

**Confirmed, with one important amendment (F-U2 below): the Guard-disable code exists in only ONE of
the two turn-end handlers, because on this branch the nudge mechanism itself only exists in one of
them.**

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| a | `CEZ:ASK` parks a child at `waiting` | **Confirmed** | `packages/cezar/src/workflows/run.ts:3035-3036` (streaming/`runContinuation`) and `:3737-3738` (`runAgentStep`): `this.store.updateRun(runId, { status: 'waiting', activity: undefined })`, reached when `ask` is true (`monitoring` is false whenever `ask` is true — `!ask` at `run.ts:2978` and `:3705`). |
| b | `waiting` is not terminal → parent never told | **Confirmed** | `TERMINAL_STATUSES` = `['done', 'review', 'failed', 'cancelled']`, `packages/cezar/src/units/engine.ts:42`. `isTerminalStatus`, `engine.ts:44-46`. Gate: `packages/cezar/src/workflows/run.ts:1762` — `if (!isTerminalStatus(child.status)) return;` inside `reportSettledChildToParent` (`run.ts:1756`). No other call site ever inspects a non-terminal child's status for reporting purposes (grepped `parentRunId` repo-wide — only `run.ts`, `engine.ts`, and their tests reference it). |
| c | `waiting` still counts against the in-flight cap | **Confirmed** | `IN_FLIGHT_STATUSES = ['queued', 'running', 'waiting']`, `engine.ts:37`, read by `inFlightChildren` (`engine.ts:54-56`) and enforced at the spawn refusal, `run.ts:1627`: `if (inFlight + spawn.children.length > MAX_CHILDREN_IN_FLIGHT)`. `MAX_CHILDREN_IN_FLIGHT = 4`, `engine.ts:29`. |
| d | The autonomous nudge is deliberately disabled for a unit run that asked, in **both** turn-end handlers | **Confirmed in one handler; the other has no nudge to disable at all — see F-U2** | `runContinuation`'s turn-end (`run.ts:2955-3044`) has the guarded auto-continue block at `:3002-3018`, condition `!(unitTurn.hasUnit && Boolean(ask))` at `:3006`. `runAgentStep`'s turn-end (`run.ts:3676-3757`) has **no such block anywhere** — `AUTONOMOUS_NUDGE` (`run.ts:314-315`) is referenced exactly once in the whole file, at `run.ts:3010`, inside `runContinuation` only. |
| e | The parent, parked as monitoring, gets nudged with `MONITORING_WAKE_NUDGE` up to `MAX_AUTO_CONTINUES` times | **Confirmed** | `MAX_AUTO_CONTINUES = 40`, `run.ts:313`. `MONITORING_WAKE_NUDGE`, `run.ts:316-317`. Bound checked twice in `armMonitoringWakeTimer` (`run.ts:4284-4328`): at entry, `run.ts:4290`, and inside the fired timeout, `run.ts:4312`. The nudge is sent via `this.deliverMessage(runId, [{ type: 'text', text: MONITORING_WAKE_NUDGE }], false)`, `run.ts:4325` — a live turn on the parent's own, still-growing session. |

**Restart recovery / where the counter lives — both asked explicitly:**

- `monitoringWakeups` is an **in-memory** field on `ActiveRun` (`run.ts:264`), never persisted on the
  run record. Only two persisted artifacts exist: `monitoringWakeAt` (a timestamp, cleared/set at
  `run.ts:4306`/`:4309`/`:4334`) and `monitoringWakeCapReached` (a boolean, set at `run.ts:4293`/`:4313`).
  Neither is a durable counter — a restart cannot resume "nudge 23 of 40", it can only see "the cap was
  reached" or not.
- `reconcileMonitoringWakeTimers` (`run.ts:4277-4282`), called from `pump()` at `run.ts:1091`, only
  re-arms a timer for a `runId` already in the in-memory `this.monitoring` `Set` **with an existing
  `ActiveRun`** — both are empty on a fresh process, so this path re-arms nothing after a crash.
- **What actually happens on restart:** `recover()` (`run.ts:1314-1380`) filters live runs to
  `['queued', 'waiting', 'running']` (`run.ts:1317`) and, for every run whose status is `running`
  (which is exactly what a monitoring park still shows — `status: 'running', activity: 'monitoring'`,
  `run.ts:3027`/`:3729`), treats it identically to an ordinary mid-turn crash: it force-marks the run
  `failed` (`run.ts:1354-1359`) and calls `continueRun(..., RESTART_CONTINUATION_PROMPT, ...)`
  (`run.ts:1360-1366`). There is no branch for "this running run was actually parked as a monitor" —
  the monitoring park, its wake deadline, and its nudge count are simply abandoned; the parent comes
  back as a **fresh continuation** (new `ActiveRun`, `monitoringWakeups` starts at `undefined`/0
  again), not as a resumed monitor. In effect: **the wake timer is never "re-armed" after a restart —
  the whole monitoring park is discarded and the parent is force-continued from scratch.** This is
  arguably safer than resuming a stale timer, but it is not documented anywhere as the restart
  behaviour for a unit commander, and no test in `recover-unit.test.ts` exercises a `running`+
  `activity: 'monitoring'` unit parent at restart — only a `waiting` **child** is (`recover-unit.test.ts:136-167`).

**Cost story (e):** default wake interval is `DEFAULT_MONITORING_WAKE_MINUTES = 5`
(`packages/cezar/src/workspace/config.ts:77`), zero-config (`config.test.ts:71` pins the 5-minute
default). Worst case: **40 live model turns, ~5 minutes apart, ~3h20m of wall time**, each one a full
turn on the parent's entire accumulated session context (every prior spawn note, every delivered
report, every tool call) for a message that says nothing more than "re-check the downstream work…"
(`run.ts:317`). For an Army/Squad mission where the commander's own transcript has grown across
several spawn→report cycles, that is 40 non-trivial-cost turns that read a large and growing context
to produce, at best, a repeated `CEZ:MONITORING`, and at worst nothing (if the model errors, drifts,
or answers something unrelated) — with **zero new information** to justify any of them if the reason
nothing changed is a single stuck-and-unreported child (F-U1).

## Is there any mid-flight progress channel from child to parent today?

**No.** Searched exhaustively: `grep -r parentRunId` across `packages/cezar/src` returns exactly
`run.ts`, `engine.ts`, and their test files — no SSE stream, no shared events bus, no handoff-file
watcher, no store subscription lets a parent's *session* (as opposed to a human looking at the
cockpit) observe a child before it settles. `handleUnitMarkers` (`run.ts:1531-1567`) stores a
`CEZ:REPORT` onto `unit.report` on the **child's own** record the instant it's parsed (`run.ts:1546-1554`),
regardless of whether the same turn also said `CEZ:DONE` — but nothing reads that field for delivery
to the parent until the child later reaches a `TERMINAL_STATUS` and `reportSettledChildToParent` runs
`childSettleReport` (`engine.ts:157-189`), which reads `child.unit?.report` at settle time
(`engine.ts:161`). The spec already documents this as intentional ("a report without `CEZ:DONE` leaves
the session as today's rules dictate", spec §Markers) — it is not a bug, but it does mean a child with
a multi-hour task gives its commander (and any human reading the mission tree) nothing to read until
it is completely finished, refused, or killed.

---

## Findings

### F-U1 — HIGH — A child parked on `CEZ:ASK` is invisible to its parent for as long as the ask is open
**Evidence:** the confirmed chain above — `run.ts:3035-3036`/`:3737-3738` (park), `engine.ts:42`+
`run.ts:1762` (not reported), `engine.ts:37`+`run.ts:1627` (still occupies a slot).
**Why it matters:** with `MAX_CHILDREN_IN_FLIGHT = 4`, one child stuck on a Guard question that
nobody has noticed in the (separate, human-only) Guard inbox silently removes up to a quarter of a
commander's fan-out capacity, and the commander itself has no way to tell *which* of its children is
the blocked one, or that any of them is blocked at all — it only ever sees "still nothing new" nudges
(F-U3). For a long autonomous mission this is the textbook AGENTS.md dead end: the child's only exit
is "a human types something" into a UI surface (`/guard`) the parent-as-agent cannot see or prompt
anyone toward, and the parent's own only exits are the same three AGENTS.md enumerates (a user
message, the autonomous nudge — disabled here by design, Q4 — and the wake timer, which is capped and
uninformative).

### F-U2 — HIGH — The Guard exception is only real in one of the two turn-end handlers, because the nudge itself only exists in one of them
**Evidence:** `run.ts:3002-3018` (the guarded `autoContinued` block, `runContinuation`) vs.
`run.ts:3676-3757` (`runAgentStep`'s turn-end — no such block). `grep -n AUTONOMOUS_NUDGE run.ts`
returns exactly one use site, `run.ts:3010`. Git history: `git log --all -S"autoContinued"` finds a
commit **not in this branch's history** — `b5f0b316 fix(runs): make the autonomous auto-continue
nudge reachable on both turn-end paths` (`git merge-base --is-ancestor b5f0b316 HEAD` → not an
ancestor), whose own message states: *"the first-step handler had no nudge at all — so every
#autonomous run parked like a normal one."* `units-engine.test.ts:474-486` documents the same gap in
its own comment and works around it (`armAutonomous`, `:487-496`) by manually setting
`state.autonomous = true` on the `runContinuation`-only `ActiveRun`, so the Guard test at
`units-engine.test.ts:508-513` exercises **only** the continuation path — never `runAgentStep`.
**Why it matters:** every unit child is a fresh, single-step, `interactive: true` run
(`spawnChildren` → `startRun`, spec §"Child run creation"; `interactive` for a single-step workflow
is `i === lastAgentIdx && i === workflow.steps.length - 1`, `run.ts:3460`, always true here) —
meaning **every child's first turn goes through `runAgentStep`, not `runContinuation`.** If that
first turn ends without `CEZ:DONE`/`CEZ:SPAWN`/`CEZ:REPORT`+`CEZ:DONE`/`CEZ:ASK`/`CEZ:MONITORING` —
which is the ordinary case for any task not finished in one shot — the child parks at `waiting` with
**no nudge attempt at all**, autonomous or not, unit or not. This makes the F-U1 scenario reachable
without the child ever calling `CEZ:ASK`: any incomplete first turn produces the exact same invisible,
slot-occupying `waiting` child. This is the general #autonomous bug (already fixed elsewhere, see
project memory: PR #967, "units branch must re-apply its nudge exceptions after rebase"), but it is
squarely in scope here because it is the single biggest amplifier of the upward-reporting gap this
file is about.

### F-U3 — MEDIUM-HIGH — Up to 40 uninformative full-context turns on a parked commander, with no unit-aware backoff or content
**Evidence:** as in the confirmed chain (e) above — `run.ts:313`, `:316-317`, `:4284-4328`,
`config.ts:77`.
**Why it matters:** quantified above (~3h20m, 40 full turns, zero new information in the exact
scenario F-U1/F-U2 produce). This is a cost tail with no functional payoff, hidden behind a generic,
non-unit-aware nudge message that gives the model nothing to act on beyond "check again" — it doesn't
even say *why* it's being asked to check (no children summary, no pending-ask count).

### F-U4 — MEDIUM — Restart recovery reports a Guard-blocked child upward as `done`, indistinguishably from genuinely finished work
**Evidence:** `recover()`'s `waiting` branch, `run.ts:1328-1344`, calls `settleSuccess` (`run.ts:4152-4176`)
unconditionally for **every** run found at `waiting` on restart — with no check for whether that
`waiting` was a live human question (`ask.requested`, unanswered) versus an ordinary end-of-turn park.
`settleSuccess` resolves to `'done'` for any `run.autonomous === true` (`run.ts:4159`, review is gated
off), which every unit run is. The synthesized report (`childSettleReport`, `engine.ts:141-146` +
`:157-189`) then tells the parent `status done (cezar: done)` for a child that may have been sitting on
an entirely unanswered, irreversible-action question. `recover-unit.test.ts:136-167` pins the general
"a waiting child is settled and reported on restart" mechanic, but seeds no `ask.requested` event, so
this specific interaction — the one the Guard exists for — is untested.
**Why it matters:** the Guard's entire premise (spec Q4: "a unit run must ask before anything
irreversible… an autonomous unit run never auto-continues past its own question") is defeated by a
process restart landing at the wrong moment: the parent (and a human skimming the mission tree) sees
a clean "done" from a child whose last real state was "I stopped and asked before doing something
irreversible" — with no human ever having answered.

### F-U5 — MEDIUM — Settled-child reports beyond `MAX_PENDING_REPORTS` are silently and permanently dropped
**Evidence:** `withPendingReport` (`engine.ts:191-195`) does `[...(unit.pendingReports ?? []),
entry].slice(-MAX_PENDING_REPORTS)`, `MAX_PENDING_REPORTS = 20` (`engine.ts:34`). Pinned as intended
behaviour in `engine.test.ts:172-178`: *"the three oldest fell off"* for 23 appended entries, with **no
note, no event, no counter** anywhere recording that a drop happened.
**Why it matters:** for a long autonomous mission with many spawn/settle cycles while the commander's
session is unreachable (all of `deliverMessage`/`enqueueMessage`/`deferMessage` failing — e.g. a
commander parked `done`/`failed`/`review` for a stretch, or one whose queue never drains), the 21st
settled child's report — and every one after it up to the 24th — permanently vanishes with zero trace
that it ever existed. `MAX_PENDING_REPORTS` is documented as "a bound, not a policy" (`engine.ts:31-34`)
but nothing enforces that the *bound itself* is ever surfaced.

### F-U6 — LOW — A narrow ack-before-durability window, and a fully silent catch-all around the whole settle path
**Evidence:** `reportSettledChildToParent` (`run.ts:1756-1827`) acks (removes) the pending entry the
instant `deliverMessage`/`enqueueMessage` return `true` (`run.ts:1812-1813`) — a JS-level "the call
succeeded", not a guarantee the underlying agent process durably read the text before a crash in that
exact window. The comment at `run.ts:1804-1810` reasons carefully about which rungs need the durable
entry and which don't, but the guarantee is at the wrong layer (session hand-off, not process
durability). Separately, the whole function is wrapped in a `try {} catch { /* comment, no log */ }`
(`run.ts:1757`/`:1823-1826|); its own comment claims *"the pending report is already on the record by
the time anything below it can throw"* (`run.ts:1824-1825`), which is true for `deliverMessage`
onward but not for anything earlier in the function (e.g. a corrupted `unit.report` shape reaching
`childSettleReport`'s array `.join`/`.length` calls, `engine.ts:179-186`, before the pending entry is
written at `run.ts:1775-1777`) — and even when the comment's premise holds, a genuine bug here
produces **zero log output**, so it would be undiagnosable in production.
**Why it matters:** low likelihood (both scenarios need either a millisecond-scale crash or an
already-corrupted store record), but the combination of "silently swallowed" and "silently dropped
past a bound" (F-U5) means this whole channel currently has **no failure signal at all** — every
loss mode found in this audit is silent by construction.

### F-U7 — LOW (documented, not a bug) — No mid-flight progress channel exists
**Evidence:** see "Is there any mid-flight progress channel" above.
**Why it matters:** listed for completeness per the task; the spec already calls this out as accepted
scope (`CEZ:REPORT` without `CEZ:DONE` is inert until settle). Recorded here because P-U2 below
proposes narrowing — not closing — this gap for exactly one case (a blocked child), not general
progress streaming.

---

## Proposals

### P-U1 — Rebase onto the existing autonomous-nudge fix and re-thread the Guard exception through it
**Rank 1 · Effort S · Risk Low**
**Problem:** F-U2 — the Guard exception (`!(unitTurn.hasUnit && Boolean(ask))`, `run.ts:3006`) only
guards a mechanism that exists in one of the two turn-end handlers on this branch.
**Concrete change:** merge/rebase `fix/autonomous-nudge-reachability` (commit `b5f0b316`, already
authored, tested, and — per its own message — reviewed) onto this branch, then move the units Guard
condition into whatever single shared helper that commit introduces (its message says: *"one shared
`tryAutonomousNudge` helper… called from both turn-end handlers with the same conditions, cap and
note"*), so the Guard is expressed once instead of needing to be re-derived per call site. This is not
a new mechanism — it is finishing one that already shipped elsewhere.
**Default-path impact:** for a **non-unit** autonomous run, this changes today's `runAgentStep`
behaviour (silently parks `waiting` on an incomplete first turn) to match `runContinuation`'s
documented promise (auto-nudge, capped at `MAX_AUTO_CONTINUES`). That is a real default-path change
outside the units feature's own gate — call it out explicitly in the merge, per AGENTS.md's "diff the
default path, not the feature." For a **unit** run, the shipped default (`CEZ_UNITS=1` + the Guard
condition) is unchanged in intent, only reachable everywhere it should be.
**Transitions:** none new — this closes a missing transition (`runAgentStep`'s first turn had *no*
autonomous exit before; now it has the same one `runContinuation` already has).
**Tests to pin:** carry over `autonomous-nudge.test.ts` from the fix branch; extend
`units-engine.test.ts`'s "the Guard" describe block (`:474-522`) to also drive the ask through a
child's **first** turn (`runAgentStep`) rather than only through `continueRun` (today's
`askOnContinue` helper, `:499-506`, exercises `runContinuation` exclusively) — this is the "green
either way" gap AGENTS.md warns about, and it is currently open.
**Risk:** low — the fix is already written and (per its message) tested; the only new work is
re-threading one boolean condition into the merged helper.

### P-U2 — A live "child is blocked" notice to the parent, reusing the report delivery ladder
**Rank 2 · Effort M · Risk Low-Medium**
**Problem:** F-U1 — a parent has no way to learn that one specific in-flight child is parked on an
unanswered `CEZ:ASK`, as opposed to "still working."
**Concrete change:** add an optional `unit.blockedChildren?: { fromRunId: string; title: string;
askedAt: string }[]` field to `RunUnit` (contract + store persistence twin, same parity discipline as
`pendingReports`). In both turn-end handlers, at the exact point `ask` is computed true for a run that
`unitTurn.hasUnit` (right beside `emitAskRequested`, `run.ts:3025`/`:3727`), append an entry to the
**parent's** `unit.blockedChildren` (mirrring `withPendingReport`'s shape/bound so the same
`MAX_PENDING_REPORTS`-style cap applies) and route ONE line of prose — `"<role> "<title>" (<id>) is
waiting for a Guard answer"` — through the **exact same** delivery ladder `reportSettledChildToParent`
already uses (`deliverMessage` → `enqueueMessage` → `deferMessage`; no `continueRun` rung — a blocked
notice should never resurrect a settled/cancelled parent). Extract that ladder into one shared private
helper both call sites use, closing the "hand-duplicated" risk AGENTS.md flags. Clear the entry the
moment that child's status next leaves `waiting` (already observed today — `deliverMessage`'s success
path, `run.ts:2626-2638`, or the child's own settle, `dropActive` → `reportSettledChildToParent`).
**Default-path impact:** strictly additive — a run with `capabilities.units` off, or without a
`unit`, or one whose children never ask, sees no new field, no new event, no new message. At its
shipped default this notice fires only on the exact edge (`ask` newly true for a unit child) already
computed by existing code — no new knob.
**Transitions out of the new state:** `blockedChildren` entry created only on the ask edge (not on
every subsequent waiting turn — idempotent, checked by "was this child already listed"); removed when
the child's status changes away from `waiting` for any reason (answered-and-resumed, settled,
cancelled) — all of which already fire a store update this can hook.
**Tests to pin:** a monitoring parent gets the live notice the instant a child asks; a closed-session
parent gets a durable `blockedChildren` entry flushed into its next prompt (same mechanism as
`pendingReportsBlock`); the entry clears once the child is answered (mirrors
`units-engine.test.ts`'s existing "does not re-flush" pattern, `:296-327`); no duplicate notice fires
on the child's next waiting-but-still-unanswered turn (there isn't one — `waiting` doesn't re-run
turn-end — but a defensive idempotency test still earns its keep given F-U6's "everything here is
silent" pattern).
**Effort:** M. **Risk:** Low-Medium — the "clear on unblock" transition is the one part that must be
exactly right, or the parent's guard summary goes stale and re-introduces a smaller version of F-U1.

### P-U3 — Log and count dropped pending reports instead of silently truncating
**Rank 3 · Effort S · Risk Low**
**Problem:** F-U5 — reports past `MAX_PENDING_REPORTS` vanish with no trace.
**Concrete change:** in `withPendingReport` (`engine.ts:191-195`), when the incoming list before the
slice exceeds `MAX_PENDING_REPORTS`, return an extra `droppedCount` alongside the trimmed list (or
add `unit.droppedReportsCount?: number`, incremented by the caller in `run.ts`); append one transcript
note the first time a given parent turn drops something (mirroring the existing "note fires once"
pattern already used for the budget brake, `run.ts:1585-1591`). Surface the counter in
`pendingReportsBlock` (`engine.ts:202-211`) so a flushed prompt literally says "…and 3 earlier reports
were dropped (cap: 20)."
**Default-path impact:** none below the cap (the overwhelming majority of missions, per the spec's
own "bound, not a policy" framing) — this only changes behaviour once a commander is already past 20
unread reports, which today already loses data silently.
**Transitions:** `droppedReportsCount` resets to 0 the next time `flushPendingReports` runs (same
clear-on-read discipline `pendingReports` already has, `run.ts:1489-1496`).
**Tests to pin:** extend `engine.test.ts:172-178` to assert `droppedReportsCount === 3` for the same
23-entry fixture; a `run.ts`-level test asserting the note appears once, not once per drop.
**Effort:** S. **Risk:** Low.

### P-U4 — Don't force-settle an ask-pending unit run to `done` on restart
**Rank 4 · Effort M · Risk Medium**
**Problem:** F-U4 — `recover()`'s blanket `waiting` → `settleSuccess` (`run.ts:1328-1344`) reports a
Guard-blocked child upward as indistinguishable from finished work.
**Concrete change:** scope narrowly to unit runs (`run.unit` present) to avoid touching the
general-purpose restart path AGENTS.md warns against widening: before calling `settleSuccess` in the
`waiting` branch, check for a trailing `ask.requested` event with no later resolution on that run
(the same signal the Guard inbox already needs to exist, spec §Cockpit "Guard inbox = unit runs at
`waiting` with a pending ask"); if found, either (a) leave the run at `waiting` with a note
("restarted while a Guard question was open — still needs a human answer") instead of settling it, or
(b) still settle it (today's behaviour, so its process truly ends) but have `childSettleReport`
report `status: 'blocked'` with `result` naming the unanswered question, instead of falling through
`statusToReportStatus('done')` (`engine.ts:141-146`).
**Default-path impact:** zero for every restart that is **not** a unit run parked on an unanswered
ask (the vast majority) — this is a narrow, unit-gated carve-out of an existing mechanism, not a
change to it.
**Transitions:** unchanged — a Guard-blocked child still ultimately needs the same human answer via
the same Guard inbox; this only changes what the *parent* is told about it, not how it gets resolved.
**Tests to pin:** a `recover-unit.test.ts` case seeding an `ask.requested` event with no answer before
restart; assert either the run stays `waiting` or its synthesized report reads `blocked`, not `done`.
**Effort:** M — touches shared restart-recovery code; must be careful (option (a) especially) not to
change behaviour for any run without `unit` set. **Risk:** Medium — exactly the "changing a mechanism
that already works" territory AGENTS.md calls the highest-risk change in the repo; scope strictly to
`run.unit !== undefined` and add a test proving an ordinary (non-unit) `waiting` run's restart
behaviour is untouched.

### P-U5 — Unit-aware backoff on the monitoring wake nudge (flagged, not fully specified)
**Rank 5 · Effort L · Risk High — recommend deferring to its own dedicated review**
**Problem:** F-U3 — up to 40 full-context, zero-information turns on a parked commander.
**Sketch, not a full proposal:** when `state.unitRole` is set and no child has settled since the last
wake (`reportSettledChildToParent`'s reset at `run.ts:1798-1799` never fired), grow the wait
geometrically instead of firing every fixed interval, still capped at the same `MAX_AUTO_CONTINUES`
total nudges — spreading the same budget over more wall-clock time rather than adding a new knob.
**Why this is only sketched, not proposed:** `monitoringWakeIntervalMinutes` and its whole timer are
exactly the mechanism AGENTS.md's own worked example (#810/#811, and the `IDLE_TIMEOUT_MS` story) was
about — "before deleting a timer, lock, cap or timeout, grep for everything that reaches a terminal
state *because* of it." A drive-by change here, bundled into an upward-reporting fix, is the wrong
shape of change for this area; it deserves its own audit of every consumer of
`monitoringWakeIntervalMinutes`/`armMonitoringWakeTimer` first. Recorded here so it isn't lost, and
listed in Open questions below rather than committed to as a ranked proposal.

---

## Open questions for the user

1. **P-U1's default-path change is bigger than "units":** rebasing onto `b5f0b316` changes behaviour
   for every `#autonomous` run in the repo (not just unit runs), because the bug it fixes predates
   this feature. Do you want that rebase folded into the units work, or landed separately on `main`
   first (it appears to already be a candidate for that, per `fix/autonomous-nudge-reachability`) so
   the units branch can just rebase past it?
2. **P-U2's scope — blocked-child notice only, or a broader "children summary" nudge?** The proposal
   above is deliberately narrow (one line, one edge). Should the monitoring-wake nudge itself
   (`MONITORING_WAKE_NUDGE`, F-U3) also be made unit-aware — e.g. always include a one-line census of
   children by status — or is that a separate piece of work?
3. **P-U4 option (a) vs (b):** leaving a restart-recovered, ask-pending unit run at `waiting`
   (a) is more honest but means a mission can come back from a restart with a run that looks "stuck"
   until someone visits `/guard`; reporting it as `blocked` while still settling it (b) is a smaller
   change but means the process genuinely ends without ever giving the human a chance to answer the
   original question through that same run. Which matches the intended Guard semantics better?
4. **Is `MAX_PENDING_REPORTS = 20` (P-U3) the right cap to keep, or should a long Army mission be able
   to configure it?** AGENTS.md's "never trade a working default for a knob" argues for leaving it a
   constant and just making the drop visible (as proposed) rather than adding a setting — confirming
   that reading before anyone asks for a knob here.
