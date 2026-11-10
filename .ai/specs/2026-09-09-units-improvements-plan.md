# Units improvements — implementation plan

> **Superseded (2026-09-10):** the missions/units feature was removed and replaced by task dispatch — see `2026-09-10-dispatch.md` and `units-research/00-verdict.md`. Kept for the record.


> Slug: `units-improvements-plan` · Status: proposed

## TLDR

The units audit (`.ai/specs/units-improvements/00-SUMMARY.md`, R1-R28, D1-D7) found that no rank
in the Caesar → Legate → Centurion hierarchy fully owns the mission's final goal today, for two
compounding reasons: the downward envelope is too narrow for a child to be *accountable* to the
goal rather than a paraphrase of it, and the engine's own turn-end/marker/budget/restart
machinery has live, reproducible defects that can silently convert honest work into a false
`done` or starve a mission of budget it still has. This plan sequences the fix into **four
missions, in order** — `run.ts` and `engine.ts` are shared load-bearing files for nearly every
finding, so "disjoint" below means disjoint *functions*, not disjoint *files*; land these
worktrees one at a time, not in parallel, or risk exactly the silent merge collision R2/D7 already
caught this audit doing once.

**Mission 1 — the ladder can delegate at all.** Fixes the marker-parsing death spiral (R1/D1-D4)
that refuses a by-the-book spawn as invalid JSON and idles the run to a false `done`; makes the
autonomous nudge reachable on a unit's first turn (R10); stops restart from lying about an
unanswered question (R9/D6); persists the pending ask (R16); rewrites the two commander prompts so
they stop contradicting themselves about merging and editing (R4, F1/F3 of `02-roles/SUMMARY.md`).
No dependency — land first, because nothing else can be trusted to work until the transcript and
the report actually reflect what happened.

**Mission 2 — the Legate can finish and answer.** Releases a settled child's unspent budget back to
its parent (R3), gives an over-budget mission a path back to autonomous operation (R21), fixes the
cockpit's budget double-count (R17), and teaches the Guard inbox to tell a genuine question apart
from a budget halt or an exhausted wake cap (R5). It also builds the escalation ladder proper —
`CEZ:ESCALATE`/`CEZ:ANSWER`, routed one rank at a time, reaching a human only when the question is
irreversible or financial or the round cap trips (R12) — and the live "child is blocked" notice that
tells a commander which of its children is stuck (R11). Depends on Mission 1 (shares
`enforceUnitBudget`'s turn-end call site, and the ladder needs Mission 1's persisted `pendingAsk` to
survive a restart).

**Mission 3 — the Legate knows and steers.** Gives every child an engine-composed envelope (mission
brief, siblings, newest reports — R13); adds a marker to message, re-scope or stop a running child;
enforces `retry_limit` with lineage tracking (R15); warns on scope overlap (R22); enforces worktree
isolation at settle time (R2, this mission's own worst-case empirical failure); lets a mission root
reach the `review` gate and nudges toward its one draft PR (R6, R7); adds the missions `GET`/cancel
routes (R24) and the mission-scoped concurrency limit the user's decision #2 calls for. Depends on
Mission 2 (shares `spawnChildren` and `engine.ts`'s other exported functions).

**Mission 4 — verification and defaults.** Introduces the Review Centurion rank the user's decision
#3 calls for — a dedicated verification step that re-reads a child's diff and evidence before its
parent accepts, roughly doubling the cost of a reviewed piece of work by design; splits a child's
report into what it *claims* versus what the engine *observes* (R14); ships per-role ladder
defaults as composer pre-fill only, per the user's decision; documents and, where practical,
restricts the scope brake on codex/opencode (R8). Depends on Mission 3 (the review step reads the
envelope and settle machinery Mission 3 finishes wiring).

Every citation below was verified against this worktree's HEAD (`4d2b80d1`) while writing this
plan: `git grep` for every named function and constant in `packages/cezar/src/units/`,
`packages/cezar/src/workflows/run.ts`, `packages/cezar/src/server/server.ts`,
`packages/contract/src/units.ts` and `packages/web/src/lib/missions.ts`. Line numbers drift a
little from the audit's own citations (the audits ran at `df73cfa9`/`8ed75a05`, this plan at
`4d2b80d1`, all three units-focused source directories unchanged in between) — every function and
constant named here was re-confirmed to exist, and drift is noted where it changes a proposal's
shape.

## Resolved assumptions

| # | Decision | Applied default | Why |
|---|---|---|---|
| D1 | The Legate rank | **Stays.** The organising goal of every mission is a Legate that works autonomously end to end — not a leaner Caesar→Centurion tree. `00-SUMMARY.md`'s open question 9 (a Legate-less `unitSizeSchema` size) is answered **no**; `02-roles/SUMMARY.md` F10's real complaint (no concurrency payoff at `maxParallel=2`) is answered by D2, not by removing the rank. | A shallower tree trades away exactly the mid-tier judgement (`02-roles/SUMMARY.md` P5's table: Legate = "a mistake is contained to one branch of the tree") the hierarchy exists for. |
| D2 | Concurrency | A **mission-scoped** parallel limit: a new optional field on the mission record and composer (not the global `resources.maxParallel` knob, `config.ts:36`). Default equals today's global `maxParallel` (2), so a mission that never sets it is byte-for-byte unchanged. The composer pre-fills **4** for an `army` mission only. | Answers `00-SUMMARY.md` open question 9(c) without its stated blast radius — raising the *global* semaphore would widen concurrency for every project sharing it, not just missions that want it. |
| D3 | Verification | A **Review Centurion** rank/step that re-reads a child's diff and evidence before the parent accepts — not engine-run `verify_commands`. Roughly doubles the cost of a reviewed piece of work; accepted as the price of not trusting a child's own honesty about its own work. Answers `00-SUMMARY.md` open question 11 with option (4) from `02-roles/SUMMARY.md` P9's own ranked list, not its top pick (1). | A dedicated, independent rank cannot be fooled the way a child re-running its own claimed command can; the audit itself ranked (4) "best independent verification" and only deprioritized it for cost, which this decision accepts paying. |
| D4 | Ladder defaults (Caesar's recommendation, adopted) | Per-role model defaults (`02-roles/SUMMARY.md` P5) ship as **composer pre-fill only**, never as an engine default-path change. An API-started, zero-config mission still gets one model across all three ranks, exactly as today. | Shipping it as a real default changes what every existing zero-config mission does (`00-SUMMARY.md` open question 10's stated risk); pre-fill gets the UX benefit with zero blast radius on anything that doesn't go through the composer. |
| D5 | The `CEZ:ASK` escape hatch (Caesar's recommendation, adopted) | Stays a **permanent** escape hatch at every rank, even after Mission 2 adds the `CEZ:ESCALATE`/`CEZ:ANSWER` ladder, Mission 3 adds `CEZ:DIRECT` and Mission 4 adds the Review Centurion. The engine never refuses a non-Caesar `CEZ:ASK`. Answers `00-SUMMARY.md` open question 3: no rank is ever refused a direct page to the human. | An escalation or verification mechanism that can itself get stuck must not be the only way out; `CEZ:ASK` is the one path that always reaches a human because it needs no other rank's cooperation. |

Two further scoping notes, not user decisions but load-bearing for what follows:

- **`00-SUMMARY.md`'s open question 2** ("leave `waiting`, or settle reporting `blocked`?") is
  answered inside Mission 1's own work list: *settle, but report `blocked`* — see Mission 1, work
  item 4. This is the exact task-order wording ("restart reports a waiting unit run as blocked
  instead of settling done"), so it is applied here as a resolved design choice, not left open.
- **`00-SUMMARY.md`'s open question 1** (does rebasing the autonomous-nudge fix belong on `main`
  first?) is answered by repository state, not by asking again: the fix already exists, authored
  and tested, on branch `fix/autonomous-nudge-reachability` (commits `b5f0b316` + `c8dc7cef`,
  confirmed present in this worktree's history but **not yet merged** to `origin/main`, still at
  `e8c95f3a`). Mission 1's work item 3 depends on landing that branch on `main` first, then
  rebasing this units branch past it — see Mission 1's Dependencies.

---

## Mission 1 — the ladder can delegate at all

**No dependency; land first.**

### Goal

Make the engine's own turn-end, marker-parsing and restart machinery trustworthy enough that a
spawn that should succeed does succeed, a refusal is recoverable instead of silently fatal, a unit
child's first turn actually uses autonomous mode, and a restart never reports an unanswered
question as clean success. Fix the two commander prompts' self-contradictions in the same pass,
since they live in the same file already in scope.

### Work items

**1. Anchor marker parsing on the LAST keyword occurrence, tolerant of a trailing monitoring line.**
*Source: `00-SUMMARY.md` R1 (= D1-D4, this mission's own empirical finding).*
`SPAWN_MARKER_CANDIDATE_RE`/`REPORT_MARKER_CANDIDATE_RE` (`packages/cezar/src/units/markers.ts:35-36`,
confirmed verbatim: `/CEZ:SPAWN[ \t]+([\s\S]*)$/` and its `REPORT` twin) are non-global regexes fed
through `.exec()` inside `parseMarker` (`markers.ts:62`), which finds the **first** match in the
turn and captures everything after it to end-of-text. Two failure shapes follow: (a) the prompt
orders a trailing `CEZ:MONITORING` line in the *same* turn as `CEZ:SPAWN` (`prompts.ts:99` Caesar,
`:130` Legate — confirmed both still order this), so the by-the-book marker's own JSON gets the
monitoring line appended to its tail and fails `JSON.parse`; (b) an earlier prose mention of the
keyword (a model narrating its plan) anchors the candidate regex there instead of the real marker
line. Fix: change `parseMarker`'s search to the **last** match (`[...text.matchAll(candidateRe)].at(-1)`
in place of `.exec()`, candidate regexes made global — `g` flag), and, independently, strip a
trailing `CEZ:MONITORING`/`CEZ:DONE` line from the captured JSON candidate before parse (mirroring
`closeUnbalancedJson`'s existing repair step at `markers.ts:74`) so a same-turn monitoring
follow-through never gets swallowed into the payload even if the model puts the marker last anyway.

**2. Deliver a marker refusal note back into the child's own session, with a re-prompt.**
*Source: `00-SUMMARY.md` D4 (partially — the refusal note itself already exists; only its delivery
is missing).*
`unitMarkerRejection` (`run.ts:164`) already builds refusal text; `handleUnitMarkers`
(`run.ts:1531`) already calls `note(unitMarkerRejection(...), 'danger')` at both the `CEZ:REPORT`
(`run.ts:1553`) and `CEZ:SPAWN` (`run.ts:1563`) sites — but `note` only calls
`this.store.appendEvent`, a transcript write with no path back into the model. `handleUnitMarkers`
already receives `ctx.state: ActiveRun` (`run.ts:1534`), the same shape `tryAutonomousNudge` (item
3 below) uses to call `state.session?.sendMessage(...)`. Fix: on a rejection, in addition to the
transcript note, call `ctx.state.session?.sendMessage([{ type: 'text', text: rejectionRePrompt }])`
where `rejectionRePrompt` restates the parse error and asks the agent to re-emit a corrected marker
before ending its turn — the same delivery primitive the autonomous nudge already uses, so no new
plumbing. Guard it exactly like the nudge: only when the session is still open (`sendMessage`
already returns `false` on a closed one) and only once per rejection, not once per malformed retry
loop.

**3. Make the autonomous nudge reachable on a unit's first turn.**
*Source: `00-SUMMARY.md` R10, `01-communication/SUMMARY.md` F1.*
Verified live in this worktree: `runContinuation`'s turn-end (`run.ts:2988-3016`) already computes
`autoContinued` with the three unit exceptions the spec requires —
`!unitTurn.spawned && !unitTurn.overBudget && !(unitTurn.hasUnit && Boolean(ask))` — but
`runAgentStep`'s twin block (`run.ts:3696-3743`, confirmed: no `state.autonomous` read, no nudge
call at all) has none of this. Every unit child's **first** turn goes through `runAgentStep`, so a
centurion or legate that doesn't end its first turn with a marker parks at `waiting` unconditionally
today, autonomous or not.
*Dependency, not optional:* branch `fix/autonomous-nudge-reachability` (`b5f0b316` +
`c8dc7cef`, confirmed present in this worktree's git history, **not yet merged to `origin/main`**
at `e8c95f3a`) introduces exactly the shared helper this fix needs — `tryAutonomousNudge(runId,
state, stepId?)` — but ships it with **no unit exceptions at all**: its own doc comment says
`CEZ:ASK` and `CEZ:MONITORING` "are OVERRIDDEN while budget remains (the nudge deliberately wins
over both)". Merged as-is, that would **break the Guard invariant** this spec's Q4 promises ("an
autonomous unit run never auto-continues past its own question") for every unit run, not just fix
`runAgentStep`. Land `fix/autonomous-nudge-reachability` on `main` first (resolving `00-SUMMARY.md`
open question 1 — see Resolved assumptions), rebase this branch past it, then **fold the three unit
exceptions already live in `runContinuation`'s inline block into `tryAutonomousNudge` itself** (an
`options: { unitTurn?: UnitTurnResult; ask?: AskRequest }` parameter, or an early-return predicate)
so both call sites share one gate instead of `runContinuation` keeping a bespoke inline copy that
can drift from the shared helper.

**4. Restart reports a waiting unit run as `blocked`, not `done`.**
*Source: `00-SUMMARY.md` R9 (= D6), `01-communication/SUMMARY.md` F7; resolves open question 2 as
"settle, but report blocked" per the task order's own wording.*
`recover()`'s `waiting` branch (`run.ts:1328-1344`, confirmed) calls `settleSuccess` unconditionally;
`childSettleReport` (`engine.ts:157-189`, confirmed) then synthesizes a report via
`statusToReportStatus(child.status)` (`engine.ts:141-146`) whenever the child never emitted its own
`CEZ:REPORT` — and since `settleSuccess` resolves every autonomous run's terminal `RunRecord.status`
to `'done'` (review is gated off by default, Mission 3 item 6), that synthesis always produces
`report.status: 'done'`. Fix, using the *existing* `'blocked'` enum value already in
`unitReportSchema` (`contract/src/units.ts:75-83` — `status: z.enum(['done','partial','failed','blocked'])`,
confirmed, no schema change needed): thread the child's `unit.pendingAsk` (item 5 below) into
`childSettleReport`'s `context` parameter; when present and unanswered, force
`{ status: 'blocked', result: '<questions from pendingAsk>, unanswered — the run was restarted before a reply arrived' }`
instead of calling `statusToReportStatus`. The child `RunRecord`'s own terminal `status` is
unaffected by this fix — it still resolves through the existing `settleSuccess` path (Mission 3
item 6 changes that path for the mission root only); what changes is only what gets **reported
upward**, which is the field a parent actually trusts (`02-roles/SUMMARY.md` F6).

**5. Persist the pending question.**
*Source: `01-communication/SUMMARY.md` F8 (prerequisite for item 4 above and for
`03-lifecycle-cockpit/SUMMARY.md` P3's `guardReason` in Mission 2).*
Add to `unitSchema` (`contract/src/units.ts:96-116`):
```ts
pendingAsk: z.object({
  requestId: z.string().optional(),
  questions: z.array(z.string().max(400)).max(4),
  askedAt: z.string(), // ISO-8601
}).optional(),
```
**with the persistence twin in `packages/cezar/src/runs/store.ts` in the same commit** — the file
already imports `unitSchema` directly from the contract package (`store.ts:13`,
`unit: unitSchema.optional().catch(undefined)` at `store.ts:200`), so this is additive with no
separate schema to keep in sync; the parity test the codebase already runs
(`contract-parity.runs.test.ts`, referenced by `contract/src/units.ts`'s own doc comment) covers it
for free. Write `pendingAsk` beside both `emitAskRequested` call sites (`run.ts:3025`/`3906` in
`runContinuation`, and the `runAgentStep` twin around `run.ts:3910` per
`03-lifecycle-cockpit/SUMMARY.md` F2's citation — re-verify the exact line once item 3's rebase
lands, since `fix/autonomous-nudge-reachability` shifts nearby lines).

**6. Rewrite the commander prompts: integration-only editing, Guard covers shared branches only.**
*Source: `02-roles/SUMMARY.md` F1 (R4), F3 — full resolution and exact replacement text already
worked out in `02-roles/SUMMARY.md`'s "The merge-vs-Guard contradiction — resolved" section and its
P1/P2; this item adopts that text verbatim, re-verified against this worktree's HEAD.*
Confirmed still live and unfixed: `GUARD_RULE` (`prompts.ts:79-84`) still reads "merging anything"
verbatim, contradicting `CHILD_BRANCH_RULE`'s mandate two paragraphs earlier at `prompts.ts:38`
("For each child you accept, merge its branch into your own worktree..."); `CAESAR_PROMPT:90` /
`LEGATE_PROMPT:121` still claim "You do not edit files yourself. Not one," contradicted by
`prompts.ts:35` (commit before spawn) and `:39` (resolve sibling conflicts and commit). Apply
`02-roles/SUMMARY.md` P1's `GUARD_RULE` replacement in full (narrows "merging anything" to "merging
into the repository's base branch... or into any branch that is not your own worktree's branch",
and adds a leading bullet naming the in-worktree child merge as the one exception) and P2's two
prompt replacements (the integration-only editing exception, one per commanding role). No code
reads this text at runtime beyond the marker parser, which is untouched by this item.

### Files and functions touched

`packages/cezar/src/units/markers.ts` (`parseMarker`, `SPAWN_MARKER_CANDIDATE_RE`,
`REPORT_MARKER_CANDIDATE_RE`), `packages/cezar/src/units/prompts.ts` (`GUARD_RULE`,
`CAESAR_PROMPT`, `LEGATE_PROMPT` — text only), `packages/cezar/src/workflows/run.ts`
(`handleUnitMarkers` at `:1531`, the turn-end blocks inside `runContinuation` at `:2900-3050` and
`runAgentStep` at `:3676-3760`, `tryAutonomousNudge` once item 3's rebase lands it, `recover()`'s
`waiting` branch at `:1328-1344`), `packages/cezar/src/units/engine.ts` (`childSettleReport` only),
`packages/contract/src/units.ts` (`unitSchema` — add `pendingAsk`), `packages/cezar/src/runs/store.ts`
(persistence parity, no logic change beyond the schema pass-through already in place).

### Default-path statement

Every item here is a **bug fix or a text change**, not a new knob — the entire mission ships with
no new configuration surface. Item 1 (marker anchoring): a spawn that is currently well-formed and
already succeeds keeps succeeding byte-for-byte; only spawns that are *wrongly refused today* start
succeeding. Item 2 (rejection re-prompt): additive — a session that would previously idle to a
15-minute timeout on a malformed marker now gets one more chance; a session already closed behaves
exactly as today (`sendMessage` returns `false`, no-op). Item 3 (autonomous nudge on first turn) is
the one item with a real default-path change **outside the narrow unit scope**: merging
`fix/autonomous-nudge-reachability` changes every `#autonomous` run in the repo, unit or not — call
this out explicitly in the PR, per `01-communication/SUMMARY.md` P1's own default-path note. Within
units specifically, behavior for a unit run is unchanged in *intent* (nudge past a plain turn end,
never past `CEZ:ASK`/over-budget/a spawn) — only newly *reachable* on the first turn, where today it
silently never fired. Item 4 (restart reports `blocked`): zero change for any run without `unit`, and
zero change for a unit run with no `pendingAsk` set — the carve-out in `childSettleReport` is gated
on the new field's presence, so an ordinary restart of a plain `waiting` unit child (no open
question) still settles and reports exactly as before. Item 5 (`pendingAsk` field): purely additive,
`.optional()`, absent by default, no reader anywhere in this mission except item 4's own carve-out.
Item 6 (prompt text): no functional impact — nothing in the engine parses this prose beyond the
marker parser, which item 6 does not touch.

### State transitions and who fires them

- **`pendingAsk` created** — the engine, at the same instant it calls `emitAskRequested` (both
  turn-end sites), whenever a unit run's turn ends on a `CEZ:ASK`.
- **`pendingAsk` cleared** — three exits, mirroring `contract/src/units.ts`'s existing
  `pendingReports` lifecycle: (a) a human or a settled sibling's report answers it via
  `deliverMessage`'s success path (`run.ts:2594`); (b) the run settles through any *normal* path
  (not the restart-force-settle this mission fixes) — settling always clears it, since a settled
  run has no more turns to answer into; (c) `cancelDescendants` (`run.ts:1837-1845`) during a cancel
  cascade. A `pendingAsk` that survives to a restart-forced settle (Mission 1 item 4's own scenario)
  is **not cleared** by that settle — it stays on the terminal record as the honest trace of what
  went unanswered, which is exactly the information item 4's `blocked` report is built from.
- **The rejection re-prompt (item 2)** fires synchronously inside `handleUnitMarkers`, the same
  turn-end tick as the rejection note; it does not create a new run state, only a new message into
  an already-open session.
- **The autonomous nudge on a first turn (item 3)** — same lifecycle `tryAutonomousNudge` already
  documents for the continuation site: bounded by `MAX_AUTO_CONTINUES` (`run.ts:313`), exits on
  cancel, on the session closing, or on the cap.

### Tests to pin

`packages/cezar/src/units/markers.test.ts` — a spawn immediately followed by a same-turn
`CEZ:MONITORING` line parses the spawn correctly (regression for D1); a spawn preceded by prose
mentioning "CEZ:SPAWN" earlier in the turn still anchors on the real, later marker (D2); the
candidate-regex change does not change any currently-passing malformed/valid case.
`packages/cezar/src/units/prompts.test.ts` — extend the existing `/never merge/i` (`:161`) and
`toContain('git merge --no-ff')` (`:179`) assertions with one asserting the Guard names the
in-worktree exception (`toMatch(/does not cover/i)`); update the file-editing assertion
(`:150-154`) to the narrower "does not write the mission's/task's work" claim.
`packages/cezar/src/workflows/autonomous-nudge.test.ts` (carried over from
`fix/autonomous-nudge-reachability`) — extend with a unit-run case proving `tryAutonomousNudge`
still refuses to nudge past `CEZ:ASK`/over-budget/a spawn once the three exceptions move into the
shared helper. `packages/cezar/src/workflows/units-engine.test.ts` — extend `:474-522`'s
`askOnContinue`-style helper (today only exercises `runContinuation`) to drive a `CEZ:ASK` through a
child's **first** turn (`runAgentStep`), proving the Guard holds there too now that the nudge is
reachable. `packages/cezar/src/workflows/recover-unit.test.ts` — a sibling to the existing
`:136-167` fixture, seeding an unanswered `ask.requested` event and a `pendingAsk`, asserting the
synthesized report is `status: 'blocked'` naming the question, not `done`; and an explicit assertion
that a `waiting` run **without** `pendingAsk` still settles and reports exactly as today (the
regression guard for the narrow gate). `packages/cezar/src/units/engine.test.ts` — `pendingAsk`
round-trips through the contract-parity check; `childSettleReport` produces the forced `blocked`
report when passed a `pendingAsk` context.

### Suggested legate/centurion split and rough budget

One Legate coordinating three Centurions, sequenced (this mission's own items share `run.ts` turn-end
blocks too tightly to parallelize blind):
- **Centurion A** — items 1 and 2 (`markers.ts`, `handleUnitMarkers`'s rejection path). ~$3.
- **Centurion B** — item 3, gated on the `main` rebase landing first (coordinate with the Legate
  before starting; this is the one item with an external dependency outside this mission's own
  branch). ~$4.
- **Centurion C** — items 4 and 5 together (`pendingAsk` schema + `childSettleReport` + `recover()`),
  since item 4 depends on item 5's field existing. ~$4.
- **Legate** — item 6 (prompt text, small enough to do directly rather than spawn a fourth
  centurion for ~$1 of work), plus review/merge of A, B, C. ~$4.
- **Total: ~$15.**

### Acceptance criteria

- A spawn followed by a same-turn `CEZ:MONITORING` line succeeds (no `invalid-json` refusal).
- A malformed marker triggers a re-prompt into the open session, visible as a new session message
  in the transcript, not just a `note` event.
- A fresh unit child (first turn, `runAgentStep`) that ends its turn on a plain autonomous
  continuation nudges instead of parking `waiting`; one that ends on `CEZ:ASK` still parks.
- A restart during an unanswered unit `CEZ:ASK` reports `blocked` to the parent, not `done`; a
  restart during an ordinary `waiting` unit run with no open question is unaffected.
- `prompts.test.ts` and `markers.test.ts` pass in full; no existing passing test in either suite
  regresses.

### Dependencies

None to start Centurion A. Centurion B blocks on `fix/autonomous-nudge-reachability` merging to
`main` and this branch rebasing past it — flag this explicitly to the commander before spawning.

---

## Mission 2 — the Legate can finish and answer

**Depends on Mission 1** (shares `enforceUnitBudget`'s turn-end call site, which item 3's rebase and
item 4's `pendingAsk` both touch).

### Goal

Stop a well-run mission from losing delegation capacity it never actually spent, give a parked
over-budget mission a real way back to autonomous operation, and make the Guard inbox tell the
operator *why* a run is waiting instead of flattening every reason into one identical row.

### Work items

**1. Release a settled child's unspent budget reservation.**
*Source: `00-SUMMARY.md` R3 — independently found and reconciled by three separate audits
(`01-communication/SUMMARY.md` F4, `02-roles/SUMMARY.md` F8,
`03-lifecycle-cockpit/SUMMARY.md` F1/F8/P7); this item is the single reconciled fix, landed once.*
`remainingBudgetUsd` (`engine.ts:67-72`, confirmed) sums every child's full `budgetUsd` regardless of
status via `childrenOf` (`engine.ts:49-51`, no status filter). Fix, exactly as
`03-lifecycle-cockpit/SUMMARY.md` P7 states it:
```ts
const promised = children.reduce(
  (sum, child) =>
    sum + (isTerminalStatus(child.status) ? (child.costUsd ?? child.unit?.budgetUsd ?? 0)
                                            : (child.unit?.budgetUsd ?? 0)),
  0,
);
```
A terminal child (`isTerminalStatus`, `engine.ts:44-46`) is charged its actual `costUsd`; an
in-flight one keeps reserving its full ceiling, since it may yet spend it. The `costUsd ?? budgetUsd`
fallback means a settled child with no recorded cost is never *under*-charged by a data gap. No
double-counting risk: `run.costUsd` is summed strictly from a run's own steps
(`store.ts:938-939`, confirmed) and never rolls up children — the three audits' shared open
question 5/13 is answered no by direct re-read.

**2. A validated budget top-up route that clears `overBudget` and re-arms the wake timer.**
*Source: `03-lifecycle-cockpit/SUMMARY.md` P9 (fixes F11 = R21), reconciling the two independently
proposed shapes named in `00-SUMMARY.md`'s "notable duplicate" note (`PATCH .../runs/:id/unit
{budgetUsd}` vs `PATCH /missions/:id/budget {budgetUsd}`) into one.*
`PATCH /api/v1/p/:projectId/missions/:id/budget { budgetUsd }`, resolving `:id` to its mission root
(no `parentRunId`, `unit.missionId === :id`) — same resolution pattern Mission 3 item 8's `GET`
route uses, share the helper. Reject a new ceiling below `costUsd + Σ children.budgetUsd` (reuse
item 1's own `remainingBudgetUsd` arithmetic, solved for the ceiling, so a top-up can never
retroactively under-fund work already promised). Route the write through `updateUnit`
(`run.ts:1586`, confirmed as `enforceUnitBudget`'s own mutator). **Must fix both exits from
`overBudget` in the same change**, per `03-lifecycle-cockpit/SUMMARY.md` P9's own explicit warning:
today an ordinary human message to an over-budget run gives it one more turn but does **not** clear
`unit.overBudget` (grep-confirmed: the flag is set once at `run.ts:1585-1586` and read only
elsewhere), so it re-parks silently on the very next turn. This PATCH must be the one path that
actually clears the flag **and** re-arms the wake timer specifically (`enforceUnitBudget`'s whole
job is closing a run's wake sources at zero budget — a top-up that clears the flag but leaves the
timer disarmed produces a mission that looks funded but never wakes).

**3. Fix `totalBudgetUsd`'s double-count.**
*Source: `03-lifecycle-cockpit/SUMMARY.md` F5/P5 (= `00-SUMMARY.md` R17).*
`buildMissionTrees` (`packages/web/src/lib/missions.ts:145-225`, confirmed; the reducer sits at
`:211-219` per the audit, re-verify exact offset since this file's structure is unchanged since
audit HEAD) sums every node's own `budgetUsd` across the tree, but `carveChildBudgets`
(`run.ts:1713-1739`) subtracts a child's ceiling from the **same envelope** as a capped parent's own
`budgetUsd` — a child's ceiling is new money only when its parent is uncapped. Fix: only add a
node's `budgetUsd` when it is genuinely new — the root, or a node whose immediate parent has no
`budgetUsd` — mirroring `remainingBudgetUsd`'s own rule, needing a second pass over `nodes` keyed by
`run.unit.parentRunId`. Currently zero blast radius (no route renders `totalBudgetUsd` today,
confirmed by grep across `packages/web/src` — the only hits are `missions.ts` and its own test) but
a live landmine the moment Mission 3's cockpit surfaces it.

**4. Give the Guard a reason, using data already on the wire.**
*Source: `03-lifecycle-cockpit/SUMMARY.md` F2/P3 (= `00-SUMMARY.md` R5), plus F6/P4 for the
mirror-image false negative.*
Add `guardReason: 'ask' | 'overBudget' | 'other'` to `MissionNode` (`missions.ts:73-79`, confirmed
field list includes `needsGuard: boolean`), derived in `nodeOf` (`missions.ts:86-109`) from
`run.unit.overBudget` first (already reaches the client, `contract/src/units.ts` `overBudget` field,
confirmed unread by any file under `packages/web/src` today), else a coarser `'ask'`/`'other'` split
— this coarseness is a known, accepted gap until Mission 1 item 5's `pendingAsk` field is wired
through here too (a follow-up inside this same item once `pendingAsk` exists: prefer
`Boolean(run.unit.pendingAsk)` over the coarse fallback). Keep `needsGuard` itself as
`status === 'waiting'` — additive, not a redefinition. Separately, OR
`Boolean(run.monitoringWakeCapReached)` into `needsGuard` (`missions.ts:106`, confirmed exact text)
— `armMonitoringWakeTimer`'s cap-reached path (`run.ts:4290-4300`, `:4312-4318`, confirmed) sets
`monitoringWakeCapReached: true` but leaves `status: 'running'`, so today's `needsGuard` never
becomes `true` for a run whose auto-wake is permanently exhausted; `monitoringWakeCapReached` is
already a top-level `RunRecord` field (`contract/src/runs.ts:203`, confirmed), so no new plumbing.
Update `guard.tsx`'s `SUBTITLE` (confirmed present at `guard.tsx:83`) to stop overpromising "every
unit run that stopped to ask" now that the inbox also carries budget-halt and wake-cap rows with a
visible `guardReason` label distinguishing them.

**5. The escalation ladder proper: `CEZ:ESCALATE` / `CEZ:ANSWER`, one rank at a time.**
*Source: `01-communication/SUMMARY.md` P5 (fixes F3 = `00-SUMMARY.md` R12, plus F15/F16).*
A new unit-only marker **pair**, parsed in `packages/cezar/src/units/markers.ts` through the same
shared generic `parseMarker` helper (`markers.ts:62`, confirmed) the spawn and report markers already
use — deliberately **not** an extension of `ask.ts`, which is shared non-unit infrastructure carrying
no notion of rank. Schema in `packages/contract/src/units.ts`, `.strict()` like `unitSpawnSchema`:
`{ requestId?: string, irreversible: boolean, financial: boolean, questions: askQuestion[1..4] }`;
`CEZ:ANSWER` carries `{ requestId, answers }`. Both markers inherit Mission 1 item 1's
last-occurrence anchoring and trailing-marker tolerance for free — that is the main reason this item
lands *after* Mission 1 rather than beside it.
*Routing (the whole point of the item):* an escalation is delivered **one hop**, to
`unit.parentRunId`, through the same three-rung ladder `reportSettledChildToParent` already uses
(`run.ts:1756`, the `deliverMessage` → `enqueueMessage` → deferred-continue cascade at `run.ts:1812`,
confirmed) — reuse that cascade, do not write a second one. A dead or settled ancestor is skipped
upward. A question reaches the **human** in exactly three cases, and no others: `irreversible ||
financial` is true and the current holder is the Caesar/root; the round cap trips; or no live
ancestor remains. Answers travel back **down** the same cascade, fired synchronously from the
answering rank's own turn-end when it emits a valid `CEZ:ANSWER`.
*Guard-filter change, mandatory in the same commit:* narrow `needsGuard` (`missions.ts:106`,
confirmed) to exclude a run that is waiting on a **live ancestor** — otherwise the ladder ships as a
no-op that re-floods the same inbox item 4 just taught to be precise (`01-communication/SUMMARY.md`
F15). Add `'escalated'` to item 4's `guardReason` union rather than a second field.
*Prompt change, mandatory in the same commit:* teach `LEGATE_PROMPT` and `CENTURION_PROMPT` the
marker pair (`prompts.ts`) — without it no model ever emits it and the ladder is dead on the default
path (`01-communication/SUMMARY.md` F16, the audit's own "a replacement that ships OFF is not a
replacement" standard). The plain `CEZ:ASK` wording **stays** in all three prompts per decision D5.
*Round cap:* a `unit.escalationRounds` counter on the escalating run, incremented per hop, defaulting
to **3** round-trips; on trip, the question goes straight to the human with a note naming the cap.
The cap's *value* remains an open question (see Open questions remaining #1) — the *mechanism* is not
optional, since without it a two-rank disagreement can bounce indefinitely and never reach anyone.

**6. A live "child is blocked" notice to the parent.**
*Source: `01-communication/SUMMARY.md` P6 (fixes F2 = `00-SUMMARY.md` R11).*
Today a child parked on `CEZ:ASK` is invisible to its commander *and* still eats a quarter of its
fan-out: `TERMINAL_STATUSES` excludes `waiting` (`engine.ts:42`, confirmed) so the report gate at
`run.ts:1756` returns early and the parent is told nothing, while `IN_FLIGHT_STATUSES` *includes*
`waiting` (`engine.ts:37`, confirmed) so the child still counts against `MAX_CHILDREN_IN_FLIGHT = 4`
(`engine.ts:29`, confirmed). Add `unit.blockedChildren?: { fromRunId, title, askedAt }[]` to
`packages/contract/src/units.ts` and its `store.ts` persistence twin, bounded exactly like
`pendingReports` is by `withPendingReport`/`MAX_PENDING_REPORTS` (`engine.ts:192`, `:34`, confirmed)
— add a sibling `withBlockedChild` helper there rather than inlining the slice twice. Append on the
one edge existing code already computes: beside `emitAskRequested` (`run.ts:3025` in
`runContinuation` and `run.ts:3727` in `runAgentStep`, both confirmed), and route one line of prose
to the parent through **the same delivery helper item 5 extracts**, so the two paths cannot drift.
**No `continueRun` rung** on this path: a blocked-child notice must never resurrect a settled or
cancelled parent — it is information, not a wake source.
*Relation to item 5:* `01-communication/SUMMARY.md` P6 notes it is "largely subsumed by P5 if the
ladder ships." It is kept here deliberately: the ladder covers a child that *escalates*, this covers
a child that uses the D5 escape hatch and asks the human directly — which decision D5 guarantees
stays possible at every rank forever. Build item 5 first, then item 6 on top of its extracted helper;
the marginal cost is small and the coverage gap is real.

### Files and functions touched

`packages/cezar/src/units/engine.ts` (`remainingBudgetUsd`, plus a new `withBlockedChild` beside
`withPendingReport`), `packages/cezar/src/units/markers.ts` (two new marker parsers over the existing
`parseMarker` helper — no change to the spawn/report parsers Mission 1 owns),
`packages/cezar/src/units/prompts.ts` (the escalation paragraph only — Mission 1 owns the merge/edit
rewrite in the same file, which is why these two missions must not run in parallel),
`packages/contract/src/units.ts` (`unitEscalationSchema`, `unitAnswerSchema`, `blockedChildren`,
`escalationRounds`) and its `packages/cezar/src/runs/store.ts` persistence twin (the parity test must
pass), `packages/cezar/src/workflows/run.ts` (`carveChildBudgets` and `enforceUnitBudget` only among
existing functions, plus one new escalation-delivery helper extracted from
`reportSettledChildToParent`'s cascade and called from both turn-end sites beside
`emitAskRequested` — no other existing function in this large file), one new route in
`packages/cezar/src/server/server.ts` (the budget PATCH, alongside the existing
`/missions`/`/units/prompts*` family at `:3486-3577`), `packages/web/src/lib/missions.ts`
(`buildMissionTrees`, `nodeOf`, `MissionNode` type), `packages/web/src/routes/missions/guard.tsx`
(`SUBTITLE`, row rendering).

### Default-path statement

Item 1 strictly loosens an existing refusal — no mission that can spawn today stops being able to;
an uncapped parent (`budgetUsd === undefined`) is untouched (`remainingBudgetUsd` still returns
`undefined`). Item 2 is purely additive — a mission that never calls the new PATCH route behaves
exactly as today; the "must fix both exits" clause is the one place this item touches *existing*
behavior (the human-message exit), and that touch is a bug fix (a flag that should clear but
doesn't), not a knob. Item 3 has zero current user-visible effect (no consumer renders
`totalBudgetUsd` yet) but changes the field's computed value — the existing test
(`missions.test.ts:187-199`, pinned wrong today per the audit's own note) must be updated to the
corrected expectation as part of this fix, not left passing by accident. Item 4 is additive on both
halves: `guardReason` is a new derived field, `needsGuard`'s wake-cap OR only ever flips a
currently-`false` value to `true` for a run that genuinely needs a human, never the reverse.

Item 5 is the one item in this mission that changes an existing default path, and it does so in two
steps that must ship together: until the prompt paragraph lands, no model emits the new markers and
behaviour is byte-for-byte unchanged; after it lands, a question that previously always paged the
human may instead stop one rank up. `CEZ:ASK` is untouched at every rank (decision D5), so the
escape hatch never closes and no question can become unreachable — the worst case of a ladder bug is
a question that arrives via `CEZ:ASK` instead, which is exactly today's behaviour. Item 6 is strictly
additive: a new bounded array on a record that is absent today, appended on an edge existing code
already computes, with no knob and no new wake source.

### State transitions and who fires them

- **`overBudget` cleared** — exactly one new firer: the budget PATCH route (item 2), which also
  re-arms the wake timer in the same transaction. The pre-existing informal "exit" (a human message)
  is fixed to also clear it, so after this mission there remain exactly two ways out, both explicit.
- **`guardReason`** — purely derived, recomputed on every read, no stored state, no transition.
- **`totalBudgetUsd`** — pure function of already-read data, same lifecycle as today, no transition.
- **`escalated-waiting`** (item 5) — *entered* by the escalating run's own turn-end handler on a
  valid `CEZ:ESCALATE`, which parks it exactly as `CEZ:ASK` parks a run today. *Exited* by exactly
  four firers, all of them synchronous with some turn end, none of them a new timer: (a) the
  ancestor's turn-end delivering a valid `CEZ:ANSWER` back down the cascade; (b) the same run
  re-escalating under the round cap (a fresh entry replaces the old, `requestId` preserved);
  (c) the round cap tripping, which converts the escalation into an ordinary human-facing ask and
  hands it to the Guard inbox with `guardReason: 'escalated'`; (d) the cancel cascade. A restart
  with an open escalation re-delivers it rather than settling — this reuses Mission 1 item 4's
  `blocked` rule and item 5's persisted `pendingAsk`, and is why this item cannot precede Mission 1.
- **`blockedChildren` entry** (item 6) — *created* once per ask by whichever turn-end handler fired
  `emitAskRequested` for a unit child (idempotent: a second still-blocked turn adds nothing).
  *Removed* by the child's own status leaving `waiting` for any reason — answered, settled, failed or
  cancelled — fired from the same status-write path that already notifies the parent on settle.

### Tests to pin

`packages/cezar/src/units/engine.test.ts` — `remainingBudgetUsd` with a terminal underspent child, a
terminal overspent child, and an in-flight child, asserting only terminal ones are charged at
actual cost; a `run.test.ts` case that a spawn refused before a child settles succeeds after.
Server-side route test (new, alongside `missions-api.test.ts`) — "PATCH budget rejects a ceiling
below what's already spent/promised"; "PATCH budget on an over-budget root clears
`unit.overBudget` and re-arms the wake timer so the next turn actually fires"; "a plain human
message to an over-budget run, on its own, still does NOT clear `overBudget`" pinned as a
regression guard **before** this item lands, then flipped to "now DOES clear it" once landed — do
not skip the pre-fix pin, it is the proof the bug existed. `packages/web/src/lib/missions.test.ts`
— update `:187-199`'s `totalBudgetUsd` expectation from `25` to `20` for the existing $20
caesar + $5 carved legate fixture; add a 3-level fully-carved chain case; add a case with
`unit.overBudget: true` asserting `guardReason === 'overBudget'`; add a
`monitoringWakeCapReached: true` fixture asserting `needsGuard === true`.

`packages/cezar/src/units/markers.test.ts` — round-trip the `CEZ:ESCALATE`/`CEZ:ANSWER` examples
exactly as printed in the prompts (the round-trip test `02-roles/SUMMARY.md` F15 says is missing for
`CEZ:REPORT` today, not repeated for a new marker); unknown keys rejected; a trailing
`CEZ:MONITORING` line tolerated (Mission 1 item 1's guarantee, re-pinned for the new markers).
`packages/cezar/src/units/engine.test.ts` — `withBlockedChild` bounds the array and is idempotent
for the same `fromRunId`. `packages/cezar/src/workflows/units-engine.test.ts` — a centurion's
escalation reaches its legate and does **not** appear in `/guard`; an `irreversible: true`
escalation held by the Caesar reaches the human; a dead intermediate rank is skipped one hop
further up; the round cap terminates and lands the question on the human with
`guardReason: 'escalated'`; a restart with an open escalation re-delivers instead of settling; a
plain `CEZ:ASK` from a centurion still reaches the human directly (decision D5's escape hatch,
pinned as a permanent guarantee); a monitoring parent receives the blocked-child notice
immediately; a parent with a closed session gets a durable `blockedChildren` entry flushed into its
next prompt; the entry clears on unblock; a settled parent is **not** resurrected by a notice.

### Suggested legate/centurion split and rough budget

- **Centurion A** — item 1 (`remainingBudgetUsd`, pure function, isolated). ~$3.
- **Centurion B** — item 2 (budget PATCH route + the two-exit fix). Touches `server.ts`, needs
  item 1 merged first for the ceiling-solving arithmetic. ~$5.
- **Centurion C** — items 3 and 4 together (`packages/web/src/lib/missions.ts` — both touch the
  same file, doing them separately would just create merge friction). ~$4.
- **Centurion D** — item 5, the escalation ladder: markers, contract schemas, the extracted
  delivery helper, both turn-end call sites, the prompt paragraph, and the `needsGuard` narrowing.
  The largest single piece in the plan; must land after C because it edits the same `missions.ts`
  `guardReason` union. ~$12.
- **Centurion E** — item 6, on top of D's extracted helper. ~$4.
- **Review Centurion** — item 5 only, re-reading D's diff and evidence per decision D3. This is the
  one piece in Missions 1-3 large and default-path-touching enough to justify the review step
  before Mission 4 makes it routine. ~$5.
- **Legate** — coordinate B waiting on A and E waiting on D, adjudicate the review verdict,
  review/merge all five. ~$7.
- **Total: ~$40.**

### Acceptance criteria

- A mission whose three children reserved $2.50 each but spent $1.60/$2.14/$1.73 can spawn a fourth
  child for the difference, where today it would be refused.
- `PATCH .../missions/:id/budget` on an over-budget root: rejects a ceiling below committed spend;
  on a valid raise, clears `overBudget` and the next scheduled wake actually fires (not silently
  swallowed).
- `/guard` shows a distinct label for an over-budget row versus a genuine-ask row versus a
  wake-cap-exhausted row (currently invisible from `/guard`/`/missions` entirely).
- `missions.test.ts` passes with the corrected `totalBudgetUsd` expectations.
- A centurion emitting `CEZ:ESCALATE` with `irreversible: false, financial: false` parks, its legate
  receives the question in its own session, and nothing appears in `/guard`; the legate's
  `CEZ:ANSWER` unparks the centurion on the legate's own turn end.
- The same escalation held by a Caesar with `irreversible: true` reaches the human, and so does one
  that has bounced past the round cap — labelled `escalated` in the Guard inbox.
- A plain `CEZ:ASK` from any rank still reaches the human unchanged (decision D5), pinned by a test
  that would fail if the ladder ever swallowed it.
- A commander with a child parked on `CEZ:ASK` can name that child from its own session, and a
  parent whose session was closed when the child blocked sees the notice in its next prompt.

### Dependencies

Mission 1 (shared `enforceUnitBudget` call site via item 3's rebase; the `pendingAsk` field item 4
consumes and item 5 *requires* to survive a restart; item 1's last-occurrence marker anchoring, which
the two new markers inherit; and `prompts.ts`, which Mission 1 rewrites for merge/edit wording and
this mission extends with the escalation paragraph — the reason these two missions must land in
order rather than in parallel worktrees).

---

## Mission 3 — the Legate knows and steers

**Depends on Mission 2** (shares `spawnChildren` and `engine.ts`'s other exported functions — the
envelope and settle-time work below sit right next to Mission 2's budget carving in the same
functions).

### Goal

Give a child enough context to be accountable to the mission's actual goal, not just a paraphrase of
it; give a commander a way to intervene in a running child instead of only reading its eventual
report; close the two structural gaps that let a mission silently outrun its own guardrails
(unenforced worktree isolation, uncommitted parent state); and let a finished mission actually reach
its review checkpoint and its one draft PR.

### Work items

**1. An engine-composed downward envelope: mission brief, siblings, prior findings.**
*Source: `01-communication/SUMMARY.md` F9/F10/F11/F17, `02-roles/SUMMARY.md` F4 (= `00-SUMMARY.md`
R13); concrete shape from `02-roles/SUMMARY.md` P7 and `01-communication/SUMMARY.md` P3, merged —
P7's `## Mission brief` block plus P3's `## Siblings spawned with you` and `## What your commander
already learned` blocks, since they extend the same function at the same call site with no overlap.*
Extend `childTaskEnvelope` (`engine.ts:88-102`, confirmed signature) with an optional `mission`
parameter rendered above the existing `## Task order` block:
```ts
export function childTaskEnvelope(
  child: UnitSpawnChild,
  parent: { id: string; branch?: string; role: UnitRole },
  mission?: { objective: string; constraints?: string[]; budgetUsd?: number; spentUsd?: number },
  siblings?: readonly { title: string; scope?: string }[],
  learned?: readonly UnitPendingReport[],
): string
```
`spawnChildren` (`run.ts:1607-1699`) already holds `this.store` and `unit.missionId` in scope
(confirmed: `unit` param present, missionId read at the existing call), so populating `mission` costs
one extra `this.store.getRun(unit.missionId)` per spawn call, sourced fresh from the store (not
baked in at creation) so it survives a restart and degrades to "no mission brief" rather than
throwing if the root record is gone. `siblings` is the *other* children in the same `CEZ:SPAWN`
batch (title + `scope`, never the child's own entry). `learned` is the ≤3 newest entries of the
parent's own `unit.pendingReports` at spawn time — bounded the same way `MAX_PENDING_REPORTS`
bounds reports, so this cannot grow unbounded on a long wave-after-wave mission. A Squad (lone
centurion) never reaches `spawnChildren` (`CHILD_ROLE.centurion === undefined`, `engine.ts:21-25`),
so this is a no-op there exactly as today.

**2. `CEZ:DIRECT`: message, re-scope or stop a running child.**
*Source: `01-communication/SUMMARY.md` P8 (fixes F9's intervention half).*
New marker, parsed in `handleUnitMarkers` (`run.ts:1531`) before its `ctx.done` return:
`CEZ:DIRECT {"child":"<runId>","action":"message"|"rescope"|"stop","text":"…"}`. Orthogonal to the
existing precedence order in the spec's Markers section — it never sets `spawned`/`overBudget`, so
it cannot flip the parent's own park decision the way a spawn or budget breach does. `stop` calls
the existing `cancelDescendants`/cancel path (`run.ts:1837-1845`, `:2247`); `message`/`rescope` call
the existing `sendMessage` (`run.ts:2582`) — the same methods the human-only HTTP routes
(`POST /runs/:id/messages`, `POST /runs/:id/cancel`) already use, so no new delivery mechanism, only
a new caller. Refuse against a child not in `IN_FLIGHT_STATUSES` (`engine.ts:37`, referenced by the
audit; protects Mission 4's review gate from being bypassed by a `stop` racing a settle).

**3. Lineage-tracked retries: actually enforce `retry_limit`.**
*Source: `01-communication/SUMMARY.md` F13, `02-roles/SUMMARY.md` F7 (= `00-SUMMARY.md` R15).*
Add `retry_of: z.string().optional()` to the spawn child schema
(`unitSpawnSchema`'s child object, `contract/src/units.ts:128-153`, `.strict()` — confirmed) and
persisted `retryLimit`/`retryCount`/`retryOf` to `unitSchema`, **with the `runs/store.ts` persistence
twin in the same commit** (same parity mechanism as Mission 1 item 5's `pendingAsk`).
`spawnChildren` resolves `retry_of` to a settled child of the *same parent* (refused if it names an
unrelated run); a retry chain increments the inherited count off that child's own `retryCount`, and
refuses past the inherited `retryLimit` — a retry can never raise its own ceiling by omitting
`retry_limit` on the new spawn. A parent that never names `retry_of` behaves exactly as today; this
is opt-in reinforcement, inert until the prompt teaches it (bundle the prompt change in the same
commit — see Mission 3's default-path statement).

**4. Warn on scope overlap at spawn time.**
*Source: `03-prompt-noop-audit.md` F3 via `02-roles/SUMMARY.md` F12 (= `00-SUMMARY.md` R22).*
In `spawnChildren`, before creating anything, compare each pair of `scope` strings in the batch plus
in-flight siblings (`inFlightChildren`, `engine.ts:54-56`, confirmed) by exact match or a true
`/`-segment prefix (never a raw string prefix — `packages/billing` must not "overlap" with
`packages/billing-utils`). On a hit, append a `danger`-tone note naming both children; **the spawn
still proceeds** — a hard refusal is deliberately not proposed, since false positives would strand
legitimate missions and a bypass flag just trades one knob for another.

**5. Enforce worktree isolation at settle time.**
*Source: `01-communication/SUMMARY.md` F5 (= `00-SUMMARY.md` R2/D7) — this mission's own worst-case
empirical failure: a centurion committed into the user's main checkout, on the shared branch
`feat/units-mvp`, undetected.*
Cannot prevent a rogue write at the tool layer within this scope (that is `allowed_tools`
enforcement, backend-dependent — Mission 4 item 4), but can **detect and refuse to silently accept
it**: at settle (`childSettleReport` or the caller in `run.ts` around `reportSettledChildToParent`,
`:1756`), compare the child's recorded `unit`-seeded `branch`/`baseBranch` against where its commits
actually landed (`git rev-parse` in the child's own worktree, or absence of a worktree at all when
one was expected). On a mismatch, force the synthesized report toward `status: 'blocked'` (reusing
Mission 1 item 4's same mechanism) naming the discrepancy, instead of letting a clean `done` paper
over a branch that moved somewhere the parent's merge step doesn't expect.

**6. Let the mission root reach `review`; nudge toward the one draft PR.**
*Source: `03-lifecycle-cockpit/SUMMARY.md` F1(part)/F3 (= `00-SUMMARY.md` R6/R7), P1.*
`settleSuccess` (`run.ts:4152-4176`) computes `review = hasDiff && reviewGateEnabled(config) &&
run.autonomous !== true` (`run.ts:4159`, confirmed verbatim) — the last conjunct is `false` for
every unit run, root included, since every unit run is created `autonomous: true`
(`server.ts:3529`, `run.ts:1671`/nearby, confirmed both literally `autonomous: true,`). Widen this
one line for the **root only**: `run.autonomous !== true || run.unit?.missionId === run.id` (a root
is its own mission). Every legate and centurion beneath the root keeps `autonomous: true` behaving
exactly as today — they still must report to a parent and run unattended; only the root, which has
no parent to report to, is eligible. With `reviewGateEnabled(config)` defaulting **off**, this is
zero behavior change until a repository opts in. Once `review` is reachable, the finish-nudge half
(R7): Caesar's own finishing instructions never mention `POST /runs/:id/pr` today
(`prompts.ts:41` only tells the human "opens the pull request" in prose) — add one line to
`CAESAR_PROMPT`'s finishing section pointing at the review-then-PR sequence explicitly, so a Caesar
that reaches `review` knows what the state means and what it should ask the human for next (adopting
Caesar's own recommendation from the handoff: "finish nudges toward the one draft PR").

**7. Missions `GET` and mission-scoped cancel.**
*Source: `03-lifecycle-cockpit/SUMMARY.md` F10/P8 (= `00-SUMMARY.md` R24).*
`GET /api/v1/p/:projectId/missions/:id` — filter `store.listRuns()` by `unit.missionId === :id`,
return `{ root, runs }`; expose the grouping `packages/web/src/lib/missions.ts` already implements
as a shared, testable pure function both server and web import, rather than reimplementing it.
`POST /missions/:id/cancel` — resolve the mission root, delegate to the *same* cascade
`POST /runs/:id/cancel` already runs (`cancelDescendants`, `run.ts:1837-1845`, children-first,
called from `:2247`, confirmed) — no new cancellation logic, only a lookup wrapper. Both routes sit
behind the existing `requireUnits` gate (`server.ts:3465-3468`, confirmed).

**8. The mission-scoped parallel limit (user decision D2).**
*Source: this plan's own Resolved assumptions, answering `00-SUMMARY.md` open question 9(c) and
`02-roles/SUMMARY.md` F10 without the global-knob blast radius.*
Add `maxParallel: z.number().int().min(1).max(16).optional()` to `startMissionInputSchema`
(`contract/src/units.ts`, alongside `budgetUsd`/`ladder`/`constraints`) and to `unitSchema` on the
root record. Enforcement point: `pump()`'s `capacity()` closure (`run.ts:1090-1210`, specifically
`:1106-1117`, confirmed — today gates on `this.semaphore.busy() < maxParallel` (global) and
`this.busySlots() < projectMax` (per-project) only). Add a third, mission-scoped check reusing the
same `next = this.queue.findIndex(...)` skip-not-block pattern the existing account-hold gate
already uses (`run.ts:1143-1149`, confirmed — a held run is skipped, not dequeued and requeued, so
its position survives): a new `missionBusySlots(missionId)` helper counts active+starting run ids
whose `unit.missionId` matches, excluding spawn-parked/monitoring-exempt ones the same way
`busySlots()` does (`run.ts:1014-1026`); a queued run whose mission is at its own `maxParallel` is
skipped in the `findIndex`, leaving it queued in place exactly like an account-held run today. This
is a check **in addition to** the existing global/per-project gates, never a way to exceed them —
the tightest of the three always wins.

### Files and functions touched

`packages/cezar/src/units/engine.ts` (`childTaskEnvelope` only), `packages/cezar/src/workflows/run.ts`
(`spawnChildren` `:1607-1699`, `handleUnitMarkers` for `CEZ:DIRECT`, `reportSettledChildToParent`
`:1756` for item 5's worktree check, `settleSuccess` `:4152-4176` for item 6, `pump()`/`capacity()`
`:1090-1210` for item 8), `packages/cezar/src/units/prompts.ts` (`CAESAR_PROMPT` finishing section,
new `CEZ:DIRECT`/`retry_of` documentation), `packages/contract/src/units.ts` (`unitSpawnSchema`
child object — `retry_of`; `unitSchema` — `retryLimit`/`retryCount`/`retryOf`/`maxParallel`;
`startMissionInputSchema` — `maxParallel`), `packages/cezar/src/runs/store.ts` (persistence parity
for the new `unitSchema` fields), `packages/cezar/src/server/server.ts` (missions `GET`/cancel
routes, alongside the existing family at `:3486-3577`), `packages/web/src/lib/missions.ts` (a
shared grouping function extracted for the new `GET` route to reuse), `packages/web/src/routes/missions/*`
(composer pre-fills `maxParallel: 4` for `army`, per D2).

### Default-path statement

Item 1 (envelope): every child's prompt grows by a few lines; no schema change, purely additive —
`unitSpawnSchema` (what a commander may *send*) is untouched. Item 2 (`CEZ:DIRECT`): inert until the
prompt teaches it, exactly like `retry_of` — a mission that never emits the marker is byte-for-byte
unchanged. Item 3 (`retry_of`): a parent that never names it behaves exactly as today; opt-in
reinforcement only. Item 4 (scope overlap): runs on every spawn but only *acts* (appends a note) on
an actual collision — a mission with disjoint scopes sees nothing change; the spawn is never
refused. Item 5 (worktree check): additive read-only git check at settle; the only behavior change
is a mismatch producing `blocked` instead of `done` — a mission where every child commits correctly
(the overwhelming case) is unaffected. Item 6 (`review` gate): zero change with
`reviewGateEnabled(config)` at its shipped-off default; only a repository that already opted in for
ordinary tasks gets the same protection extended to a mission root's terminal settle — and only the
root, never a legate or centurion beneath it. Item 7 (routes): purely additive, both gated behind
`requireUnits` exactly like every other units route — a project with units off gets the same 409.
Item 8 (mission-scoped parallel limit): **the knob's own default is the global `maxParallel`**, so a
mission that never sets it is unaffected; the composer's `army` pre-fill of 4 is the one place
behavior visibly changes for a *new* mission started through the UI, and only because a human
explicitly chose `army` in the composer — never for an API-started mission that omits the field.

### State transitions and who fires them

- **`CEZ:DIRECT`'s three actions** — `stop` transitions the target child through the existing cancel
  cascade (terminal, fired by the parent's own turn-end marker handling); `message`/`rescope`
  deliver text into the child's open session without changing its status at all (fired the same
  way). None of the three touch the *parent's* own park decision.
  Fired synchronously by the parent's own turn-end handler, never by the engine on its own.
- **`retryCount`/`retryOf`** — plain data, written once at spawn time when `retry_of` is present, read
  only at a future spawn to compute the inherited limit; no timer, no park state.
  Fired by `spawnChildren`, the same place every other spawn field is written.
- **Scope-overlap note** — one extra transcript note per collision per spawn call; no state, no
  transition to track.
- **Worktree-mismatch → `blocked` report** — fired once, at the exact moment `reportSettledChildToParent`
  builds the report for a settling child; not a new run status, only a forced report shape (same
  mechanism as Mission 1 item 4).
- **Root reaching `review`** — identical lifecycle to any other `review` run today: a human sends
  feedback (`deliverMessage` reopens the session) or calls `POST /runs/:id/pr` (unchanged) to
  publish the draft. No new mechanism, only a widened eligibility check.
- **Mission-scoped parallel cap** — a queued run whose mission is at capacity stays `queued`
  (unchanged status), simply skipped in `pump()`'s dequeue scan each tick until a mission sibling
  frees a slot; fired implicitly by every `pump()` invocation, the same as the existing account-hold
  skip.

### Tests to pin

`packages/cezar/src/units/engine.test.ts` — mission block present for a rank-2+ child, absent for a
squad's lone centurion; sibling lines never include the child itself; the learned-reports block
bounded at 3, newest-first; a two-wave spawn where wave 2's envelope contains wave 1's settled
result. `packages/cezar/src/workflows/run.test.ts` (or `units-engine.test.ts`) — a `CEZ:DIRECT
message` delivered without disturbing the parent's own park state; `stop` cascades exactly like
`POST /runs/:id/cancel`; a settled child is refused; a non-child run id is refused; a `CEZ:DIRECT` in
the same turn as `CEZ:SPAWN` — both take effect. `retry_of` naming an unrelated run is refused; a
retry chain exceeding the inherited limit is refused at the `(limit+1)`th with the count named in
the note; an ordinary spawn naming no `retry_of` is unaffected. Scope-overlap: identical scopes →
one note, both still spawn; segment-prefix overlap with an in-flight sibling → note;
`packages/billing` vs `packages/billing-utils` → no note (false-positive guard, real regression
target). A worktree-mismatch fixture at settle → `blocked` report naming the discrepancy; a normal
matching-branch settle → unaffected. `settleSuccess` tests — an autonomous mission **root** with the
review gate on and a non-empty diff parks at `review`, not `done`; a mission **child** (legate or
centurion) with the review gate on still settles straight to `done` — the root exception must not
leak downward; with the gate at its off default, a root's terminal settle is byte-identical to
before this item. New route tests (alongside `missions-api.test.ts`) — `GET` returns every run whose
`unit.missionId` matches, root first; cancel-by-mission-id cascades identically to cancel-by-root-id
on the same fixture tree. `pump()`/concurrency test — two missions each with `maxParallel: 1` run
one child at a time each, but the two missions run concurrently with each other (proving the cap is
per-mission, not global); a mission with no `maxParallel` set behaves exactly as today's
global-only gating.

### Suggested legate/centurion split and rough budget

Four centurions, mostly parallel after the Legate splits the shared `run.ts` sections by line range
up front to avoid collision (per this plan's own opening note: disjoint functions, not files):
- **Centurion A** — item 1 (`childTaskEnvelope`, isolated to `engine.ts`). ~$4.
- **Centurion B** — items 2 and 3 together (`CEZ:DIRECT` + `retry_of`, both touch
  `handleUnitMarkers`/`spawnChildren` and the spawn schema — doing them separately would double the
  schema-touch conflict risk). ~$6.
- **Centurion C** — items 4, 5 and 6 together (all three touch `spawnChildren`'s neighborhood or
  `settleSuccess`/`reportSettledChildToParent` — same file, adjacent functions, better as one
  centurion's sequenced work than three separate diffs against the same region). ~$7.
- **Centurion D** — items 7 and 8 (new routes + the mission-scoped parallel limit — both touch
  `server.ts` and `contract/src/units.ts`'s route-adjacent schemas). ~$6.
- **Legate** — pre-split the shared `run.ts`/`engine.ts` line ranges before spawning, review and
  merge all four in sequence (B and C both touch `run.ts` — merge B first, then rebase C's diff on
  top before accepting). ~$7.
- **Total: ~$30.**

### Acceptance criteria

- A rank-2+ child's envelope contains a `## Mission brief` naming the root objective, budget and
  remaining spend, and a `## Siblings spawned with you` block listing its co-spawned siblings' scope.
- A commander can send `CEZ:DIRECT {"child":"...","action":"stop"}` and the named child cascades to
  `cancelled` exactly as `POST /runs/:id/cancel` would.
- A fourth spawn naming `retry_of` a child whose chain already hit its inherited `retry_limit` is
  refused with the count in the refusal note.
- Two children spawned with identical or prefix-overlapping `scope` values both still spawn, with one
  extra `danger` note naming both.
- A child that committed to a branch other than its assigned one settles with `status: 'blocked'`
  naming the mismatch, not a clean `done`.
- With the review gate on, a mission root with a non-empty diff parks at `review`; its own legate and
  centurion children still settle straight to `done`.
- `GET .../missions/:id` and `POST .../missions/:id/cancel` both work against a live fixture tree.
- Two `army` missions each capped at `maxParallel: 2` run 2 children each concurrently (4 total, if
  the global/project cap allows), never more than 2 *per mission* even when idle global capacity
  exists.

### Dependencies

Mission 2 (`spawnChildren`, `engine.ts`'s exported surface). Item 5 (worktree isolation) and item 6
(review gate) both read `reportSettledChildToParent`/`settleSuccess`, which Mission 1 item 4 and
Mission 2 item 1 also touch — sequence this mission's Centurion C to start only after Mission 2 is
fully merged, not just started.

---

## Mission 4 — verification and defaults

**Depends on Mission 3** (the review step reads the envelope Mission 3 item 1 composes and the
settle machinery Mission 3 items 5-6 finish wiring).

### Goal

Ship the Review Centurion the user's decision #3 calls for, so a parent's acceptance of a child's
work depends on more than the child's own prose; give the parent structurally trustworthy facts
about what a child actually did, not just what it claims; ship per-role ladder defaults as a
composer convenience without touching the zero-config default path; and be honest about where the
scope brake is real.

### Work items

**1. The Review Centurion — design and wiring.**
*Source: this plan's Resolved assumptions D3, answering `00-SUMMARY.md` open question 11 with
option (4) of `02-roles/SUMMARY.md` P9's own ranked list (a dedicated review rank), not option (1)
(engine-run `verify_commands`) that document's own text ranked first on trust grounds alone.*
**Who spawns it.** The child's own parent (legate or Caesar), automatically, immediately after a
centurion settles and *before* that settlement is delivered to the parent's own session as an
acceptable report — i.e. inserted between a child's `CEZ:REPORT`/settle and
`reportSettledChildToParent`'s delivery. Implemented as a new `unitRoleSchema` value,
`'review-centurion'` (`contract/src/units.ts:31-33`, alongside `caesar`/`legate`/`centurion`), spawned
via the same `spawnChildren` machinery Mission 3 already touches, with `CHILD_ROLE` (`engine.ts:21-25`)
extended so a settled centurion's parent can spawn exactly one review-centurion per settled child
(never a review-centurion spawning another — `CHILD_ROLE['review-centurion'] === undefined`,
mirroring today's `centurion → undefined` terminal entry).
**What it reads.** The settled child's diff (`git diff <baseBranch>..HEAD` in the child's own
worktree, still reachable via `worktreeOf`/`workingDirectoryOf`, `server.ts:4557-4563`, before
retention reclaims it — coordinate with Mission 3 item 5's worktree-mismatch check, which reads the
same data), the child's own `CEZ:REPORT` (`result`/`evidence`/`side_effects`/`errors`), and the
`success_criteria`/`required_evidence` strings from the *original* spawn payload (currently written
into the envelope and never read back, `02-roles/SUMMARY.md` F5 — this is precisely where they
finally get read).
**Its report shape.** A dedicated verdict schema, distinct from `unitReportSchema` (which stays
generic prose for every other rank):
```ts
reviewVerdictSchema = z.object({
  verdict: z.enum(['accept', 'reject', 'accept-with-notes']),
  criteria_met: z.array(z.object({ criterion: z.string().max(400), met: z.boolean(), note: z.string().max(400).optional() })).max(10),
  concerns: z.array(z.string().max(400)).max(10),
})
```
**How the parent uses it.** The verdict is appended to the delivered report text
(`childSettleReport`'s output) as a `## Review` block before the original commander ever sees the
child's own claims — `reject` forces the delivered report's `status` to `'blocked'` (reusing the same
forced-status mechanism Mission 1 item 4 and Mission 3 item 5 both already use, now a third
consumer of the same pattern) regardless of what the child itself claimed, so a parent cannot accept
what the review step rejected without deliberately overriding it.
**Cost.** Roughly doubles the cost of a reviewed piece of work, by design — the user's decision D3
accepts this explicitly.

**2. Split the report into "child claims" vs "engine observes."**
*Source: `02-roles/SUMMARY.md` F6/P8 (= `00-SUMMARY.md` R14, the non-review-centurion half of it).*
Extend what the engine derives at settle time, alongside the existing cost/`diffStat` append
(`engine.ts:183-186`, confirmed in `childSettleReport`) — deliberately **not** new child-authored
schema fields, since a child self-reporting these is no more trustworthy than its prose:
```ts
commitSha: string;      // the child's HEAD in its own worktree at settle
filesTouched: string[]; // git diff --name-only <baseBranch>..HEAD in the child's worktree
```
`commitSha` pins exactly what was reviewed (`branch` moves if the child commits again after
settling); `filesTouched` gives a cheap scope audit `diffStat`'s bare counts (`store.ts:124-131`,
confirmed: `adds`/`dels`/`files`/`repointed?`, no paths) cannot. Both are read-only git operations on
a worktree the engine already owns, and both are exactly the data source the Review Centurion (item
1) also needs — implement this first within the mission so item 1 consumes it rather than
duplicating the git plumbing.

**3. Ship per-role ladder defaults as composer pre-fill only (user decision D4).**
*Source: `02-roles/SUMMARY.md` F9/P5 (= `00-SUMMARY.md` R25), constrained by this plan's D4.*
The concrete model table from `02-roles/SUMMARY.md` P5 (Caesar `claude-fable-5-1`, Legate
`claude-opus-5`, Centurion `claude-sonnet-5`) ships **only** in the `/missions/new` composer as the
pre-filled ladder values a human sees and can edit before submitting — never as a
`DEFAULT_UNIT_LADDER` constant consulted by `run.ts`'s spawn path or `server.ts`'s root creation.
This is a deliberate divergence from P5's own proposed engine-level default: P5 states plainly that
shipping it as a real default is "a real behaviour change" for zero-config missions; D4 accepts the
UX benefit and explicitly declines that risk. `unitLadderSchema` stays exactly as documented in the
house spec (`unitRoleSchema`-keyed, fully `.partial()`) with no code change beyond the composer's
own form defaults.

**4. Document and, where practical, restrict the scope brake on codex/opencode.**
*Source: `02-roles/SUMMARY.md` F2/P3 (= `00-SUMMARY.md` R8).*
Confirmed still true: `codex-app-server-runner.ts:56-58` and `opencode-server-runner.ts:46-47` both
state `spec.allowedTools` is ignored (running with full sandbox/approval bypass); only
`claude-cli-runner.ts:381-383` turns it into a real `--allowedTools` argument. Two changes, cheapest
first: (a) tell the child which situation it's in, inside Mission 3 item 1's own envelope — one
line derived from the same predicate `unitSubagentTools` uses (`engine.ts:112-120`):
`- Backend: ${runner} (${hasSubagentTool ? 'legionaries available' : 'no sub-agent tool on this backend — work sequentially'})`,
extended with whether `allowed_tools` is enforced or advisory-only for that backend; (b) document
the gap loudly in the mission composer's own copy and in `AGENTS.md`/`AGENT_PROTOCOL.md` — "on codex
and opencode, `scope` and `allowed_tools` are advisory prompt text, not an enforced boundary."
*Restriction, optional and scoped conservatively:* rather than a hard backend restriction on
`army`/`squad` (which the audit itself does not recommend without its own separate design review),
this item's restriction half is limited to a composer-level warning banner when a non-`claude`
backend is selected for a spawn-capable role — no engine-level refusal, since that would be a new
default-path change this mission's own budget does not include design review for.

### Files and functions touched

`packages/contract/src/units.ts` (`unitRoleSchema` — add `'review-centurion'`; new
`reviewVerdictSchema`), `packages/cezar/src/units/engine.ts` (`CHILD_ROLE`, `childSettleReport` —
`commitSha`/`filesTouched` append, review-block append), `packages/cezar/src/workflows/run.ts`
(`reportSettledChildToParent` — insert the review-centurion spawn before delivery, `spawnChildren`
for the new role), `packages/cezar/src/units/prompts.ts` (new `REVIEW_CENTURION_PROMPT`, and the
`unitSubagentTools`-derived backend line in the shared envelope helper from Mission 3 item 1),
`packages/web/src/routes/missions/missions-new.tsx` (or wherever the composer's ladder form lives —
pre-fill values only, plus the non-claude backend warning banner).

### Default-path statement

Item 1 (Review Centurion): **the one real default-path change in this mission**, but scoped
narrowly and accepted by decision D3 — a mission that spawns a centurion now also spawns a
review-centurion after it settles, roughly doubling cost for that piece of work, by design, with no
knob to opt out (the user's decision explicitly wants this as the verification story, not an
optional extra). Item 2 (claims vs observes split): the engine-derived pair rides on the delivered
text like `diffStat` already does — no migration, and the schema addition is additive with no
required fields. Item 3 (ladder defaults): zero engine-level behavior change — an API-started
mission with no `ladder` field still gets one model across all three ranks, exactly as today; only a
human going through `/missions/new` sees the new pre-filled values, and can still clear them. Item 4
(backend documentation): additive envelope text and composer copy; the optional composer warning
banner is UI-only, never a spawn refusal.

### State transitions and who fires them

- **Review-centurion spawned** — fired automatically by the engine (not by a marker the parent
  writes) the instant a plain centurion settles, before that settlement reaches the parent's own
  session. This is the one new *automatic* spawn in the whole units feature — every other spawn in
  Missions 1-3 is marker-driven by a commander's own turn.
- **Review verdict → forced report status** — `reject` forces `status: 'blocked'` on the delivered
  report, the third consumer of the forced-status mechanism (after Mission 1 item 4's unanswered-ask
  case and Mission 3 item 5's worktree-mismatch case); `accept`/`accept-with-notes` leave the child's
  own reported status untouched, with the verdict appended as context.
- **`commitSha`/`filesTouched`** — computed once, at the same settle instant `diffStat` already is;
  no lifecycle of their own.
- **Ladder pre-fill** — a pure form-default in the composer; no backend state, no transition.

### Tests to pin

`packages/cezar/src/units/engine.test.ts` — `childSettleReport` appends `commitSha`/`filesTouched` for
a child with a `baseBranch`; a review-centurion role is a valid spawn target and its own further
spawn is refused (`CHILD_ROLE['review-centurion'] === undefined`, mirroring the existing centurion
test at `engine.test.ts:106`). `packages/cezar/src/units/markers.test.ts` — the new optional
report-derived fields parse; `unitReportSchema` staying non-`.strict()`
(`contract/src/units.ts:70-73`, confirmed) is re-confirmed as still the right call once the schema
carries these trust-bearing fields. A `run.ts` integration test (new, alongside
`units-engine.test.ts`) — a plain centurion settling triggers exactly one review-centurion spawn,
never two even if the settle path is re-entered; a `reject` verdict forces the delivered report to
`status: 'blocked'` even when the child's own `CEZ:REPORT` claimed `done`; an `accept` verdict passes
the child's own status through unchanged. Composer test (web) — the ladder form pre-fills the three
models for a new `army` mission and leaves them editable; selecting a non-claude backend for a
spawn-capable role shows the advisory-only warning.

### Suggested legate/centurion split and rough budget

- **Centurion A** — item 2 first (`commitSha`/`filesTouched`), since item 1 (Legate-supervised,
  below) consumes it directly. ~$4.
- **Legate directly** (not delegated further — this is the highest-judgement item in the whole
  plan and the audit's own reasoning for D3 is that independent judgement is the point) — item 1,
  the Review Centurion design and wiring, once Centurion A's git plumbing lands. ~$10.
- **Centurion B** — item 3 (composer pre-fill only, small and isolated to the web package). ~$3.
- **Centurion C** — item 4 (envelope backend line + documentation + optional warning banner). ~$4.
- **Legate** — review/merge, plus its own item 1 work above. ~$3 (on top of the $10).
- **Total: ~$24.**

### Acceptance criteria

- A settled centurion automatically triggers exactly one review-centurion spawn before its report
  reaches its own parent's session.
- A review verdict of `reject` results in the parent seeing `status: 'blocked'` regardless of what
  the reviewed child's own `CEZ:REPORT` claimed.
- The delivered report for any settled centurion carries `commitSha` and `filesTouched` alongside
  the existing cost/`diffStat`.
- `/missions/new` pre-fills the three-model ladder for an `army` mission; an API-started mission
  with no `ladder` field still runs every rank on the project's `defaultRunner`, unchanged.
- Selecting codex or opencode for a spawn-capable role shows the advisory-only warning; no spawn is
  refused on that basis.

### Dependencies

Mission 3 (the envelope item 1 extends, and the settle machinery items 5-6 finish wiring, both feed
this mission's review step and forced-status mechanism).

---

## Deferred

Explicitly out of scope for all four missions above, carried forward from `00-SUMMARY.md`'s own
"not sequenced into these three, deliberately deferred" list plus items this plan's own missions
identified as out of their reach:

- **A cockpit surface for the escalation ladder** — a view showing where a question currently sits
  in the tree and which rank is holding it. The ladder's engine and marker halves ship in Mission 2
  (items 5-6); the Guard inbox learns to *exclude* a question waiting on a live ancestor and to
  label a capped-out one, which is enough to keep the inbox honest, but there is no affordance for
  watching a question travel. UI-only, no engine dependency, land it whenever convenient.
- **Engine-run `verify_commands`** (`02-roles/SUMMARY.md` P9's option 1). Superseded by decision D3
  — the Review Centurion is the chosen verification mechanism; engine-executed child-named strings
  remain unbuilt and, per D3's own reasoning, deliberately so.
- **A fourth `unitSizeSchema` value (Caesar→Centurion, no Legate rung).** Superseded by decision D1
  — the Legate rank stays for every mission size; the mission-scoped parallel limit (D2, Mission 3
  item 8) is the chosen fix for the concurrency complaint that motivated this option.
  `00-SUMMARY.md` open question 9's options (a) and (c) are also closed by D1/D2 for the same
  reason.
- **Raising the global `resources.maxParallel` semaphore.** Explicitly rejected by decision D2 in
  favor of the mission-scoped field — its cross-project blast radius is exactly what D2 avoids.
- **Legionary fan-out for codex/opencode/pi centurions.** `02-roles/SUMMARY.md` F11 judges the
  current state acceptable as shipped (the prompt claims no capability that isn't there); Mission
  4 item 4 documents the *undocumented* half of the same root cause (the scope brake) without
  reopening this one.
- **A hard backend restriction refusing `army`/`squad` on codex/opencode.** Mission 4 item 4 ships
  the documentation and a composer warning only; an engine-level refusal is left for a future,
  separately-scoped design pass, per `02-roles/SUMMARY.md`'s own recommendation against building
  it without one.
- **Mission-aware worktree retention** (never reclaiming a child's worktree until its branch is
  proven merged). `03-lifecycle-cockpit/SUMMARY.md` F9/P11 name this as a deliberate follow-up, not
  bundled into Mission 3's narrower fix (telling the truth about a *reclaimed* worktree on the three
  read routes) — left exactly as deferred as that document already states.
- **A cascading "Stop mission" button and re-budget affordance in the cockpit UI**
  (`03-lifecycle-cockpit/SUMMARY.md` P12). The backend halves both ship (Mission 3 item 7's cancel
  route, Mission 2 item 2's budget PATCH); the UI surface consuming them is left for a follow-up
  pass, since it is a UI-only addition with no engine dependency blocking it from landing whenever
  convenient.
- **An on-disk mission ledger file.** `00-SUMMARY.md` R28 and `03-lifecycle-cockpit/SUMMARY.md` F14
  both recommend *against* building this — `runs.json` (via `archiveFinished`, which only ever
  stamps `archived: true` and never deletes) already serves the purpose. Recorded here so it is not
  proposed again without re-litigating that verdict.
- **Configurable `MAX_PENDING_REPORTS`.** Left at its constant `20` (`engine.ts:34`); only the
  "surface dropped reports" hygiene item (`00-SUMMARY.md` R28) is in scope, and only if a mission
  above happens to touch `withPendingReport` for another reason — none currently do, so this is a
  standalone follow-up.
- **Phone-drill-in for the Missions tree.** Out of scope per the original house spec
  (`2026-09-08-units-hierarchy.md` "Out of scope") and untouched by anything in this plan.

## Open questions remaining

Deduplicated against `00-SUMMARY.md`'s own list (§e) and the two per-audit lists it merged; items
answered by this plan's Resolved assumptions or by a specific mission's work item are marked
resolved below rather than repeated as open.

1. **The escalation round cap's value** (Mission 2 item 5 ships the *mechanism*, defaulted to 3).
   Is 3 round-trips right, or should it scale with rank distance (a legate↔Caesar hop costs more
   than centurion↔legate, since the middle rank burns budget deciding)? The default is safe either
   way — the cap only ever routes a question to the human *sooner* — so this does not block
   Mission 2, but it is worth ruling on before the ladder has real usage to calibrate against.
2. **`MAX_PENDING_REPORTS = 20`.** Keep as a constant and just surface drops, or make it
   configurable for army-sized missions? Not touched by any mission above; genuinely open.
3. **Should `rescope` be `CEZ:DIRECT`'s own distinct action value** (as this plan's Mission 3 item 2
   specifies it), **or folded into `message` with a prefix?** This plan picked the distinct-value
   shape for transcript legibility, matching `01-communication/SUMMARY.md` P8's own choice, but the
   audit itself left this open (its own open question 7) and it is cheap enough to revisit during
   Mission 3's own implementation without replanning.
4. **Ship each mission's engine work and its prompt changes in the same PR, or land the engine
   first and the prompts separately?** Applies most to Mission 3 items 2-3 (`CEZ:DIRECT`,
   `retry_of`) — both are inert until their prompt teaches them, per this audit's own "a
   replacement that ships OFF is not a replacement" standard (`01-communication/SUMMARY.md` F16).
   This plan recommends the same-PR shape throughout (stated per-mission above) but the user has not
   explicitly ruled on it as a standing policy.
5. **Does the Review Centurion (Mission 4 item 1) get its own budget carve-out from the reviewed
   centurion's allotment, or from the commissioning parent's remaining budget directly?** Not
   specified by the user's decision D3, which fixes *that* a review step exists and *roughly what it
   costs* (double), but not *whose ledger* absorbs it. This plan's design assumes the parent's own
   remaining budget (the same pool `spawnChildren` already carves every child from), but this should
   be confirmed before Mission 4 starts, since it changes `carveChildBudgets`' arithmetic in a way
   this plan has not fully specified.
6. **Should the mission-scoped `maxParallel` (Mission 3 item 8, decision D2) be settable after
   mission creation** (via the same budget-PATCH-style route Mission 2 item 2 adds for budget), **or
   fixed at composer time only?** The user's decision specifies the field and its default and
   pre-fill, not whether it is ever adjustable mid-mission. This plan's Mission 3 item 8 ships it as
   set-once at creation; a follow-up PATCH route is a small addition if the answer is yes.
