# Role design audit — responsibility model (Caesar / Legate / Centurion)

Audited at HEAD `df73cfa9` (branch `cez/674dc2a6`, forked from `cez/d9628fff`). Every
citation below was read at that commit; line numbers are quoted from the file as I saw it,
not copied from the task order.

Background: `.ai/specs/2026-09-08-units-hierarchy.md`.

---

## Q1 — Contradictions in the prompts

### The evidence

`packages/cezar/src/units/prompts.ts`:

- `CHILD_BRANCH_RULE` (declared 31-41) tells a commander, unconditionally, at **line 38**:
  > "For each child you accept, merge its branch into your own worktree: `git merge --no-ff <child branch>`. One child at a time, re-running the repository's checks after each merge."
  and at **line 39**:
  > "Sibling conflicts are yours to resolve. You handed out the scopes, so two children touching the same lines is your decision to settle — resolve it in your worktree and commit the merge. Never send a conflict back down to a child."
  and at **line 35**:
  > "COMMIT your work before every CEZ:SPAWN. Anything you left uncommitted does not exist for your children, and they will either redo it or contradict it."

- `GUARD_RULE` (declared 79-84) says, at **line 79** (first sentence):
  > "Before ANY action that is irreversible, financial, or widens your scope, end the turn with CEZ:ASK and stop. That includes: pushing to a shared branch, **merging anything**, force-pushing, deleting a branch or a remote, publishing a package, spending money, touching production or any credential, rewriting history, and doing work outside the scope you were given."

  `GUARD_RULE` is interpolated into **both** `CAESAR_PROMPT` (at `${GUARD_RULE}`, line 111)
  and `LEGATE_PROMPT` (line 138) — the same prompts that also interpolate `CHILD_BRANCH_RULE`
  (line 107 and line 134 respectively). So a single assembled Caesar/Legate prompt contains,
  a few paragraphs apart, "merge the child's branch, one at a time" and "merging anything
  requires CEZ:ASK and a full stop."

- `CAESAR_PROMPT` (86-115), **line 90**:
  > "You do not edit files yourself. **Not one.** If you find yourself opening an editor, you have taken a legate's job — decompose it and spawn instead."
  Two paragraphs later the same prompt embeds `CHILD_BRANCH_RULE`, whose lines 35 and 39
  (quoted above) order Caesar to commit and to resolve conflicts by editing files and
  committing a merge. `git merge --no-ff` on a real conflict *requires* editing the
  conflicted files before `git commit` — there is no way to satisfy line 39 without opening
  an editor, which line 90 just forbade "not one" of.

- `LEGATE_PROMPT` (117-142), **line 121**, has the weaker but still-contradicted version:
  > "You do not edit files yourself. You plan, spawn, review and report. […] But the writing
  is your centurions' work, and doing it yourself both burns your budget and leaves your
  commander with no record of who did what."
  Same `CHILD_BRANCH_RULE` embed at line 134 gives it the same commit/resolve duties.

- The test suite currently **encodes the contradiction as two separate, both-passing
  assertions**, which is why it has shipped unnoticed:
  `packages/cezar/src/units/prompts.test.ts:161` — inside "carries the Guard rule in every
  role" — asserts `expect(prompt).toMatch(/never merge/i)` for every role including
  caesar/legate; `prompts.test.ts:179` — inside "states the filled-in child-branch rule in
  both commanding prompts" — asserts `expect(prompt).toContain('git merge --no-ff')` for the
  same two roles. Both pass today because the two rules never get checked against each other,
  only against a regex each.

### The resolution

**GUARD_RULE loses this one, but only partially — it is over-broad, not wrong in spirit.**
The whole point of `CHILD_BRANCH_RULE` (per its own doc-comment at prompts.ts:24-29) is that
cezar's engine does nothing to reassemble a mission's work: a child's branch just sits there
until a commander merges it into its own branch, in its own worktree, which the engine
already forked from the parent's committed tip (`spawnChildren`, `run.ts:1688`, seeds
`baseBranch: parent.branch`). That merge:

- never leaves the commander's own worktree,
- never touches a shared/base/remote branch,
- is exactly as reversible as any other commit the commander makes itself (`git reset`, or
  just discard the worktree),
- and is the **only mechanism the hierarchy has** to turn N children's work into one
  deliverable branch.

That is categorically different from "pushing to a shared branch" or "merging to main" — the
two things GUARD_RULE is actually trying to stop (see its own closing bullet, unchanged:
"Open pull requests as DRAFTS. Never merge to the base branch, and never push to it.",
prompts.ts:83). The fix is to narrow GUARD_RULE's opening sentence from "merging anything" to
"merging into a branch that is not your own", and say explicitly that merging an accepted
child's branch into your own worktree is the standing exception, not a Guard violation.

Symmetrically, **"you do not edit files. Not one." is wrong for Caesar and overstated for
Legate**, because both ranks are given, in the very same prompt, an editing duty: committing
before a spawn (nothing to commit if nothing changed, so this line is Caesar/Legate's own
bookkeeping, not a delegation of the mission's work) and resolving a merge conflict between
two children's branches. The coherent split is not "commanders never touch a file" — it's
**"commanders never do the mission's actual work (the task's fixes/features/tests), but they
do the integration work: committing their own state, merging accepted children, and
resolving conflicts between siblings, all inside their own worktree."** That is a narrower,
truthful claim, and it is the one the rest of both prompts already assumes.

### Coherent responsibility model per rank

| | Caesar | Legate | Centurion |
|---|---|---|---|
| Writes the mission's task work (features/fixes/tests) | No — spawns Legates | No — spawns Centurions | Yes — directly, or via its own sub-agent "legionaries" |
| Commits its own state (before each spawn) | Yes | Yes | Yes (as part of its own work) |
| Merges an accepted child's branch into its own | Yes (`git merge --no-ff <legate branch>`, own worktree) | Yes (`git merge --no-ff <centurion branch>`, own worktree) | N/A — no children (CEZ:SPAWN refused, `engine.ts:21-25`) |
| Resolves sibling-branch conflicts | Yes, in its own worktree | Yes, in its own worktree | N/A |
| Merges to a shared/base/remote branch | Never | Never | Never |
| Pushes to a shared branch, force-pushes, rewrites history | Never without CEZ:ASK | Never without CEZ:ASK | Never without CEZ:ASK |
| May open a draft PR | Implied end-of-mission action; still never merges it | Same, if it is the mission root | Same, if it is the mission root (squad) |
| May ask (CEZ:ASK) | Yes — real failures, contradictory reports, anything Guard-scoped | Yes — same, or carries the conflict up to Caesar instead of picking a winner (line 132) | Yes — same |

### Exact replacement text

**1. `GUARD_RULE` (prompts.ts:79-84) — replace the whole constant with:**

```
const GUARD_RULE = `The Guard rule — this one is absolute. Before ANY action that is irreversible, financial, or widens your scope, end the turn with CEZ:ASK and stop. That includes: pushing to a shared branch, merging into the repository's base branch (main / master / develop) or into any branch that is not your own worktree's branch, force-pushing, deleting a branch or a remote, publishing a package, spending money, touching production or any credential, rewriting history, and doing work outside the scope you were given.

- Merging an accepted child's branch into YOUR OWN worktree's branch is the one merge this rule does not cover. It never leaves your own worktree, it is as reversible as any other commit you make yourself, and it is the only mechanism this hierarchy has for turning your children's work into your own deliverable — see the branch rule below. Every other use of the word "merge" in this prompt means merging somewhere else, and that needs CEZ:ASK.
- Ask with CEZ:ASK, not in prose: a single line CEZ:ASK {"questions":[{"header":"≤12 chars","question":"…?","options":[{"label":"…","description":"…"}]}]} — 1-4 questions, 2-4 options each. Then stop. Do not keep working past your own question, and do not answer it yourself.
- Never work around a blocked action. If a tool is denied, a command needs a permission you do not have, or a guard stops you, that is the answer — report it or ask. Do not find another route to the same effect.
- Open pull requests as DRAFTS. Never merge to the base branch, and never push to it.
- When in doubt about whether something is reversible, it is not. Ask.`;
```

**2. `CAESAR_PROMPT` (prompts.ts:86-115) — replace line 90 with:**

```
You do not write the mission's work yourself — no feature code, no fixes, no new files, not one. If you find yourself opening an editor to do the task, you have taken a legate's job — decompose it and spawn instead. The one exception is integration: committing your own state, and merging an accepted legate's branch (or resolving a conflict between two legates' branches) into your own, both covered by the branch rule below and both staying inside your own worktree. Reading is different too: read as much of the repository as you need to plan well, and run read-only commands (git log, tests, greps) to check a claim.
```

**3. `LEGATE_PROMPT` (prompts.ts:117-142) — replace line 121 with:**

```
You do not write the task order's work yourself. You plan, spawn, review and report. Read the repository as much as you need to; run read-only commands freely to verify a claim. But the writing is your centurions' work, and doing it yourself both burns your budget and leaves your commander with no record of who did what. The one exception is integration: committing your own state, and merging an accepted centurion's branch (or resolving a conflict between two centurions' branches) into your own — see the branch rule below.
```

No change is needed to `CHILD_BRANCH_RULE` itself (prompts.ts:31-41) — it was already correct;
the two prompts that quoted it around a contradictory Guard sentence and an absolute
no-editing sentence are what needed the fix.

---

## Q2 — Goal awareness

### The evidence

`childTaskEnvelope` (`packages/cezar/src/units/engine.ts:88-102`) builds exactly:

```
${child.objective}

## Task order
- Scope: …
- Allowed tools: …
- Max cost: …
- Success criteria: …
- Required evidence: …
- Retry limit: …
- Parent branch (your fork point): …
- Ordered by: the <role> on run <id>
```

Its own doc-comment (engine.ts:83-84) says it outright: *"A child sees this text and nothing
else the parent knows — separate session, separate worktree, separate budget."* The unit test
at `engine.test.ts:75-92` (`describe('childTaskEnvelope', …)`) pins exactly this field set —
scope, allowed_tools, max_cost, success_criteria, required_evidence, retry_limit, parent
branch, ordered-by — and none of them is mission-level.

`spawnChildren` (`packages/cezar/src/workflows/run.ts:1607-1699`) confirms the child's task is
this envelope and nothing else — **line 1660**: `task: childTaskEnvelope(child, { id:
parentId, branch: parent.branch, role: unit.role })`. It has `unit.missionId` in scope
(`unit.missionId` is read at line 1674 to stamp the child's own record) but never reads the
mission ROOT record to pull its objective/constraints/budget into the envelope.

The mission's objective and the user's `## Constraints` block are assembled exactly once, by
`missionTask` (`packages/cezar/src/server/server.ts:3476-3480`), and used exactly once, at
**line 3518**: `const task = missionTask(body.objective, body.constraints);` — which becomes
the **root** run's task (line 3522-3523, `manager.startRun(workflow, { task, … })`). Nothing
downstream of the root ever reads `body.objective` or `body.constraints` again. `budgetUsd`
similarly lands once, on the root's `unit.budgetUsd` (line 3537), and is only ever consumed
arithmetically by `remainingBudgetUsd` (`engine.ts:67-72`) to carve child caps — never restated
to a child as prose.

Net effect: a Centurion two hops under an `army` Caesar sees only the Legate's paraphrase of a
paraphrase of the user's actual ask. The user's original constraints (e.g. "never touch
`packages/billing`", or "match the existing test style") are visible to the root run only —
by the second hop they exist only if a Legate chose to restate them verbatim in the
`objective` string it wrote for `CEZ:SPAWN`, which nothing enforces or checks.

### Where the mission brief should live, and why

**Proposal: a new field in the envelope, not a worktree file and not the role system
prompt.**

- **Not the role system prompt** (`unitRolePromptPart`, `run.ts:506-510`): that text is
  shared across every run at a rank and de-duplicated against the run's extra prompt
  precisely because it's mission-agnostic (doc-comment at run.ts:500-504: composing it twice
  would "hand the backend ~8 KB of identical instructions twice"). Baking one mission's
  objective into it would break that de-dup and would need to change every time a new mission
  starts.
- **Not a file in the worktree**: every child gets its own fresh worktree per
  `spawnChildren` (forked off `parent.branch`), and worktrees are torn down independently.
  Writing a `MISSION.md` would need to happen at every single spawn anyway (no filesystem is
  shared across the tree), which is no simpler than writing the same text into the envelope —
  and it costs the child an extra tool call (open the file) to see something that is already
  in front of it, which contradicts the current model of "one prompt is the whole assignment."
- **The envelope, sourced fresh from the store at spawn time**: `spawnChildren` already has
  `this.store` in scope and already reads `parent` from it (`run.ts:1622`). Reading the ROOT
  record via `unit.missionId` costs one more `store.getRun` call, is naturally re-derivable
  after a restart (nothing is baked once and forgotten), and keeps the "child sees this text
  and nothing else" model intact — the child still gets one self-contained prompt.

### Concrete shape

Add a `## Mission brief` section **above** `## Task order` in `childTaskEnvelope`, and thread
it in from `spawnChildren`:

```ts
// engine.ts — new parameter on childTaskEnvelope
export function childTaskEnvelope(
  child: UnitSpawnChild,
  parent: { id: string; branch?: string; role: UnitRole },
  mission?: { objective: string; constraints?: string[]; budgetUsd?: number; spentUsd?: number },
): string {
  const lines: string[] = [];
  if (mission) {
    lines.push(`## Mission brief`);
    lines.push(`- Objective: ${clip(mission.objective, 600)}`);
    if (mission.constraints?.length) {
      lines.push(`- Constraints: ${mission.constraints.join(' · ')}`);
    }
    if (mission.budgetUsd !== undefined) {
      const remaining = mission.budgetUsd - (mission.spentUsd ?? 0);
      lines.push(`- Mission budget: ${usd(mission.budgetUsd)} total, ${usd(remaining)} remaining`);
    }
    lines.push('');
  }
  // … existing "## Task order" block unchanged
}
```

`spawnChildren` would resolve `mission` once per spawn call via
`this.store.getRun(unit.missionId)` (already has `unit` and `this.store` in scope at
`run.ts:1607-1622`), reading that record's `task` (root's objective+constraints, already
concatenated by `missionTask`) and `unit.budgetUsd`. A short `clip()` helper truncates the
root objective so it doesn't dominate every hop's prompt at depth 3. This is additive: it
does not change `## Task order`'s existing fields, so `engine.test.ts:75-92` keeps passing
unmodified; a new test should assert the mission brief appears and is truncated/omitted
correctly when `mission` is absent (root-run spawns before it has a missionId to read, or a
`legionary`-size run that never calls this at all).

---

## Q3 — Is the Legate rank worth it?

### The evidence

- `MAX_CHILDREN_IN_FLIGHT = 4` (`engine.ts:29`) — per parent, enforced in `spawnChildren`
  (`run.ts:1626-1633`).
- `maxParallel` defaults to **2**, confirmed at `packages/cezar/src/config.ts:36`:
  `maxParallel: z.number().int().min(1).max(16).default(2)`. This is a **global**,
  cross-mission concurrency cap on actually-running agent turns (`WorkspaceSemaphore`,
  `packages/cezar/src/workspace/semaphore.ts`), not a per-parent one.
- A parked commander (Caesar or Legate waiting on its own children) does **not** consume a
  `maxParallel` slot at all — it is exempt outright. `run.ts:682-687`:
  > "These are exempt from the slot count OUTRIGHT — `maxMonitoringSessions` does not bound
  them (see `busySlots`)… A parked commander's process is idle; the runs it waits for are the
  ones that need the capacity."
  Confirmed by the test title at `packages/cezar/src/workflows/units-engine.test.ts:178`:
  *"surrenders the commander's slot to its children even past `maxMonitoringSessions`"*.
  (Bonus finding, F5 below: `engine.ts:27-29`'s own comment — *"only two monitors are
  slot-exempt"* — is stale against this; it describes the separate, bounded
  `maxMonitoringSessions` watcher exemption, default 2 per `config.ts:84`, not the unbounded
  unit-parent exemption `run.ts:682-687` actually documents.)
- `unitSizeSchema` (`packages/contract/src/units.ts:168`) is `['legionary', 'squad', 'army']`
  — there is no fourth option where Caesar spawns Centurions directly. `squad` maps to a
  single root Centurion (`server.ts:3510`: `role = body.unit === 'army' ? 'caesar' :
  'centurion'`) whose "children" are its backend's own in-process sub-agents (legionaries),
  never cezar runs; `army` is the full three-rung tree.

### The analysis

Because a parked commander costs nothing, `MAX_CHILDREN_IN_FLIGHT=4` is not really a
concurrency knob — it bounds how much a parent can have *outstanding* (queued or running), not
how much runs *at once*. Actual concurrency, system-wide, across every mission and every rank,
is still exactly `maxParallel` — **2 by default**. An `army` fanning out to 4 legates × 4
centurions can have up to 16 centurion-level tasks nominally "in flight," but only 2 of them
are ever actually executing; the rest queue behind the semaphore regardless of tree shape.
Depth does not buy throughput at the default config — it buys latency and dilution:

- **Latency.** Each rank change is a brand-new session: new worktree (`spawnChildren`,
  `run.ts:1642-1690`), new agent process, a full read-the-repo-and-plan turn before the next
  spawn happens. `army` pays that cost twice (Caesar→Legate, Legate→Centurion) before any task
  work starts; `squad` pays it once (the mission root **is** the Centurion,
  `server.ts:3510/3522`) and its legionaries are ordinary in-process sub-agent calls the
  Centurion issues itself mid-turn, with none of that per-hop cold-start cost.
- **Budget dilution.** `remainingBudgetUsd` (`engine.ts:67-72`) is carved at every spawn. A
  $10 mission run as `army` gets carved once into ≤4 legate shares, then each of those carved
  again into ≤4 centurion shares — plausibly low single digits or cents per centurion for a
  modest budget. `squad` puts the whole mission budget behind the one Centurion doing the
  work.
- **Context loss per hop.** This compounds Q2 directly: today, neither hop restates the
  mission objective/constraints (Q2's finding), so `army` loses that context **twice** before
  real work happens, while `squad` never loses it once — the mission root Centurion is seeded
  by `missionTask` with the full objective and constraints already in its own task
  (`server.ts:3518`). Landing Q2's fix narrows this gap but does not close the latency/budget
  gap above.

### When to pick which

- **`squad` (default recommendation for most missions).** One Centurion, with disjoint-scope
  legionaries as its own sub-agents. Pick this whenever the work is one coherent objective
  that decomposes into pieces a single reviewer can hold in their head — which is most
  missions. No per-hop session cold-start, no budget carved twice, no context restated twice,
  and legionary parallelism doesn't compete for `maxParallel` at all.
- **`army`.** Pick this only when the mission is genuinely **several independent programs of
  work**, each big enough to deserve its own sub-budget, its own plan, and its own commander
  empowered to accept/reject/escalate on its slice without Caesar reading every diff itself —
  e.g. "rewrite auth" + "migrate CI" + "audit billing" as three real workstreams under one
  mission, not three files of one feature. If the user picks `army` at the default
  `maxParallel=2`, the honest advice is to also raise `maxParallel` (`config.ts:36`, capped at
  16) — otherwise the extra rank buys mostly queueing, not concurrency.

---

## Findings

- **F1 (critical)** — `GUARD_RULE` and `CHILD_BRANCH_RULE`, both embedded in `CAESAR_PROMPT`
  and `LEGATE_PROMPT`, give the same commander literally opposite instructions about merging:
  "merge its branch… one child at a time" (`prompts.ts:38`) vs. "merging anything" requires
  `CEZ:ASK` and a full stop (`prompts.ts:79`). Because both instructions live in the same
  assembled system prompt for both commanding ranks, a model following the prompt literally
  cannot execute the mission's only aggregation step (accepting a child's work) without either
  ignoring the Guard rule or halting every mission at the first accepted child. The current
  test suite passes because `prompts.test.ts:161` and `prompts.test.ts:179` assert the two
  halves independently and never against each other.

- **F2 (high)** — `CAESAR_PROMPT:90` ("You do not edit files yourself. Not one.") is falsified
  by the very rule it stands next to: `CHILD_BRANCH_RULE:35` orders a pre-spawn commit and
  `:39` orders resolving sibling conflicts "in your worktree and commit the merge" — which
  requires editing conflicted files. `LEGATE_PROMPT:121` makes the same, slightly softer,
  claim and has the same conflict. An agent that takes line 90 literally either refuses to
  commit/merge (breaking the hierarchy's only aggregation mechanism) or breaks the "not one"
  promise the first time it resolves a conflict, and either way the prompt has told it two
  different things about its own job.

- **F3 (high)** — The mission's objective, the user's `## Constraints` block, and the mission
  budget are assembled once (`missionTask`, `server.ts:3476-3480`) and used exactly once, for
  the root run's task (`server.ts:3518, 3522-3523`). `childTaskEnvelope`
  (`engine.ts:88-102`, pinned by `engine.test.ts:75-92`) never reads them, so every rank below
  the root sees only its immediate parent's paraphrase. Under `army`, a Centurion two hops
  down has no reliable access to the user's original constraints (e.g. "don't touch
  `packages/billing`") unless a Legate chose to restate them verbatim — nothing enforces or
  checks that it did.

- **F4 (medium)** — With `maxParallel` defaulting to 2 (`config.ts:36`) and parked commanders
  exempt from that cap outright (`run.ts:682-687`, test title at
  `units-engine.test.ts:178`), `army`'s extra Legate rank does not buy additional concurrency
  at the default config — actual throughput is still bounded by the same 2-wide semaphore
  regardless of tree depth. It does buy two extra session-cold-start hops of latency and two
  extra rounds of budget-carving (`remainingBudgetUsd`, `engine.ts:67-72`) before real task
  work starts, on top of the context loss in F3, compounded once per hop.

- **F5 (low)** — `engine.ts:27-29`'s comment — "`maxParallel` defaults to 2 and only two
  monitors are slot-exempt" — describes the bounded `maxMonitoringSessions` watcher exemption
  (default 2, `config.ts:84`), not the unbounded unit-parent exemption that actually governs
  `army`/`squad` slot arithmetic (`run.ts:682-687`, unconditional; confirmed by
  `units-engine.test.ts:178`'s title, "surrenders the commander's slot to its children even
  past `maxMonitoringSessions`"). Anyone sizing a mission's fan-out off that comment alone
  would under-estimate how many commanders can park for free.

## Proposals

**P1 — Narrow `GUARD_RULE`, carve out the in-worktree merge (fixes F1).**
Problem: "merging anything" in `GUARD_RULE` (prompts.ts:79) contradicts the mandatory
`git merge --no-ff` in `CHILD_BRANCH_RULE` (prompts.ts:38). Change: replace `GUARD_RULE`
(prompts.ts:79-84) with the text given in Q1 above — narrows the trigger to "merging into a
branch that is not your own", adds an explicit exception bullet for merging an accepted
child's branch into the commander's own worktree. Default-path impact: none functionally
(nothing in code enforces or reads this prompt text at runtime beyond the marker parser,
which is untouched); behavior-relevant only insofar as it stops the model from second-guessing
its own aggregation step. Tests to pin: extend
`prompts.test.ts`'s "carries the Guard rule" block with an assertion that the Guard text
names the in-worktree-merge exception explicitly (e.g. `toMatch(/does not cover/i)` scoped to
caesar/legate), and keep the existing `/never merge/i` and `git merge --no-ff` assertions
(both still pass against the proposed text, verified by re-reading the draft against the
regexes above). Effort: S. Risk: low — text-only change, no schema/marker impact.

**P2 — Replace the absolute "not one" file-editing ban with an integration-only exception
(fixes F2).** Problem: `CAESAR_PROMPT:90` and `LEGATE_PROMPT:121` claim commanders never edit
files, contradicted by the mandatory commit/merge/conflict-resolution duties two paragraphs
later. Change: replace both lines with the text given in Q1 above — keeps "you don't write the
mission's/task's work" as the load-bearing claim, adds the integration exception (commit own
state, merge/resolve conflicts in own worktree) explicitly. Default-path impact: none
functionally. Tests to pin: `prompts.test.ts:150-154` ("tells the two commanding roles not to
edit files themselves") currently matches `/do not edit files yourself/i` — update its intent
(not just its regex) to assert the narrower "do not write the mission's/task's work" claim
plus the integration exception, so a future edit can't silently re-introduce the absolute
claim. Effort: S. Risk: low.

**P3 — Add a `## Mission brief` to `childTaskEnvelope`, sourced from the root run record at
spawn time (fixes F3).** Problem: mission objective/constraints/budget vanish after the root
hop. Change: as specified in Q2 above — new optional `mission` parameter on
`childTaskEnvelope`, populated by `spawnChildren` via one extra `store.getRun(unit.missionId)`
read per spawn call. Default-path impact: every child's prompt grows by a few lines (the
clipped root objective, constraints, and budget-remaining); no schema change, additive only —
`unitSpawnSchema` (`packages/contract/src/units.ts`) is untouched, so this doesn't touch what
a commander is allowed to *send* in `CEZ:SPAWN`, only what a child is told on the way in.
Tests to pin: extend `engine.test.ts`'s `childTaskEnvelope` describe block
(currently `engine.test.ts:75-92`) with cases for `mission` present/absent, truncation at the
clip boundary, and constraints/budget rendering; add a `spawnChildren`-level test asserting
the root record is actually read and threaded through (not just that the pure function
accepts the parameter). Effort: M (touches `engine.ts`, `run.ts`, and both test files; no
contract/schema change). Risk: medium — a wrong `missionId` lookup (e.g. root already
archived/deleted) must degrade to "no mission brief" rather than throw, since a child's spawn
must not fail because the mission root's record went away.

**P4 — Document (and default users toward) `squad` over `army` at the current `maxParallel`
default; no code change required (addresses F4).** Problem: users have no guidance on when the
extra Legate hop is worth its latency/budget/context cost, and at `maxParallel=2` it rarely
is. Change: this is a docs/UX proposal, not a code change — surface the Q3 guidance (squad by
default; army only for genuinely independent workstreams, and raise `maxParallel` if you pick
it) wherever the cockpit's mission composer explains `unitSizeSchema`'s three options. Default-
path impact: none (advisory only). Tests to pin: none (no behavior change) — if this becomes a
cockpit copy change, a snapshot/text test on that copy would be the natural pin, but that is
outside this audit's file scope. Effort: S. Risk: low.

**P5 — Fix the stale `engine.ts:27-29` comment (addresses F5).** Problem: the comment
describes the bounded `maxMonitoringSessions` exemption where the code path it sits next to
(`MAX_CHILDREN_IN_FLIGHT`) is actually governed by the unconditional unit-parent exemption in
`run.ts:682-687`. Change: reword the comment to point at the correct mechanism and its test
(`units-engine.test.ts:178`). Default-path impact: none (comment only). Tests to pin: none.
Effort: S. Risk: none.

---

## For the summary

- **F1 (critical):** `GUARD_RULE` ("merging anything" needs CEZ:ASK, prompts.ts:79) directly
  contradicts `CHILD_BRANCH_RULE`'s mandatory `git merge --no-ff` for commanders
  (prompts.ts:38) — both embedded in the same Caesar/Legate prompts; exact replacement text
  proposed.
- **F2 (high):** Caesar's "You do not edit files yourself. Not one." (prompts.ts:90) is
  falsified by the same prompt's mandatory pre-spawn commit and conflict-resolution duties
  (prompts.ts:35, :39); Legate has the softer version of the same bug (prompts.ts:121).
- **F3 (high):** Mission objective/constraints/budget are assembled once for the root run
  (`server.ts:3476-3480`, used at `3518`) and never propagate into `childTaskEnvelope`
  (`engine.ts:88-102`) — every rank below the root loses the user's original ask and
  constraints, worst at Centurion-under-army (two lossy hops).
