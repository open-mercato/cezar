# Units — communication & escalation audit: SUMMARY

> Audit of how units communicate in cezar's mission feature (Caesar → Legate → Centurion, spec
> `.ai/specs/2026-09-08-units-hierarchy.md`). Analysis only — nothing outside this directory was
> modified. All citations verified at HEAD `df73cfa9` unless noted.
>
> **Provenance.** Three centurions produced the detail files below; this summary was written by the
> legate directly, because the delegation budget was exhausted before a fourth centurion could be
> spawned (see F4 — the refusal is itself a finding). Two facts here (F5, F6) were established by
> the legate during the audit rather than by a centurion, and are marked as such.

| detail file | topic | ids |
|---|---|---|
| `01-downward-lateral-control.md` | downward envelope, lateral/scope, parent→child, `retry_limit` (Q1, Q3, Q5, Q6) | F-D1..F-D8, P-D1..P-D5 |
| `02-upward-reporting-delivery.md` | upward reports, waiting-child deadlock, delivery ladder (Q2, Q7) | F-U1..F-U7, P-U1..P-U5 |
| `03-escalation-ladder.md` | the `CEZ:ASK` bypass and the proposed ladder (Q4) | F-E1..F-E7, P-E1..P-E6 |

## Id mapping

| unified | source | unified | source |
|---|---|---|---|
| F1 | F-U2 (+F-E4) | F10 | F-D3 |
| F2 | F-U1 | F11 | F-D4 |
| F3 | F-E1 | F12 | F-D6 |
| F4 | *new (legate)* | F13 | F-D7 |
| F5 | *new (legate)* | F14 | F-U5 |
| F6 | *new (legate)* | F15 | F-E5 |
| F7 | F-E2 + F-U4 (merged) | F16 | F-E6 |
| F8 | F-E3 | F17 | F-D5 |
| F9 | F-D1, F-D2, F-D8 | F18 | F-U6, F-U7, F-E7 |

| unified | source | unified | source |
|---|---|---|---|
| P1 | P-U1 | P6 | P-U2 |
| P2 | *new (legate)* | P7 | P-D3 |
| P3 | P-D1 | P8 | P-D4 |
| P4 | P-E3 + P-E4 + P-U4 | P9 | P-D5 |
| P5 | P-E1 + P-E2 + P-E5 | P10 | P-D2, P-E6, P-U3, P-U5 |

---

## Findings

### High

**F1 — The autonomous nudge does not exist in one of the two turn-end handlers, so every child parks after its first incomplete turn.**
`AUTONOMOUS_NUDGE` (`run.ts:314`) has exactly one use site, `run.ts:3010`, inside `runContinuation`
(declared `run.ts:2810`, ending before `execute` at `run.ts:3240`). `runAgentStep` (declared
`run.ts:3548`) and its turn-end block (`run.ts:3676-3757`) have none. Every unit child is a fresh
single-step run whose **first** turn goes through `runAgentStep`, so any first turn not ending in a
marker parks at `waiting` with no nudge at all.
*Why it matters:* this is the single biggest amplifier of every other upward-reporting gap — it makes
F2 reachable without the child ever asking anything. Fixed on an unmerged branch (`b5f0b316`,
`fix/autonomous-nudge-reachability`), not on this one.
*Conflict, resolved:* `02` and `03` disagreed on which handler holds the nudge. The legate verified
the declaration offsets directly (above); `02` is correct, `03`'s F-E4 has the two handlers inverted.
`03`'s F-E4 conclusion — that the guarantee is expressed through different code shapes in the two
sites and must be re-verified against both — still stands.

**F2 — A child parked on `CEZ:ASK` is invisible to its parent and still consumes a slot.**
Park at `run.ts:3035-3036` / `run.ts:3737-3738`; `TERMINAL_STATUSES` excludes `waiting`
(`engine.ts:42`) so the report gate `run.ts:1762` returns early; `IN_FLIGHT_STATUSES` **includes**
`waiting` (`engine.ts:37`) so the spawn cap at `run.ts:1627` still counts it.
*Why it matters:* one unnoticed Guard question silently removes a quarter of a commander's fan-out
(`MAX_CHILDREN_IN_FLIGHT = 4`, `engine.ts:29`), and the commander cannot tell which child is stuck,
or that any is. **Answer to the task's question: a waiting child does NOT notify its parent.**

**F3 — `CEZ:ASK` bypasses the tree entirely; every rank pages the human.**
Guard-inbox membership is `needsGuard: run.status === 'waiting'`
(`packages/web/src/lib/missions.ts:106`) over a whole-tree walk (`missions.ts:242-252`). No code
path reads `unit.parentRunId` when an ask fires — contrast `reportSettledChildToParent`, which does
(`run.ts:1759`).
*Why it matters:* an army-sized mission pages a human at the same per-agent rate as a flat run, which
is worse than not having a hierarchy.

**F4 — A parent's delegation budget is permanently consumed by reservations, never released when a child underspends.** *(legate)*
`remainingBudgetUsd` (`engine.ts:67-72`) computes `budget − parent.costUsd − Σ children.budgetUsd`
over `childrenOf(...)` (`engine.ts:49-51`), which returns **all** children regardless of status. A
settled child's unspent reservation is never reclaimed, and `carveChildBudgets` refuses at
`run.ts:1720-1724` once the remainder is ≤ 0.
*Evidence — observed live in this run:* budget `$12.00`, own `costUsd` `$9.008`, three children
reserved `$2.50` each (`$7.50`) but actually spent `$1.60 + $2.14 + $1.73 = $5.47`. Remaining
computes to `12 − 9.008 − 7.5 = −4.5`, so both attempts to spawn the SUMMARY centurion were refused,
even though `$2.03` of the reservations had never been spent.
*Why it matters:* a long mission loses delegation capacity monotonically as it delegates, regardless
of what its children actually cost. The refusal text tells the commander to "report what has been
achieved instead of shrinking the remaining work" — sound advice, but it fires while real budget
remains. This is exactly how this audit lost its final centurion.
*Caveat:* whether `parent.costUsd` also rolls up descendants was not established; no rollup code was
found, so it appears to be the run's own spend. Either reading yields the same refusal here.

**F5 — Worktree and branch isolation are unenforced; a child can write to the user's checkout and commit to a shared branch.** *(legate, empirical)*
Demonstrated during this audit: centurion `1477f47a`, scoped to one file in its own worktree, instead
wrote and committed into the user's **main checkout** on the shared branch `feat/units-mvp` (commit
`9704bc31`), while its assigned branch `cez/1477f47a` stayed empty at the fork point. Nothing
detected or prevented it; the run reported `done` and its report claimed the wrong branch. Nothing in
`spawnChildren` (`run.ts:1607-1699`) constrains where a child writes — the worktree is a *starting*
cwd, not a boundary.
*Why it matters:* this is F12 (`scope` is prose) escalated to its worst case. A commander's merge
step assumes each child's work is on its own branch; a child that commits elsewhere silently breaks
the parent's accept/reject/merge protocol and can move a branch a human owns. Per the user's
decision, commit `9704bc31` was left in place.

**F6 — An in-flight child lost to a process restart reports nothing; the parent must discover the loss by hand.** *(legate, empirical)*
The cezar process restarted mid-audit. The SUMMARY centurion vanished leaving no branch, no commit
and no report; `runs.json` shows only three children under this run. The legate found out only by
searching every branch for the expected file. Ties directly to F7: `recover()` handles runs that
*exist* at restart, but a spawn that never materialised leaves the parent monitoring a child that was
never recorded.
*Why it matters:* the parent's only signal that a child exists is the spawn note in its own
transcript. Nothing reconciles "children I believe I spawned" against "children in the store."

**F7 — Restart settles a `waiting` run as `done` and reports that upward as success.**
`recover()`'s `waiting` branch (`run.ts:1328-1344`) calls `settleSuccess` unconditionally, which
resolves to `done` for any autonomous run (`run.ts:4159`) — every unit run. The synthesized report
(`engine.ts:141-146`, `157-189`) then tells the parent `status done`. Pinned as current behaviour by
`recover-unit.test.ts:136-167`, which seeds no `ask.requested` event, so the Guard interaction is
untested.
*Why it matters:* a restart at the wrong moment converts "I stopped and asked before doing something
irreversible" into a clean `done` that no human ever answered — defeating the Guard's entire premise.

**F8 — A pending ask has no persisted representation.**
`emitAskRequested` (`run.ts:173-177`) mints an SSE `ask.requested` event with no twin on `RunRecord`
or `unitSchema` (`packages/contract/src/units.ts:101-117`).
*Why it matters:* combined with F7, a pending question is invisible to anything reading only the
record — a recovered process, a script, a cockpit tab that missed the event. Any ladder design needs
durable state to branch on.

**F9 — The downward envelope carries no mission context, no siblings, and no way to intervene later.**
`childTaskEnvelope` (`engine.ts:88-101`) emits only the child's own objective plus scope /
`allowed_tools` / `max_cost` / `success_criteria` / `required_evidence` / `retry_limit` and the
immediate parent's branch, id and role. It never reads `unit.missionId`, the mission root's `task`
(which already exists as one string, `server.ts:3476-3479`), the sibling batch, or the parent's
`pendingReports`. It is called once per child inside `spawn.children.forEach`
(`run.ts:1642-1691`) with only that one child. And once spawned, the only channels reaching a
running child are the human-only HTTP routes `POST /runs/:id/messages` (`server.ts:3831`) and
`POST /runs/:id/cancel` (`server.ts:3821`) — `handleUnitMarkers` (`run.ts:1531-1567`) gives a
commander no marker to message, re-scope or stop a child.
*Why it matters:* the mission objective reaches the agent that touches files via two lossy prose
rewrites with nothing checking for drift; siblings cannot see each other's scopes even though the
prompt calls a scope collision "the one failure mode this design cannot recover from"
(`prompts.ts:52`); and the process most likely to notice a child going wrong early — the parent,
reading reports — cannot act until the spend is sunk.

### Medium

**F10 — Prior siblings' findings are never passed to later children.** `unit.pendingReports`
(`contract/src/units.ts:86-95`) accumulates on the parent and is flushed only into the *parent's* own
prompt (`run.ts:1489-1496`, `engine.ts:202-211`); no part of it reaches a new child's envelope. The
prompt's own advice — "respawn with what you learned added to the objective" (`prompts.ts:103,132`) —
is advisory prose over structured data discarded at the one moment reusing it would be free.

**F11 — Branch topology is one level deep.** The envelope prints only the immediate parent's branch
and role (`engine.ts:99-100`); `unit.missionId` (`contract/src/units.ts:105`) never appears. Once the
spawning legate settles, multi-level provenance is unrecoverable from the envelope text.

**F12 — `scope` is enforced nowhere and is not even persisted.** Read in exactly two places:
`engine.ts:93` (printed into the envelope) and `prompts.ts:52` (prose). The child's persisted `unit`
literal (`run.ts:1672-1678`) carries `role`, `missionId`, `parentRunId`, `budgetUsd`, `ladder` — not
`scope`, so it cannot even be checked after the fact. See F5 for the worst case.

**F13 — `retry_limit` is read once, to print it.** `engine.ts:98` is the only production read in the
repo (schema at `contract/src/units.ts:144`; all other occurrences are prompts or fixtures). No
lineage field links a respawn to the attempt it replaces, so nothing could count retries even if it
wanted to. A commander can respawn the same failing piece indefinitely, bounded only by the budget
brake.

**F14 — Reports past `MAX_PENDING_REPORTS` are silently dropped.** `withPendingReport`
(`engine.ts:191-195`) slices to the newest 20 (`engine.ts:34`) with no note, event or counter;
pinned as intended in `engine.test.ts:172-178` ("the three oldest fell off").

**F15 — The Guard inbox cannot distinguish "waiting on a human" from any other waiting.**
`missions.ts:106`; the module's own comment admits the coincidence (`missions.ts:58-62`). Any ladder
that keeps an escalating child at `waiting` will re-flood the inbox with internal chatter unless this
filter changes first.

**F16 — Role prompts are the only surface teaching the markers.** `prompts.ts:7-10`, with
`GUARD_RULE` composed identically into all three roles (`prompts.ts:111,138,162`). A new marker
without a prompt change is unreachable by any model — the concrete form of "a replacement that ships
OFF is not a replacement."

**F17 — Mission-specific decisions never written to the repo are invisible to children.** Children
fork the full repo (`run.ts:1688`) so `AGENTS.md` is readable and correctly not restated; what is
lost is an ad-hoc planning decision that lives only in the parent's transcript.

### Low

**F18 — The channel has no failure signal anywhere.** Three instances: the ack fires the instant
`deliverMessage`/`enqueueMessage` return true (`run.ts:1812-1813`), a JS-level success rather than a
durability guarantee; the whole settle path is wrapped in a silent `catch` (`run.ts:1757`,
`1823-1826`) whose premise holds only after the pending write at `run.ts:1775-1777`; and
`autoContinues`/`monitoringWakeups` are in-memory only (`run.ts:264,276`), resetting on restart. No
mid-flight progress channel exists at all — `grep parentRunId` returns only `run.ts`, `engine.ts` and
their tests; a `CEZ:REPORT` is stored on the child's own record (`run.ts:1546-1554`) but nothing
delivers it until settle. The spec accepts that last one as scope.

**Wake-nudge count — the task's second explicit question.** A parked commander receives
`MONITORING_WAKE_NUDGE` (`run.ts:316-317`) up to `MAX_AUTO_CONTINUES = 40` times (`run.ts:313`,
bounded twice in `armMonitoringWakeTimer` at `run.ts:4290` and `run.ts:4312`), at the zero-config
default of 5 minutes (`workspace/config.ts:77`) — **~40 full-context turns over ~3h20m, carrying no
new information**, each one re-reading the commander's entire accumulated session. Recorded as F-U3
in `02` at medium-high; it is a pure cost tail with no functional payoff whenever F1/F2 are the
reason nothing has changed.

---

## Proposals

Ranked by value over effort across all three topics.

### P1 — Rebase onto the existing autonomous-nudge fix and re-thread the Guard exception
**Fixes F1 · Effort S · Risk Low**
Merge `b5f0b316` (`fix/autonomous-nudge-reachability`, already authored and tested), then express the
units Guard condition (`!(unitTurn.hasUnit && Boolean(ask))`) once inside the shared
`tryAutonomousNudge` helper that commit introduces, rather than per call site.
*Default path:* this changes behaviour for **every** `#autonomous` run, not just units — `runAgentStep`
goes from silently parking to nudging. Call that out explicitly; it is a default-path change outside
the `CEZ_UNITS` gate. For unit runs the shipped default is unchanged in intent, only reachable.
*Transitions:* adds none; restores a missing one.
*Tests:* carry over `autonomous-nudge.test.ts`; extend `units-engine.test.ts:474-522` to drive the ask
through a child's **first** turn (`runAgentStep`) — today's `askOnContinue` helper exercises only
`runContinuation`, so the Guard is green either way.

### P2 — Release a settled child's unspent budget reservation *(new)*
**Fixes F4 · Effort S · Risk Low**
In `remainingBudgetUsd` (`engine.ts:67-72`), count a **settled** child at its actual `costUsd` and
only an **in-flight** child at its full `budgetUsd`:
`promised = Σ(inFlight: budgetUsd) + Σ(settled: costUsd ?? budgetUsd)`.
*Default path:* strictly loosens an existing refusal — no mission that can spawn today stops being
able to. Uncapped parents (`budgetUsd === undefined`) still return `undefined` and are untouched.
*Transitions:* none; pure arithmetic on data already read.
*Tests:* a parent whose settled children underspent can spawn again for the difference; an
in-flight child still reserves its full cap; a settled child with no recorded cost falls back to its
reservation (never frees budget it cannot prove); the uncapped-parent path is unchanged.
*Open:* confirm whether `parent.costUsd` rolls up descendants — if it does, this fix must avoid
double-counting settled children.

### P3 — An engine-composed downward envelope: mission, siblings, prior findings
**Fixes F9 (partly), F10, F11, F17 · Effort S · Risk Low**
Extend `childTaskEnvelope` with data already in scope at its single call site (`run.ts:1660`), plus
one store read per spawn (`store.getRun(unit.missionId)`): a `## Mission` block (id, objective, root
branch when it differs), a `## Siblings spawned with you` block (title + scope of the *other* children
in the batch), and a `## What your commander already learned` block (≤3 newest settled reports).
*Default path:* no knob; applies to every spawn on ship. A Squad (lone centurion) never reaches
`spawnChildren` (`engine.ts:24`), so it is a no-op there exactly as today.
*Transitions:* none — pure text composition.
*Tests:* mission block present for a rank-2+ child; sibling lines never include the child itself; the
learned block bounded at 3 and newest-first; a two-wave spawn where wave 2's envelope contains wave
1's result. Bound every block the way `MAX_PENDING_REPORTS` bounds reports.

### P4 — Persist the pending question, and stop force-settling it on restart
**Fixes F7, F8; prerequisite for P5 · Effort M · Risk Medium**
Add `unit.pendingAsk?: { requestId, questions, askedAt, rounds }` to `unitSchema` **and its
persistence twin in `runs/store.ts` in the same commit** (the parity AGENTS.md names for this exact
field). Write it beside `emitAskRequested` at both sites (`run.ts:3025`, `run.ts:3727`). Then narrow
`recover()`'s `waiting` branch (`run.ts:1328-1344`) to check for it **only when `run.unit` is set**:
if present, re-park with a note instead of settling, or (option b) still settle but report
`status: 'blocked'` naming the unanswered question rather than `done`.
*Default path:* zero change for any run without `unit`, and for unit runs with no open question — the
carve-out is gated twice. This is the "changing a mechanism that already works" case; scope it
strictly and add a test proving an ordinary `waiting` run's restart is untouched.
*Transitions out of the new state:* `pendingAsk` cleared when an answer is delivered
(`deliverMessage`'s success path already fires a store update), when the run settles, or on cancel
cascade (`run.ts:1837-1845`).
*Tests:* `recover-unit.test.ts` case seeding an unanswered `ask.requested` — assert the run does not
report `done`; assert a non-unit `waiting` run still settles exactly as `recover-unit.test.ts:136-167`
pins today.

### P5 — The ladder proper: `CEZ:ESCALATE` / `CEZ:ANSWER`, one rank at a time
**Fixes F3, F15, F16 · Effort L · Risk Medium**
New unit-only marker pair parsed by `units/markers.ts` through the existing shared `parseMarker`
helper (`markers.ts:62-89`) — deliberately **not** an extension of `ask.ts`, which is shared non-unit
infrastructure carrying no notion of rank. Schema (`contract/src/units.ts`, `.strict()` like
`unitSpawnSchema`):
`{ requestId?, irreversible: boolean, financial: boolean, questions: askQuestion[1..4] }`.
Routing: deliver one hop to `unit.parentRunId` through the **same three routes**
`reportSettledChildToParent` already uses (`deliverMessage` → `enqueueMessage` → `deferMessage`),
skipping a dead ancestor upward; a question reaches the human only when `irreversible || financial`
is true at Caesar, or when the round cap trips, or when no live ancestor remains. Answers travel back
down the same cascade, fired synchronously from the parent's own turn-end on a valid `CEZ:ANSWER`.
Narrow the Guard filter (`missions.ts:106`) to exclude "waiting on a live ancestor" in the **same
change**, or the ladder ships as a no-op that re-floods the inbox (F15).
**Update `CENTURION_PROMPT`/`LEGATE_PROMPT` in the same commit** — without it no model ever emits the
marker and the ladder is dead on the default path (F16).
*Default path:* until the prompt lands, nothing emits it and behaviour is byte-for-byte unchanged;
after it lands, `CEZ:ASK` still works from any rank and still reaches the human, so the escape hatch
never closes.
*Transitions:* every new edge is one of the eight wake sources enumerated in `03` §4.3 — all
turn-end-synchronous, no new timer, webhook or process-exit callback. `escalated-waiting` exits on
answer delivered, re-escalation under cap, cap trip → human, or cancel cascade.
*Tests:* a centurion's escalation reaches its legate and not `/guard`; an `irreversible` one at Caesar
reaches the human; a dead intermediate rank is skipped; the round cap terminates; a restart with an
open escalation re-delivers rather than settling (P4).
*Sequencing:* P4 must land first — the ladder needs durable state to survive a restart.

### P6 — A live "child is blocked" notice to the parent
**Fixes F2 · Effort M · Risk Low-Medium**
Add `unit.blockedChildren?: { fromRunId, title, askedAt }[]` (bounded like `pendingReports`), appended
on the exact edge where `ask` becomes true for a unit child (beside `emitAskRequested`,
`run.ts:3025`/`3727`), and route one line of prose to the parent through the report delivery ladder —
**extracted into one shared helper** so the two paths cannot drift. No `continueRun` rung: a blocked
notice must never resurrect a settled or cancelled parent.
*Default path:* strictly additive; fires only on an edge existing code already computes. No knob.
*Transitions:* entry created once per ask (idempotent); removed when the child's status leaves
`waiting` for any reason — answered, settled, or cancelled.
*Tests:* a monitoring parent gets the notice immediately; a closed-session parent gets a durable entry
flushed into its next prompt; the entry clears on unblock; no duplicate on a later still-blocked turn.
*Note:* largely subsumed by P5 if the ladder ships — build it only if P5 is deferred.

### P7 — Warn on scope overlap at spawn time
**Fixes F12 (partly) · Effort M · Risk Medium**
In `spawnChildren` before creating anything, compare each pair of `scope` strings in the batch plus
those of in-flight siblings (`engine.ts:54-56`) by exact match or true `/`-segment prefix (never raw
string prefix). On a hit, append a `danger` note naming both children — **the spawn still proceeds**.
*Default path:* the check runs always but only *acts* on a collision, so a mission with correct
disjoint scopes sees nothing change. A hard refusal is deliberately not proposed: false positives
would strand legitimate missions, and shipping a bypass flag to fix that trades a working default for
a knob.
*Transitions:* none — one extra note on an existing turn-end.
*Tests:* identical scopes → one note, both spawn; segment-prefix overlap with an earlier in-flight
sibling → note; disjoint scopes → no note (false-positive guard).

### P8 — `CEZ:DIRECT`: message, re-scope or stop a running child
**Fixes F9 (the intervention half) · Effort M · Risk Medium**
`CEZ:DIRECT {"child":"<runId>","action":"message"|"rescope"|"stop","text":"…"}`, parsed in
`handleUnitMarkers` and acted on before the `ctx.done` return (`run.ts:1556`). Orthogonal to the
existing precedence — it never sets `spawned`/`overBudget` so it cannot flip the parent's own park
decision. `stop` reuses `cancel` (`run.ts:2246`); `message`/`rescope` reuse `sendMessage`
(`run.ts:2582`) — the same methods the human routes already call. Refused against a child that is not
in `IN_FLIGHT_STATUSES`, protecting the review gate.
*Default path:* inert until the prompts teach it, exactly like P5.
*Transitions:* adds none — a third caller of two already-tested public methods.
*Tests:* message delivered without disturbing the parent's park; `stop` cascades; a settled child is
refused; a non-child run id is refused; `CEZ:DIRECT` + `CEZ:SPAWN` in one turn both take effect.

### P9 — Lineage-tracked retries: actually enforce `retry_limit`
**Fixes F13 · Effort M-L · Risk Medium**
Add `retry_of` to the spawn child schema and persisted `retryLimit`/`retryCount`/`retryOf` to
`unitSchema` — **with the `runs/store.ts` twin in the same commit**. `spawnChildren` resolves
`retry_of` to a settled child of the same parent, increments the inherited count, and refuses past the
inherited limit (a retry can never raise its own ceiling).
*Default path:* a parent that never names `retry_of` behaves exactly as today — this is an opt-in
reinforcement, inert until the prompt teaches it.
*Transitions:* plain data, read only at a future spawn; no timer, no park.
*Tests:* `retry_of` naming an unrelated run → refused; a chain exceeding the limit → the (limit+1)th
refused with the count in the note; inherited limit wins over a retry's own; a normal spawn is
unaffected.

### P10 — Smaller items worth keeping
**Effort S each · Risk Low**
- **Surface dropped reports** (F14): return a `droppedCount` from `withPendingReport` and say
  "…and N earlier reports were dropped (cap: 20)" in `pendingReportsBlock`; note once per turn, using
  the existing budget-brake note-once pattern (`run.ts:1585-1591`). Extend `engine.test.ts:172-178`.
- **A per-mission scope ledger** (F12): rewrite `.ai/cezar/runs/<missionId>/scopes.md` atomically on
  every spawn and settle; advisory, readable by any child's own tools. Written state, never required.
- **Reconcile spawned-vs-recorded children** (F6): at `recover()`, compare the children a parent's
  record implies against the store, and deliver a synthetic `blocked` report for any that vanished.
- **Enforce worktree isolation** (F5): at minimum, have a child's settle compare its recorded
  `branch` against the branch its commits actually landed on, and report a mismatch rather than a
  clean `done`.
- **Unit-aware wake backoff** (F18 / wake-nudge count): grow the interval geometrically while no
  child has settled, keeping the same total cap. **Deferred deliberately** — `armMonitoringWakeTimer`
  is exactly the mechanism AGENTS.md's worked example is about; it deserves its own audit of every
  consumer first, not a drive-by change bundled into this work.

---

## Open questions for the user

1. **P1's blast radius.** Rebasing `b5f0b316` changes every `#autonomous` run in the repo, not just
   units. Land it on `main` first and rebase the units branch past it, or fold it into the units work?
2. **P4 option (a) vs (b).** On restart with an unanswered question: leave the run at `waiting` (more
   honest, but it looks stuck until someone visits `/guard`), or settle it while reporting `blocked`
   (smaller change, but the process ends without the human ever answering)?
3. **Should the engine refuse a non-Caesar `CEZ:ASK` once the ladder ships?** P5 makes `CEZ:ASK`
   Caesar-only by prompt convention, not enforcement — a centurion can still page the human directly.
   Keep that as a permanent escape hatch, or refuse it with a transcript note?
4. **Escalation round cap.** Is 3 round-trips right, or should it scale with rank distance (a
   legate↔Caesar hop costs more than centurion↔legate, since the middle rank burns budget deciding)?
5. **Does `parent.costUsd` roll up descendants?** P2's arithmetic depends on the answer; no rollup
   code was found, but this should be confirmed before changing the budget calculation.
6. **`MAX_PENDING_REPORTS = 20`** — keep as a constant and just make drops visible (P10), consistent
   with "never trade a working default for a knob", or make it configurable for army-sized missions?
7. **`rescope` as its own action?** In P8 it is `message` with a prefix; keep it labelled for
   transcript legibility, or drop the third enum value?
8. **Should `retry_of` (P9) and `CEZ:DIRECT` (P8) ship with their prompt changes in the same PR**, so
   they are load-bearing from day one, or land the engine work first and the prompts separately?
