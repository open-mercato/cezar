# Units role design — audit summary (Caesar / Legate / Centurion)

What was audited: whether each rank of cezar's mission feature has the **competence, the
information and the responsibility** it needs to reach the *final goal of a mission*, not merely
its own task order. Subject: `.ai/specs/2026-09-08-units-hierarchy.md` as implemented at
**`df73cfa9`** (the fork point of this branch; every citation below was re-read against that
commit in this worktree, and the ones carried over from the three findings files were spot-checked
again before being quoted here — see "Verification" at the end).

Source files, all in this directory:

| File | Covers | Local findings |
|---|---|---|
| `01-responsibility-model.md` | Q1 contradictions, Q2 goal awareness, Q3 is the Legate rank worth it | F1-F5, P1-P5 |
| `02-validation-and-ladder.md` | Q4 report validation, Q5 report schema, Q6 ladder defaults, Q8 legionaries per backend | F1-F5, P1-P4 |
| `03-prompt-noop-audit.md` | Q7 no-op audit of the three role prompts | F1-F6, P1-P4 |

**Verdict.** Each rank has the *competence* it needs and, at the top, the *information*: Caesar is
seeded with the user's full objective and constraints. Below the root, both degrade.
**Information** is the sharper failure: the mission objective, the user's `## Constraints` block
and the mission budget are assembled once for the root run and never propagate downward
(`server.ts:3476-3480` used only at `:3518`; `childTaskEnvelope`, `engine.ts:88-102`, has no
mission-level field), so a Centurion two hops down is accountable to its parent's paraphrase
rather than to the user's actual ask — precisely the gap this audit was commissioned to find.
**Responsibility** is coherent in substance but *self-contradictory as written*: the same
assembled prompt orders a commander both to merge accepted child branches and to stop and ask
before "merging anything." And the mechanisms that would let a parent *hold a child to* the final
goal — `success_criteria`, `required_evidence`, `retry_limit`, `scope`, `allowed_tools` — are, to
varying degrees, prose that no code checks.

---

## Findings

Globally renumbered across the three files and ordered by severity. Each entry names its source
file and local number. Deduplication is noted inline; nothing has been dropped except true
duplicates.

### F1 — CRITICAL — `GUARD_RULE` and `CHILD_BRANCH_RULE` give commanders opposite orders about merging
*Source: `01-responsibility-model.md` F1; the same wording overlap was independently noticed as
`03-prompt-noop-audit.md` F6, which deferred it here — merged into this one finding.*

- `packages/cezar/src/units/prompts.ts:38` — "For each child you accept, merge its branch into your
  own worktree: `git merge --no-ff <child branch>`."
- `packages/cezar/src/units/prompts.ts:79` — "Before ANY action that is irreversible, financial, or
  widens your scope, end the turn with CEZ:ASK and stop. That includes: pushing to a shared branch,
  **merging anything**, …"
- Both constants are interpolated into the *same* assembled prompt for both commanding ranks:
  `CHILD_BRANCH_RULE` at `prompts.ts:107` (Caesar) and `:134` (Legate); `GUARD_RULE` at `:111` and
  `:138`.
- The test suite passes because the two halves are asserted independently and never against each
  other: `prompts.test.ts:161` asserts `/never merge/i` for every role, `prompts.test.ts:179`
  asserts `toContain('git merge --no-ff')` for caesar and legate.

**Why it matters.** Merging accepted child branches is the *only* mechanism the hierarchy has for
turning N children's work into one deliverable — nothing in the engine does it. A commander
following the prompt literally must either ignore the Guard rule or halt the mission at the first
accepted child. Resolved in full below.

### F2 — CRITICAL — a spawn's `scope` / `allowed_tools` brake is inert on two of four backends
*Source: `02-validation-and-ladder.md` F1.*

- `packages/cezar/src/core/codex-app-server-runner.ts:56-58` — "Codex has no per-tool allowlist, so
  `spec.allowedTools` is ignored" (running `sandbox: danger-full-access`, `approvalPolicy: never`).
- `packages/cezar/src/core/opencode-server-runner.ts:46-47` — "OpenCode has no per-tool allowlist,
  so `spec.allowedTools` is ignored."
- `packages/cezar/src/core/claude-cli-runner.ts:381-383` — `claude` is the one backend that turns
  `spec.allowedTools` into a real `--allowedTools` argument.
- The fields exist and are documented as brakes: `packages/contract/src/units.ts:136,140`;
  `prompts.ts:52` ("Give every sibling a DISJOINT scope") and `:53`.

**Why it matters.** The Guard rule's "stay inside your scope" and the whole task-order model assume
the brake is real. On codex and opencode a child spawned with `allowed_tools: ["Read"]` retains
unrestricted shell and filesystem access. This is broader than the legionary question that
surfaced it: the scope brake on the *task order itself* is decorative on half the supported
backends, and nothing tells the user that.

### F3 — HIGH — the absolute "you do not edit files. Not one." is falsified by the same prompt
*Source: `01-responsibility-model.md` F2.*

- `prompts.ts:90` (Caesar) — "You do not edit files yourself. Not one."
- `prompts.ts:121` (Legate) — the softer version of the same claim.
- Contradicted two paragraphs later by `prompts.ts:35` ("COMMIT your work before every CEZ:SPAWN")
  and `:39` ("Sibling conflicts are yours to resolve … resolve it in your worktree and commit the
  merge"), which cannot be satisfied without editing conflicted files.

**Why it matters.** A commander that takes line 90 literally refuses the integration work that is
its actual job; one that doesn't has been told two different things about its own role. The
coherent line is not "commanders never touch a file" but "commanders never do the *mission's* work
— they do the *integration* work, inside their own worktree."

### F4 — HIGH — the mission brief never reaches any rank below the root
*Source: `01-responsibility-model.md` F3. This is the audit's central question (Q2).*

- Objective and constraints are assembled once by `missionTask` (`server.ts:3476-3480`) and used
  once, for the root run's task (`server.ts:3518`, `:3522-3523`).
- `budgetUsd` lands once on the root's `unit.budgetUsd` (`server.ts:3537`) and is only ever consumed
  arithmetically by `remainingBudgetUsd` (`engine.ts:67-72`) — never restated to a child as prose.
- `childTaskEnvelope` (`engine.ts:88-102`, pinned by `engine.test.ts:75-92`) renders only
  scope / allowed tools / max cost / success criteria / required evidence / retry limit / parent
  branch / ordered-by. Its own doc comment (`engine.ts:83-84`) states the consequence outright: "A
  child sees this text and nothing else the parent knows."
- `spawnChildren` (`run.ts:1660`) passes exactly that envelope, and has `unit.missionId` in scope
  (read at `run.ts:1674`) but never reads the root record.

**Why it matters.** Under `army`, a user constraint like "never touch `packages/billing`" survives
to a Centurion only if a Legate happened to restate it verbatim in free-text prose. Nothing
enforces or checks that it did. Every rank is accountable to its task order; only the root is
accountable to the goal.

### F5 — HIGH — `success_criteria` and `required_evidence` are written out and never read back
*Source: `02-validation-and-ladder.md` F2 (Q4).*

- Every hit in the repository is the schema field, the envelope render, the prompt text describing
  it, or a test of those: `contract/src/units.ts:142-143`; `engine.ts:96-97`; `prompts.ts:46,55-56`;
  `markers.test.ts:48-49`; `prompts.test.ts:203`. (Re-verified by grep in this pass.)
- `childSettleReport` (`engine.ts:157-189`) appends only `cost` (`:183`) and `diffStat`
  (`:184-186`); it has no notion of the order it is settling against.

**Why it matters.** A child that ignores `required_evidence` entirely still produces a
schema-valid `CEZ:REPORT` and settles normally. The parent's only check is an agent reading prose
in its own context window.

### F6 — HIGH — `unitReportSchema` is free text except `status`
*Source: `02-validation-and-ladder.md` F3 (Q5).*

- `contract/src/units.ts:75-83` — `status` (enum) plus `result`, `evidence[]`, `side_effects[]`,
  `errors[]`, `recommended_next_action`, all narrative.
- The only trustworthy facts a parent receives are the two the *engine* appends from its own store:
  cost and `diffStat` — and `diffStat` is counts only, no paths and no sha
  (`packages/cezar/src/runs/store.ts:124-131`: `adds`, `dels`, `files`, `repointed?`).
- The design already concedes this: `prompts.ts:37` tells every parent to "read that branch's diff,
  run the tests and commands the child claims to have run" by hand.

**Why it matters.** Verification is pushed entirely onto the parent's budget and judgement, with no
structural cross-check — and it is the parent's budget that runs out first (see F8).

### F7 — HIGH — `retry_limit` is pure honor system
*Source: `03-prompt-noop-audit.md` F1.*

- `contract/src/units.ts:144` bounds the *payload* (`int 0-3`). No code counts actual respawns:
  the only other hits are the envelope render (`engine.ts:98`) and three prose mentions,
  `prompts.ts:103` (Caesar), `:132` (Legate), `:160` (Centurion). (Re-verified by grep in this
  pass; `run.ts:3503-3514`'s `onFail.retry` is unrelated workflow-step logic.)

**Why it matters.** It is the one brake in the spawn contract with no engine backstop at all —
unlike the fan-out cap (`run.ts:1627-1633`) and the budget cap (`run.ts:1720-1736`), which the
engine actively refuses. A commander may reasonably assume the engine counts, and stop
self-policing.

### F8 — HIGH — a settled child's *unspent* budget is never released back to its parent
*Not from the three source files — found first-hand while running this mission, and evidenced
below.*

- `remainingBudgetUsd` (`engine.ts:67-72`) computes `budgetUsd − costUsd − Σ children.budgetUsd`,
  summing every child's **promised** ceiling regardless of whether that child has settled or what
  it actually spent.
- `carveChildBudgets` refuses any spawn once that value is `≤ 0` (`run.ts:1718-1724`).
- Observed on this run: budget $12.00, own spend $7.29, three children promised $2.50 each
  ($7.50) but actually spent **$3.34 in total** (`$0.77 + $1.21 + $1.36`, from the run store).
  Remaining computes as `12 − 7.29 − 7.50 = −$2.79`, so every further spawn is refused —
  although $4.71 of real budget was left and $4.16 of the children's promises had been discharged
  unspent.
- No double-counting concern: a run's `costUsd` is summed from its own steps
  (`run.ts:2947`, `:3674`) and does not roll up children.

**Why it matters.** This is a *responsibility* defect, not just accounting: a Legate can be unable
to finish its own task order — here, to delegate the summary you are reading — because headroom is
held hostage by promises that were already fulfilled under budget. It penalises exactly the
behaviour the design wants (children that come in cheap) and it silently converts a well-run
mission into a truncated one.

### F9 — MEDIUM — the ladder ships no per-role defaults
*Source: `02-validation-and-ladder.md` F4 (Q6).*

- `unitLadderSchema` is `.partial()` over fully optional entries (`contract/src/units.ts:44-58`).
- An omitted rung falls back to the parent's own runner/model (`run.ts:1667-1668`) or, at the root,
  to one project-wide `defaultRunner` (`server.ts:3511`, `:3515`).

**Why it matters.** A zero-config mission runs Caesar, Legate and Centurion on the *same* model,
though the three do work with very different cost/judgement profiles.

### F10 — MEDIUM — the Legate rank buys latency and dilution, not concurrency, at default config
*Source: `01-responsibility-model.md` F4 (Q3).*

- `MAX_CHILDREN_IN_FLIGHT = 4` (`engine.ts:29`), enforced at `run.ts:1626-1633`, bounds what a
  parent may have *outstanding*, not what runs at once.
- Real concurrency is `maxParallel`, default **2**, global across all missions
  (`packages/cezar/src/config.ts:36`).
- Parked commanders are exempt from that count **outright** (`run.ts:682-687`; test title at
  `packages/cezar/src/workflows/units-engine.test.ts:178`, "surrenders the commander's slot to its
  children even past `maxMonitoringSessions`").

**Why it matters.** An `army` can have 16 centurion tasks nominally in flight while 2 execute. The
extra rank costs two session cold-starts, two rounds of budget carving (`engine.ts:67-72`) and —
until F4 is fixed — two lossy context hops, in exchange for no additional throughput.
`unitSizeSchema` (`contract/src/units.ts:168`) offers no Caesar→Centurion middle option.

### F11 — MEDIUM — Centurions get no legionary fan-out on codex, opencode or pi
*Source: `02-validation-and-ladder.md` F5 (Q8).*

- `unitSubagentTools` (`engine.ts:112-120`) adds `Task`/`Agent` only when
  `role === 'centurion' && backend === 'claude'`; pinned by `engine.test.ts:106`
  (`unitSubagentTools(['Read'], 'centurion', 'codex')` → `['Read']`).
- No non-claude runner has an equivalent primitive (codex `:45-58`, opencode `:37-47`, pi
  `pi-runner.ts:267-285`).
- The prompt is honest about it (`prompts.ts:148`, `:152`).

**Why it matters.** A parent sizes a task order assuming parallel legionaries, but the backend is
resolved *inside* `spawnChildren` (`run.ts:1667`) — after the sizing. **Judged acceptable as
shipped** (the prompt claims no capability that isn't there); the *undocumented* half of the same
root cause, F2, is not.

### F12 — MEDIUM — sibling scope disjointness and scope containment are unvalidated
*Source: `03-prompt-noop-audit.md` F3.*

- `unitSpawnSchema` (`contract/src/units.ts:128-153`) treats each `scope` as an independent,
  unchecked string. Nothing verifies two children's scopes are disjoint (`prompts.ts:52`) or that a
  Legate's children nest inside the Legate's own scope (`prompts.ts:126`).

**Why it matters.** `prompts.ts:52` calls overlapping scopes "the one failure mode this design
cannot recover from," and the prose is the only thing preventing it. It also means these lines are
strictly load-bearing and must not be trimmed as generic advice.

### F13 — MEDIUM — Caesar's "spawned as part of a larger structure" branch is unreachable
*Source: `03-prompt-noop-audit.md` F2.*

- `prompts.ts:113` instructs a Caesar to emit `CEZ:REPORT` first "if you were spawned as part of a
  larger structure." `CHILD_ROLE` (`engine.ts:21-25`) maps nothing to `caesar`, and the only
  `caesar` creation path is `POST /missions` (`server.ts:3501`, `:3510`), confirmed by
  `packages/cezar/src/server/missions-api.test.ts:102`
  (`expect(store.getRun(id)?.unit).toEqual({ role: 'caesar', missionId: id })`, no `parentRunId`).

**Why it matters.** Dead in the current build. Plausibly forward-compatible with the reserved
"Legion" tier (`contract/src/units.ts:160-166`), so not recommended for deletion — but it should
not be mistaken for exercised behaviour.

### F14 — LOW — `engine.ts:27-29`'s comment describes the wrong exemption
*Source: `01-responsibility-model.md` F5.*

- The comment says "`maxParallel` defaults to 2 and only two monitors are slot-exempt." That
  describes the bounded `maxMonitoringSessions` watcher exemption (default 2,
  `packages/cezar/src/workspace/config.ts:84`), not the *unbounded* unit-parent exemption at
  `run.ts:682-687` that actually governs mission slot arithmetic.

**Why it matters.** Anyone sizing a fan-out from that comment under-estimates how many commanders
can park for free.

### F15 — LOW — no test round-trips the `CEZ:REPORT` example against `unitReportSchema`
*Source: `03-prompt-noop-audit.md` F4.*

- `prompts.test.ts:193-200` parses and schema-validates the `CEZ:SPAWN` example; there is no
  equivalent for the `CEZ:REPORT` example at `prompts.ts:64`.

**Why it matters.** A rename of a `unitReportSchema` key would not be caught the way a
`unitSpawnSchema` rename would. Given F6's proposal to add trust-bearing report fields, this gap
gets more expensive, not less.

### F16 — LOW — the Centurion prompt assumes it always has a commander
*Source: `03-prompt-noop-audit.md` F5.*

- `unitSizeSchema` allows `squad`, where a Centurion *is* the mission root (`server.ts:3510`), yet
  `prompts.ts:164` speaks unconditionally of "your commander."

**Why it matters.** Harmless but imprecise: for a squad root, the only reader is the human in the
cockpit.

---

## Proposals

Ranked by value-for-effort: the four `S`-effort prompt/text changes that close a critical or high
finding come first (P1-P4), then the `S`-effort default-path change (P5), then the structural work
in ascending cost (P6-P9), then the two cheap hygiene items (P10-P11). Where two source files touch
the same constant, composition is stated explicitly.

**Composition note.** P1, P2, P4 and P10 all edit `packages/cezar/src/units/prompts.ts`. They touch
disjoint lines (`79-84`, `90`/`121`, `57`, `31`/`49`/`54`) and **compose without conflict** — no
two proposals rewrite the same line. P1's replacement `GUARD_RULE` deliberately keeps the closing
"Open pull requests as DRAFTS. Never merge to the base branch" bullet, which is the overlap
`03-prompt-noop-audit.md` F6 noted with `CHILD_BRANCH_RULE:41`; that redundancy is retained on
purpose, since it is the sentence doing the real work once "merging anything" is narrowed.

---

### P1 — Narrow `GUARD_RULE` to carve out the in-worktree merge — fixes F1 (critical)

**Problem.** `prompts.ts:79`'s "merging anything" forbids what `prompts.ts:38` mandates.

**Concrete change.** Replace `GUARD_RULE` (`prompts.ts:79-84`) in full with:

```
const GUARD_RULE = `The Guard rule — this one is absolute. Before ANY action that is irreversible, financial, or widens your scope, end the turn with CEZ:ASK and stop. That includes: pushing to a shared branch, merging into the repository's base branch (main / master / develop) or into any branch that is not your own worktree's branch, force-pushing, deleting a branch or a remote, publishing a package, spending money, touching production or any credential, rewriting history, and doing work outside the scope you were given.

- Merging an accepted child's branch into YOUR OWN worktree's branch is the one merge this rule does not cover. It never leaves your own worktree, it is as reversible as any other commit you make yourself, and it is the only mechanism this hierarchy has for turning your children's work into your own deliverable — see the branch rule below. Every other use of the word "merge" in this prompt means merging somewhere else, and that needs CEZ:ASK.
- Ask with CEZ:ASK, not in prose: a single line CEZ:ASK {"questions":[{"header":"≤12 chars","question":"…?","options":[{"label":"…","description":"…"}]}]} — 1-4 questions, 2-4 options each. Then stop. Do not keep working past your own question, and do not answer it yourself.
- Never work around a blocked action. If a tool is denied, a command needs a permission you do not have, or a guard stops you, that is the answer — report it or ask. Do not find another route to the same effect.
- Open pull requests as DRAFTS. Never merge to the base branch, and never push to it.
- When in doubt about whether something is reversible, it is not. Ask.`;
```

`CHILD_BRANCH_RULE` (`prompts.ts:31-41`) needs no change — it was already correct.

**Default-path impact.** None functionally; no code reads this text at runtime beyond the marker
parser, which is untouched. **Tests to pin.** The existing `/never merge/i` (`prompts.test.ts:161`)
and `toContain('git merge --no-ff')` (`:179`) both still pass against this text; add an assertion
that the Guard names the in-worktree exception (e.g. `toMatch(/does not cover/i)` for caesar and
legate) so the contradiction cannot be reintroduced. **Effort: S. Risk: low.**

### P2 — Replace the absolute file-editing ban with an integration-only exception — fixes F3 (high)

**Problem.** `prompts.ts:90` / `:121` claim commanders never edit files; `prompts.ts:35` and `:39`
require it.

**Concrete change.** Replace `CAESAR_PROMPT`'s line 90 with:

```
You do not write the mission's work yourself — no feature code, no fixes, no new files, not one. If you find yourself opening an editor to do the task, you have taken a legate's job — decompose it and spawn instead. The one exception is integration: committing your own state, and merging an accepted legate's branch (or resolving a conflict between two legates' branches) into your own, both covered by the branch rule below and both staying inside your own worktree. Reading is different too: read as much of the repository as you need to plan well, and run read-only commands (git log, tests, greps) to check a claim.
```

and `LEGATE_PROMPT`'s line 121 with:

```
You do not write the task order's work yourself. You plan, spawn, review and report. Read the repository as much as you need to; run read-only commands freely to verify a claim. But the writing is your centurions' work, and doing it yourself both burns your budget and leaves your commander with no record of who did what. The one exception is integration: committing your own state, and merging an accepted centurion's branch (or resolving a conflict between two centurions' branches) into your own — see the branch rule below.
```

**Default-path impact.** None functionally. **Tests to pin.** `prompts.test.ts:150-154` currently
matches `/do not edit files yourself/i`; update its *intent* to assert the narrower "does not write
the mission's/task's work" claim plus the integration exception. **Effort: S. Risk: low.**

### P3 — Say plainly where `scope` / `allowed_tools` are not enforced — fixes F2 (critical), addresses F11

**Problem.** The scope brake is inert on codex and opencode and nothing says so (F2); a Centurion
also has no way to know at spawn time whether it will have legionaries (F11).

**Concrete change**, cheapest first (steps 1-2 of `02-validation-and-ladder.md` P4):

1. Tell the child which situation it is in, in the envelope rather than by trial and denial —
   extend `childTaskEnvelope` (`engine.ts:88-102`) with a line derived from the same predicate
   `unitSubagentTools` uses:
   `- Backend: ${runner} (${hasSubagentTool ? 'legionaries available via Task/Agent' : 'no sub-agent tool on this backend — work sequentially'})`.
2. Document the brake's real reach — in the mission composer/cockpit copy and in
   `AGENTS.md`/`AGENT_PROTOCOL.md` — stating that on codex and opencode a spawn's `scope` and
   `allowed_tools` are **advisory prompt text, not an enforced boundary**, because neither CLI
   exposes a tool allowlist to drive (`codex-app-server-runner.ts:56-58`,
   `opencode-server-runner.ts:46-47`).
3. *(M, optional)* Make the capability a fact the ladder can reason about:

```ts
// next to CHILD_ROLE, engine.ts:21-29
export const BACKEND_HAS_SUBAGENT_TOOL: Record<RunnerId, boolean> = {
  claude: true, codex: false, opencode: false, pi: false,
};
```

A fourth option — giving non-claude Centurions a real fan-out primitive — is explicitly **not**
recommended without its own design review: it reopens `CHILD_ROLE.centurion === undefined`
(`engine.ts:21-25`), a deliberate boundary.

**Default-path impact.** Steps 1-2 are additive text; no change to the spawn/settle path.
**Tests to pin.** `engine.test.ts` — the new envelope line per backend, and a
documentation-as-test asserting `unitSubagentTools` and `BACKEND_HAS_SUBAGENT_TOOL` agree for every
`RUNNER_IDS` entry so the two cannot drift. **Effort: S (steps 1-2), M (step 3). Risk: low.**

### P4 — Make the `retry_limit` honor system explicit — fixes F7 (high)

**Problem.** Nothing counts retries, and the prompt never says so, so a commander may assume the
engine will refuse a fourth respawn the way it refuses an over-cap or over-budget spawn.

**Concrete change.** Replace `prompts.ts:57` in full with:

```
- "retry_limit" — optional integer 0-3. No code counts your actual retries against it — track them yourself before spawning again.
```

**Default-path impact.** None to schema or enforced behaviour; adds ~85 bytes to `SPAWN_CONTRACT`,
therefore to both commanding prompts. **Tests to pin.** `prompts.test.ts:203-205`'s
`toContain('retry_limit')` still passes; add an assertion pinning the "No code counts your actual
retries" clause so a future trim cannot mistake it for boilerplate. **Effort: S. Risk: low.**

### P5 — Ship per-role ladder defaults — fixes F9 (medium)

**Problem.** A zero-config mission runs all three ranks on one model (F9).

**Concrete change.** The contract shape is unchanged — `unitLadderSchema` stays fully optional so an
explicit ladder still wins. Add:

```ts
// next to CHILD_ROLE, packages/cezar/src/units/engine.ts:21-25
export const DEFAULT_UNIT_LADDER: Record<UnitRole, { runner: 'claude'; model: string }> = {
  caesar: { runner: 'claude', model: 'claude-fable-5-1' },
  legate: { runner: 'claude', model: 'claude-opus-5' },
  centurion: { runner: 'claude', model: 'claude-sonnet-5' },
};
```

and insert it between the explicit rung and today's fallback at `run.ts:1667-1668`
(`rung?.runner ?? DEFAULT_UNIT_LADDER[childRole].runner ?? parent.runner`) and at
`server.ts:3511,3515` for the root.

| Role | Model | $/1M in / out | Why |
|---|---|---|---|
| Caesar | `claude-fable-5-1` | $10 / $50 | Long-horizon planning over the whole repo; reviews every report; never edits. Bounded volume, highest-leverage judgement — a bad decomposition is the most expensive failure in the tree. |
| Legate | `claude-opus-5` | $5 / $25 | Mid-tier judgement over a narrower slice; a mistake is contained to one branch of the tree. |
| Centurion | `claude-sonnet-5` | $2 / $10 | Bulk execution against a tight task order it did not write; the highest-volume rank. Do **not** default lower (e.g. Haiku): centurion reports are the least independently verified today (F5, F6), so a weaker model's "done" is the one most needing scrutiny. |

(Prices from the `claude-api` skill, checked 2026-09-08, not from model memory. This is also the
ladder this very mission ran.)

**Default-path impact.** A **real behaviour change** for the zero-config path — worth a release
note. `agentModelsLocked` (`server.ts:3512-3513`) and explicit rungs still take precedence.
**Tests to pin.** A `run.ts` test that a Centurion under a ladder-less army gets `claude-sonnet-5`
even when its Legate parent runs something else; the same for `POST /missions` root creation with
`unit: 'army'` and `'squad'`. **Effort: S. Risk: low.**

*Secondary, unscored:* legionaries have no ladder rung at all (`contract/src/units.ts:52-58`), so a
Centurion's model also sets its legionaries' cost tier — worth its own finding once legionary cost
becomes visible.

### P6 — Release a settled child's unspent budget back to its parent — fixes F8 (high)

**Problem.** `remainingBudgetUsd` counts promised ceilings forever, so a parent loses headroom to
children that already finished under budget, and can be refused the spawn that would complete its
own task order (F8).

**Concrete change** — `packages/cezar/src/units/engine.ts:67-72`:

```ts
export function remainingBudgetUsd(parent: RunRecord, children: readonly RunRecord[]): number | undefined {
  const budget = parent.unit?.budgetUsd;
  if (budget === undefined) return undefined;
  // A child that has SETTLED can no longer spend: charge what it actually spent, not what it was
  // promised. A child still in flight is charged its whole ceiling, because it may yet use it.
  const promised = children.reduce(
    (sum, child) =>
      sum + (isTerminalStatus(child.status) ? (child.costUsd ?? 0) : (child.unit?.budgetUsd ?? 0)),
    0,
  );
  return budget - (parent.costUsd ?? 0) - promised;
}
```

No schema change. Safe against double counting: a run's `costUsd` is summed from its own steps
(`run.ts:2947`, `:3674`) and never rolls up children — verified in this pass.

**Default-path impact.** Parents regain headroom as children settle; a mission that would previously
have stalled mid-plan can finish. It cannot *over*spend: the mission ceiling still bounds the sum,
and the turn-end brake (`run.ts:1578-1590`) is unchanged. **Tests to pin.** `engine.test.ts` —
`remainingBudgetUsd` with a settled underspent child, a settled overspent child, and an in-flight
child, asserting only the settled ones are charged at actual; a `run.ts` test that a spawn refused
before a child settles succeeds after. **Effort: S. Risk: low-medium** — the one real risk is a
child that settles with `costUsd` not yet written, which would under-charge; guard by treating
`undefined` cost on a settled child as its promised budget.

### P7 — Add a `## Mission brief` to `childTaskEnvelope` — fixes F4 (high)

**Problem.** The mission objective, constraints and budget stop at the root (F4).

**Concrete change** — a new optional parameter on `childTaskEnvelope` (`engine.ts:88-102`),
rendered *above* `## Task order`:

```ts
export function childTaskEnvelope(
  child: UnitSpawnChild,
  parent: { id: string; branch?: string; role: UnitRole },
  mission?: { objective: string; constraints?: string[]; budgetUsd?: number; spentUsd?: number },
): string {
  const lines: string[] = [];
  if (mission) {
    lines.push(`## Mission brief`);
    lines.push(`- Objective: ${clip(mission.objective, 600)}`);
    if (mission.constraints?.length) lines.push(`- Constraints: ${mission.constraints.join(' · ')}`);
    if (mission.budgetUsd !== undefined) {
      const remaining = mission.budgetUsd - (mission.spentUsd ?? 0);
      lines.push(`- Mission budget: ${usd(mission.budgetUsd)} total, ${usd(remaining)} remaining`);
    }
    lines.push('');
  }
  // … existing "## Task order" block unchanged
}
```

`spawnChildren` populates it with one extra `this.store.getRun(unit.missionId)` per spawn call — it
already holds both `unit` and `this.store` (`run.ts:1607-1622`) and already reads `parent` at
`:1622`. Sourcing it fresh from the store (rather than baking it in at creation) is what makes it
survive a restart.

**Why the envelope and not the alternatives.** Not the role system prompt: that text is
mission-agnostic and de-duplicated precisely because it is shared per rank
(`unitRolePromptPart`, `run.ts:500-510`). Not a worktree file: every child gets a fresh worktree, so
it would have to be written at every spawn anyway, and it costs the child a tool call to read
something that could already be in front of it.

**Default-path impact.** Every child's prompt grows by a few lines; no schema change, purely
additive, so `unitSpawnSchema` and what a commander may *send* are untouched. **Tests to pin.**
`engine.test.ts:75-92` keeps passing unmodified; add cases for `mission` present/absent, clip
boundary, constraints and budget rendering, plus a `spawnChildren`-level test that the root record
is actually read and threaded. **Effort: M. Risk: medium** — a missing or archived root record must
degrade to "no mission brief," never throw, since a spawn must not fail because the root's record
went away.

### P8 — Split the report into "child claims" vs "engine observes" — fixes F6 (high)

**Problem.** The only trustworthy facts in a report are the two the engine appends (F6).

**Concrete change.** Extend what the *engine* derives at settle time, alongside the existing
cost/`diffStat` append (`engine.ts:183-186`) — deliberately **not** new child-authored schema
fields, because a child self-reporting these is no more trustworthy than its prose:

```ts
commitSha: string;      // the child's HEAD in its own worktree at settle
filesTouched: string[]; // `git diff --name-only <baseBranch>..HEAD` in the child's worktree
```

and one genuinely child-authored addition to `unitReportSchema` (`contract/src/units.ts:75-83`):

```ts
commands: z.array(z.object({
  cmd: z.string().max(200),
  exitCode: z.number().int(),
  outputExcerpt: z.string().max(2000).optional(),
})).max(10).optional(),
testNames: z.array(z.string().max(200)).max(50).optional(),
```

`commitSha` pins exactly what was reviewed (`branch` moves if the child commits again);
`filesTouched` gives the cheap scope audit `diffStat`'s counts cannot (`store.ts:124-131`), and
being engine-derived it cannot be faked. `result`, `side_effects`, `errors` and
`recommended_next_action` are inherently narrative — **free text is already the right shape** and
schema-fying them would add structure without a guarantee.

**Default-path impact.** The engine-derived pair rides on the delivered text, like `diffStat`, so no
migration; the two child-authored fields are `.optional()`, so old reports still parse.
**Tests to pin.** `engine.test.ts`'s `childSettleReport` block — `commitSha`/`filesTouched` present
for a child with a `baseBranch`; `markers.test.ts` — the new optional fields parse (and re-confirm
that `unitReportSchema` being non-`.strict()`, per `contract/src/units.ts:70-73`, is still the right
call once the schema carries trust-bearing fields). **Effort: S (schema) + M (git plumbing).
Risk: low** — both are read-only git operations on a worktree the engine already owns.

### P9 — Have the engine run the child's verification commands itself — fixes F5 (high)

**Problem.** `success_criteria`/`required_evidence` are never checked by code (F5).

**Options considered, ranked:** (1) engine-executed required commands — highest trust, does not
depend on the child's honesty; (2) structured self-reported evidence — cheap and parseable, but a
lying child fabricates an exit code as easily as a sentence; (3) an engine-rendered checklist echoed
into the child's report prompt — nearly free, zero guarantee; (4) a dedicated review Centurion —
best independent verification, but doubles cost and latency, so better as an opt-in for high-stakes
spawns than as the default path.

**Pick: (1), carried by the schema shape of (2).**

```ts
// unitSpawnSchema, contract/src/units.ts:128-153, inside the .strict() child object:
verify_commands: z.array(z.string().max(200)).max(5).optional(),

// unitReportSchema — written by the ENGINE, not the child:
verified: z.array(z.object({
  cmd: z.string().max(200),
  exitCode: z.number().int(),
  outputExcerpt: z.string().max(2000).optional(),
})).max(5).optional(),
```

`childTaskEnvelope` renders `verify_commands` as a task-order line (same pattern as `engine.ts:96`);
the settle path in `run.ts` re-runs each command in the child's worktree and merges the real exit
codes into the report before it is delivered or persisted. That execution is stateful and
process-spawning, so it belongs in `run.ts`, not the pure `engine.ts` (per that module's own
pure/stateful split, `engine.ts:1-13`). `SPAWN_CONTRACT` and `REPORT_CONTRACT` (`prompts.ts:44-59`,
`:62-75`) gain a line documenting that the field is engine-checked, not self-reported.

**Default-path impact.** Fully additive; a spawn omitting `verify_commands` behaves exactly as
today. **Tests to pin.** `engine.test.ts` (envelope renders it), `markers.test.ts` (schema accepts
and rejects), and a `run.ts` integration test that a nonzero exit code reaches the parent *even when
the child's own `evidence` claims success*. **Effort: M-L. Risk: medium** — bound the list to 5,
enforce a short timeout, and never let `verify_commands` become a way to execute something the child
was not already permitted to run.

### P10 — Three prompt rewords from the no-op audit — hygiene

The full audit (`03-prompt-noop-audit.md`) found **0 pure cuts, 4 rewords, ~40 keeps** across ~46
substantive lines, and explicitly confirmed the `SPAWN_CONTRACT`/`REPORT_CONTRACT` schema
restatement is **load-bearing** (nothing else teaches the payload shape) and must not be cut. The
three trims, each exact and ready to paste:

- `prompts.ts:31`: `Branches and merges — no code does this for you, so read it twice.` →
  `Branches and merges — no code does this for you.`
- `prompts.ts:49`: → `- "children" — 1 to 4 entries per CEZ:SPAWN, and no more than 4 may be in flight under one parent at once; a spawn that would exceed either is refused.`
- `prompts.ts:54`: → `- "max_cost" — optional, a positive number of dollars, carved out of your own remaining budget.`

**Be honest about the payoff.** Composed sizes are `CAESAR_PROMPT` 7,950 chars, `LEGATE_PROMPT`
7,461, `CENTURION_PROMPT` 4,611. These three save **106 bytes** in each of the two commanding
prompts (~1.3%) and nothing in the Centurion prompt — and P4 adds ~85 bytes back. Net across
P4+P10 is roughly flat. **This is a tight file, not a bloated one; adopt P10 for clarity, not for
tokens.** **Effort: S. Risk: none** (no existing assertion checks these strings).

### P11 — Two comment/test hygiene items — fixes F14, F15

- Reword `engine.ts:27-29` to name the unconditional unit-parent exemption (`run.ts:682-687`) and
  its test (`units-engine.test.ts:178`) instead of the bounded `maxMonitoringSessions` one.
- Add a `prompts.test.ts` assertion mirroring `:193-200` that round-trips the `CEZ:REPORT` example
  (`prompts.ts:64`) through `unitReportSchema`.

**Effort: S. Risk: none.** F13 and F16 are recorded but **no change is proposed**: the dead Caesar
branch is plausibly forward-compatible with the reserved Legion tier, and the squad-root wording is
a genuine content decision rather than a trim.

---

## The merge-vs-Guard contradiction — resolved

Self-contained; you do not need to open `01-responsibility-model.md` to act on this.

**The two lines, verified at `df73cfa9`:**

- `packages/cezar/src/units/prompts.ts:38` —
  > "For each child you accept, merge its branch into your own worktree: `git merge --no-ff <child
  > branch>`. One child at a time, re-running the repository's checks after each merge."
- `packages/cezar/src/units/prompts.ts:79` —
  > "Before ANY action that is irreversible, financial, or widens your scope, end the turn with
  > CEZ:ASK and stop. That includes: pushing to a shared branch, **merging anything**, force-pushing,
  > …"

Both reach both commanding ranks in the *same assembled prompt*: `CHILD_BRANCH_RULE` at
`prompts.ts:107` (Caesar) and `:134` (Legate); `GUARD_RULE` at `:111` and `:138`. The related pair
`prompts.ts:90` / `:121` ("you do not edit files… not one") is contradicted by the same block's
`:35` (commit before spawning) and `:39` (resolve sibling conflicts and commit the merge).

**Which wins: `CHILD_BRANCH_RULE`. `GUARD_RULE` is over-broad, not wrong in spirit.**

Merging an accepted child's branch into the commander's own branch, in the commander's own
worktree: never leaves that worktree; never touches a shared, base or remote branch; is exactly as
reversible as any other commit the commander makes; and is **the only mechanism the hierarchy has**
for turning children's work into one deliverable — nothing in cezar does it for you
(`CHILD_BRANCH_RULE`'s own doc comment, `prompts.ts:24-29`; `spawnChildren` seeds
`baseBranch: parent.branch` and stops there, `run.ts:1642-1690`). That is categorically different
from the two things `GUARD_RULE` actually exists to stop, which its own closing bullet
(`prompts.ts:83`) already states precisely: pushing to a shared branch, and merging to the base
branch.

The fix is therefore to narrow the *trigger* and name the exception, and — symmetrically — to
replace the absolute editing ban with the narrower, truthful claim the rest of both prompts already
assumes: **commanders never do the mission's work; they do the integration work, inside their own
worktree.**

**Replacement text: `GUARD_RULE` in full (`prompts.ts:79-84`)** — see **P1** above for the complete
block, whose operative changes are (a) "merging anything" → "merging into the repository's base
branch (main / master / develop) or into any branch that is not your own worktree's branch", and
(b) a new leading bullet naming the in-worktree child merge as the one merge the rule does not
cover. **Replacement text for `CAESAR_PROMPT:90` and `LEGATE_PROMPT:121`** — see **P2** above; both
are given in full, ready to paste.

**Responsibility model per rank, after the fix:**

| | Caesar | Legate | Centurion |
|---|---|---|---|
| Writes the mission's task work | No — spawns Legates | No — spawns Centurions | **Yes** — itself or via legionaries |
| Commits its own state before spawning | Yes | Yes | Yes (as part of its work) |
| Merges an accepted child's branch into its own | Yes, own worktree | Yes, own worktree | N/A — spawn refused (`engine.ts:21-25`) |
| Resolves sibling-branch conflicts | Yes, own worktree | Yes, own worktree | N/A |
| Merges to a shared/base/remote branch | Never | Never | Never |
| Pushes, force-pushes, rewrites history | Never without CEZ:ASK | Never without CEZ:ASK | Never without CEZ:ASK |
| Adjudicates contradictory child reports | Yes — resolves or asks the user | **No** — carries the conflict up with both sides quoted (`prompts.ts:132`) | N/A |

**Note on this document's own provenance.** This audit's Legate followed exactly the resolution
above: it merged each accepted Centurion branch into its own with `git merge --no-ff` without
raising `CEZ:ASK`, treating `prompts.ts:83` as the operative sentence. The mission would have
deadlocked under the literal reading of `prompts.ts:79`, since a `CEZ:ASK` reaches the human, not
Caesar. That is F1 observed in production, not merely in review.

---

## Open questions for the user

1. **Should `unitSizeSchema` gain a Caesar→Centurion shape (no Legate rung)?** F10 shows the Legate
   rank buys no concurrency at `maxParallel = 2` — only latency, two rounds of budget carving, and
   (until P7) two lossy context hops. Options: (a) leave the three sizes and document "squad by
   default, army only for genuinely independent workstreams"; (b) add a fourth size where Caesar
   spawns Centurions directly, keeping `legate` in `UNIT_ROLES` for the reserved Legion tier;
   (c) raise the `maxParallel` default so `army` pays off. (c) has the widest blast radius — it is a
   global, cross-project semaphore (`config.ts:36`).

2. **Should the per-role ladder defaults (P5) ship as a behaviour change, or as composer
   pre-fill?** Shipping them changes what a zero-config mission does today, and every existing
   mission that relied on "everything inherits `defaultRunner`" would move. Pre-filling the composer
   instead keeps the default path untouched but leaves API-started missions on one model.

3. **How much verification should the engine perform on a child's behalf (P9)?** Running
   child-named commands at settle time is the only option that does not depend on the child's
   honesty, but it means the engine executes strings an agent wrote. The alternative — an
   adversarial review Centurion — is more trustworthy still and needs no new execution path, but
   roughly doubles the cost of every task order.

4. **Is the `allowed_tools` gap (F2) a documentation fix or a backend-support decision?** As
   shipped, cezar offers a scope brake that two of four backends silently ignore. Options: document
   it loudly (P3, cheap, honest); restrict `army`/`squad` missions to backends that can enforce the
   brake; or accept it as-is and treat scope as advisory everywhere.

5. **Does the budget model (F8/P6) match your intent?** Today a parent's headroom is consumed by
   promises even after they are discharged under budget. P6 releases the unspent remainder as each
   child settles. The counter-argument is that the current behaviour is a deliberately conservative
   brake against a runaway tree — if so, the refusal message (`run.ts:1722`) should say that the
   money still exists but is intentionally withheld, because today it reads as "no budget left."

---

## Verification

- Audited at `df73cfa9`; findings files produced on three Centurion branches (`cez/674dc2a6`,
  `cez/49d757ef`, `cez/9be2e435`), each validated and merged into `cez/d9628fff` one at a time.
- Citations independently re-checked while writing this summary, beyond the Centurions' own
  verification: `config.ts:36`; `run.ts:678-690`; `prompts.test.ts:161`, `:179`, `:193-206`;
  `codex-app-server-runner.ts:56-58`; `opencode-server-runner.ts:46-47`;
  `claude-cli-runner.ts:381-383`; `engine.test.ts:104-108`; `runs/store.ts:124-131`;
  `missions-api.test.ts:102`; `server.ts:3465-3542`; `run.ts:1607-1739`; the `success_criteria`,
  `required_evidence` and `retry_limit` greps across `packages/`. No citation carried from a source
  file failed re-verification; none required correction.
- Findings before deduplication: 16 across three files (5 + 5 + 6). After merging
  `03`-F6 into F1 as a duplicate: **16 global findings** (the merge removed one; F8 is new,
  first-hand from operating the system during this mission).
- `03-prompt-noop-audit.md` reports `npx vitest run packages/cezar/src/units/prompts.test.ts` →
  18/18 passing, with no source file modified by this audit.
- **Authorship note.** `SUMMARY.md` was written by the mission's Legate rather than delegated to a
  Centurion, contrary to `prompts.ts:121`. The spawn that would have produced it was refused for
  lack of budget under F8's accounting ($12.00 allotted, $7.29 spent, $7.50 promised to three
  children that in fact spent $3.34). Reported rather than concealed, per `prompts.ts:67`.
