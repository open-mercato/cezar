# 03 — Budget and restart lifecycle

Audit of cezar's mission (units) **budget brake** and **restart recovery** against
`.ai/specs/2026-09-08-units-hierarchy.md` and the code at HEAD `076cead2785891af80b9ea7440bf3be973c0bbfe`
(branch `cez/6f88c659`, forked from `cez/5a23b3d1`). Every citation below was re-read at HEAD in
this worktree with `sed`/`grep`; line numbers are what I actually saw, not carried over from the
task order (they matched exactly — see "Verification" at the end).

Scope: analysis only. No source, test or other file was touched.

---

## 1 — How `carveChildBudgets`, `enforceUnitBudget` and `remainingBudgetUsd` actually behave

`remainingBudgetUsd` (`packages/cezar/src/units/engine.ts:67-72`):

```ts
export function remainingBudgetUsd(parent: RunRecord, children: readonly RunRecord[]): number | undefined {
  const budget = parent.unit?.budgetUsd;
  if (budget === undefined) return undefined;
  const promised = children.reduce((sum, child) => sum + (child.unit?.budgetUsd ?? 0), 0);
  return budget - (parent.costUsd ?? 0) - promised;
}
```

`budgetUsd - costUsd - Σ children.budgetUsd`. `undefined` parent budget → `undefined` remaining
(uncapped, engine.ts:61-65's own comment: "the pre-existing behaviour of every cezar run"). It can
go **negative** — `engine.test.ts:65-67` pins this deliberately ("goes negative rather than
clamping — an overspent commander must read as overspent"). `children` is `childrenOf(runs,
parent.id)` (engine.ts:49-51), which is **every** child regardless of status — done, failed,
cancelled or still running all count their full `budgetUsd` against `promised` forever (confirmed:
`run.ts:1718` calls `remainingBudgetUsd(parent, childrenOf(runs, parent.id))` with no status
filter). A settled child's *unused* allocation is never released back to the parent — see Finding
F3.

`carveChildBudgets` (`run.ts:1713-1739`) is the spawn-time gate, two-pass by design (its own
comment at 1704-1708 explains why: handing an uncosted child the whole remainder would starve its
siblings in the same payload):

1. `remaining = remainingBudgetUsd(...)`. `undefined` → every child gets exactly the `max_cost` it
   named, or none (`run.ts:1719`) — an uncapped parent carves nothing.
2. `remaining <= 0` → refuse the whole payload (`run.ts:1720-1724`): *"no budget left ... Report
   what has been achieved instead of shrinking the remaining work."*
3. Children that named `max_cost` are summed; if that sum exceeds `remaining`, refuse the whole
   payload (`run.ts:1726-1730`).
4. Whatever is left is split evenly among children that named no `max_cost` (`run.ts:1731-1738`);
   if that split would be `<= 0`, refuse and ask for explicit caps on every child.

Every refusal is a transcript `note`, **no state change** — `spawnChildren` (`run.ts:1607-1699`)
returns `false` and the parent is exactly where it was (`run.ts:1598-1602`'s own comment: "a
refused spawn leaves the parent exactly where today's rules put it"). This is intentionally
all-or-nothing per payload, not a partial spawn.

`enforceUnitBudget` (`run.ts:1578-1593`) is the **turn-end** brake, called from the one shared
`handleUnitMarkers` helper both turn-end handlers use (`run.ts:1531-1567`):

```ts
const spent = run.costUsd ?? 0;
if (spent < budget) return false;
if (!unit.overBudget) { /* set overBudget: true, note once */ }
return true;
```

No `budgetUsd` on the run → returns `false` unconditionally (`run.ts:1582`), i.e. **no brake at
all**. The check runs *after* the turn's cost is already recorded (the `cost` event stream updates
`run.costUsd` live during the turn, `run.ts:2945-2947`, before `turn-end` fires), so a single
expensive turn can sail well past the ceiling before the brake ever fires — `units-engine.test.ts:364-367`
demonstrates exactly this: a `budgetUsd: 0.001` run is parked only after its first mock turn already
spent `$0.0342`, 34x the ceiling. **The brake caps damage per turn, not per dollar** — it is a
detector, not a limiter.

Minor spec/code divergence (not scored as a finding): the spec's `## Budget` section
(`.ai/specs/2026-09-08-units-hierarchy.md:113-114`) states the per-child allocation as literally
`budgetUsd: min(max_cost, remaining)`; the shipped two-pass carve above is a deliberate improvement
over that literal formula (it lets several children share one payload instead of the first
un-costed one claiming everything), documented in the code's own comment. Worth updating the spec
text to match, not a behavior bug.

## 2 — Zero-config default mission (no `budgetUsd`): is it cost-safe?

The whole units feature is opt-in behind `CEZ_UNITS=1` (spec Q1, `.ai/specs/2026-09-08-units-hierarchy.md:24`)
— that is the one AGENTS.md-mandated "cost-widening feature behind a `CEZ_*` flag, off by default"
gate. **Inside that already-opted-in feature**, `budgetUsd` on `POST /api/v1/p/:projectId/missions`
is itself optional (spec line 134: `{ objective, unit, budgetUsd?, ladder?, constraints? }`) and the
server does not fill in a default: `server.ts:3530-3540` spreads `budgetUsd` into the new root's
`unit` only `if (body.budgetUsd !== undefined)`, and `missions-api.test.ts:151-155` pins this
explicitly — *"leaves budgetUsd ABSENT when none was given, rather than writing a zero."* An absent
`budgetUsd` then means, per §1 above: `remainingBudgetUsd` is `undefined` (uncapped),
`carveChildBudgets` carves nothing and never refuses a spawn for cost, and `enforceUnitBudget`
never fires — the mission and every rank spawned under it can spend without limit for as long as it
keeps ending turns with `CEZ:SPAWN`/`CEZ:MONITORING`/the autonomous nudge.

The brakes that remain with no `budgetUsd` are all **throughput** caps, not **spend** caps:
`MAX_CHILDREN_IN_FLIGHT = 4` per parent (`engine.ts:29`) and the workspace's `maxParallel` (default
2, counted across the whole workspace, `run.ts:1082-1088`). Neither bounds total dollars over the
lifetime of an autonomous run — a flat, non-unit autonomous cezar run has always had this same
property, so *by itself* this is not a new regression.

**Explicit recommendation: the zero-config mission is not cost-safe, and this is a real
default-path gap under AGENTS.md's "Changing a mechanism that already works."** Applying that
section's own test — *"diff the default path: with every new knob at its shipped default, what does
the old scenario do now?"* — a flat autonomous run was always one uncapped agent; a zero-budget
**army** mission is up to 4 children per parent, three ranks deep (Caesar → Legate → Centurion,
`CHILD_ROLE`, `engine.ts:21-25`), each of which can itself fan out further, all uncapped, all
running autonomously (`unit: { autonomous: true }` is forced on every spawned child, `run.ts:1671`)
with no human turn required to keep going. That is a materially larger blast radius than "the
pre-existing behaviour of every cezar run" the code comment invokes to justify leaving it
uncapped (`engine.ts:63-65`) — the comment is true of one run in isolation, not of the tree the
same absence of a cap now permits. The composer/API default should not silently multiply an
already-accepted risk without at least surfacing it; see Proposal P2.

## 3 — An over-budget run parks at `waiting`: what moves it out, and who fires it

`enforceUnitBudget` returning `true` forces `monitoring = false` unconditionally at both turn-end
sites (`run.ts:2975-2980`, mirrored at `run.ts:3706` for the streaming handler) — an over-budget
run can never re-enter the `monitoring` state, so `armMonitoringWakeTimer` is never called for it
and `units-engine.test.ts:375-376` pins `monitoringWakeAt` and the active-state timer both
`undefined`. The autonomous nudge is gated the same way (`!unitTurn.overBudget`, `run.ts:3005`) —
an over-budget run also never nudges itself. AGENTS.md's own list of the three wake sources for a
parked run — "a user message (`deliverMessage`), the autonomous nudge, and the monitoring wake
timer" — is down to exactly **one** for this state: `deliverMessage`/`sendMessage`.

`deliverMessage` (`run.ts:2594-2629`) does not check `unit.overBudget` or `budgetUsd` at all — it
only requires an open live session (`run.ts:2596`), which a `waiting` park still holds (nothing
calls `state.session?.end()` in the waiting branch, `run.ts:3035-3038`). So it fires from:

- **A human** clicking Send in the cockpit (`sendMessage` → `deliverMessage`, `run.ts:2582-2590`).
- **A settled child's report**, delivered by `reportSettledChildToParent` through the same
  `deliverMessage` (`run.ts:1812`) — so a pending child report *does* reach an over-budget parent,
  not just a human.

Neither path clears `unit.overBudget`. There is no code anywhere that sets it back to `false`
(confirmed by `grep -n overBudget run.ts` — every hit is a read or the one-time `true` write at
`run.ts:1585-1586`), and there is no API to change `budgetUsd` after mission creation (`server.ts`
only writes it at `POST /missions` creation time, `server.ts:3537`). So whichever of the two above
fires, the run gets exactly **one turn**: `enforceUnitBudget` re-checks at that turn's end, `spent`
is still `>= budget` (the ceiling itself never moved), and it parks `waiting` again — silently this
time, since the note only fires once (`run.ts:1585`, guarded by the flag that is already `true`).
**Nothing automatic ever un-sticks an over-budget unit run; every further step requires a fresh
external nudge, forever.** This matches spec Q6's intent (a hard Guard-style stop), but there is no
mechanism to say "budget approved, resume autonomously" short of raising the ceiling out-of-band —
which today's API cannot even do. See Finding F4 / Proposal P3.

## 4 — Cost roll-up: does a child's spend ever reach the parent's `costUsd`?

**No.** `run.costUsd` is recomputed in `RunStore.updateStep` (`packages/cezar/src/runs/store.ts:938-939`)
strictly from that run's **own** steps:

```ts
const cost = run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
run.costUsd = cost > 0 ? cost : undefined;
```

Nothing anywhere sums a child's `costUsd` into its parent's. The only place a child's cost figures
into the parent's budget math is `remainingBudgetUsd`'s `Σ children.budgetUsd` (§1) — the
**promised ceiling**, not the actual spend, and (as noted in §1) that ceiling stays subtracted for
the lifetime of the parent record even after the child settles under budget. The combination means:

- A child that **underspends** its ceiling never returns the unused portion — `remainingBudgetUsd`
  stays permanently lower than the parent's true remaining capacity.
- A child that **overspends** its ceiling (§1: the brake is per-turn, not per-dollar, so this is
  the expected case whenever a turn is expensive relative to the cap) is invisible to the parent —
  `remainingBudgetUsd` stays exactly as if the child had spent precisely its promised `budgetUsd`,
  no more. The parent's own budget arithmetic never reflects that the subtree, in aggregate, spent
  more than the root's nominal `budgetUsd` would suggest.

Net effect: **a mission's root `budgetUsd` bounds what the root itself can hand out as ceilings, not
what the tree actually spends.** The true total is the sum of every node's own `costUsd`, which
nothing in the engine aggregates or displays anywhere in `run.ts`/`engine.ts` (the spec's Missions
tree column, `.ai/specs/2026-09-08-units-hierarchy.md:142`, is a per-row `costUsd / budgetUsd`
meter, not a subtree rollup — cockpit code is outside this audit's cited scope, noted for
completeness only). See Finding F3 / Proposal P2.

## 5 — Every terminal-transition site, and whether the parent gets a report

`reportSettledChildToParent` (`run.ts:1756-1827`) is the single place a settled child's report is
persisted and delivered. Four call sites reach it; a fifth path that reaches a genuinely terminal
status does **not**:

| # | Site | Reaches report? | Note |
|---|---|---|---|
| 1 | `dropActive` (`run.ts:1394-1430`, call at `run.ts:1423`) | **Yes** | Every terminal exit of an *active* run (done/review/failed/cancelled) funnels through here — the method's own comment: "every terminal transition funnels through this one method." Covers the ordinary end of a turn, `cancel()` on an active run, and every `dropActive(runId)` call site in the file (`run.ts:1180,1203,2040,2804,2863,3084,3234,3358,3544`). |
| 2 | `cancelOne`'s **queued**-cancel branch (`run.ts:2252-2266`, call at `run.ts:2264`) | **Yes** | A queued run never enters `active`, so it never reaches `dropActive` (comment at `run.ts:2261-2263` says so explicitly); this branch calls `reportSettledChildToParent` itself. |
| 3 | `reviveQueuedRun`'s unrecoverable-workflow branch (`run.ts:1251-1266`, call at `run.ts:1264`) | **Yes** | A queued child whose workflow definition cannot be revived after a restart is marked `failed` here and reported — comment: "the third terminal transition outside `dropActive`." |
| 4 | `recover()`'s `waiting` branch (`run.ts:1328-1344`, call at `run.ts:1343`) | **Yes, but see Finding F1** | Force-settles via `settleSuccess` (`run.ts:4152-4176`) to `done`/`review` unconditionally, *then* reports. The report is sent — but see F1 for what it actually says. |
| 5 | `recover()`'s `running`→`failed` branch (`run.ts:1346-1372`) when `continueRun`'s resume attempt fails (`resumed.ok === false`) | **No** | See Finding F2 below — this is a real gap, distinct from F1. |

Confirming #5: on restart, a run found `running` (process died mid-turn) is marked `status:
'failed'` (`run.ts:1354-1359`), then `continueRun(...)` is called to resume it
(`run.ts:1360-1366`). If it resumes (`resumed.ok`), the run re-queues via `deferForCapacity: true`
and eventually reaches an ordinary terminal transition (site #1) later — no gap. If it **cannot**
resume — `continueRun` refuses whenever the run has no step with a recorded `sessionId`
(`run.ts:2696`: `"no agent session to resume"`), which is exactly the case for a child that crashed
before its agent CLI ever emitted its first `session` event — the run is left at `status: 'failed'`,
a terminal status, and **nothing calls `reportSettledChildToParent` for it** (`run.ts:1367-1372`
only appends a transcript note on the *run itself*, never touches the parent). A parent waiting on
that child would wait for a report that is never sent. No test in `recover-unit.test.ts` or
`units-engine.test.ts` exercises this branch for a unit child.

## 6 — Restart: is an idle child settled as done, with a done report for zero work?

**Yes, and it is deliberately pinned by a test**, not an accident. `recover-unit.test.ts:129-167`,
*"reports a waiting child settled by recovery to its parent"*:

```ts
const child = store.createRun({ /* ... */ });
store.updateRun(child.id, {
  status: 'waiting',
  workflowDef: WORKFLOW_DEF,
  unit: { role: 'legate', missionId: parent.id, parentRunId: parent.id },
});

await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

expect(store.getRun(child.id)?.status).toBe('done');
expect(store.getRun(child.id)?.unit?.role).toBe('legate'); // the unit survives the settle
const pending = store.getRun(parent.id)?.unit?.pendingReports ?? [];
expect(pending).toHaveLength(1);
expect(pending[0]?.fromRunId).toBe(child.id);
// No CEZ:REPORT was ever emitted, so the report is synthesised from what the run left.
expect(pending[0]?.report.status).toBe('done');
```

The child here never ran a single turn — no session, no cost, no steps beyond the seeded
`WORKFLOW_DEF`. `recover()`'s `waiting` branch (`run.ts:1328-1344`) marks its pending/running steps
`done` (`run.ts:1330-1332`), calls `settleSuccess` (`run.ts:4152-4176`, always `status: 'done'` when
there is no worktree diff or the run is autonomous — every unit child is `autonomous: true`,
`run.ts:1671`, so `review` never applies to it), then reports. `childSettleReport`
(`engine.ts:157-189`) has no `own` report to fall back to (the child never emitted `CEZ:REPORT`), so
it synthesizes one from `statusToReportStatus('done') → 'done'` (`engine.ts:141-145`) with `result`
defaulting to the generic string `'no structured report — the run settled without emitting
CEZ:REPORT'` (`engine.ts:169`). The parent receives that as a **done** report indistinguishable, at
the `status` field, from a child that actually finished its task order. This is the same code path
as Finding F1's over-budget case — `waiting` is used for at least three distinct reasons (a plain
`CEZ:ASK`, an over-budget park, or — as this test shows — a child that was still mid-conversation
with no work of its own yet done), and `recover()` treats every one of them identically as "done."

---

## Findings

### F1 — CRITICAL — restart force-settles *every* `waiting` unit run to `done`/`review`, discarding `overBudget` and delivering a "done" report for a run that was blocked, not finished

- Evidence: `run.ts:1328-1344` (the `waiting` branch of `recover()`) has **zero** special-casing for
  `unit.overBudget` — confirmed by `grep -n overBudget run.ts`, which has no hits inside `recover()`
  (1314-1379) or `reviveQueuedRun` (1227-1301). It calls `settleSuccess` (`run.ts:4152-4176`)
  unconditionally, which only ever produces `'done'` or `'review'` — never anything reflecting
  "parked because it ran out of budget." `reportSettledChildToParent` is then called
  (`run.ts:1343`), and `childSettleReport` (`engine.ts:141-145`, `statusToReportStatus`) maps
  cezar-status `done`/`review` straight to report-status `'done'`. `units-engine.test.ts:364-379`
  establishes that an over-budget park is `status: 'waiting'` with `unit.overBudget: true`;
  `recover-unit.test.ts:136-167` establishes that `recover()`'s `waiting` handling turns *any*
  `waiting` run, unconditionally, into `status: 'done'` plus a `report.status: 'done'` sent
  upstream — the two tests together show the restart path has no way to tell "this run finished a
  turn and is waiting for the user" apart from "this run hit its budget ceiling and is blocked"
  apart from "this run never did anything at all" (§6). All three currently settle identically.
- Why it matters: a caesar/legate that restarted while one of its legates or centurions was
  over-budget-and-parked will, on the very next process restart, be told that child **finished
  successfully** — the one signal the whole budget feature exists to surface (spec Q6: "A cost
  feature with no working brake fails the cost-safe AND functional review") is silently converted
  into a success report by the *unrelated* restart-recovery code path the moment the process
  bounces. A commander that trusts its own children's `done` reports (which the spec explicitly
  expects it to, `.ai/specs/2026-09-08-units-hierarchy.md:96-101`) has no way to distinguish this
  from real completion without independently re-deriving cost, which is exactly the burden the
  report is supposed to remove.

### F2 — HIGH — one terminal-transition path (`recover()`'s unresumable `running`→`failed` child) never reports to the parent at all

- Evidence: `run.ts:1346-1372`. A `running` run found at boot is marked `status: 'failed'`
  (`run.ts:1354-1359`), then `continueRun(run.id, { text: RESTART_CONTINUATION_PROMPT }, true)` is
  called. If `continueRun` refuses — its own check at `run.ts:2696`, `!sessionStep?.sessionId →
  { ok: false, error: 'no agent session to resume' }` — the branch only appends a lifecycle note on
  the run itself (`run.ts:1367-1372`); it never calls `reportSettledChildToParent`. Compare to the
  *other* unresumable-terminal path, `reviveQueuedRun`'s workflow-not-recoverable branch
  (`run.ts:1251-1266`), which explicitly calls it with the comment "the third terminal transition
  outside `dropActive`" — the `running`-branch sibling has no such call and no such comment.
- Why it matters: a child that crashes before its agent CLI ever emits a first `session` event (the
  realistic trigger for "no agent session to resume" on a run cezar itself just marked `running`)
  ends up permanently `status: 'failed'` with no pending report ever written to its parent. A parent
  parked on that child waits for a report that will never arrive — the exact failure mode Q7 exists
  to prevent ("a `waiting` parent with no `ActiveRun` is reachable by none of the live paths"). No
  test in `recover-unit.test.ts` or `units-engine.test.ts` exercises this branch for a unit child.

### F3 — HIGH — no cost roll-up: a subtree's real spend can silently exceed the root's `budgetUsd`, and a settled child's unused ceiling is never returned

- Evidence: `packages/cezar/src/runs/store.ts:938-939` computes `run.costUsd` from that run's own
  `steps` only, inside `updateStep`; nothing in `run.ts` or `engine.ts` adds a child's `costUsd`
  into a parent's. `remainingBudgetUsd` (`engine.ts:67-72`) subtracts `Σ children.budgetUsd` —
  the promised ceiling — over **every** child from `childrenOf` (`engine.ts:49-51`, no status
  filter), confirmed live at the one call site, `run.ts:1718`. `enforceUnitBudget`'s brake is
  turn-boundary, not turn-start (§1), and `units-engine.test.ts:364-367` shows a live 34x overshoot
  in a single turn ($0.0342 spent against a $0.001 ceiling) before the brake fires.
- Why it matters: the two facts compound. A child can overspend its own ceiling before its own
  brake catches it, and that overspend is invisible to the parent's budget arithmetic forever — the
  parent still sees exactly `Σ children.budgetUsd` subtracted, never `Σ children.costUsd`. A mission
  root's `budgetUsd` therefore bounds what it can *promise* downward, not what the tree actually
  *spends* — the two can diverge in either direction with nothing in the engine to reconcile them,
  and nothing surfaces the true aggregate spend anywhere `run.ts`/`engine.ts` computes.

### F4 — MEDIUM — an over-budget unit run has no path back to autonomous operation, and no API can raise its ceiling

- Evidence: `run.ts:2975-2980` and `:3706` force `monitoring = false` whenever
  `unitTurn.overBudget`; `run.ts:3005` gates the autonomous nudge the same way. `grep -n overBudget
  run.ts` shows the flag is set once (`run.ts:1585-1586`) and never cleared anywhere. `server.ts`'s
  only write of `unit.budgetUsd` is at mission creation (`server.ts:3530-3540`); no route patches an
  existing run's `unit`.
- Why it matters: per §3, the only way to move a run out of `waiting` once over budget is an
  external message (human, or a child's report delivery), and that message buys exactly one more
  turn before `enforceUnitBudget` parks it again — permanently, since the ceiling that made it
  overspend in the first place never moves. This may match the Guard's intent (a hard stop, spec
  Q6), but there is currently no product mechanism to say "the extra spend is approved, keep going"
  short of restarting the mission with a new run and a higher `budgetUsd` from scratch.

---

## Proposals

### P1 — for F1: give restart recovery a way to tell "blocked" apart from "done", and stop settling `overBudget` runs as successes

**Problem.** `recover()`'s `waiting` branch (`run.ts:1328-1344`) has one outcome for three distinct
situations: a plain `CEZ:ASK` pause, an over-budget park, and a child that never did any work. Only
the first is actually "the turn was over and the ball was in the user's court," which is the
branch's own justifying comment (`run.ts:1308-1309`).

**Concrete change.** Before calling `settleSuccess`, branch on `run.unit?.overBudget`:

```ts
if (run.status === 'waiting') {
  if (run.unit?.overBudget) {
    // Leave status at 'waiting' (already is), re-arm nothing — the run is exactly where
    // enforceUnitBudget left it. Only the transcript note changes, to say a restart happened
    // while it was parked, so the cockpit's Guard inbox still surfaces it correctly.
    this.store.appendEvent(run.id, {
      type: 'lifecycle',
      message: 'cezar restarted — still parked over budget, unchanged',
    });
    continue; // no settleSuccess, no reportSettledChildToParent — nothing to report, it never settled
  }
  // ...existing plain-waiting handling unchanged
}
```

An over-budget run parked at `waiting` is, by construction, already sitting in the terminal-looking
state the rest of the product (Guard inbox, `waiting` + pending-ask filter, spec Q4) already expects
to find it in — restart should leave it exactly there, not manufacture a settle event for it.

**Default-path impact.** None for a mission with no `budgetUsd` (this branch is unreachable —
`overBudget` can only be set when a budget exists). For a budgeted mission, a restart during an
over-budget park now correctly reports nothing changed, instead of a false "done."

**Transitions out of the (unchanged) state:** identical to §3's existing enumeration — a user
message via `deliverMessage`, or a settled sibling's report delivery — both already survive a
restart today because the run stays `active`-less but its session-open flag is process-local; a
restarted process has no open session for it either way, so `sendMessage`/`deliverMessage` will
correctly report "no open session" and the cockpit's existing "Continue" fallback
(`continueRun`, gated to `['done','failed','cancelled','review']`, `run.ts:2692`) does **not**
apply to `waiting` — this is an existing gap outside this proposal's scope: a restarted process
currently has no live path to resume ANY `waiting` run (unit or not) except by having a user turn it
into a fresh continuation. Worth a follow-up finding in a future pass, not scored here.

**Tests to pin:** extend `recover-unit.test.ts` with a sibling to "reports a waiting child settled
by recovery to its parent" — same fixture but `unit.overBudget: true` — asserting `status` stays
`'waiting'`, `unit.overBudget` stays `true`, and `pending.length` stays `0` (no false report).

**Effort: S.** **Risk: low** — the branch is additive (an early `continue`) and only changes
behavior when `unit.overBudget` is already `true`, a state that (per F4) cannot currently self-heal
anyway.

### P2 — for F3/§2/§4: surface actual subtree spend, and make it the thing `remainingBudgetUsd` reasons about for settled children

**Problem.** `remainingBudgetUsd` subtracts a **promised ceiling** for every child forever (§4), and
nothing anywhere sums real descendant `costUsd` (F3). Combined with §2's zero-config gap, a
commander (human or the caesar itself) has no single number for "what has this mission actually
cost so far," only "what has been promised."

**Concrete change, two parts:**

1. In `remainingBudgetUsd` (`engine.ts:67-72`), for children whose status `isTerminalStatus(...)`
   (`engine.ts:44-46`) is true, subtract `child.costUsd ?? 0` instead of `child.unit?.budgetUsd ??
   0` — a settled child's *actual* spend, trued up, rather than its ceiling. In-flight children keep
   subtracting their promised ceiling (the money is still reserved, not yet known). This is a pure
   function change, testable in isolation without touching `run.ts`.
2. Add a small helper, `subtreeCostUsd(runs, rootId)`, recursively summing `costUsd` over
   `childrenOf` at every depth — for the Missions tree's budget meter (spec line 142) to show real
   spend instead of a per-row number that never includes what was delegated away. (Cockpit wiring is
   outside this audit's code scope; the helper itself belongs beside `remainingBudgetUsd` in
   `engine.ts`.)

**Default-path impact:** for an uncapped mission (§2), `remainingBudgetUsd` still returns
`undefined` — no behavior change. For a budgeted mission, remaining budget becomes *more* accurate
(rises when a child underspends, falls when a child overspends) rather than a static promise.

**Tests to pin:** `engine.test.ts`'s `remainingBudgetUsd` suite gets two new cases: a done child
that spent less than its `budgetUsd` (remaining should be higher than today's calculation), and a
done child that spent more (remaining should be lower) — both currently impossible to express since
the function only reads `unit.budgetUsd` today.

**Effort: M.** **Risk: low-medium** — pure-function change with direct test coverage; the only risk
is a spawn-time regression if `carveChildBudgets` (which also calls `remainingBudgetUsd`, `run.ts:1718`)
starts seeing more available budget mid-mission than it did before and a commander over-delegates —
mitigated by capping the *increase* to what was actually promised, never trued up above it.

### P3 — for F4: an explicit way to lift `overBudget`, instead of relying on a per-turn message forever

**Problem.** §3/F4: once `unit.overBudget` is set, the only way to keep a mission moving is a fresh
external message every single turn, forever — there is no "resume autonomously" action anywhere in
the API.

**Concrete change.** Add `PATCH /api/v1/p/:projectId/runs/:id/unit` (or fold into an existing
run-patch route) accepting `{ budgetUsd?: number }` for a unit run, that (a) updates
`unit.budgetUsd`, and (b) if the new ceiling exceeds current spend, clears `unit.overBudget`. Route
this through `updateUnit` (already the single mutator used by `enforceUnitBudget`,
`run.ts:1586`) so the write path is unchanged; only a new caller is added.

**Default-path impact:** none — the route is additive, only reachable when a user explicitly raises
a budget on a run that has one.

**Transitions out of `waiting` this enables, and who fires them:** the PATCH itself does not wake
the run (it only clears the flag); the very next `deliverMessage`/`sendMessage` (§3, still the human
or a child's report) then completes a turn where `enforceUnitBudget` re-checks and, this time,
returns `false` — the run is free to `monitoring`/auto-continue again on its own. No new wake source
is added; this proposal removes the permanent re-arm, it does not add a fourth wake path.

**Tests to pin:** a `run.ts`/`units-engine.test.ts` case: park a run over budget, PATCH a higher
`budgetUsd`, send one message, assert the *next* turn (not the one that delivered the message) is
allowed to `monitoring`/auto-continue again — i.e. `overBudget` reads `false` and the wake timer can
be armed.

**Effort: S.** **Risk: low** — additive route, reuses `updateUnit`; the only care needed is
guarding against lowering `budgetUsd` below current spend (would just re-trigger the brake on the
next turn end, which is correct, but worth a note in the response rather than a silent no-op).

---

## Verification

Commands actually run in this worktree (HEAD `076cead2785891af80b9ea7440bf3be973c0bbfe`), not
copied from the task order:

```
$ git rev-parse HEAD
076cead2785891af80b9ea7440bf3be973c0bbfe
$ sed -n '67p' packages/cezar/src/units/engine.ts
export function remainingBudgetUsd(parent: RunRecord, children: readonly RunRecord[]): number | undefined {
$ grep -n "enforceUnitBudget|carveChildBudgets|spawnChildren" packages/cezar/src/workflows/run.ts
1578: private enforceUnitBudget(...)
1607: private spawnChildren(...)
1713: private carveChildBudgets(...)
$ sed -n '1394p;1314p;1756p;2252p' packages/cezar/src/workflows/run.ts   # dropActive / recover / reportSettledChildToParent / cancelOne
$ sed -n '938,939p' packages/cezar/src/runs/store.ts                    # cost roll-up (own steps only)
$ sed -n '3530,3540p' packages/cezar/src/server/server.ts               # POST /missions budgetUsd — no default
$ grep -n "no agent session to resume" packages/cezar/src/workflows/run.ts
2696
$ grep -n overBudget packages/cezar/src/workflows/run.ts                # confirms: set once (1585-1586), never cleared
```

All line numbers cited above (`engine.ts:67`, `run.ts:1578/1607/1713`, `dropActive`, `recover`) were
given in the task order and matched exactly at HEAD — no drift to reconcile.

---

*Generated by a centurion under `.ai/cezar` on `cez/6f88c659`. Read-only audit; no source, test or
other file was modified.*
