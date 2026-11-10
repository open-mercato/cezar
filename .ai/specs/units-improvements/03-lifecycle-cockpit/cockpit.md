# Mission Cockpit audit — lifecycle & Guard

Read-only audit. HEAD at commit `076cead2785891af80b9ea7440bf3be973c0bbfe` (branch `cez/ff773c08`).
Every `file:line` below was read at this commit; line numbers are cited as of that HEAD, not the
spec doc.

Spec referenced throughout: `.ai/specs/2026-09-08-units-hierarchy.md` (§Q3 worktrees/merge, §Q4
Guard, §Q6 budget brakes, §Cockpit).

## 1. `totalBudgetUsd` — the $12 → $3+$3 arithmetic

**Where it's computed.** `packages/web/src/lib/missions.ts:211-219`:

```ts
const budgets = nodes.filter((node) => node.budgetUsd !== undefined)
...
...(budgets.length === 0 ? {} : { totalBudgetUsd: budgets.reduce((sum, node) => sum + (node.budgetUsd ?? 0), 0) })
```

`nodes` is every node in the tree (`flattenMission`, `missions.ts:231-233`), root included. The
reducer sums **every node's own `budgetUsd`**, unconditionally — root plus every child that has a
ceiling. The doc comment that justifies this, `missions.ts:76-79`, argues a SUM is needed because "a
child's budget is carved out of its parent's, so the root's number alone would under-report a tree
whose children were given ceilings directly."

**What "carved" actually means, from the backend.** `packages/cezar/src/units/engine.ts:67-72`
(`remainingBudgetUsd`):

```ts
export function remainingBudgetUsd(parent: RunRecord, children: readonly RunRecord[]): number | undefined {
  const budget = parent.unit?.budgetUsd;
  if (budget === undefined) return undefined;
  const promised = children.reduce((sum, child) => sum + (child.unit?.budgetUsd ?? 0), 0);
  return budget - (parent.costUsd ?? 0) - promised;
}
```

and `packages/cezar/src/workflows/run.ts:1701-1739` (`carveChildBudgets`, docstring: "Carve each
child's ceiling out of what the parent has left"): when a parent has its own `budgetUsd`, every
child it spawns is checked against, and subtracted from, **that same envelope**
(`run.ts:1718-1730`). Only when the parent is uncapped (`budgetUsd === undefined`) does a child's
`max_cost` NOT come out of anything (`run.ts:1710-1711`, "carves nothing… what every cezar run did
before this feature").

So a child's `budgetUsd` is additional money on top of its parent's ceiling **only when the parent
itself declared no ceiling**. When the parent has a `budgetUsd`, the child's ceiling is a
sub-allocation of it, not new spend capacity.

**Worked table — a $12 caesar carving $3 + $3 to two legates.**

| Node | `unit.budgetUsd` | Carved from | Real ceiling this node adds to the mission |
|---|---|---|---|
| caesar (root) | $12 | — (its own ceiling) | $12 (the whole mission's envelope) |
| legate A | $3 | caesar's $12 (`run.ts:1718-1730`) | $0 — already inside the $12 |
| legate B | $3 | caesar's $12, alongside A (`remaining ≥ named`, `run.ts:1725-1730`) | $0 — already inside the $12 |
| **True mission ceiling** | | | **$12** |

`remainingBudgetUsd(caesar, [A, B])` after both spawns = `12 − costUsd(caesar) − (3 + 3)`
(`engine.ts:70-71`) — i.e. the engine's own arithmetic treats the $12 as the one pool both children
draw from.

**What `missions.ts` computes for this exact tree:** `nodes = [caesar(12), A(3), B(3)]`,
`budgets.length = 3`, `totalBudgetUsd = 12 + 3 + 3 = 18` (`missions.ts:217-219`).

**Verdict: WRONG.** The UI's `totalBudgetUsd` would report **$18** for a mission whose actual
spending ceiling is **$12** — a **50% overstatement**, exactly the amount carved out ($3+$3) being
counted twice: once as part of the root's $12, once again as the children's own $3 each. The
`missions.ts:76-79` comment's stated goal (not under-reporting a tree whose children got
ceilings directly) is only correct for children of an **uncapped** parent; it is wrong for the
much more common case — the one the backend implements first (`carveChildBudgets`) — where the
parent itself has a budget and hands pieces of it out.

`totalCostUsd` (`missions.ts:216`, `Σ node.costUsd`) has no equivalent problem: each node's
`costUsd` is its own distinct spend with no carve-out relationship, so summing it is correct.

**Verified by test, not just reading:** `packages/web/src/lib/missions.test.ts:187-199` pins the
*current, wrong* behaviour —a caesar with `budgetUsd: 20` and a legate with `budgetUsd: 5` (legate
carved from the caesar's budget) asserts `mission.totalBudgetUsd === 25` (`missions.test.ts:198`).
Ran `npx vitest run src/lib/missions.test.ts` from `packages/web` at HEAD: **26 passed**, including
this one — the test suite actively locks in the double-count.

**F1 (severity: high).** `totalBudgetUsd` (`missions.ts:79`, computed `missions.ts:217-219`) sums
every node's `budgetUsd` instead of only the "new money" a node adds, double-counting any budget
carved from a parent that itself has a ceiling (the normal path, `run.ts:1701-1739`). Pinned wrong
by `missions.test.ts:187-199`. **Currently has zero blast radius in the UI** — grepped every
`.tsx` under `packages/web/src` for `totalBudgetUsd`/`totalCostUsd`: the only hits are
`missions.ts` and `missions.test.ts` themselves; no route renders either field today (see F3 in §3
below). It is a live landmine for the first surface that does.

## 2. `needsGuard` — enumerating every `waiting` park site

`needsGuard` is defined at `missions.ts:106`: `needsGuard: run.status === 'waiting'`. The doc
comment above it (`missions.ts:56-64`) claims "a unit run only parks at `waiting` when it asked
something, so the two coincide today." Spec `.ai/specs/2026-09-08-units-hierarchy.md` §Q4 states
the intended contract explicitly: **"Guard inbox = unit runs at `waiting` with a pending ask."**
Below is every backend site that writes `status: 'waiting'` on a run, at HEAD, with a verdict on
whether that write actually means "a pending ask."

| # | Site (`file:line`) | Trigger | Ask involved? | Verdict |
|---|---|---|---|---|
| W1 | `run.ts:3025` + `3035` (`runContinuation`, the autonomous/continuation turn-end handler) | `CEZ:ASK` marker parsed, `resolveAskTurn` returns `ask` truthy (`run.ts:2968-2971`) | Yes — `emitAskRequested(sink, ask)` fires on the same branch | **Correctly flagged.** This is the genuine case the spec names. |
| W2 | `run.ts:3910` (`handleRunnerUiEvent`) | Native backend's own `ask.requested` UI event, arriving mid-turn, before turn-end (`run.ts:3900-3901`) | Yes, by construction (`event.type === 'ask.requested'`, `run.ts:3905`) | **Correctly flagged.** |
| W3 | `run.ts:3035` reached via the `else` branch at `run.ts:3019-3039`, when `unitTurn.overBudget` is true (`run.ts:2979`, `3706` for the twin) | `enforceUnitBudget` (`run.ts:1578-1590`) sets `unit.overBudget = true` once `costUsd ≥ budgetUsd` — the Q6 budget brake, not a question | No — no `CEZ:ASK` text, `ask` is not required to be set | **Mislabelled.** The run is parked because it ran out of money, not because it asked anything. `run.unit.overBudget` is already on the wire (`packages/contract/src/units.ts:116`) but `missions.ts`/`guard.tsx` never read it (grep of `packages/web/src` for `overBudget`: zero hits outside this audit). |
| W4 | `run.ts:3035`, reached when the autonomous nudge is exhausted: `(state.autoContinues ?? 0) < MAX_AUTO_CONTINUES` fails (`run.ts:3007`, cap = 40, `run.ts:313`) | The role kept ending turns with no `CEZ:SPAWN`/`CEZ:MONITORING`/`CEZ:ASK`/`CEZ:DONE` for 40 auto-continues in a row | No | **Mislabelled.** Nothing was asked; the automation's own retry budget ran out. |
| W5 | `run.ts:3737` (`runAgentStep`, the non-continuation turn-end handler used for a workflow's interactive step — first turn of a run, or a human's own follow-up message) | Plain turn end: session stays open, not `done`, `ask` false, `monitoring` false (`run.ts:3701-3707`, `3718-3719`) — this handler has **no** autonomous-nudge branch at all, unlike W3/W4's handler | No | **Mislabelled when the run has a `unit`.** Every unit root is started `autonomous: true` (`packages/cezar/src/server/server.ts:3529`, asserted for squads too by `packages/cezar/src/server/missions-api.test.ts:95`), but that flag only drives the *nudge* in `runContinuation`; `runAgentStep` has no such branch, so a unit run's very first turn (or a human's manual follow-up to it) parking here with no marker at all still sets `status: 'waiting'` and is indistinguishable from W1. |
| W6 | *(absence, not a write)* — `armMonitoringWakeTimer` (`run.ts:4284-4328`), cap reached at `run.ts:4290-4300` and again at `run.ts:4312-4318` | The automatic monitoring wake-up cap (`MAX_AUTO_CONTINUES` = 40) is reached; `monitoringWakeCapReached: true` is persisted, but **`status` is left as `'running'`, `activity: 'monitoring'`** (no call to `updateRun(..., { status: 'waiting' })` on this path) | No | **Mislabelled the other way — a false negative.** `deriveAttention` (`packages/web/src/lib/attention.ts:116-121`) keeps this in the `running` bucket forever, so `needsGuard` (`missions.ts:106`) never becomes `true`. The run will never be nudged again by the engine, yet nothing in `/missions` or `/guard` says so. The information *does* exist and *is* rendered — but only if a human opens that exact run's own thread: `packages/web/src/routes/task-thread/run-header.tsx:811-818` (`MonitoringSchedule`) prints "Automatic checks paused — 40/40 reached" there, and nowhere else. |

**Verdict on the doc comment's claim** (`missions.ts:60-62`, "the two coincide today"): **false**,
demonstrably, for W3, W4 and W5 — all three park at `waiting` with `needsGuard = true` for reasons
that are not a pending ask. W6 is the mirror failure: a run that needs a human (automatic wake-ups
permanently stopped) is never flagged at all.

Guard's own copy compounds this: `packages/web/src/routes/missions/guard.tsx:83-84`
(`SUBTITLE`) says *"Every unit run that stopped to ask. Opening one lands on its question in the
thread…"* — a promise the queue does not keep for W3/W4/W5 rows, which land on a thread with no ask
card at all.

**Verified by test:** `packages/web/src/lib/missions.test.ts:224-236`
("rolls a waiting descendant up to the mission") shows `needsGuard` is driven purely by
`status === 'waiting'` with no reason attached — the fixture never sets a `CEZ:ASK`, just
`status: 'waiting'` directly, and the roll-up still flags it. `npx vitest run
src/lib/missions.test.ts` (26 passed) confirms this is exactly how the shipped code behaves, not a
misreading.

**F2 (severity: critical).** `needsGuard` (`missions.ts:106`) conflates a genuine pending question
(W1, W2) with a budget halt (W3), an exhausted nudge cap (W4) and an ordinary turn end that never
invoked a unit marker (W5) — all rendered identically as the violet "needs you" pill
(`attention.ts:110-111`, label `"needs you"`) and listed identically in the Guard inbox
(`guard.tsx:54-77`), contradicting spec §Q4's own definition ("waiting **with a pending ask**").
`run.unit.overBudget` — the one distinguishing signal that already reaches the client — is read by
no file under `packages/web/src`.

**F2b (severity: high, paired with F2).** `armMonitoringWakeTimer`'s cap-reached path
(`run.ts:4290-4300`, `4312-4318`) never transitions `status` to `waiting`, so `needsGuard` misses a
run that is permanently stuck (W6). `monitoringWakeCapReached` is already a contract field
(`packages/contract/src/runs.ts:203`) and already rendered — but only inside the single run's own
`run-header.tsx:811-818`, never rolled into `missions.ts`/`guard.tsx`.

## 3. What a supervising human cannot see or do from the cockpit

| Gap | Evidence it is missing | What surface would show it |
|---|---|---|
| **Mission cost against budget** | `MissionTree.totalCostUsd`/`totalBudgetUsd` (`missions.ts:74-79`) are computed but grepping every `.tsx` in `packages/web/src` for either name returns nothing outside `missions.test.ts`. `missions.tsx`'s `BudgetMeter` (`missions.tsx:303-333`) is per-node only — one bar per row, never an aggregate. A mission with 8 nodes has 8 separate meters and no total. (This also means F1's bug is currently invisible — nobody reads the wrong number yet.) | A mission-root summary line/chip in `missions.tsx`'s `MissionRows` header row or the mission-level card, once F1 is fixed. |
| **Which child is blocked, and why** | `MissionNode` (`missions.ts:37-66`) carries only the boolean `needsGuard` — no reason, no ask text, no `overBudget`/`monitoringWakeCapReached` flag. `guard.tsx:54-77`'s row renders role chip, title, mission name, age and an "Open" button — nothing about *why* it's there (consistent with F2: it can't say why, because it doesn't know). | A short reason chip on the Guard row and the mission table row (`guard.tsx`, `missions.tsx:275-279`), sourced from `unit.overBudget` / an ask summary / `monitoringWakeCapReached` — all either already on the wire or cheap to add. |
| **Branches left unmerged** | Spec §Q3: *"The parent merges the child branches it accepts (`git merge --no-ff cez/<id8>`) in its own worktree."* This is role-prompt / agent behaviour, not engine-tracked: grepped `packages/cezar/src` and `packages/web/src` for `merged` — the only hits are unrelated (usage-merging, git-status "unmerged path" parsing in `git-worktree.ts:362-369` for conflict detection, not merge-completion tracking). No `RunRecord`/`RunUnit` field records whether a child's branch actually landed in its parent's. | A "merged into parent" indicator per child row, computed by checking whether the child's branch tip is an ancestor of the parent's current branch (not currently done anywhere). |
| **Stopping or re-budgeting a running mission** | `run-header.tsx:308-310`/`1008-1011` has a per-run **Cancel**, reachable only by opening that exact run's own thread — no mission-wide stop button exists in `missions.tsx` or `guard.tsx` (their rows only link to `/tasks/:id`, e.g. `missions.tsx:267-272`, `guard.tsx:72-74`). Re-budgeting: grepped `packages/web/src` for `budgetUsd` — it is only *read* (`missions.ts`, `missions.tsx`, `new-mission.tsx` at creation time) and *set once* at mission creation (`new-mission.tsx:135-148`); no mutation anywhere edits an existing run's `budgetUsd`, and `units-section.tsx` (Settings → Units) has no budget-related field at all (grepped for `budget`/`Budget`/`cap`/`Cap`: one unrelated hit at `units-section.tsx:37`, a comment). Backend-side, `carveChildBudgets`'s only knobs are at spawn time (`run.ts:1713-1739`); nothing re-opens a settled envelope. | A "Stop mission" action on the mission root row (cascading cancel, which the backend already implements per spec §Q6) and a budget-edit affordance, both in `missions.tsx`. |
| **Any signal the mission has ended** | `MissionTree` (`missions.ts:68-84`) has no aggregate "settled"/"complete" field — only per-node `attention` (`missions.ts:44`). A caesar reaching `CEZ:DONE` shows as that one row's Pill turning green (`attention.ts:131-133`, label `"done"`), but `handleUnitMarkers` (`run.ts:1531-1567`) returns on `ctx.done` (`run.ts:1556`) with **no check against `inFlightChildren`** — nothing stops a commander from declaring done while children are still `running`/`waiting`. Rows default to expanded (`missions.tsx:227`) so a live child is visible today if the row is open, but nothing computed rolls "every node here is terminal" into one signal a human can scan for across missions. | A derived `tree.settled` (all nodes in `TERMINAL_STATUSES`, `engine.ts:42`) surfaced as a chip on the mission row, and ideally a guard against `CEZ:DONE` while children are still in flight. |

**F3 (severity: medium, scoping note for F1).** `totalBudgetUsd`/`totalCostUsd` are dead code
today — zero consumers in `packages/web/src/**/*.tsx` (verified by grep). This is why F1 has no
current user-visible symptom; it becomes one the moment either field is wired into a surface, which
is exactly what the "mission cost against budget" gap above calls for.

**F4 (severity: medium).** `guard.tsx:83-84`'s subtitle overpromises given F2 — *"the rows are the
mission tree's `needsGuard` nodes, and the approval itself happens in the thread, on the `CEZ:ASK`
card"* (`guard.tsx:17-21`) is false for W3/W4/W5 rows, which have no ask card to approve.

## Proposals

**P1 — Fix `totalBudgetUsd` to not double-count carved budgets.**
- *Problem:* F1. Summing every node's `budgetUsd` counts money twice whenever a child's ceiling
  came out of a parent that itself has one.
- *Concrete change:* in `buildMissionTrees` (`missions.ts:203-225`), change the budget reducer to
  only add a node's `budgetUsd` when it is genuinely new money: the root, or a node whose immediate
  parent has no `budgetUsd` (mirrors `remainingBudgetUsd`'s own rule, `engine.ts:67-72`, and
  `carveChildBudgets`'s "an uncapped parent carves nothing", `run.ts:1710-1711`). Concretely:
  `totalBudgetUsd = Σ_node budgetUsd(node) where node is root OR budgetUsd(parent(node)) === undefined`.
  This needs each node to know its parent's `budgetUsd` at fold time — cheapest done as a second
  pass over `nodes` keyed by `run.unit.parentRunId`, or threaded through `build()`'s recursion in
  `missions.ts:194-201`.
- *Default-path impact:* none — no route currently renders this field (F3), so the change is
  invisible until a consumer is added. It DOES change `missions.test.ts:187-199`'s expected value
  from `25` to `20` (the fixture's legate is carved from the caesar's budget) — that assertion must
  be updated as part of the fix, not left passing by accident.
- *Transitions / who fires them:* pure function, no new state.
- *Tests to pin:* (a) the $12/$3+$3 case from §1 → `totalBudgetUsd === 12`; (b) update
  `missions.test.ts:187-199`'s expectation to `20`; (c) an uncapped root with two independently
  budgeted children (`budgetUsd: 3` each, root's `budgetUsd` absent) → `totalBudgetUsd === 6` (the
  existing "don't under-report" case, still correct under the new rule); (d) a 3-level chain
  (root $20 capped → legate carved $5 → centurion carved $2, all carved) → `totalBudgetUsd === 20`.
- *Effort:* S. *Risk:* low — isolated pure-function change with existing test coverage to extend.

**P2 — Give the Guard a reason, using data already on the wire.**
- *Problem:* F2. `needsGuard`/the Guard inbox cannot tell a genuine ask (W1/W2) from a budget halt
  (W3) or an exhausted nudge cap (W4/W5), despite `run.unit.overBudget` already reaching the client
  unused (`packages/contract/src/units.ts:116`).
- *Concrete change:* add a `guardReason: 'ask' | 'overBudget' | 'other'` (name TBD) to
  `MissionNode`, derived in `nodeOf` (`missions.ts:86-109`) from `run.unit.overBudget` first, else
  `'ask'`/`'other'` as a coarser bucket until a real pending-ask flag exists (the code's own honest
  caveat at `missions.ts:58-62` — inventing a full ask/no-ask split needs a backend flag this audit
  did not find). Render it as a small label on `guard.tsx`'s row (next to age, `guard.tsx:69-71`)
  and `missions.tsx`'s status cell (`missions.tsx:275-279`). Keep `needsGuard` itself as
  `status === 'waiting'` — this is additive, not a behaviour change to what counts as guarded.
- *Default-path impact:* none for existing missions without a budget; over-budget missions get a
  visibly different (and honest) row instead of the current "needs you"/"question" framing.
- *Transitions / who fires them:* none new — `guardReason` is derived, same lifecycle as
  `needsGuard`.
- *Tests to pin:* extend `missions.test.ts` with a case where `unit.overBudget: true` and assert
  `guardReason === 'overBudget'`; a plain `CEZ:ASK` case still resolves `'ask'`/default.
- *Effort:* S. *Risk:* low.

**P3 — Flag the monitoring-wake-cap dead end.**
- *Problem:* F2b (W6). A run whose automatic wake-ups are exhausted (`monitoringWakeCapReached`,
  `run.ts:4290-4300`) never becomes `needsGuard`; it is invisible outside its own thread
  (`run-header.tsx:811-818`).
- *Concrete change:* in `nodeOf` (`missions.ts:86-109`), OR this into `needsGuard`:
  `needsGuard: run.status === 'waiting' || Boolean(run.monitoringWakeCapReached)`.
  `monitoringWakeCapReached` is already a top-level `RunRecord` field
  (`packages/contract/src/runs.ts:203`), so no new plumbing is required.
- *Default-path impact:* a currently-silent stuck run starts appearing in `/guard` and painting the
  violet banner (`missions.tsx:147-163`) — intended: this is exactly the class of run that needs a
  human, per this audit's own gap analysis.
- *Transitions / who fires them:* the run leaves this state the same way it does today — a human
  sends it a message (`deliverMessage`), which the backend already handles regardless of
  `monitoringWakeCapReached`; no new engine transition needed, only the read side changes.
- *Tests to pin:* a `MissionNode` fixture with `status: 'running', activity: 'monitoring',
  monitoringWakeCapReached: true` → `needsGuard === true`; `guardCount`/`guardQueue`
  (`missions.ts:242-257`) include it.
- *Effort:* S. *Risk:* low — additive OR on an existing boolean.

**P4 — Surface mission-level cost/budget, once P1 lands.**
- *Problem:* the "mission cost against budget" gap in §3 — `totalCostUsd`/`totalBudgetUsd` are
  computed and unused (F3).
- *Concrete change:* render `tree.totalCostUsd` / `tree.totalBudgetUsd` as a one-line summary on
  the mission root's row in `missions.tsx` (near `BudgetMeter`, `missions.tsx:283-285`), reusing
  `BudgetMeter`'s tone logic (`budgetTone`, `missions.ts:261-265`) against the mission totals rather
  than the node's own.
- *Default-path impact:* new visible text on every mission row that has a budget anywhere in its
  tree; none for missions with no budgets (`totalBudgetUsd` stays `undefined`,
  `missions.ts:217-219`).
- *Transitions:* none — read-only rendering of an existing derived value.
- *Tests to pin:* a `missions.tsx` render test asserting the mission-level text matches
  `tree.totalCostUsd`/`totalBudgetUsd` for a multi-node fixture.
- *Effort:* S–M (mostly UI). *Risk:* low, but **must ship after P1** — shipping this against the
  current arithmetic would make F1's bug user-visible instead of latent.

**P5 — Cascading "Stop mission" and a re-budget affordance.**
- *Problem:* the "stopping or re-budgeting a running mission" gap in §3 — only per-run Cancel
  exists (`run-header.tsx:308-310`), reachable one run at a time, and no UI or API mutation edits an
  existing run's `budgetUsd` after mission creation (`new-mission.tsx:135-148` is create-only).
- *Concrete change:* add a mission-root action in `missions.tsx` that calls `cancelRun` on the
  root — the backend's cascade-to-descendants behaviour is already specified (§Q6: "`cancel`
  cascades to descendants, depth-first, children first") and should be verified to exist server-side
  before wiring the button (out of this audit's scope — backend confirmation needed). Re-budgeting
  needs a new `PATCH` field for `unit.budgetUsd` on a running unit run, since none exists today.
- *Default-path impact:* new destructive/scope-widening action — this is exactly the kind of change
  that should get its own Guard-style confirmation, not a one-click cascade.
- *Transitions / who fires them:* human-initiated only; cascading cancel ends the mission
  (terminal); a budget increase clears `unit.overBudget` (needs the engine to actually reset that
  flag on the next turn once `costUsd < budgetUsd` again — not currently done anywhere in
  `run.ts`, since `overBudget` is only ever set `true`, never reset — this is itself a small gap to
  close as part of this proposal).
- *Tests to pin:* cascading cancel test (root cancel → every in-flight descendant transitions to
  `cancelled`); a re-budget mutation test asserting `unit.overBudget` clears once the new ceiling
  exceeds spend.
- *Effort:* M–L (new API surface + confirmation UX + the `overBudget` reset gap). *Risk:* medium —
  touches the cancel cascade and a currently one-way flag.

---

## What was verified how

- **Ran, not just read:** `cd packages/web && npx vitest run src/lib/missions.test.ts` at HEAD —
  **26 passed**, including `missions.test.ts:198` (`totalBudgetUsd === 25`, the pinned-wrong case
  cited in F1) and `missions.test.ts:234-235` (`needsGuard` roll-up, cited in F2).
- **Grepped, not assumed:** every "X is unused" / "X has zero hits" claim above (`overBudget` in
  `packages/web/src`; `totalBudgetUsd`/`totalCostUsd` outside `missions.ts`/`missions.test.ts`;
  `merged` across `packages/cezar/src`+`packages/web/src`; `budget`/`Budget`/`cap`/`Cap` in
  `units-section.tsx`) was a live `grep`/`rg` run against this worktree at HEAD, not inferred from
  memory.
- **Read at HEAD:** every `file:line` citation was opened and confirmed at commit
  `076cead2785891af80b9ea7440bf3be973c0bbfe` during this audit — none are carried over from the
  spec doc's own (older) line numbers.
- **Not verified (out of scope):** whether the backend's cancel cascade (§Q6) actually cascades
  depth-first as specced — cited from the spec doc's prose, not traced through
  `packages/cezar/src/workflows/run.ts`'s cancel path, since P5 is a proposal, not a finding.
