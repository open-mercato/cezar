# Units improvements — SUMMARY

> Synthesis of three independent audits of cezar's mission (units) feature —
> `01-communication/SUMMARY.md`, `02-roles/SUMMARY.md`, and the three files in
> `03-lifecycle-cockpit/` (no SUMMARY.md there yet; a sibling is writing one). All source citations
> in those five documents were re-read at HEAD `8ed75a05` in this worktree; a further batch was
> re-opened directly for this document (list at the end). Written for one decision: **how to build
> the best setup for complicated autonomous work in which agents have real competence and real
> responsibility for the final goal, not just their own task order.**
>
> This document adds nothing new by way of code-reading except seven engine defects Caesar (the
> mission's own root run) observed first-hand while *running* this very audit — folded in below,
> each mapped to an existing finding id or marked NEW.

---

## (a) Does each rank own the final goal? — the blunt verdict

**No rank fully does, and the reasons are different at each layer, and they compound.**

**Caesar (root).** Has the *information* — the user's full objective, constraints and budget are
assembled once, for it (`server.ts:3476-3480`). Has the *competence* the prompt claims. Does **not**
reliably have the *responsibility*, because the mechanisms meant to let it hold a child to the goal
are mostly prose the engine never checks (`scope`, `success_criteria`, `required_evidence`,
`retry_limit` — 02-roles/SUMMARY.md's verdict, restated below), and because the prompt it is given
is internally contradictory about its own core duty: merge accepted children's work (mandatory,
`CHILD_BRANCH_RULE:38`) vs. never merge anything (absolute, `GUARD_RULE:79`) — 02-roles/SUMMARY.md
F1. A commander that reads both literally cannot act. Below that: this very mission's Legate had to
*resolve* that contradiction unilaterally to avoid deadlocking (02-roles/SUMMARY.md, "Note on this
document's own provenance") — i.e. today, holding the mission to its goal already depends on an
agent silently overriding its own written rule correctly, not on the rule being correct.

**Legate.** Competence: yes. Information: markedly worse — the mission objective, constraints and
budget stop at the root; a Legate is accountable only to whatever prose its Caesar chose to restate
(01-communication/SUMMARY.md F9, 02-roles/SUMMARY.md F4 — the same gap, found by both audits
independently, at the same code: `childTaskEnvelope`, `engine.ts:88-102`, whose own doc comment
says it outright: *"A child sees this text and nothing else the parent knows."*). Responsibility:
structurally sound (review, adjudicate, carry contradictions up) but exercised entirely on trust —
a Legate's only tool for validating a Centurion's "done" is reading the diff itself, in its own
budget, because the report schema is free text past `status` (02-roles/SUMMARY.md F6). And — this is
new, empirical, from this mission — the *engine itself* actively worked against the Legate doing its
job: real spawn budget was refused while real dollars sat unspent (see D5 below), a spawn's own
`CEZ:MONITORING` follow-through could get the whole turn refused as invalid JSON (D1-D4), and a
`waiting` legate that survives a restart can be silently declared "done" with nothing having
happened (D6). **A Legate trying to act responsibly is fighting its own runtime as much as the
mission.**

**Centurion.** Full competence and, for its own narrow task order, adequate information — but *zero
mission awareness by design* (no sibling visibility, no mission id in its envelope,
01-communication/SUMMARY.md F9/F11) and *zero verified enforcement of its own boundary*: `scope` is
never persisted or checked (01-F12/02-F12), and on two of four supported backends
(`codex`, `opencode`) `allowed_tools` is silently ignored — a spawn's stated brake is decorative and
nothing tells the user (02-roles/SUMMARY.md F2). This mission witnessed the worst-case outcome of
exactly that gap: a Centurion committed into the **user's own main checkout**, on the **shared
branch** `feat/units-mvp`, while its assigned branch stayed empty — nothing detected or prevented it
(01-communication/SUMMARY.md F5, empirical). A rank can have all the competence in the world and
still betray the final goal if nothing in the runtime enforces where its authority ends.

**Net verdict.** The *role design* (who reports to whom, who merges what, who escalates) is largely
coherent once its two self-contradictions are fixed (§b, R4/R20) — 02-roles/SUMMARY.md's own
headline. What actually threatens ownership of the final goal today is **two layers below the role
design**: (1) the downward information pipe is too narrow for a child to be meaningfully
*accountable* to the goal rather than to a lossy paraphrase of it, and (2) the engine's own
turn-end/marker/budget/restart machinery has live, reproducible defects (D1-D7) that can silently
convert honest work into a false "done" or starve a mission of budget it still has. Fixing the
prompts without fixing the engine leaves agents with the right instructions and a runtime that
occasionally refuses to let them follow them.

---

## (b) The ranked, deduplicated proposal list

One list across all three audits. Cross-audit duplicates are merged into one entry naming every
source. Severity and effort are as judged by the source doc(s); where two docs disagreed, the
higher severity is kept and the disagreement is noted. `label` = **defect-fix** (bug in
already-built behavior) or **redesign** (new mechanism / structural change).

| # | Finding / proposal | Source(s) | Severity | Effort | Label |
|---|---|---|---|---|---|
| R1 | Marker-parsing spawn-refusal death spiral: the prompt orders `CEZ:SPAWN` then a separate `CEZ:MONITORING` line in the *same* turn (`prompts.ts:99,130`), but the parser's candidate regex (`markers.ts:35`) captures from the keyword to end-of-turn, swallowing the trailing marker (or an earlier prose mention) and refusing a by-the-book spawn as invalid JSON; the refusal never reaches the model, the run idles the full 15-minute `IDLE_TIMEOUT_MS`, and settles `done` with an empty branch | **NEW** (D1-D4, this mission) | **CRITICAL** | S | defect-fix |
| R2 | Worktree/branch isolation is unenforced — empirically breached: a Centurion committed into the user's own main checkout, on the shared branch `feat/units-mvp`, undetected | 01-communication/SUMMARY.md F5 (**= D7**) | **CRITICAL** | M | defect-fix |
| R3 | A settled child's unspent budget reservation is never released back to its parent — independently found and evidenced with live dollar figures by three separate audits | 01-communication/SUMMARY.md F4 + 02-roles/SUMMARY.md F8 + 03-lifecycle-cockpit/budget-and-restart.md F3 | **CRITICAL/HIGH** | S | defect-fix |
| R4 | `GUARD_RULE` and `CHILD_BRANCH_RULE` give commanders opposite orders about merging (mandate vs. absolute ban) in the same assembled prompt | 02-roles/SUMMARY.md F1 | **CRITICAL** | S | defect-fix |
| R5 | The Guard inbox (`needsGuard`) conflates a genuine pending question with a budget halt, an exhausted nudge cap, and an ordinary turn end — and separately never flags a run whose auto-wake is permanently exhausted | 03-lifecycle-cockpit/cockpit.md F2, F2b + 01-communication/SUMMARY.md F15 | **CRITICAL** | S | defect-fix |
| R6 | Every unit run is created `autonomous: true` unconditionally, so no mission run — root included — can ever reach the `review` gate, even in a repo that has explicitly turned it on | 03-lifecycle-cockpit/branches-and-end-state.md F2 | **CRITICAL** | S | defect-fix |
| R7 | Nothing in the codebase ever opens, or nudges toward, a finished mission's draft PR — the only mechanism is a manual, non-mission-aware route with no trigger | 03-lifecycle-cockpit/branches-and-end-state.md F3 | **CRITICAL** | S | defect-fix |
| R8 | `scope`/`allowed_tools` are inert on 2 of 4 backends (codex, opencode) and nothing tells the user the brake is decorative there | 02-roles/SUMMARY.md F2 | **CRITICAL** | S (document) / M (make it a fact the ladder can reason about) | defect-fix / redesign |
| R9 | Restart force-settles every `waiting` unit run to `done`, discarding `overBudget` and delivering a false "done" report | 01-communication/SUMMARY.md F7 + 03-lifecycle-cockpit/budget-and-restart.md F1 (**= D6**) | **HIGH** | S | defect-fix |
| R10 | The autonomous nudge does not exist in `runAgentStep`, so every unit child's first turn can park with no nudge at all — fix already authored, unmerged (`b5f0b316`) | 01-communication/SUMMARY.md F1 | **HIGH** | S | defect-fix |
| R11 | A child parked on `CEZ:ASK` is invisible to its parent yet still consumes a fan-out slot | 01-communication/SUMMARY.md F2 | **HIGH** | M | defect-fix |
| R12 | `CEZ:ASK` bypasses the tree entirely — every rank pages the human at the same rate regardless of hierarchy depth | 01-communication/SUMMARY.md F3 | **HIGH** | L | redesign |
| R13 | The downward envelope carries no mission context, no sibling visibility, no prior findings, and no way to intervene in a running child | 01-communication/SUMMARY.md F9, F10, F11, F17 + 02-roles/SUMMARY.md F4 | **HIGH** | S-M | defect-fix |
| R14 | `success_criteria`/`required_evidence` are written into the envelope and never read back; a report is trusted on prose alone | 02-roles/SUMMARY.md F5, F6 | **HIGH** | M-L | redesign |
| R15 | `retry_limit` is pure honor system — nothing counts actual respawns against it | 01-communication/SUMMARY.md F13 + 02-roles/SUMMARY.md F7 | **HIGH** | M-L (S for an honest interim fix) | redesign |
| R16 | A pending ask has no persisted representation on the run record | 01-communication/SUMMARY.md F8 | **HIGH** | M | defect-fix, prerequisite for R12 |
| R17 | `totalBudgetUsd` double-counts every carved-out child budget, overstating a mission's true ceiling by up to 50% (currently dead code — no UI consumer yet) | 03-lifecycle-cockpit/cockpit.md F1 (F3: scoping note) | **HIGH** | S | defect-fix |
| R18 | One terminal-transition path (`recover()`'s unresumable `running`→`failed` child) never reports to its parent at all | 03-lifecycle-cockpit/budget-and-restart.md F2 | **HIGH** | S-M | defect-fix |
| R19 | Uncommitted parent work is silently invisible to a spawned child — nothing checks working-tree cleanliness before forking | 03-lifecycle-cockpit/branches-and-end-state.md F1 | **HIGH** | S | defect-fix |
| R20 | "You do not edit files yourself. Not one." is falsified by the same prompt two paragraphs later (commit before spawn, resolve+commit sibling conflicts) | 02-roles/SUMMARY.md F3 | **HIGH** | S | defect-fix |
| R21 | An over-budget unit run has no path back to autonomous operation and no API can raise its ceiling — permanently sticky once parked | 03-lifecycle-cockpit/budget-and-restart.md F4 + 03-lifecycle-cockpit/branches-and-end-state.md F5 (budget portion) | **MEDIUM** | S-M | defect-fix |
| R22 | Sibling scope disjointness and parent→child scope containment are entirely unvalidated and unpersisted | 01-communication/SUMMARY.md F12 + 02-roles/SUMMARY.md F12 | **MEDIUM** | M | defect-fix (warn-only) |
| R23 | Worktree retention is project-wide and mission-blind, and misreports a reclaimed worktree as "never had one" to the cockpit's own diff/changes/commits routes | 03-lifecycle-cockpit/branches-and-end-state.md F4 | **MEDIUM** | S | defect-fix (message only, not the policy) |
| R24 | The missions API has exactly one route (`POST /missions`) — no `GET`, no mission-scoped cancel, no pause/resume | 03-lifecycle-cockpit/branches-and-end-state.md F5 (non-budget portion) | **MEDIUM** | S | defect-fix (additive routes) |
| R25 | The ladder ships no per-role defaults; a zero-config mission runs Caesar/Legate/Centurion on the same model | 02-roles/SUMMARY.md F9 | **MEDIUM** | S | redesign (real default-path change — needs sign-off, §e) |
| R26 | The Legate rank buys latency and dilution, not concurrency, at default `maxParallel=2` | 02-roles/SUMMARY.md F10 | **MEDIUM** | — (policy question, §e) | — |
| R27 | A zero-config mission (no `budgetUsd`) is not cost-safe: uncapped, up to 4-wide fan-out, three ranks deep, fully autonomous | 03-lifecycle-cockpit/budget-and-restart.md §2 | **MEDIUM** | M | redesign |
| R28 | Hygiene cluster (each low severity, S effort, defect-fix): dropped reports past `MAX_PENDING_REPORTS` are silent (01-F14); a stale code comment names the wrong slot exemption (02-F14); no test round-trips the `CEZ:REPORT` example (02-F15); the Centurion prompt assumes it always has a commander (02-F16); Caesar's "spawned as part of a larger structure" branch is unreachable (02-F13); the channel has no failure signal anywhere (01-F18); the ~40-nudge monitoring-wake tail is a pure cost with no payoff whenever R10 is the actual cause (01, unnumbered); an on-disk mission ledger is not worth building — `runs.json` already serves the purpose (03-branches F6, recommend *against*) | 01-communication/SUMMARY.md F14, F18 + 02-roles/SUMMARY.md F13, F14, F15, F16 + 03-lifecycle-cockpit/branches-and-end-state.md F6 | **LOW** | S | defect-fix |

**Notable duplicate worth flagging on its own:** the mid-flight budget top-up (part of R21) was
proposed *twice*, independently, by the two centurions who wrote `budget-and-restart.md` and
`branches-and-end-state.md` in the *same* 03 audit round — `PATCH .../runs/:id/unit {budgetUsd}`
vs. `PATCH /missions/:id/budget {budgetUsd}`. Same fix, different route shape; needs reconciling to
one, not built twice.

---

## (c) The same list, regrouped

**Fix-now defects** (cheap, high-confidence, mostly S-effort correctness bugs):
R1, R2, R3, R9, R10, R17, R18, R19, R23, R28.

**Communication and escalation ladder:**
R5, R11, R12, R16.
*(R28's "channel has no failure signal" and "wake-nudge cost tail" items also belong here.)*

**Roles, prompts and responsibility:**
R4, R8, R13, R14, R15, R20, R22, R25, R26.
*(R28's "Caesar-unreachable-branch", "commander wording", "no CEZ:REPORT round-trip test" items
also belong here.)*

**Budget, lifecycle and cockpit:**
R6, R7, R21, R24, R27.
*(R28's "on-disk mission ledger not needed" item also belongs here.)*

---

## (d) Recommended implementation order — follow-up missions

Three missions, **sequenced, not parallel** — `run.ts` and `engine.ts` are the load-bearing files
for nearly every finding above, so "disjoint" here means disjoint *functions*, not disjoint
*files*; running these three in parallel worktrees risks exactly the kind of silent merge collision
R2 already caught this mission doing once. Land in order.

**Mission 1 — Marker/turn-end engine correctness.** *No dependency; land first, everything else
gets easier once the transcript and the report actually reflect what happened.*
Fixes: R1 (D1-D4), R9 (D6), R10, R4 (prompt-only, same file already in scope).
Files it may touch: `packages/cezar/src/units/markers.ts`, `packages/cezar/src/units/prompts.ts`,
`packages/cezar/src/workflows/run.ts` — only the turn-end handlers inside `runContinuation`
(≈2900-3050) and `runAgentStep` (≈3676-3760), and `recover()`'s `waiting` branch (≈1328-1344) —
plus their tests: `markers.test.ts`, `prompts.test.ts`, `recover-unit.test.ts`,
`units-engine.test.ts`.

**Mission 2 — Budget & Guard truth.** *Depends on Mission 1 (shares `enforceUnitBudget`'s turn-end
call site); land second.*
Fixes: R3, R21, R17, R5.
Files it may touch: `packages/cezar/src/units/engine.ts` (`remainingBudgetUsd` only),
`packages/cezar/src/workflows/run.ts` (`carveChildBudgets` ≈1713-1739, `enforceUnitBudget`
≈1578-1593 only), `packages/cezar/src/server/server.ts` (one new budget PATCH route — reconcile the
two proposed shapes into one, see the duplicate note in §b), `packages/web/src/lib/missions.ts`
(`totalBudgetUsd`, `needsGuard`/`guardReason`), `packages/web/src/routes/missions/guard.tsx`, plus
`engine.test.ts` and `missions.test.ts`.

**Mission 3 — Downward context, scope integrity & mission end-state.** *Depends on Mission 2
(shares `spawnChildren` and `engine.ts`'s other exported functions); land third.*
Fixes: R13, R2, R19, R6, R7, R23, R24, R8 (documentation half), R22.
Files it may touch: `packages/cezar/src/units/engine.ts` (`childTaskEnvelope` only),
`packages/cezar/src/workflows/run.ts` (`spawnChildren` ≈1607-1699, `settleSuccess` ≈4152-4176
only), `packages/cezar/src/units/prompts.ts` (backend-capability line, scope-overlap docs),
`packages/cezar/src/server/server.ts` (missions `GET`/cancel routes, `worktreeOf` reclaimed
messaging), plus `engine.test.ts`.

**Not sequenced into these three, deliberately deferred:** R12 (escalation ladder), R14/R15
(engine-run verification, lineage-tracked retries) and R25/R27 (ladder defaults, cost-safe
zero-config) are each **L**-effort redesigns that change a default path or add real new mechanism —
they need the open questions in §e answered first, and each is large enough to be its own mission
once scoped.

---

## (e) Open questions for the user

Deduplicated across all three audits' own lists (01-communication had 8, 02-roles had 5; the three
03 files raised none as a formal list — their recommendations are folded into §b/§c above instead).

1. **P1's blast radius (01 Q1).** Rebasing the existing autonomous-nudge fix (`b5f0b316`, R10)
   changes every `#autonomous` run in the repo, not just units. Land it on `main` first and rebase
   the units branch past it, or fold it into the units work directly?
2. **Restart-recovery option for an unanswered question (01 Q2, feeds R9/R16).** On restart with an
   open `CEZ:ASK`: leave the run at `waiting` (honest, but looks stuck until someone visits
   `/guard`), or settle it while reporting `blocked` (smaller change, but the question is never
   actually answered)?
3. **Should the engine refuse a non-Caesar `CEZ:ASK` once an escalation ladder ships (01 Q3,
   feeds R12)?** Keep it as a permanent escape hatch at every rank, or restrict it once R12 exists?
4. **Escalation round cap (01 Q4, feeds R12).** Is 3 round-trips right, or should it scale with
   rank distance?
5. **Does `parent.costUsd` roll up descendants (01 Q5)?** Confirmed **no** by this pass and by
   03-lifecycle-cockpit/budget-and-restart.md §4 (`run.ts:2947,3674` sums only the run's own steps)
   — carried here only because R3's fix must not silently start double-counting if that ever
   changes.
6. **`MAX_PENDING_REPORTS = 20` (01 Q6).** Keep as a constant and just surface drops (part of R28),
   or make it configurable for army-sized missions?
7. **`rescope` as its own `CEZ:DIRECT` action (01 Q7, only relevant once R11/R12 ship)?** Keep it a
   distinct enum value for transcript legibility, or fold it into `message`?
8. **Ship engine work and prompt changes in the same PR (01 Q8), or land the engine first and the
   prompts separately?** Applies to R13, R15, R22 alike — each is inert until its prompt change
   teaches the marker/field, per this audit's own "a replacement that ships OFF is not a
   replacement" standard.
9. **A Caesar→Centurion size with no Legate rung (02 Q1, feeds R26)?** R26 shows the Legate rank
   buys no concurrency at `maxParallel=2` today — add a fourth `unitSizeSchema` value, or raise
   `maxParallel` (global, cross-project) so `army` pays off, or leave it and document when to use
   `squad` vs `army`?
10. **Should per-role ladder defaults (R25) ship as a real behaviour change, or as composer
    pre-fill only?** Shipping changes what every existing zero-config mission does; pre-filling
    keeps the default path untouched but leaves API-started missions on one model.
11. **How much verification should the engine perform on a child's behalf (02 Q3, feeds R14)?**
    Engine-run `verify_commands` at settle time is the only option that doesn't depend on the
    child's honesty, but it means the engine executes strings an agent wrote; a dedicated review
    rank is more trustworthy but roughly doubles cost.
12. **Is the `allowed_tools`/backend gap (R8) a documentation fix or a backend-support decision?**
    Document it loudly (cheap, honest), restrict `army`/`squad` to backends that can enforce it, or
    accept it as advisory everywhere?
13. **Does the current budget model match your intent (02 Q5, feeds R3/R21)?** Today a parent's
    headroom is consumed by promises even after they're discharged under budget — this audit treats
    that as a bug (R3). The counter-argument: it may be a *deliberate* conservative brake against a
    runaway tree, in which case the fix is to say so in the refusal note, not to release the money.

---

## D1-D7 — engine defects observed while running this mission

Verified at HEAD `8ed75a05` in this worktree (not carried over from the task order — every cited
line was reopened, see "Citations opened at HEAD" below).

| id | Summary | Existing finding? |
|---|---|---|
| D1 | `prompts.ts:99` (Caesar) and `:130` (Legate) order "after spawning, end your turn with a line containing exactly `CEZ:MONITORING`" — a *second* marker in the same turn as `CEZ:SPAWN`. The parser's candidate regex (`SPAWN_MARKER_CANDIDATE_RE`, `markers.ts:35`, `CEZ:SPAWN[ \t]+([\s\S]*)$`) captures from the keyword to end-of-turn, swallowing the trailing `CEZ:MONITORING` text; `JSON.parse` then fails on the extra trailing content, which is not a bracket-imbalance the repair helper (`closeUnbalancedJson`) can fix, so a by-the-book spawn is refused as `invalid-json`. | **NEW** |
| D2 | The same non-global `.exec()` matches the **first** occurrence of the keyword in the turn text, not the trailing one. If the model's own prose earlier in the turn mentions "CEZ:SPAWN" (e.g. narrating its plan) before the real marker line, the candidate regex anchors there instead and captures prose, not JSON — same `invalid-json` refusal, for a different reason than D1. | **NEW** |
| D3 | The per-event marker strip (`stripUnitMarkers`, called at `run.ts:2928` inside `runContinuation`'s `onEvent`, and its `runAgentStep` twin at `run.ts:3654`) runs `parseSpawnMarker`/`parseReportMarker` against **one streaming text event's own chunk**, independently of the per-turn parse (`handleUnitMarkers` on the full accumulated `turnText`, called shortly after at `run.ts:2960-2964`). A chunk that happens to contain a complete, valid marker on its own is stripped from the transcript at persist time — even when the full-turn parse later refuses the same marker (as in D1/D2) — so the transcript loses the one piece of evidence of what the agent actually tried to do. | **NEW** |
| D4 | The combination is silently fatal. The refusal note (`unitMarkerRejection`) is appended to the transcript only — nothing delivers it back into the model's own session, so no correction happens. Because the spawn never registers (`unitTurn.spawned` stays `false`), and because `runAgentStep`/`runContinuation`'s `monitoring` computation can also come up `false` in this state, the run parks at `waiting` and simply idles for the full `IDLE_TIMEOUT_MS = 15 * 60_000` (`run.ts:108`), at which point `armIdleTimer` (`run.ts:4256-4267`) closes the session outright. The run then settles `done` with an empty branch, and its parent receives that as a clean success report. **Observed twice this mission.** This is the same shape as R10 (nudge missing) and R9 (restart force-settles `waiting` as `done`) but is neither — it needs no restart and no nudge-cap exhaustion; the marker-refusal death spiral alone is sufficient. | **NEW** — related to, but distinct from, R9/R10/01-communication F1/F7 |
| D5 | A settled child's unspent budget is never released — the refusal that stopped this very mission's fourth centurion from being spawned. | **= R3** (01-communication/SUMMARY.md F4) |
| D6 | Restart settles a `waiting` run as `done`. | **= R9** (01-communication/SUMMARY.md F7) |
| D7 | Centurion `1477f47a` committed `9704bc31` into the user's own main checkout, on the shared branch `feat/units-mvp`. | **= R2** (01-communication/SUMMARY.md F5) |

---

## Citations opened at HEAD `8ed75a05` while writing this document

- `packages/cezar/src/units/prompts.ts:90-166` — full `CAESAR_PROMPT`/`LEGATE_PROMPT`/
  `CENTURION_PROMPT` bodies, to confirm the exact `CEZ:MONITORING` instruction wording and line
  numbers (`grep -n "CEZ:MONITORING" prompts.ts` → 99, 130, 154).
- `packages/cezar/src/units/markers.ts` — full file (134 lines): `SPAWN_MARKER_RE`/`REPORT_MARKER_RE`
  vs. the looser `SPAWN_MARKER_CANDIDATE_RE`/`REPORT_MARKER_CANDIDATE_RE` (line 35), `parseMarker`'s
  non-global `.exec()`, `stripSpawnMarker`/`stripReportMarker`.
- `packages/cezar/src/workflows/run.ts:108` — `IDLE_TIMEOUT_MS = 15 * 60_000`.
- `packages/cezar/src/workflows/run.ts:134-175` — `appendTurnText`, `stripDoneMarker`,
  `stripMonitoringMarker`, `stripUnitMarkers`, `unitMarkerRejection`.
- `packages/cezar/src/workflows/run.ts:2900-3050` — `runContinuation`'s turn-end `onEvent` handler:
  the per-event strip (`2928`), `handleUnitMarkers` call (`2960-2964`), `monitoring` computation
  (`2972-2980`), autonomous-nudge gating (`2988-3010`).
- `packages/cezar/src/workflows/run.ts:3676-3760` — `runAgentStep`'s twin turn-end handler,
  confirmed to have no autonomous-nudge branch at all (R10) and the same `monitoring` computation
  shape as `runContinuation`.
- `packages/cezar/src/workflows/run.ts:4250-4275` — `armIdleTimer`/`clearIdleTimer`.
- `git log --oneline -5` and `git merge-base HEAD cez/e44f25a3` — confirmed the fork point for this
  file is `8ed75a05`, the same commit as HEAD at the start of this task.

---

*Written by a centurion on `cez/9c64969f`, forked from `cez/e44f25a3`. Analysis and this one file
only — no other file in the repository was modified.*
