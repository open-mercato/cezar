# 02 — Validation and the ladder

Audit of **how a parent validates what comes back** in cezar's mission/units feature
(Caesar → Legate → Centurion), against `.ai/specs/2026-09-08-units-hierarchy.md` and the code at
HEAD (`df73cfa9`, branch `cez/49d757ef`, forked from `cez/d9628fff`). Every citation below was
re-read at HEAD in this worktree; line numbers are what I actually saw, not carried over from the
task order.

Scope: analysis only. No source, test or other spec file was touched.

---

## Findings

### F1 — CRITICAL — the spawn's `allowed_tools`/scope brake is enforced on exactly one of four backends

- Evidence: `packages/cezar/src/core/codex-app-server-runner.ts:56-58` — "Codex has no
  per-tool allowlist, so `spec.allowedTools` is ignored" (codex runs with
  `sandbox: danger-full-access` + `approvalPolicy: never`). `packages/cezar/src/core/opencode-server-runner.ts:46-47`
  — "OpenCode has no per-tool allowlist, so `spec.allowedTools` is ignored" (auto-approved
  permissions). `packages/cezar/src/core/claude-cli-runner.ts:381-383` shows `claude` is the one
  backend that actually turns `spec.allowedTools` into `--allowedTools` on the CLI. `pi-runner.ts:262,267-285`
  shows `pi` *does* map `allowedTools` onto its own `--tools` flag, but its tool map
  (`Read/Bash/Edit/Write/Grep/Glob`) has no sub-agent entry either.
- Why it matters: `unitSpawnSchema.children[].scope` and `.allowed_tools`
  (`packages/contract/src/units.ts:136,140`) are the mechanism the whole design leans on for a
  child staying inside its task order, and the Guard rule ("stay inside your scope... end the turn
  with CEZ:ASK") assumes that mechanism is real. On codex and opencode it isn't: a child spawned
  with `allowed_tools: ["Read"]` still has unrestricted shell/filesystem access, because the field
  is never read by either runner. This is a bigger and more general gap than the legionary
  question (Q8) asks about — it means the scope brake on the *task order itself*, not just the
  legionary fan-out, is decorative prompt text on two of the four backends.

### F2 — HIGH — `success_criteria` and `required_evidence` are prose the engine never reads back (Q4)

- Evidence (grep, verbatim):
  ```
  $ grep -rn "success_criteria" --include="*.ts" packages/
  packages/contract/src/units.ts:142:            success_criteria: z.string().max(1000).optional(),
  packages/cezar/src/units/markers.test.ts:48:      success_criteria: 'npm test is green',
  packages/cezar/src/units/engine.ts:96:  if (child.success_criteria) lines.push(`- Success criteria: ${child.success_criteria}`);
  packages/cezar/src/units/prompts.ts:46: ..."success_criteria":"…"...
  packages/cezar/src/units/prompts.ts:55:- "success_criteria" — optional, ≤1000 chars. How the child knows it is done.
  packages/cezar/src/units/prompts.test.ts:203:      for (const key of [..., 'success_criteria', 'required_evidence', ...]) {

  $ grep -rn "required_evidence" --include="*.ts" packages/
  packages/contract/src/units.ts:143:            required_evidence: z.string().max(1000).optional(),
  packages/cezar/src/units/markers.test.ts:49:      required_evidence: 'the test output',
  packages/cezar/src/units/engine.ts:97:  if (child.required_evidence) lines.push(`- Required evidence: ${child.required_evidence}`);
  packages/cezar/src/units/prompts.ts:46: ...
  packages/cezar/src/units/prompts.ts:56:- "required_evidence" — optional, ≤1000 chars. ...
  packages/cezar/src/units/prompts.test.ts:203: (same loop)
  ```
  Every hit is: the schema field itself, `childTaskEnvelope` rendering it *into the child's own
  prompt* (`engine.ts:96-97`), the shipped prompt text describing the field to the model
  (`prompts.ts:46,55-56`), and tests of those two things. **Nothing** — no code in
  `workflows/run.ts`, `units/engine.ts`'s `childSettleReport`/`statusToReportStatus`, or
  `server.ts` — reads `success_criteria`/`required_evidence` back off the *settled child* to check
  the report against them. They are written into the outbound task order and never looked at
  again. `childSettleReport` (`engine.ts:157-189`) appends only `cost` (line 183) and `diffStat`
  (lines 184-186) to what a parent sees; it has no notion of the order it is settling against.
- Why it matters: the parent's only validation of "did this child actually meet its criteria and
  produce its evidence" is the parent-agent *reading prose in its own context window* — nothing
  structural connects the order to the report. A child that ignores `required_evidence` entirely
  still produces a schema-valid `CEZ:REPORT` and settles normally.

### F3 — HIGH — `unitReportSchema`'s only structured, non-free-text signal is what the engine itself appends (Q5)

- Evidence: `packages/contract/src/units.ts:75-83` — every field on `unitReportSchema` is
  `status` (enum) or free-text-ish arrays/strings (`result`, `evidence[]`, `side_effects[]`,
  `errors[]`, `recommended_next_action`). `engine.ts:157-189` (`childSettleReport`) appends
  `cost ${usd(child.costUsd)}` (line 183) and `diff ${child.diffStat.files} files, +adds -dels`
  (lines 184-186) — both derived from the *store's own record*, not from anything the child typed.
  `child.diffStat` is `{ adds, dels, files, repointed? }` (`packages/cezar/src/runs/store.ts:124-131`)
  — counts only, no paths, no commit sha.
- Why it matters: the two facts a parent can currently trust without re-deriving them itself are
  cost and a diff *count*. Everything else — what was actually done, what was tested, which files
  were touched — is prose the child wrote about itself, with no cross-check. `CHILD_BRANCH_RULE`
  in `prompts.ts:31-41` already tells every parent role to "read that branch's diff, run the tests
  and commands the child claims to have run" by hand — i.e. the design already knows free-text
  evidence isn't enough and pushes the entire burden onto the parent's own budget and judgement.

### F4 — MEDIUM — the ladder has no shipped per-role defaults; an omitted rung falls back to one project-wide default (Q6)

- Evidence: `packages/contract/src/units.ts:52-58` — `unitLadderSchema` is `.partial()` over
  three optional `unitLadderEntrySchema` (`runner`/`model`, both `.optional()`, lines 44-47).
  `packages/cezar/src/workflows/run.ts:1665-1668` — "the mission ladder decides the child's
  backend and model; absent a rung it inherits the parent's" → `runner: rung?.runner ?? parent.runner`.
  `packages/cezar/src/server/server.ts:3511,3515` — the root's rung lookup
  (`body.ladder?.[role]`) and its fallback: `rung?.runner ?? (await loadConfig(repoRoot)).defaultRunner`
  — a single, global, role-blind default.
- Why it matters: a project that has never configured a ladder runs **caesar, legate and
  centurion on the literal same runner+model** — one setting doing three jobs with very different
  cost/judgement tradeoffs (see Q6 proposal). Filling in sensible per-role defaults is entirely a
  human, per-mission act today; nothing in the shipped product nudges toward "planning model here,
  execution model there" unless a composer user fills all three ladder rungs by hand every time.

### F5 — MEDIUM — a centurion's legionaries have no fan-out at all on codex/opencode/pi (Q8)

- Evidence: `packages/cezar/src/units/engine.ts:112-120` (`unitSubagentTools`) —
  `if (role !== 'centurion' || backend !== 'claude') return [...base];` — only `claude` gets
  `Task`/`Agent` added. Confirmed by the existing test,
  `packages/cezar/src/units/engine.test.ts:106`: `expect(unitSubagentTools(['Read'], 'centurion', 'codex')).toEqual(['Read'])`
  (comment on the same line: "Other backends have no sub-agent tool and ignore allowedTools
  entirely (#430)"). The centurion prompt (`packages/cezar/src/units/prompts.ts:148,152`) is
  backend-agnostic: "Your backend's own sub-agent tool... is your century" / "If this backend has
  no sub-agent tool, that is fine: do the work yourself, sequentially." Checked all three
  non-claude runners for an equivalent primitive: codex (`codex-app-server-runner.ts:45-58`, no
  per-tool concept at all), opencode (`opencode-server-runner.ts:37-47`, same), pi
  (`pi-runner.ts:267-285`, tool map has no sub-agent entry). None has one.
- Why it matters: this is what the task calls out directly, and the prompt is honest about it —
  it doesn't claim a capability that isn't there. But it means a centurion's task order, sized by
  its parent assuming 2-4x legionary parallelism (the centurion prompt's own advice: "give each
  one a DISJOINT scope... two legionaries editing the same file will clobber each other"), takes
  proportionally longer wall-clock and burns proportionally more of *its own* context doing
  sequentially on codex/opencode/pi what claude would parallelize — and the parent has no signal
  at spawn time about which backend its centurion will actually land on (the ladder rung is
  resolved *inside* `spawnChildren`, `run.ts:1667`, after the spawn was already sized).

---

## Proposals

### P1 — for F2/Q4: stop trusting the child's self-report; have the engine run a bounded set of verification commands itself

**Problem.** `success_criteria`/`required_evidence` are instructions the child reads and prose the
parent reads back — nothing in between is checked by code (F2).

**Ranked options considered:**
1. **Required test commands the engine runs itself.** The spawn names commands; the engine
   re-executes them in the child's own worktree at settle time and appends the *actual* exit codes
   to what the parent receives. Highest trust — doesn't depend on the child being honest.
2. **Structured evidence fields** (commands+exit codes as data, not prose). Cheap, parseable, but
   still self-reported — a lying child can fabricate a zero exit code as easily as a sentence.
3. **Engine-rendered checklist injected into the child's report prompt** (echo `success_criteria`
   back as "before you report, confirm: ..."). Nearly free, but purely a prompting nudge with zero
   structural guarantee.
4. **Dedicated review centurion** (an adversarial second run that reviews the diff before it
   reaches the parent). Best independent verification, but doubles the cost and latency of every
   task order — too heavy to ship as the default path; better as an opt-in for high-stakes spawns.

**Pick: #1, carried by the schema shape of #2.** Add an optional field the spawn names and the
*engine* — not the child — executes and reports on:

```ts
// unitSpawnSchema, packages/contract/src/units.ts:128-153, inside the .strict() child object:
verify_commands: z.array(z.string().max(200)).max(5).optional(),
// "Commands you must be able to run clean before you report done — the engine re-runs them
//  itself and the exit code is what your parent actually sees, not your own claim."
```

```ts
// unitReportSchema, packages/contract/src/units.ts:75-83 — the ENGINE writes this, not the child:
verified: z.array(z.object({
  cmd: z.string().max(200),
  exitCode: z.number().int(),
  outputExcerpt: z.string().max(2000).optional(),
})).max(5).optional(),
```

**Where the code changes:**
- `packages/contract/src/units.ts` — the two additions above.
- `packages/cezar/src/units/engine.ts` — `childTaskEnvelope` (88-102) renders `verify_commands` as
  a task-order line, same pattern as `success_criteria` today (line 96).
- `packages/cezar/src/workflows/run.ts` — the settle path that calls `childSettleReport`
  (mirrors the existing branch/diffStat lookup already done there) gains a step: for each
  `verify_commands` entry on the *spawn* the settling child was created from, run it in the
  child's `cwd`/branch, capture exit code + tail of output, and merge into `report.verified`
  before the report is delivered upward or persisted as a pending report. This is a stateful,
  process-spawning change, so it belongs in `run.ts`, not the pure `engine.ts` (per the module's
  own pure/stateful split, `engine.ts:1-13`).
- `packages/cezar/src/units/prompts.ts` — extend `SPAWN_CONTRACT` (44-59) and `REPORT_CONTRACT`
  (62-75) to document the new field and that it is *engine-checked, not self-reported*.
- Tests to pin: `engine.test.ts` (childTaskEnvelope renders `verify_commands`),
  `markers.test.ts` (schema accepts/rejects the new fields), a new integration-style test in
  `run.ts`'s own test suite for "settle re-runs verify_commands and the parent sees a nonzero exit
  code even when the child's own `evidence` claims success."

**Default-path impact:** additive and optional — a spawn that omits `verify_commands` behaves
exactly as today. **Effort: M–L** (schema: S; envelope rendering: S; actual command execution
against a settled child's worktree, with its own timeout/cost accounting: M–L). **Risk:** running
arbitrary child-named commands is itself a scope question — bound the list to 5, run with a short
timeout, and never let a `verify_commands` entry substitute for the Guard rule (a child cannot use
this field to get something executed it wasn't already allowed to run).

### P2 — for F3/Q5: split the report into "child claims" vs. "engine observes," and only extend the former where free text genuinely falls short

**Problem.** `unitReportSchema` (75-83) is entirely free text except `status`; the two facts a
parent can trust without re-deriving them (`cost`, `diffStat` counts) are exactly the two the
*engine* appended itself, not the child (F3).

**Concrete shape** — extend what the engine derives from the child's own git state at settle
time (parallel to the existing `cost`/`diffStat` append in `childSettleReport`, `engine.ts:183-186`),
**not** the child-authored schema:

```ts
// Rendered into the settle text alongside cost/diffStat, engine.ts:183-186 — NOT new
// unitReportSchema fields, because a child self-reporting these is no more trustworthy than
// self-reporting anything else; these are cheap for the engine to read off git directly.
commitSha: string;      // child's HEAD in its own worktree at settle
filesTouched: string[]; // `git diff --name-only <baseBranch>..HEAD` in the child's worktree
```

And a smaller, genuinely child-authored addition to `unitReportSchema` for the one thing only the
child knows — *which* commands it considers its verification, ahead of P1 making the exit codes
trustworthy:

```ts
commands: z.array(z.object({
  cmd: z.string().max(200),
  exitCode: z.number().int(),
  outputExcerpt: z.string().max(2000).optional(),
})).max(10).optional(),
testNames: z.array(z.string().max(200)).max(50).optional(),
```

**What each buys, and where free text is already enough:**
- `commitSha` — buys precision: `branch` (already appended) is a moving target if the child keeps
  committing after it reports; a sha pins exactly what was reviewed. **Real gain.**
- `filesTouched` — buys a cheap scope audit: today a parent auditing "did the child stay inside
  its `scope`" has to run `git diff` by hand; `diffStat` has *counts* but not *paths*
  (`runs/store.ts:124-131`). **Real gain**, and it's engine-derived so it can't be faked.
- `commands`/`testNames` (child-authored) — buys structure and parseability over prose, but is
  **only as trustworthy as the child** until paired with P1's engine re-execution. Modest gain on
  its own.
- `result`, `side_effects`, `errors`, `recommended_next_action` — these are inherently narrative
  (what happened, why, what's next); **free text is already the right shape here** — schema-fying
  them would just be structure with no new guarantee.

**Default-path impact:** `commitSha`/`filesTouched` are additive fields on the delivered text,
computed the same way `diffStat` already is — no schema migration needed since they're not on the
persisted `unitReportSchema` at all. The two child-authored fields are `.optional()` additions to
`unitReportSchema`, so an old child report still parses.

**Tests to pin:** `engine.test.ts`'s `childSettleReport` describe block (currently around line
112+) gets a case asserting `commitSha`/`filesTouched` appear in the settle text for a child with
a `baseBranch`; `markers.test.ts` gets a case for the new optional `commands`/`testNames` fields
parsing and being `.strict()`-safe (report schema is *not* `.strict()`, per the comment at
`units.ts:70-73`, so an unrecognized key is stripped, not refused — worth re-confirming that
stripping is still the right choice once the schema starts carrying trust-bearing fields).

**Effort:** S (schema) + M (engine-side git plumbing for `commitSha`/`filesTouched`). **Risk:** low
— both are read-only git operations against a worktree the engine already owns.

### P3 — for F4/Q6: ship per-role ladder defaults, inserted between the explicit ladder and today's single project-wide default

**Problem.** An omitted ladder rung falls back to `parent.runner`/`defaultRunner` — one setting for
all three roles (F4) — even though the roles do very different work:

- **Caesar** — plans and decomposes over the *whole* repository, reviews every report that comes
  back, and never edits a file itself (`prompts.ts:90`). Low token *volume* (bounded prose:
  a plan, then reports) but the highest cost of getting it wrong — a bad decomposition (wrong
  scope, missing success criteria) cascades and multiplies down the entire tree.
- **Legate** — decomposes one slice of the plan, adjudicates centurion reports, same "no editing"
  constraint (`prompts.ts:121`) but over a narrower scope. Judgement matters, but a mistake here is
  contained to one branch of the tree, not the whole mission.
- **Centurion** — the only role that actually edits files, runs tests, and burns bulk tokens
  reading/writing/running commands (`prompts.ts:146,156-160`). Judgement is bounded by a tight
  task order it did not write.

**Recommended shipped defaults** (current per the `claude-api` skill, checked 2026-09-08 — not
from training-data memory):

| Role | Runner | Model | Price ($/1M in / out) | Why |
|---|---|---|---|---|
| Caesar | `claude` | `claude-fable-5-1` | $10 / $50 | Long-horizon planning/decomposition over the whole repo, reviews every child report, never edits — bounded volume, highest-leverage judgement in the tree; a bad plan here is the most expensive failure mode to have. |
| Legate | `claude` | `claude-opus-5` | $5 / $25 | Mid-tier judgement over a narrower slice; contains mistakes to one branch of the tree rather than the whole mission. |
| Centurion | `claude` | `claude-sonnet-5` | $2 / $10 | Bulk execution — reading, editing, running commands. Coding/agentic work is what benefits most from spending on *effort*, not necessarily model tier, once the task order is tight; Sonnet 5 is 2.5x cheaper than Opus 5 and 5x cheaper than Fable 5.1 for the highest-volume rank. Do **not** go cheaper (e.g. Haiku) by default: centurion reports are the least independently verified today (F2/F3), so a weaker model's "done" is exactly the report that most needs scrutiny, not less of it. |

This matches what this very mission is actually running (caesar/fable, legate/opus, centurion/sonnet)
— the recommendation is to make that the *shipped* default rather than something every mission has
to re-specify.

**Concrete change** (contract shape is unchanged — `unitLadderSchema` stays fully optional so an
explicit ladder still wins):

```ts
// New, e.g. packages/cezar/src/units/engine.ts, next to CHILD_ROLE (engine.ts:21-25):
export const DEFAULT_UNIT_LADDER: Record<UnitRole, { runner: 'claude'; model: string }> = {
  caesar: { runner: 'claude', model: 'claude-fable-5-1' },
  legate: { runner: 'claude', model: 'claude-opus-5' },
  centurion: { runner: 'claude', model: 'claude-sonnet-5' },
};
```

- `packages/cezar/src/workflows/run.ts:1667-1668` — change
  `runner: rung?.runner ?? parent.runner` / `rung?.model ?? parent.model` to insert the role
  default between the explicit rung and the parent's own: `rung?.runner ?? DEFAULT_UNIT_LADDER[childRole].runner ?? parent.runner`.
- `packages/cezar/src/server/server.ts:3511,3515` — same insertion for the root run:
  `rung?.runner ?? DEFAULT_UNIT_LADDER[role].runner ?? (await loadConfig(repoRoot)).defaultRunner`.

**Default-path impact:** a mission that never touches the ladder composer today runs all three
roles on one model; after this change it gets the table above instead — a real behavior change
for the zero-config path, not just documentation. Worth a release note.

**Tests to pin:** a `run.ts` test asserting a centurion spawned under an army mission with no
ladder gets `claude-sonnet-5` even when the parent (legate) itself is running a different model;
same for `server.ts`'s `POST /missions` root-creation path with `unit: 'army'`/`'squad'` and no
`ladder` in the body.

**Effort: S.** **Risk: low** — additive fallback, explicit ladder entries and `agentModelsLocked`
(`server.ts:3512-3513`) still take precedence unchanged.

**Secondary observation (not scored as its own finding):** legionaries have no ladder rung of
their own at all — `unitLadderSchema` only covers `caesar`/`legate`/`centurion`
(`units.ts:52-58`) — so a centurion's model choice *also* sets its legionaries' cost tier, even
though legionary tasks ("a search across many files... a self-contained refactor," `prompts.ts:148`)
are exactly the bounded, low-judgement work the `claude-api` skill says responds well to a cheaper
model. Out of scope for this pass (the schema has no seam for it today), but worth its own finding
in a future round if legionary cost becomes visible.

### P4 — for F1/F5/Q8: make the backend degradation self-aware, then decide whether to close the capability gap

**Problem.** Two separate gaps, both rooted in the same fact (only `claude` has a real per-tool
seam): (F1, critical) the spawn's own `allowed_tools`/scope brake is inert on codex/opencode; (F5,
medium) centurions get no legionary fan-out at all on codex/opencode/pi, and the parent that sized
the task order has no way to know which backend its centurion will land on until after the spawn.

**Recommended sequence, cheapest first:**

1. **(S, ship first)** Tell the child which situation it's actually in, in the envelope itself,
   instead of leaving it to discover by trying and being denied. Extend `childTaskEnvelope`
   (`engine.ts:88-102`) with a line derived from `unitSubagentTools`'s own logic:
   `- Backend: ${runner} (${hasSubagentTool ? 'legionaries available via Task/Agent' : 'no sub-agent tool on this backend — work sequentially'})`.
2. **(S, pair with F1)** Surface the allowed_tools gap loudly rather than silently: since
   `spec.allowedTools` is inert on codex/opencode (F1), the composer/cockpit UI and
   `AGENTS.md`/`AGENT_PROTOCOL.md` should say plainly that a spawn's `scope`/`allowed_tools` are
   *advisory prompt text only* on those two backends — not an enforced boundary — until/unless
   those CLIs ship a driveable sandboxing mode. This is a documentation/UI change, not a schema
   one, but it's the honest fix for F1 given neither codex nor opencode expose a tool allowlist to
   drive.
3. **(M)** Make backend capability a fact the *ladder* can reason about, not just prompt text:
   ```ts
   // next to CHILD_ROLE / DEFAULT_UNIT_LADDER, engine.ts:21-29:
   export const BACKEND_HAS_SUBAGENT_TOOL: Record<RunnerId, boolean> = {
     claude: true, codex: false, opencode: false, pi: false,
   };
   ```
   surfaced in the mission composer so a human picking a centurion backend for a large or
   parallelizable objective is warned *before* the mission starts that it will run sequentially,
   rather than the parent finding out after burning 3-4x the wall-clock of the claude case.
4. **(L, don't ship without real demand)** Give non-claude centurions a genuinely narrower
   fan-out primitive — e.g. allow `CEZ:SPAWN` for exactly one more rung of plain (non-unit) runs
   when `BACKEND_HAS_SUBAGENT_TOOL[backend]` is false, capped tighter than the claude legionary
   cap. This is the only option that actually closes the capability gap instead of documenting it,
   but it directly reopens the design decision the spec made on purpose
   (`CHILD_ROLE.centurion === undefined`, `engine.ts:21-25`, "the hierarchy stops at you...
   because a fourth layer of real runs starves the whole tree of agent slots") and needs its own
   design review, not a quick patch.

**Judgment:** the *legionary* degradation (F5) is acceptable as shipped — the prompt is honest
about it, and no backend actually has an equivalent tool to fake. The *allowed_tools* degradation
(F1) is **not** acceptable as currently undocumented — a scope brake that silently doesn't apply
on two of four backends is the kind of gap that should be loud, not discovered by an incident.

**Tests to pin:** `engine.test.ts` — a case for the new envelope line reflecting
`BACKEND_HAS_SUBAGENT_TOOL`; a case (documentation-as-test) asserting `unitSubagentTools` and
`BACKEND_HAS_SUBAGENT_TOOL` agree for all four `RUNNER_IDS`, so the two don't drift.

**Effort:** S (steps 1-2) → M (step 3) → L (step 4, and only if pursued). **Risk:** step 4 is the
only one with real risk (reopening a deliberate design boundary); steps 1-3 are additive
documentation/prompt/UI changes with no behavior change to today's spawn/settle path.

---

## For the summary

- **F1 (critical):** on codex and opencode, a spawn's `allowed_tools`/scope brake is completely
  inert — `spec.allowedTools` is ignored by both runners, so the Guard rule's scope enforcement is
  decorative prompt text on two of four backends.
- **F2 (high):** `success_criteria`/`required_evidence` are written into the child's task order and
  never read back by any code — grep across `packages/` shows every hit is the schema, the
  envelope render, the prompt text, or a test of those, and nothing checks a settled report against
  them.
- **F3 (high):** `unitReportSchema` is entirely free text except `status`; the only facts a parent
  can trust without re-deriving them (`cost`, `diffStat` counts) are exactly the two the engine
  appends itself, not the child.
