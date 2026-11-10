# Units lifecycle, budget and cockpit audit — SUMMARY

> What was audited: cezar's mission (units) **lifecycle** end-to-end — how a mission's branches
> accumulate and end, how its budget brake and restart-recovery behave, and how the Mission Cockpit
> (`/missions`, `/guard`) reflects both — against `.ai/specs/2026-09-08-units-hierarchy.md`. All
> three source files were audited at HEAD `076cead2785891af80b9ea7440bf3be973c0bbfe`; this summary
> re-verified every citation at HEAD `8ed75a05` in this worktree (see Verification — no source
> commits touch `packages/cezar/src`, `packages/web/src` or `packages/contract/src` between the two
> commits, so the code is identical).

| detail file | topic | local ids |
|---|---|---|
| `branches-and-end-state.md` | branch/worktree mechanism, mission end state, missions API surface | F1-F6, P1-P5 |
| `budget-and-restart.md` | budget brake (`carveChildBudgets`/`enforceUnitBudget`/`remainingBudgetUsd`), restart recovery | F1-F4, P1-P3 |
| `cockpit.md` | Mission Cockpit's `totalBudgetUsd`, `needsGuard`, and operator-visibility gaps | F1, F2, F2b, F3, F4, P1-P5 |

**Verdict.** The branch/worktree mechanism and the budget arithmetic are each internally sound in
isolation, but three independent gaps compound into one outcome: **a mission can silently convert a
real stop signal (an unanswered question, a budget halt, a stuck automation) into a false "done,"
and the cockpit cannot tell the difference either.** Every unit run is created `autonomous: true`
with no exception, which (a) means no unit run — root included — can ever reach the `review`
checkpoint that would otherwise precede a draft PR, and (b) means restart recovery's uniform
`waiting → settleSuccess` path force-settles a budget-halted run to `done` and reports that upward
as success. The cockpit's own `needsGuard` flag then can't distinguish that same budget halt (or an
exhausted auto-continue cap) from a genuine pending question, so the one queue built to catch this
class of problem shows it identically to routine chatter — or, for the exhausted-cap case, not at
all. Two structural gaps make this worse over a long mission: a settled child's unspent budget
reservation is never released back to its parent (found independently in three separate audits of
this feature, cross-referenced below), and the missions API has exactly one route, so an operator
cannot inspect, cancel-by-mission, pause, or top up a mission short of finding and cancelling its
root run by id.

## Id mapping

| unified | source | unified | source |
|---|---|---|---|
| F1 | branches-and-end-state F2 **+** budget-and-restart F1 (merged) | F8 | budget-and-restart F3 |
| F2 | cockpit F2 | F9 | branches-and-end-state F4 |
| F3 | branches-and-end-state F3 | F10 | branches-and-end-state F5 |
| F4 | branches-and-end-state F1 | F11 | budget-and-restart F4 |
| F5 | cockpit F1 | F12 | cockpit F3 |
| F6 | cockpit F2b | F13 | cockpit F4 |
| F7 | budget-and-restart F2 | F14 | branches-and-end-state F6 |

| unified | source | unified | source |
|---|---|---|---|
| P1 | branches-and-end-state P2 | P7 | budget-and-restart P2 |
| P2 | budget-and-restart P1 | P8 | branches-and-end-state P3 |
| P3 | cockpit P2 | P9 | branches-and-end-state P4 **+** budget-and-restart P3 (merged) |
| P4 | cockpit P3 | P10 | budget-and-restart P2 (cross-ref only, see P7) |
| P5 | cockpit P1 | P11 | branches-and-end-state P5 |
| P6 | branches-and-end-state P1 | P12 | cockpit P5 |

(P10 is not a distinct entry — `remainingBudgetUsd`'s trued-up-on-settle fix is one proposal, listed
once as P7; the row above exists only to make the id-mapping table exhaustive over every local
proposal id. See P7's own text.)

---

## Findings

Findings are globally renumbered and ordered CRITICAL → HIGH → MEDIUM → LOW. Two overlaps named in
the task order are resolved, not re-derived, below (F1 and F8); every other finding is kept as its
source stated it, cross-referenced where a related-but-distinct finding exists.

### CRITICAL

**F1 — No unit run can ever reach the `review` checkpoint, and restart recovery force-settles a `waiting` run — including one parked over budget — to a false "done."**
*Merged: branches-and-end-state F2 (CRITICAL) + budget-and-restart F1 (CRITICAL) — the task order
named this overlap explicitly. They are two faces of the same mechanism: F2 is why the general
settle path can never produce `review` for a unit run; budget-and-restart's F1 is the specific,
worse consequence when that same mechanism runs during restart recovery against a run that is
`waiting` because it hit its budget ceiling, not because it finished cleanly.*

- Every unit run is created `autonomous: true` with no exception — the mission root at
  `packages/cezar/src/server/server.ts:3529`, every spawned child at
  `packages/cezar/src/workflows/run.ts:1671` (verified: both lines are literally `autonomous:
  true,`). `settleSuccess` (`run.ts:4152-4176`) computes `review = hasDiff &&
  reviewGateEnabled(config) && run.autonomous !== true` at **run.ts:4159** (verified verbatim) — the
  last conjunct is `false` for every node in every mission, so `review` is `false` unconditionally,
  *even when a repository has explicitly turned the review gate on*. `engine.ts`'s own
  `TERMINAL_STATUSES`/`statusToReportStatus` still branch on `'review'` — dead code for units.
- `recover()`'s `waiting` branch (`run.ts:1328-1344`, verified) has zero special-casing for
  `unit.overBudget` and calls `settleSuccess` unconditionally, then
  `reportSettledChildToParent(run.id)` at **run.ts:1343** (verified exact line). Since `review` is
  always `false` per the point above, this settle always resolves to `done`.
  `units-engine.test.ts:364-379` establishes that an over-budget park is `status: 'waiting'` with
  `unit.overBudget: true`; `recover-unit.test.ts:129-167` establishes `recover()`'s `waiting`
  handling turns *any* `waiting` run — a plain `CEZ:ASK`, an over-budget park, or a child that never
  ran a single turn — into `status: 'done'` plus a synthesized `report.status: 'done'`, verified by
  the same test's own assertions.
- Why it matters: this is the one signal the whole budget feature exists to surface (spec Q6: "a
  cost feature with no working brake fails the cost-safe AND functional review"). A commander that
  restarted while a child was over-budget-and-parked is told, on the very next restart, that the
  child *finished successfully* — indistinguishable at the `status` field from real completion, and
  a commander is expected to trust that field (spec Q7). Separately, even without a restart, a
  repository that opted into the review gate for ordinary tasks gets none of that protection for
  missions — the feature built specifically for autonomous, multi-rank delegation is the one thing
  that bypasses the checkpoint by construction.

### F2 — CRITICAL — `needsGuard` conflates a genuine pending question with a budget halt and an exhausted retry cap

- `needsGuard: run.status === 'waiting'` (`packages/web/src/lib/missions.ts:106`, verified exact
  line and text). Enumerating every backend site that sets `status: 'waiting'`: a genuine `CEZ:ASK`
  (`run.ts:3025`/`3035` in `runContinuation`, and `run.ts:3910` in `handleRunnerUiEvent`, all
  verified) is correctly flagged; but so is an over-budget park (`enforceUnitBudget`,
  `run.ts:1578-1593`, gated the same way at `run.ts:3005`/`3706`, verified `!unitTurn.overBudget &&`
  at both), an exhausted autonomous-nudge cap (`(state.autoContinues ?? 0) < MAX_AUTO_CONTINUES` at
  **run.ts:3007**, verified), and a plain turn end on a unit's first turn or a human's own follow-up
  (`runAgentStep`, `run.ts:3737`, verified — this handler has no autonomous-nudge branch at all,
  unlike its `runContinuation` sibling). `run.unit.overBudget` already reaches the client
  (`packages/contract/src/units.ts:116`, verified) but is read by no file under
  `packages/web/src` — every "needs you" pill and every Guard-inbox row looks identical regardless
  of which of these four caused it.
- Why it matters: spec §Q4 defines the Guard inbox as "unit runs at `waiting` **with a pending
  ask**." Three of the four park reasons above are not a pending ask, so an army-sized mission pages
  a human at the same rate as a flat run for reasons that need no human at all — worse than not
  having a hierarchy — while `guard.tsx`'s own subtitle ("Every unit run that stopped to ask...")
  promises something the queue does not deliver for those rows.

### F3 — CRITICAL — nothing in the codebase ever opens a mission's draft PR; the only mechanism is a manual route with no trigger and no signal that one is expected

- `POST /runs/:id/pr` (`packages/cezar/src/server/server.ts:4344-4382`, verified) is the only
  PR-creation route in the repository — `createDraftPr`'s only caller, grep-verified, and it does
  not require `status === 'review'` (it is callable on a `done` run too, since F1 guarantees every
  unit run settles to `done`). The intended human trigger exists only in prose:
  `packages/cezar/src/units/prompts.ts:41` ("a human opens the pull request"), verified. Caesar's own
  finishing instructions never mention the PR route.
- Why it matters: combined with F1, a finished mission gives the operator no signal at all — no
  note, no distinct status, no cockpit badge — that a draft PR is expected. The lifecycle note is
  the generic "run finished" (`run.ts:4174`), identical to any ordinary task with no mission
  attached.

### HIGH

### F4 — HIGH — uncommitted parent work is silently invisible to a spawned child, and nothing checks for it

- `spawnChildren` (`run.ts:1607-1699`) has no git-status check anywhere in the function; it seeds
  `baseBranch: parent.branch` (**run.ts:1688**, verified — the line reads
  `...(parent.branch ? { baseBranch: parent.branch } : {}),`), and `createWorktree`
  (`packages/cezar/src/git-worktree.ts:211`, verified: `git worktree add -b <branch> <path>
  <base>`) forks from that branch's last **commit**, not the parent's live working tree. Enforcement
  is prose only: `CHILD_BRANCH_RULE:35` (verified exact line and text), "COMMIT your work before
  every CEZ:SPAWN. Anything you left uncommitted does not exist for your children."
- Why it matters: a commander that forgets to commit before `CEZ:SPAWN` hands its children a stale
  fork point with no refusal, no note, and no recovery — they "will either redo it or contradict
  it," with no code-level signal that this happened. The same gap applies symmetrically one level
  up: an uncommitted parent merge in response to a child's report is invisible to any further child
  spawned before it's committed.

### F5 — HIGH — `totalBudgetUsd` double-counts every budget carved from a parent that itself has a ceiling

- `packages/web/src/lib/missions.ts:211-219` (verified verbatim) sums every node's own `budgetUsd`
  across the whole mission tree. But `carveChildBudgets` (`run.ts:1701-1739`, verified) subtracts a
  child's ceiling from the **same envelope** as its parent's `budgetUsd` whenever the parent has one
  (`remainingBudgetUsd`, `engine.ts:67-72`, verified) — a child's ceiling is new spend capacity only
  when its parent is uncapped. For a $12 caesar carving $3+$3 to two legates, the true mission
  ceiling is $12, but `totalBudgetUsd` computes $12+$3+$3 = $18, a 50% overstatement. Pinned wrong by
  `missions.test.ts:187-199` (`totalBudgetUsd === 25` for a $20 caesar + $5 carved legate); the
  source doc ran `npx vitest run src/lib/missions.test.ts` and confirmed 26 passed, including this
  case.
- Why it matters: currently zero blast radius — no route renders `totalBudgetUsd` today (see F12) —
  but it is a live landmine for the first surface that does, and it is the *normal* case
  (`carveChildBudgets` is what every capped mission actually uses), not the edge case the code
  comment justifying the sum was written for.

### F6 — HIGH — the monitoring-wake-cap dead end never sets `status: 'waiting'`, so `needsGuard` misses it entirely (paired with F2)

- `armMonitoringWakeTimer`'s cap-reached path (**run.ts:4290-4300** and **run.ts:4312-4318**, both
  verified exact) sets `monitoringWakeCapReached: true` but leaves `status: 'running'`,
  `activity: 'monitoring'` — no call to `updateRun(..., { status: 'waiting' })` on this path,
  confirmed by reading the full function. `deriveAttention` keeps this in the `running` bucket
  forever, so `needsGuard` never becomes `true` for it. The information exists and is rendered — but
  only inside that one run's own thread (`run-header.tsx:811-818`, `MonitoringSchedule`, "Automatic
  checks paused — 40/40 reached") — nowhere else.
- Why it matters: this is F2's mirror failure — a false negative rather than a false positive. A run
  whose automatic wake-ups have permanently stopped needs a human exactly as much as a genuine
  `CEZ:ASK` does, but it is invisible from `/missions` and `/guard` both.

### F7 — HIGH — one terminal-transition path never reports to the parent at all

- `recover()`'s unresumable `running`→`failed` branch (`run.ts:1346-1372`, verified): a `running` run
  found at boot is marked `failed`, then `continueRun` is attempted; if it refuses (its own check at
  **run.ts:2696**, `!sessionStep?.sessionId → { ok: false, error: 'no agent session to resume' }`,
  verified), the branch only appends a lifecycle note on the run itself — it never calls
  `reportSettledChildToParent`. Contrast the *other* unresumable-terminal path,
  `reviveQueuedRun`'s workflow-not-recoverable branch (`run.ts:1251-1266`), which explicitly does,
  with a comment calling itself "the third terminal transition outside `dropActive`" — the sibling
  branch has no such call and no such comment.
- Why it matters: a child that crashes before its agent CLI ever emits a first `session` event ends
  up permanently `failed` with no pending report ever written to its parent. A parent parked on that
  child waits for a report that will never arrive — the exact failure mode spec Q7 exists to
  prevent. No test in `recover-unit.test.ts` or `units-engine.test.ts` exercises this branch for a
  unit child.

### F8 — HIGH — no cost roll-up: a subtree's real spend can silently exceed the root's `budgetUsd`, and a settled child's unspent ceiling is never returned

*This is the same underlying defect independently found and already unified in the two sibling
audits — `01-communication/SUMMARY.md` F4 and `02-roles/SUMMARY.md` F8, per the task order's own
pointer. Not re-derived here; kept as its own entry because it is this doc's own local finding, with
a cross-reference rather than a restatement of the other two audits' text.*

- `run.costUsd` is recomputed strictly from a run's own steps (`packages/cezar/src/runs/store.ts:938-939`,
  verified: `const cost = run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0); run.costUsd = cost
  > 0 ? cost : undefined;`) — nothing sums a child's cost into its parent's. `remainingBudgetUsd`
  (`engine.ts:67-72`, verified) subtracts `Σ children.budgetUsd` — the **promised ceiling** — over
  every child from `childrenOf` with no status filter (confirmed live at the one call site,
  `run.ts:1718`, inside `carveChildBudgets`). `enforceUnitBudget`'s brake is turn-boundary, not
  turn-start (verified `run.ts:1578-1593`), and `units-engine.test.ts:364-367` shows a live 34x
  overshoot in a single turn before the brake fires.
- Why it matters: a mission root's `budgetUsd` bounds what it can *promise* downward, not what the
  tree actually *spends* — the two can diverge in either direction with nothing in the engine to
  reconcile them. Separately, a child that underspends its ceiling never returns the unused portion,
  so a long mission loses delegation capacity monotonically regardless of what its children actually
  cost — this is the piece independently confirmed live, with real numbers, by both
  `01-communication` F4 and `02-roles` F8.

### MEDIUM

### F9 — MEDIUM — worktree retention is project-wide and mission-blind, and the reclaimed case is misreported to only two of the three cockpit read routes

- `selectReclaimableWorktrees` (`packages/cezar/src/runs/retention.ts:37-43`, verified) sorts ALL
  finished runs project-wide by recency and keeps the top `keep` (default **10**,
  `DEFAULT_WORKTREE_RETENTION`, `packages/cezar/src/config.ts:26`, verified), with no grouping by
  `unit.missionId`. Because every unit child settles to a reclaim-eligible status the instant it
  finishes (F1), a single busy army can push its own not-yet-merged siblings' worktrees past the
  default `keep=10` while the mission is still in flight.
- **Correction to the source's mechanism claim** (verified against server.ts directly): `GET
  /runs/:id/changes` (`server.ts:4196-4211`) and `GET /runs/:id/commits` (`server.ts:4214+`) do share
  `workingDirectoryOf`/`worktreeOf` (`server.ts:4557-4563`) and both return the JSON
  `NO_WORKTREE = 'no worktree — this task ran directly in the repo working tree'` for both "never
  had a worktree" and "reclaimed" — `run.worktreeReclaimedAt` (set at `retention.ts:26`, grep-confirmed
  read nowhere in `server.ts`) is consulted by neither. **But `GET /runs/:id/diff`
  (`server.ts:4185-4193`) does NOT go through that shared machinery** — it has its own separate,
  inline `existsSync(run.worktreePath)` check returning a plain-text literal via `c.text(...)`, which
  the code's own comment at `server.ts:4553-4554` calls "the text-blob /diff above (which stays
  untouched — protected surface)." The user-visible outcome is the same (a message claiming the run
  "ran directly in the repo working tree" when it actually had a worktree that was reclaimed), but it
  is produced by a second, separate implementation, not the one shared string the source doc
  describes all three routes as returning.
- `rematerializeReclaimedWorktree` (`retention.ts:68-82`) has exactly one call site in the whole
  codebase — `run.ts:2833`, inside `runContinuation` — verified by grep; none of the three read
  routes call it.
- Why it matters: a human inspecting a mission's child through the cockpit's diff/changes/commits
  tabs gets a message that falsely claims the task "ran directly in the repo working tree," for a
  task whose worktree was in fact reclaimed purely because the mission ran busily enough to exceed a
  project-wide, mission-unaware count.

### F10 — MEDIUM — the missions API has one route: no `GET`, no mission-scoped cancel, no pause/resume

- Full route inventory (re-verified: `packages/cezar/src/server/server.ts:3486-3577` has exactly
  four handlers total — `POST /missions`, `GET /units/prompts`, `PUT /units/prompts/:role`,
  `DELETE /units/prompts/:role`; none of the last three touch a mission's lifecycle).
  `missions-api.test.ts` (215 lines) tests only `POST /api/v1/missions`.
- No `GET /missions`/`:id` — the web UI never needed it (`missions.tsx:38` derives the tree
  client-side from `useRuns()` + `unit.missionId`/`parentRunId`), but any other consumer (a CLI, a
  script, a second front end) must fetch and filter the entire run list itself.
- No mission-scoped cancel — only `POST /runs/:id/cancel` exists; an operator must find and remember
  which run id is the mission's root, and cancelling the wrong node (e.g. a legate) cascades to its
  own descendants but leaves siblings and Caesar running.
- No pause/resume for a unit run — `POST /automations/:id/pause` is for scheduled automations, an
  unrelated feature. A mission needing a temporary hold has only two options: let it keep spending,
  or cancel it outright and lose the tree's live state.
- Why it matters: real, not merely inconvenient, costs — see F11 for the fourth gap (mid-flight
  budget change), which is severe enough to warrant its own finding.

### F11 — MEDIUM — an over-budget unit run has no path back to autonomous operation, and no API can raise its ceiling

- `run.ts:2975-2980` and its twin `:3706` (both verified) force `monitoring = false` whenever
  `unitTurn.overBudget`; the autonomous nudge is gated the same way (`!unitTurn.overBudget &&` at
  `run.ts:3005`, verified). `unit.overBudget` is set once (`run.ts:1585-1586`) and never cleared
  anywhere — grep-confirmed, every other hit is a read. `server.ts` writes `unit.budgetUsd` exactly
  once, at mission creation (`server.ts:3537`, verified); no route patches an existing run's `unit`.
  This is the same gap `unit.budgetUsd`'s single write site produces in F10's table (`server.ts:3537`
  is the identical citation both findings share) — kept as two findings because F10 catalogs the
  general API-surface gap while this one is its most severe operational consequence.
- The only way to move a run out of `waiting` once over budget is an external message (a human, or a
  settled child's report delivered through `deliverMessage`, which does not check `overBudget` at
  all) — and that message buys exactly one more turn before `enforceUnitBudget` re-checks, `spent` is
  still `>= budget` (the ceiling never moved), and it parks `waiting` again, silently this time
  (the note only fires once).
- Why it matters: this may match the Guard's intent (spec Q6: a hard stop), but there is currently no
  product mechanism to say "the extra spend is approved, keep going" short of restarting the mission
  from scratch with a new, higher `budgetUsd` — a mission proving its worth is force-stopped early
  rather than extended.

### F12 — MEDIUM — `totalBudgetUsd`/`totalCostUsd` are computed and unused; this is why F5's bug has no current symptom

- Grepped every `.tsx` under `packages/web/src` for `totalBudgetUsd`/`totalCostUsd`: the only hits
  are `missions.ts` and `missions.test.ts` themselves. `missions.tsx`'s `BudgetMeter`
  (`missions.tsx:303-333`, verified to exist) is per-node only — one bar per row, never an aggregate.
- Why it matters: a scoping note tied to F5 — nobody reads the wrong number yet, but it becomes
  user-visible the moment any surface renders it, which is exactly what the "mission cost against
  budget" gap calls for (see P6 below).

### F13 — MEDIUM — the Guard inbox's own subtitle overpromises given F2

- `guard.tsx:83-84`'s `SUBTITLE` — "Every unit run that stopped to ask. Opening one lands on its
  question in the thread..." — is false for the budget-halt / exhausted-cap / plain-turn-end rows
  F2 identifies, which land on a thread with no ask card at all.
- Why it matters: paired with F2 — a copy fix alone cannot resolve it; the underlying membership
  test has to change first (see P3).

### LOW

### F14 — LOW — no on-disk mission ledger exists; `runs.json` already serves that purpose

- Grep for `ledger` under `units/`/`contract/src/units.ts` returns no hits.
  `packages/cezar/src/runs/store.ts:977-990` (`archiveFinished`) only ever stamps `archived: true` —
  it never deletes a run record — so the "ledger" already survives indefinitely in the file the tree
  view reads (`missions.tsx:38`, deriving the whole tree from `useRuns()` alone).
- Why it matters: recorded for completeness. Building a separate ledger file would duplicate
  `runs.json`'s own fields across two write paths — the exact drift risk a shared-construction-site
  audit warns about — for no benefit `runs.json` doesn't already provide.

---

## Proposals

Ranked by value over effort. Two overlapping backend proposals (branches-and-end-state P4 and
budget-and-restart P3, both a budget top-up route) are merged into P9; every other proposal is kept
distinct, with dependencies and cross-doc convergences called out inline.

### P1 — Let the mission ROOT's terminal settle reach `review`, gated behind the existing opt-in — fixes F1 (part), F3

**Problem.** No unit run — root included — can ever park at `review`, so a mission's finished diff
never gets the checkpoint that would nudge a human toward `POST /runs/:id/pr`.

**Concrete change.** In `settleSuccess` (`run.ts:4152-4176`), widen line 4159 from
`run.autonomous !== true` to `run.autonomous !== true || run.unit?.missionId === run.id` (the root is
its own mission). Only the root is exempted; every legate and centurion beneath it keeps
`autonomous: true` behaving exactly as today — they still report to a parent and must keep running
unattended.

**Default-path impact, every knob at default.** `reviewGateEnabled(config)` defaults OFF (#489) —
with the knob at its shipped default, `review` stays `false` for everyone, root included: **zero
change** to today's behavior. Only a repository that has already opted into the review gate for
ordinary tasks gets the same protection extended to a mission's terminal settle.

**Transitions out of the new root-`review` state, and who fires them.** Identical to any other
`review` run today: a human sends feedback (reopens the session via `deliverMessage`), or calls
`POST /runs/:id/pr` (unchanged) to publish the draft. No new mechanism — this only widens which runs
are eligible for the one that exists.

**Tests to pin.** "An autonomous mission ROOT with the review gate on and a non-empty diff parks at
`review`, not `done`"; "a mission CHILD (centurion/legate) with the review gate on still settles
straight to `done` — the exception is root-only"; "with the review gate off (default), a mission
root's terminal settle is byte-identical to before this change."

**Effort: S. Risk: low-medium** — `isTerminalStatus` (`engine.ts:44-46`) already includes `'review'`,
so `reportSettledChildToParent` is unaffected; a root has no `parentRunId` to report to regardless,
so this only ever touches the ROOT's own settle. Needs a test proving that isolation explicitly,
since it is the whole safety argument for the change.

### P2 — Give restart recovery a way to tell "blocked" apart from "done" — fixes F1 (part)

**Problem.** `recover()`'s `waiting` branch has one outcome for three distinct situations: a plain
`CEZ:ASK` pause, an over-budget park, and a child that never did any work. Only the first is actually
"the turn was over and the ball was in the user's court."

**Concrete change.** In `recover()`'s `waiting` branch (`run.ts:1328-1344`), before calling
`settleSuccess`, branch on `run.unit?.overBudget`: if `true`, append a lifecycle note ("cezar
restarted — still parked over budget, unchanged") and `continue` — no `settleSuccess`, no
`reportSettledChildToParent`, since nothing actually settled. Leave the existing plain-`waiting`
handling unchanged for every other case.

**Default-path impact, every knob at default.** None for a mission with no `budgetUsd` — this branch
is unreachable, since `overBudget` can only be set when a budget exists. For a budgeted mission, a
restart during an over-budget park now correctly reports nothing changed instead of a false "done."

**Transitions out of the (unchanged) `waiting`+`overBudget` state, and who fires them.** Unchanged
from today: a user message via `deliverMessage`, or a settled sibling's report delivery — both
survive a restart already (a restarted process has no open session for a `waiting` run either way,
so `sendMessage` correctly reports "no open session" and the cockpit's "Continue" fallback, gated to
`['done','failed','cancelled','review']`, does not apply to `waiting` — a pre-existing gap outside
this proposal's scope).

**Tests to pin.** Extend `recover-unit.test.ts` with a sibling to "reports a waiting child settled by
recovery to its parent" — same fixture but `unit.overBudget: true` — asserting `status` stays
`'waiting'`, `unit.overBudget` stays `true`, and `pending.length` stays `0` (no false report).

**Effort: S. Risk: low** — additive (an early `continue`), and only changes behavior when
`unit.overBudget` is already `true`, a state that (per F11) cannot currently self-heal anyway.

### P3 — Give the Guard a reason, using data already on the wire — fixes F2

**Problem.** `needsGuard`/the Guard inbox cannot tell a genuine ask apart from a budget halt or an
exhausted nudge cap, despite `run.unit.overBudget` already reaching the client unused.

**Concrete change.** Add `guardReason: 'ask' | 'overBudget' | 'other'` to `MissionNode`, derived in
`nodeOf` (`missions.ts:86-109`) from `run.unit.overBudget` first, else `'ask'`/`'other'` as a coarser
bucket until a real pending-ask flag exists on the wire. Render it as a small label on `guard.tsx`'s
row (next to age) and `missions.tsx`'s status cell. Keep `needsGuard` itself as `status === 'waiting'`
— this is additive, not a redefinition of what counts as guarded.

**Default-path impact, every knob at default.** None for existing missions without a budget;
over-budget missions get a visibly different, honest row instead of the current generic "needs
you"/"question" framing.

**Transitions.** None new — `guardReason` is derived, same lifecycle as `needsGuard`, computed fresh
on every read.

**Tests to pin.** Extend `missions.test.ts` with a case where `unit.overBudget: true` asserting
`guardReason === 'overBudget'`; a plain `CEZ:ASK` case still resolves `'ask'`/default.

**Effort: S. Risk: low.**

### P4 — Flag the monitoring-wake-cap dead end — fixes F6

**Problem.** A run whose automatic wake-ups are exhausted (`monitoringWakeCapReached`) never becomes
`needsGuard`; it is invisible outside its own thread.

**Concrete change.** In `nodeOf` (`missions.ts:86-109`), OR this into `needsGuard`:
`needsGuard: run.status === 'waiting' || Boolean(run.monitoringWakeCapReached)`.
`monitoringWakeCapReached` is already a top-level `RunRecord` field
(`packages/contract/src/runs.ts:203`), so no new plumbing is required.

**Default-path impact, every knob at default.** A currently-silent stuck run starts appearing in
`/guard` and painting the violet "needs you" banner — intended, since this is exactly the class of
run that needs a human, per F6.

**Transitions out of this state, and who fires them.** Unchanged from today — a human sends the run a
message (`deliverMessage`), which the backend already handles regardless of
`monitoringWakeCapReached`. No new engine transition needed; only the read side changes.

**Tests to pin.** A `MissionNode` fixture with `status: 'running', activity: 'monitoring',
monitoringWakeCapReached: true` → `needsGuard === true`; `guardCount`/`guardQueue` include it.

**Effort: S. Risk: low** — additive OR on an existing boolean.

### P5 — Fix `totalBudgetUsd` to not double-count carved budgets — fixes F5

**Problem.** Summing every node's `budgetUsd` counts money twice whenever a child's ceiling came out
of a parent that itself has one.

**Concrete change.** In `buildMissionTrees` (`missions.ts:203-225`), change the budget reducer to
only add a node's `budgetUsd` when it is genuinely new money: the root, or a node whose immediate
parent has no `budgetUsd` — `totalBudgetUsd = Σ_node budgetUsd(node) where node is root OR
budgetUsd(parent(node)) === undefined`, mirroring `remainingBudgetUsd`'s own rule. Needs each node to
know its parent's `budgetUsd` at fold time — a second pass over `nodes` keyed by
`run.unit.parentRunId`, or threaded through `build()`'s recursion.

**Default-path impact, every knob at default.** None — no route currently renders this field (F12),
so the change is invisible until a consumer is added. It changes `missions.test.ts:187-199`'s
expected value from `25` to `20`; that assertion must be updated as part of the fix, not left passing
by accident.

**Transitions.** Pure function, no new state, computed fresh on every read.

**Tests to pin.** (a) the $12/$3+$3 case → `totalBudgetUsd === 12`; (b) update
`missions.test.ts:187-199`'s expectation to `20`; (c) an uncapped root with two independently
budgeted children → `totalBudgetUsd === 6` (the existing "don't under-report" case, still correct
under the new rule); (d) a 3-level fully-carved chain (root $20 → legate $5 → centurion $2) →
`totalBudgetUsd === 20`.

**Effort: S. Risk: low** — isolated pure-function change with existing test coverage to extend.

### P6 — Autosave the parent's worktree before seeding a child's fork point — fixes F4

**Problem.** A commander that forgets to commit before `CEZ:SPAWN` hands its children a stale base
with zero code-level signal.

**Concrete change.** In `spawnChildren` (`run.ts:1607`), before creating any child, call the existing
`autosaveCommit(parent.worktreePath, 'turn end')` (`git-worktree.ts:320-349`) — already used at other
lifecycle points, reusing its existing conflict-detection guard (refuses to autosave a worktree
mid-merge or carrying conflict markers). On `'refused'`, refuse the spawn with a note explaining why,
mirroring every other spawn refusal's shape; on `'committed'`/`'nothing-to-do'`, proceed as today.

**Default-path impact, every knob at default.** A parent that already commits before spawning (as
the prompt instructs) sees `autosaveCommit` return `'nothing-to-do'` — a true no-op. Only a parent
that forgot to commit changes behavior, and only by turning the previously-silent loss into either a
commit or an outright refusal — no existing passing scenario regresses.

**Transitions.** None new — the spawn either proceeds (autosaved or already clean) or is refused
exactly like any other malformed/over-budget spawn, with no new run state.

**Tests to pin.** New cases in `run.test.ts`'s spawn suite: "spawnChildren autosaves uncommitted
parent work before seeding a child's baseBranch" (dirty tree → child forks from a commit containing
the uncommitted file); "a mid-merge parent refuses to spawn rather than autosaving a broken tree."

**Effort: S. Risk: low** — reuses an already-tested helper; the only new logic is the refusal branch.

### P7 — True up `remainingBudgetUsd` at settle time so a settled child's real spend, not its ceiling, is charged — fixes F8, F11 (part)

**Problem.** `remainingBudgetUsd` subtracts a promised ceiling for every child forever; a settled
child's unused reservation is never released, so a long mission loses delegation capacity
monotonically regardless of what its children actually cost.

*Note on convergence:* this exact fix (charge a terminal child at its actual `costUsd`, an in-flight
child at its promised ceiling) was independently proposed in `01-communication/SUMMARY.md` P2 and
`02-roles/SUMMARY.md` P6 — three separate audits of this feature converged on the identical
arithmetic. Whoever implements this should pick one PR to land it in, not three; the version below is
this doc's own statement of it, extended with the subtree-visibility half budget-and-restart's own
audit called for.

**Concrete change, two parts.** (1) In `remainingBudgetUsd` (`engine.ts:67-72`), for children whose
`isTerminalStatus(...)` is true, subtract `child.costUsd ?? child.unit?.budgetUsd ?? 0` (falling back
to the promised ceiling only if a settled child's cost was never recorded, so a spawn can never be
under-charged by a data gap) instead of always subtracting the ceiling; in-flight children keep
subtracting their promised ceiling, since the money is still reserved. Pure function change. (2) Add
a small helper, `subtreeCostUsd(runs, rootId)`, recursively summing `costUsd` over `childrenOf` at
every depth, for a future Missions-tree budget meter to show real spend instead of a per-row number
that never includes delegated-away work.

**Default-path impact, every knob at default.** For an uncapped mission, `remainingBudgetUsd` still
returns `undefined` — no change. For a budgeted mission, remaining budget becomes more accurate
(rises when a child underspends, falls when a child overspends) and strictly loosens today's
refusal — no mission that can spawn today stops being able to.

**Transitions.** None — pure arithmetic on data already read at the existing call site
(`run.ts:1718`, inside `carveChildBudgets`).

**Tests to pin.** `engine.test.ts`'s `remainingBudgetUsd` suite gets three new cases: a terminal child
that spent less than its `budgetUsd` (remaining rises), one that spent more (remaining falls), and a
terminal child with no recorded `costUsd` (falls back to its ceiling, never over-releases). A `run.ts`
test that a spawn refused before a child settles succeeds after.

**Effort: M. Risk: low-medium** — pure-function change with direct test coverage; the only risk is a
spawn-time regression if `carveChildBudgets` starts seeing more available budget mid-mission than it
did before and a commander over-delegates — mitigated by never trueing up *above* what was actually
promised.

### P8 — Two thin, additive missions routes: `GET` and mission-scoped cancel — fixes F10 (part)

**Problem.** No way to ask "what is in mission X" or "cancel mission X" without knowing its root run
id and re-implementing the grouping the web cockpit already has.

**Concrete change.** `GET /api/v1/p/:projectId/missions/:id` — filter `store.listRuns()` by
`unit.missionId === :id`, return `{ root, runs }`, ideally by exposing the grouping
`packages/web/src/lib/missions.ts` already implements as a shared, testable pure function both sides
import. `POST /missions/:id/cancel` — resolve the mission's root (the run with no `parentRunId` and
`missionId === id`) and delegate to the SAME cascade `POST /runs/:id/cancel` already runs
(`server.ts:3821`) — verified this cascades children-first via `cancelDescendants`
(`run.ts:1837-1845`, called from `run.ts:2247`) — no new cancellation logic, only a lookup wrapper.

**Default-path impact, every knob at default.** Purely additive; both new routes sit behind the
existing `requireUnits` gate (`server.ts:3465-3468`), so a repo with units off gets the same 409 it
already gets for every other units route.

**Transitions.** None new — `POST /missions/:id/cancel` produces exactly the cascade
`/runs/:id/cancel` already produces, terminal for every descendant it reaches.

**Tests to pin.** "GET returns every run whose `unit.missionId` matches, root first"; "cancel by
mission id cascades identically to cancel by root run id on the same fixture tree."

**Effort: S. Risk: low.**

### P9 — A validated budget top-up route that clears `overBudget` and re-arms the wake timer — fixes F11

*Merged: branches-and-end-state P4 + budget-and-restart P3 — both proposed the same capability (a
PATCH raising a mission's ceiling); this is the combined version, carrying both the ceiling-integrity
check from the first and the wake-timer re-arm from the second, which the other omitted.*

**Problem.** `unit.budgetUsd` is writable exactly once, at creation. Once `unit.overBudget` is set,
the only way to keep a mission moving is a fresh external message every single turn, forever — there
is no "resume autonomously" action anywhere in the API, and no way to raise a proving-its-worth
mission's ceiling short of restarting it from scratch.

**Concrete change.** `PATCH /api/v1/p/:projectId/missions/:id/budget { budgetUsd }` (or fold into a
run-level unit-patch route) on the resolved root — reject a new ceiling below `costUsd + Σ
children.budgetUsd` (reuse `remainingBudgetUsd`'s arithmetic solved for the ceiling, so it can never
retroactively under-fund work already promised) — route the write through `updateUnit`
(`run.ts:1586`, the single existing mutator `enforceUnitBudget` already uses) so the persistence path
is unchanged. If the root is currently parked with `unit.overBudget: true`, clear the flag AND
re-arm the wake timer specifically, since `enforceUnitBudget`'s whole job (`run.ts:1578-1593`) is
closing a run's wake sources when budget hits zero; a top-up that clears the flag but leaves the
timer disarmed would leave a mission that looks funded but never wakes again.

**Default-path impact, every knob at default.** Purely additive; a mission that never calls it
behaves exactly as today.

**Transitions out of `overBudget`, and who fires them.** Today there is exactly one, informal exit: a
human sends the run a message, which gives the run a turn but does NOT clear `unit.overBudget` (grep
of `overBudget` in `run.ts` confirms it is set once and read only elsewhere). This proposal adds a
second, explicit exit (the PATCH) and must fix the first exit's same gap in the same change, or the
flag becomes permanently sticky once set even after a top-up clears it once, re-triggering on the
very next turn if the human-message path is used again without a further top-up.

**Tests to pin.** "PATCH budget rejects a ceiling below what's already spent/promised"; "PATCH budget
on an over-budget root clears `unit.overBudget` and re-arms the wake timer so the next turn actually
fires"; "a plain human message to an over-budget run — the pre-existing exit — still does NOT clear
`overBudget` on its own, pinning today's actual behavior before this change touches it."

**Effort: S-M. Risk: medium** — this touches the budget brake, which spec Q6 calls a hard
requirement; needs a regression test proving the ORIGINAL over-budget park still fires unchanged and
is not weakened by adding the escape hatch.

### P11 — Tell the truth about a reclaimed worktree on the three read routes — fixes F9

**Problem.** `GET /runs/:id/diff`, `/changes`, and `/commits` all effectively claim a reclaimed
worktree "ran directly in the repo working tree," and that case is far more likely for a mission's
children (F1 removes the delay `review` would otherwise add before reclaim-eligibility).

**Concrete change.** Branch `worktreeOf`/`workingDirectoryOf` (`server.ts:4557-4563`) — which already
have the run record in hand — on `run.worktreeReclaimedAt`: when set and the directory is missing,
return a distinct `409 { error: 'worktree reclaimed — reopen this run to restore it', reclaimed: true
}` on `/changes` and `/commits`. `/diff` needs its own equivalent check added separately, since it is
a distinct implementation (`server.ts:4185-4193`, marked "protected surface" in its own comment) that
does not route through `workingDirectoryOf` at all — this is a correction to the source finding's
"all three share one mechanism" framing (see F9's Verification note); the fix must touch two call
sites, not thread through one shared helper. Do NOT change `selectReclaimableWorktrees`'s policy
(count, project-wide scope) in the same change — that mechanism already works for the non-units case.

**Default-path impact, every knob at default.** Default-on, changes nothing for a run that was never
reclaimed; a reclaimed run's error message changes from misleading to accurate — a strict
improvement, not a knob.

**Transitions.** None new.

**Tests to pin.** "`GET /runs/:id/diff` on a reclaimed run returns the reclaimed-specific message, not
the generic no-worktree text"; same assertion for `/changes` and `/commits`.

**Effort: S. Risk: low.** (Making retention mission-aware — never reclaiming a child until its branch
is proven merged — is a bigger, cross-cutting change to a working mechanism; left as a deliberate
follow-up, not bundled here.)

### P12 — Cascading "Stop mission" and a re-budget affordance in the cockpit — fixes F10 (part), F13, wires P9

**Problem.** Only a per-run Cancel exists (`run-header.tsx:308-310`), reachable one run at a time, and
no UI edits an existing run's `budgetUsd` after mission creation.

**Concrete change.** Add a mission-root action in `missions.tsx` that calls `POST
/missions/:id/cancel` (P8) on the root — verified server-side that the cascade-to-descendants
behavior already exists (`cancelDescendants`, `run.ts:1837-1845`, children-first, called from
`run.ts:2247`), so no new backend work is needed for the cancel half. Re-budgeting wires to P9's PATCH
route once it ships; until then this half is blocked.

**Default-path impact, every knob at default.** New destructive/scope-widening action — this should
get its own confirmation dialog, not a one-click cascade, so the default rendered state (button
present, confirmation required) changes nothing for a mission nobody clicks Stop on.

**Transitions, and who fires them.** Human-initiated only; cascading cancel ends the mission
(terminal, for every reachable descendant); a budget increase (once P9 lands) clears
`unit.overBudget` per P9's own transition.

**Tests to pin.** A `missions.tsx` interaction test: clicking Stop on a mission root, confirming,
asserts the resulting statuses of every in-flight descendant become `cancelled`; a re-budget
mutation test (once P9 exists) asserting the UI reflects the cleared `overBudget` flag.

**Effort: M-L. Risk: medium** — touches the cancel cascade's UI surface and depends on P9 for its
second half; ship the cancel half alone first if P9 is deferred.

---

## Open questions for the user

1. **F1's fix, P1 vs P2 — ship together or separately?** P1 (root reaches `review`) and P2 (restart
   doesn't force-settle an over-budget park) fix two different symptoms of the same root cause
   (unconditional `autonomous: true`). They are independent changes with no shared code, but landing
   only one leaves the other half of F1 open. Land both in one change, or sequence them?
2. **P9's route shape.** A dedicated `PATCH /missions/:id/budget`, or folding it into a more general
   unit-patch route that could later carry other mid-flight mutations (ladder, scope)? The latter is
   more future-proof but is new API surface beyond what this audit scoped.
3. **P7's convergence.** Since the identical `remainingBudgetUsd` fix has now been proposed three
   times (here, `01-communication` P2, `02-roles` P6), should it be implemented once as a standalone
   PR ahead of any of the three units-improvements tracks, so none of them has to carry it?
4. **P3's `guardReason` granularity.** The proposal falls back to a coarse `'ask' | 'other'` split
   because no backend flag distinguishes a genuine pending question from an ordinary unmarked turn
   end (F2's W5 case). Is a coarser-but-shipped fix acceptable now, or should a real `pendingAsk`
   flag (as `01-communication`'s own P4 proposes) land first so `guardReason` can be fully accurate
   from day one?
5. **F10's throughput cost.** No pause/resume for a unit run means a mission needing a temporary hold
   has only "let it spend" or "cancel and lose state." Is this gap worth its own proposal in this
   pass, or is P12's cascade-cancel + P9's budget top-up together sufficient operator control for the
   MVP?

---

## Verification

- Re-checked at HEAD `8ed75a05b23d32277a57df3e933eaf648089f208` in this worktree (confirmed via `git
  rev-parse HEAD`); confirmed via `git log --oneline
  076cead2785891af80b9ea7440bf3be973c0bbfe..HEAD -- packages/cezar/src packages/web/src
  packages/contract/src` (no output) that no source commit separates that HEAD from the one all
  three source audits were performed against — the code is identical to what they read.
- Re-opened and confirmed exact, verbatim: `server.ts:3529` (`autonomous: true,`), `run.ts:1671`,
  `run.ts:4159` (the `review = ...` line), `run.ts:1328-1344` and `run.ts:1343`
  (`reportSettledChildToParent(run.id);`), `run.ts:1688` (`baseBranch: parent.branch`),
  `git-worktree.ts:211`, `engine.ts:21-29` (`CHILD_ROLE`/`MAX_CHILDREN_IN_FLIGHT`), `prompts.ts:31-41`
  and `prompts.ts:35` exact text, `engine.ts:49,67-72` (`childrenOf`/`remainingBudgetUsd`),
  `missions.ts:106` (`needsGuard`), `missions.ts:211-219` (`totalBudgetUsd`), `run.ts:1578-1593`
  (`enforceUnitBudget`), `run.ts:1701-1740` (`carveChildBudgets`), `run.ts:2975-2980`/`:3706`
  (`!unitTurn.overBudget &&`), `run.ts:3005`/`3007`/`3025`/`3035`/`3727`/`3737`/`3910` (every `waiting`
  park site cited for F2), `run.ts:4284-4330` and specifically `4290`/`4312`
  (`MAX_AUTO_CONTINUES) {`), `store.ts:938-939` (`run.costUsd` from own steps),
  `contract/src/units.ts:116` (`overBudget`), `retention.ts:20-43` (`isReclaimable`/
  `selectReclaimableWorktrees`), `config.ts:26` (`DEFAULT_WORKTREE_RETENTION = 10`),
  `server.ts:4344-4382` (`POST /runs/:id/pr`), `run.ts:2833` and `retention.ts:68`
  (`rematerializeReclaimedWorktree`'s one call site), `run.ts:1788,1837-1845,2247`
  (`cancelDescendants`, children-first).
- **Correction made:** branches-and-end-state.md's F4 states that `GET /runs/:id/diff`,
  `/changes`, and `/commits` "all gate on a bare `existsSync(run.worktreePath)` check and return the
  SAME string" (`NO_WORKTREE`). Reading `server.ts:4185-4232` and `4550-4563` directly shows this is
  only true of `/changes` and `/commits`, which share `workingDirectoryOf`/`worktreeOf`/`NO_WORKTREE`.
  `/diff` (`server.ts:4185-4193`) is a separate, older implementation with its own inline check and a
  plain-text response, explicitly called "protected surface" in its own adjacent comment
  (`server.ts:4553-4554`). The user-visible conclusion (misleading message for a reclaimed worktree)
  still holds for all three routes, but the mechanism is two implementations, not one — reflected in
  F9's text above and in P11's fix, which now names two call sites instead of one shared helper.
- No other citation across the three source files, spot-checked against roughly 30 distinct
  `file:line` references spanning all three documents, required correction.
- Finding count: **15 before deduplication** (branches-and-end-state 6 + budget-and-restart 4 +
  cockpit 5, counting F2b) → **14 after** (the one merge named by the task order, branches-and-end-state
  F2 + budget-and-restart F1 → this doc's F1; budget-and-restart F3's overlap with
  `01-communication` F4 / `02-roles` F8 is cross-referenced, not merged, since those findings belong
  to other documents' own numbering, not this one's local id set).
- Proposal count: **13 before deduplication** (branches-and-end-state 5 + budget-and-restart 3 +
  cockpit 5) → **12 after** (branches-and-end-state P4 + budget-and-restart P3 merged into this
  doc's P9).

*Written by a centurion under task order from the legate on run
`e44f25a3-8a09-427b-9f41-f68a5175d198`. Create-only: no source, test, or other spec file was
touched.*
