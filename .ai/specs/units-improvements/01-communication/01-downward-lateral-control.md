# 01 — Downward & lateral control (communication, topic 1)

> Audits `.ai/specs/2026-09-08-units-hierarchy.md` against AGENTS.md §Zero config and
> §Changing a mechanism that already works. Analysis only — no source, test, config or spec
> file is touched by this document. Every citation was re-verified at HEAD
> (`df73cfa9`) by reading the file, not by trusting a previously-quoted line number.

Q2 (worktrees) and Q4 (Guard) are out of scope for this file; Q1, Q3, Q5 and Q6 are in scope,
in that order below the findings.

## Findings

### F-D1 [high] — the downward envelope carries no mission-level context

`childTaskEnvelope` (`packages/cezar/src/units/engine.ts:88-101`) builds a child's entire task
text from `child.objective` plus a `## Task order` block of `scope` / `allowed_tools` /
`max_cost` / `success_criteria` / `required_evidence` / `retry_limit` and the **immediate**
parent's `branch` / `id` / `role` (lines 92-100). Nothing here reads `unit.missionId`, the
mission root's own `task` text, or `constraints`. `spawnChildren`
(`packages/cezar/src/workflows/run.ts:1607-1699`) calls
`childTaskEnvelope(child, { id: parentId, branch: parent.branch, role: unit.role })`
(line 1660) — the only "parent" ever passed is the one rung directly above, never the root.
The root's own objective+constraints text already exists as one string,
`missionTask(objective, constraints)` (`packages/cezar/src/server/server.ts:3476-3479`,
called at line 3518) — `Objective\n\n## Constraints\n- rule\n...` — stored as that run's
`task` and retrievable by `store.getRun(unit.missionId)`, but nothing in the spawn path reads
it back.

**Why it matters for long autonomous missions**: on an Army (Caesar → Legate → Centurion) the
mission objective is two lossy prose rewrites removed from the centurion that actually touches
files, and nothing catches a legate that drifts, abbreviates or drops a constraint while
writing each centurion's `objective`. A mission that runs many spawn generations compounds this
silently — exactly the failure mode "long autonomous" is supposed to survive.

### F-D2 [high] — a child sees nothing about its siblings

`childTaskEnvelope` is invoked once per child inside `spawn.children.forEach`
(`run.ts:1642-1691`) with only that one `child` and the shared `parent`. `spawnChildren` already
computes `childrenOf(runs, parentId)` at `run.ts:1625-1626` (`inFlightChildren`, for the
fan-out cap) and holds the full `spawn.children` batch, but neither is ever folded into any
child's own envelope text.

**Why it matters**: this is the direct, uncaught cause of the exact failure the role prompts
warn about only in prose — "Give every sibling a DISJOINT scope... two children editing the
same file is the one failure mode this design cannot recover from"
(`packages/cezar/src/units/prompts.ts:52`). The parent is trusted to get every scope right once,
at spawn time, with no second reader and no way for a child to notice a collision before both
have spent budget on it.

### F-D3 [med] — a child never sees what earlier siblings already found

`unit.pendingReports` (`packages/contract/src/units.ts:86-95`) accumulates on the **parent**
only, flushed into the parent's own next prompt by `flushPendingReports`
(`run.ts:1489-1496`) via `pendingReportsBlock` (`engine.ts:202-211`). None of that structured
text is ever folded into a **new** child's envelope when the parent's next `CEZ:SPAWN` fires —
whether a second-wave child benefits from a first-wave sibling's findings depends entirely on
the parent retyping them into a fresh `objective` string.

**Why it matters**: the design's own safety language — "respawn... with what you learned added
to the objective" (`prompts.ts:103`, `132`) — is advisory prose bolted onto a data structure
that already holds exactly that information in structured form, discarded at the one moment
reusing it would be free.

### F-D4 [med] — branch topology told to a child is one level deep

`childTaskEnvelope` prints `Parent branch (your fork point): ${parent.branch}` (`engine.ts:99`)
and `Ordered by: the ${parent.role} on run ${parent.id}` (line 100). `unit.missionId`
(`contract/src/units.ts:105`) is on every record but never surfaces in the text, so a
centurion three ranks down has no vocabulary for anything above its own legate — no root branch,
no sibling legates, no mission id to cite in its own report.

**Why it matters**: once the legate that spawned a centurion has itself settled and moved on,
multi-level provenance is unrecoverable from the envelope text alone — a centurion escalating a
conflict has nothing above "my direct commander" to name.

### F-D5 [low] — repo-wide conventions are not the real gap; mission-specific ones are

Every child forks its own worktree off the parent's committed branch
(`baseBranch: parent.branch`, `run.ts:1688`) with the full repository checked out, so
`AGENTS.md`/`CLAUDE.md` etc. are on disk and directly readable — `childTaskEnvelope` correctly
never restates them. What it also omits, with no path to recover it, is anything the parent
decided ad hoc during planning that is **not written down anywhere in the repo** (a
mission-only naming choice, a decision between two valid approaches) — that lives only in the
parent's own session transcript, invisible to any child.

**Why it matters**: lower severity than F-D1–F-D3 because the omission is partly self-healing
(the child can read the repo), but a mission-specific decision made once by Caesar and never
repeated is a coordination bug waiting for two centurions to make different "correct" choices.

### F-D6 [med] — `scope` is enforced nowhere; it is prose end to end

The only two reads of `child.scope` in `packages/cezar/src` are `engine.ts:93`
(`if (child.scope) lines.push(...)`, into the envelope) and `prompts.ts:52` (instructing the
parent to keep scopes disjoint). `unitSpawnSchema`'s `scope` field
(`packages/contract/src/units.ts:136`) never reaches the spawned child's own persisted `unit`
object — the literal built at `run.ts:1672-1678` carries `role`, `missionId`, `parentRunId`,
`budgetUsd`, `ladder`, and nothing else — so `scope` is not even retrievable later for a
post-hoc check, let alone compared against a sibling's scope, `allowed_tools`, or the files a
merge actually touches.

**Why it matters**: this is the single failure mode the spec's own prompt calls unrecoverable
(`prompts.ts:52`) and it is backed by zero code — a typo'd or merely optimistic scope string is
indistinguishable, to the engine, from a correct one.

### F-D7 [med] — `retry_limit` is read by the engine exactly once, to print it

Every occurrence in the repository (grepped fresh, source only):

```
packages/contract/src/units.ts:144   retry_limit: z.number().int().min(0).max(3).optional(),
packages/cezar/src/units/engine.ts:98  if (child.retry_limit !== undefined) lines.push(`- Retry limit: ${child.retry_limit}`);
packages/cezar/src/units/prompts.ts:46   CEZ:SPAWN {"children":[{...,"retry_limit":1}]}  (schema restated in prose)
packages/cezar/src/units/prompts.ts:57   - "retry_limit" — optional integer 0-3.
packages/cezar/src/units/prompts.ts:103  ...respawn that piece once, within its retry_limit...
packages/cezar/src/units/prompts.ts:132  ...respawn once, within retry_limit, on a transient failure...
packages/cezar/src/units/prompts.ts:160  4. On a transient failure ... retry, up to the order's retry_limit and no further.
packages/cezar/src/units/markers.test.ts:50   retry_limit: 1,               (fixture)
packages/cezar/src/units/markers.test.ts:80   it('refuses ... a fractional retry_limit' ...)
packages/cezar/src/units/markers.test.ts:83   ...retry_limit: 1.5 })...      (schema-bound test)
packages/cezar/src/units/prompts.test.ts:203  for (const key of [..., 'retry_limit']) { ... }  (prompt-mentions-key test)
packages/cezar/scripts/mock-claude.mjs:121,129  retry_limit: 1,             (test fixture script)
```

`engine.ts:98` is the **only production read** in the whole repository. Nowhere does
`spawnChildren` (`run.ts:1607-1699`) persist `retry_limit` onto the new child's own `unit`
record, and there is no field anywhere linking a respawned child back to the attempt it
replaces — no lineage exists to count against a limit even if one were enforced.

**Why it matters for long autonomous missions**: the one bound the spec's own resolved
assumptions name specifically for "don't retry forever" (§Role prompts: "escalation rules —
retry ≤ retry_limit on transient failure") is enforced nowhere except a model's memory of a
number it read once. A caesar or legate that mis-reads its own advice can respawn the same
failing piece indefinitely — each attempt a brand-new, lineage-less child — with nothing in the
engine to stop it short of the budget brake itself (spec Q6 i–ii) eventually firing.

### F-D8 [high] — a commander cannot intervene in a running child; its only lever is to wait

The only two channels that reach a *specific* run mid-flight are `POST /runs/:id/messages`
(`packages/cezar/src/server/server.ts:3831`, via `deliverMessage`/`sendMessage`,
`run.ts:2582-2639`) and `POST /runs/:id/cancel` (`server.ts:3821`, via
`cancel`/`cancelDescendants`, `run.ts:2246-2249`, `1837-1845`) — both are HTTP routes a human
(or the cockpit) calls. `handleUnitMarkers` (`run.ts:1531-1567`) recognizes exactly two markers
a unit run can itself emit — `CEZ:REPORT` and `CEZ:SPAWN` — plus the pre-existing `CEZ:ASK` /
`CEZ:MONITORING` / `CEZ:DONE`. A caesar that spawns four legates and, turns later while
reviewing one report, notices a *different* legate heading somewhere wrong has no marker to say
so — it can only wait for that legate to settle, right or wrong, and act on the finished report.

**Why it matters for long autonomous missions**: this is exactly the failure shape a long tree
is likeliest to produce — a plan that looked fine at spawn time drifting wrong over many turns
of a child's own session — and the design gives the process most likely to notice early (the
parent, reading every report as it lands) no way to act on it before the spend is sunk.

## Proposals

Ranked by (severity addressed × how much of the gap closes) ÷ effort.

### P-D1 [rank 1] — an engine-composed envelope: mission, siblings, prior findings

**Problem**: F-D1, F-D2, F-D3, F-D4 — the child's only knowledge beyond its own objective is
whatever prose the parent chose to hand-write.

**Concrete change**: extend `childTaskEnvelope`'s signature with the context already available,
for free, at its one call site:

```ts
export function childTaskEnvelope(
  child: UnitSpawnChild,
  parent: { id: string; branch?: string; role: UnitRole; missionId: string },
  mission: { objective: string; rootBranch?: string },       // store.getRun(missionId)?.task, rootBranch only when it differs from parent.branch
  siblings: {
    batch: Array<{ title: string; scope?: string }>;         // the OTHER entries of this same CEZ:SPAWN payload
    learned: Array<{ title: string; result: string }>;       // ≤3, newest first, from unit.pendingReports + settled children's unit.report
  },
): string
```

New blocks appended after the existing `## Task order` (additive — nothing already parsed by a
test moves):

```
## Mission
Mission id: <missionId>
Objective: <mission.objective, truncated to ~1000 chars>
Root branch: <rootBranch>        (only printed when it differs from the immediate parent's)

## Siblings spawned with you
- "<title>" — scope: <scope | "not stated">
  (one line per OTHER child in this same batch)

## What your commander already learned
- "<title>": <result, truncated to ~300 chars>
  (≤3 most recent settled reports this parent already has, newest first)
```

Composed where `childTaskEnvelope` is already called, `spawnChildren` (`run.ts:1660`) — every
new argument is a slice of data the function already has in scope (`runs` from
`this.store.listRuns()` at line 1625, `parent`, `spawn.children`) plus **one** extra store read
per spawn call (not per child): `this.store.getRun(unit.missionId)`.

**Default-path impact**: no new knob. This changes every spawn's envelope unconditionally the
moment it ships — there is nothing to gate it behind, matching AGENTS.md §Zero config ("never
trade a working default for a knob"). A Squad mission (a lone centurion) never reaches
`spawnChildren` at all (`CHILD_ROLE.centurion === undefined`, `engine.ts:24`), so this is a
no-op for every Squad exactly as today.

**Transitions out of new state**: none — pure text composition, no new field, no new park
state, no new timer.

**Tests to pin**: extend `packages/cezar/src/units/engine.test.ts`'s `childTaskEnvelope`
coverage — (a) the mission block appears for a rank-2+ child and is absent for a rank-1
Squad/Army root's own children when there is nothing above the immediate parent to add; (b)
sibling lines list every OTHER child in the batch, never the child itself; (c) at most 3 prior
learned-report lines, newest first, each bounded. Extend the manager's unit engine suite with a
two-wave-spawn scenario asserting wave 2's envelope text contains wave 1's settled result.

**Effort**: S. **Risk**: low — additive text only; bound every new block the way
`MAX_PENDING_REPORTS` (`engine.ts:34`) already bounds pending reports, so a mission with many
prior reports cannot grow an unbounded prompt.

### P-D2 [rank 2] — a per-mission scope ledger a running sibling can read

**Problem**: F-D2, F-D6 (partial) — P-D1 only gives a child its siblings' scopes as they stood
at *its own* spawn time; a sibling spawned later, or a whole second wave, is invisible for the
rest of the run.

**Concrete change**: on every `spawnChildren` call and every child settle
(`reportSettledChildToParent`, `run.ts:1756-1826`), rewrite one plain-text ledger file at
`.ai/cezar/runs/<missionId>/scopes.md` (same shared location every worktree can reach by a
relative path from the repo root — not inside any one child's own worktree checkout), one line
per child: `- <childId> "<title>" (<status>): <scope | "not stated">`. Rewritten wholesale (tmp
write + rename, the same atomicity `writeUnitPrompt` already uses at `prompts.ts:248-256`), not
appended, so it always reflects current state. P-D1's `## Siblings spawned with you` block
names the path so a running child can `cat`/`grep` it with its own Read/Bash tool — no new
route, no new port, no daemon.

**Default-path impact**: written state, never required (AGENTS.md §Zero config: "new state may
be written, never required"). A mission that never uses Units never creates the file; deleting
`.ai/cezar/runs/` loses only a courtesy ledger, like every other file under that tree.

**Transitions out of new state**: none — the ledger has no lifecycle; it is rewritten wholesale
on every spawn/settle for that `missionId`, read only by an agent's own tool calls, never by
cezar itself.

**Tests to pin**: a new case (in `engine.test.ts` or a sibling file) asserting the ledger's
content after a spawn, after a settle, and that a second mission's ledger under a different
`missionId` is untouched by the first.

**Effort**: S–M. **Risk**: low–med — advisory only (a child must choose to read it); it does
not by itself close F-D6 (see P-D3).

### P-D3 [rank 3] — the first real check of `scope`: warn, don't refuse

**Problem**: F-D6 — `scope` is never compared against anything.

**Concrete change**: in `spawnChildren` (`run.ts:1607`), before creating any child, run every
pair of `spawn.children[i].scope` / `spawn.children[j].scope` that are both present, plus every
scope already claimed by an **in-flight** sibling (`inFlightChildren`, `engine.ts:54-56`),
through a conservative path-segment check — exact match, or one a true `/`-segment prefix of the
other (never a raw string prefix, to avoid "src/a" matching "src/ab"). On a hit, append a
`note` (`'danger'` tone) naming both children; the spawn still proceeds.

**Default-path impact**: the check runs unconditionally the moment it ships — but its *action*
is a note, never a refusal, so a mission that already names correct, disjoint scopes (the
documented happy path) sees nothing change, because the check never fires. A hard refusal is
deliberately not proposed: a naive check risks false positives, and "never trade a working
default for a knob" rules out shipping a bypass flag as the fix for a false positive that would
otherwise strand a legitimate mission.

**Transitions out of new state**: none — no field, no park, an extra note on the existing
turn-end transcript only.

**Tests to pin**: (a) two children in one batch naming identical scope → one note, both still
spawn; (b) a new child's scope segment-prefixing an in-flight sibling from an *earlier* batch →
note; (c) disjoint scopes → no note (regression guard against false positives).

**Effort**: M (the check is small; the test matrix to keep false positives rare is the real
cost). **Risk**: med — ship the check narrow (exact match + true path-segment prefix only) and
treat it as a hint for the parent to read, not a gate.

### P-D4 [rank 4] — `CEZ:DIRECT`: message, rescope or stop a running child

**Problem**: F-D8 — a parent can spawn and wait; it cannot reach a specific running child once
spawned. The only existing stop lever, `POST /runs/:id/cancel` (`server.ts:3821`), is
human/cockpit-only.

**Marker**: `CEZ:DIRECT {"child":"<runId>","action":"message"|"rescope"|"stop","text":"…"}`,
parsed the same way `CEZ:SPAWN`/`CEZ:REPORT` are (a twin of `SPAWN_MARKER_RE` in
`packages/cezar/src/units/markers.ts`).

**Schema** (`packages/contract/src/units.ts`, alongside `unitSpawnSchema`):

```ts
export const unitDirectSchema = z.object({
  child: z.string().min(1),
  action: z.enum(['message', 'rescope', 'stop']),
  text: z.string().max(4000).optional(),   // required by refinement for message/rescope; ignored for stop
}).strict();
```
`.strict()` for the same reason `unitSpawnSchema` is: an unknown key here is an instruction, and
a silently-dropped one is unsafe, not a statement to render as-is (the asymmetry
`contract/src/units.ts:70-73` already documents between report and spawn).

**Turn-end site**: inside `handleUnitMarkers` (`run.ts:1531-1567`), called from both existing
sites — `run.ts:2960` (`runContinuation`) and `run.ts:3688` (`runAgentStep`) — no third call
site. Parsed and acted on right after the `CEZ:REPORT` block and **before** the
`if (ctx.done) return` line (`run.ts:1556`): like `CEZ:REPORT`, unconditionally, on every turn.

**Precedence**: `CEZ:DIRECT` is orthogonal to the existing ladder
(`CEZ:DONE > CEZ:SPAWN > CEZ:REPORT > CEZ:ASK > CEZ:MONITORING > plain end`) — it coexists with
any of them in the same turn text (a parent can direct a child, spawn a new one, and end on
`CEZ:MONITORING`, all in one turn) because it never sets `spawned` or `overBudget`
(`handleUnitMarkers`'s return shape, `run.ts:1535`) and so cannot itself flip the parent's own
`monitoring`/nudge decision the way `CEZ:SPAWN` does (`run.ts:2972-3018`, `3699-3733`).

**Handling** (new private method `directChild`, parallel to `spawnChildren`):
1. Resolve the target via `childrenOf(this.store.listRuns(), parentId)` (`engine.ts:49-51`); not
   found → refuse-note ("not your child, or already gone"), all-or-nothing like a malformed
   spawn.
2. Refuse (note) if the child's `status` is not in `IN_FLIGHT_STATUSES`
   (`engine.ts:37`, `['queued', 'running', 'waiting']`) — a settled child is not directed, it is
   respawned (P-D5). This keeps the review gate intact with zero new "resurrect a finished run"
   code.
3. `'stop'` → `this.cancel(directive.child)` (`run.ts:2246`) — the exact public method the
   human cancel route already calls; inherits its cascade, its queued-run branch
   (`cancelOne`, `run.ts:2252-2266`) and its existing tests verbatim.
4. `'message'` → `this.sendMessage(directive.child, [{ type: 'text', text: directive.text }])`
   (`run.ts:2582`) — the exact ladder `POST /runs/:id/messages` already uses. Mid-turn vs
   parked is handled identically to a human message, because `deliverMessage`
   (`run.ts:2594-2596`) only checks `state.session?.open`, which is true in both cases (a
   `waiting`/`monitoring` park keeps the session open; only a settled run closes it, which step
   2 already excludes).
5. `'rescope'` → identical to `'message'`, text prefixed `## Scope update from your commander\n`.
   Deliberately *not* a distinct code path: there is nothing structurally different it can do.
   The child's `allowedTools` (fixed at the workflow step, `run.ts:1655`) and worktree/branch
   (fixed at spawn, `run.ts:1688`) are not mutable mid-session — a "rescope" is honestly a
   strongly-worded message asking the child to change what it touches next, running on the same
   unenforced trust `scope` itself already runs on (F-D6). A **hard** boundary change means
   `'stop'` then a fresh `CEZ:SPAWN` forked off the parent's current branch tip; the stopped
   child's branch and commits (`cez/<id8>`) are untouched on disk, exactly as an ordinary cancel
   already leaves them (`CHILD_BRANCH_RULE`, `prompts.ts:39-40`, already tells the parent this
   for a *rejected* report — the same rule now also covers a *stopped* one).

Requires, as a **follow-up out of this task's write-scope**: prose in `prompts.ts` teaching
Caesar/Legate the new marker, and an update to the spec's own §Markers precedence line.

**Default-path impact**: no knob — parsed only when present, exactly like `CEZ:SPAWN`/
`CEZ:REPORT` today. Until the `prompts.ts` follow-up ships, no role prompt mentions
`CEZ:DIRECT`, so no agent emits it, and the default path — a parent that spawns, waits, and
only ever acts on settled reports — is untouched byte-for-byte.

**Transitions out of new state**: none added at all. `'stop'` reuses `cancel`'s existing
terminal transition (`cancelled`, already tested); `'message'`/`'rescope'` reuse `sendMessage`'s
existing resume transition (parked → `running`, already tested). This proposal adds a third
caller of two already-public, already-tested methods, plus one refusal-note path with no state
of its own.

**Tests to pin**: (a) direct an in-flight child with `'message'` → delivered, parent's own park
state unaffected; (b) `'stop'` on an in-flight child with its own grandchildren → cascade-cancels
exactly as `cancel()` already does; (c) direct a settled child → refused, no `continueRun`
fired; (d) direct a run id that is not this parent's child → refused; (e) `CEZ:DIRECT` and
`CEZ:SPAWN` in the same turn text both take effect.

**Effort**: M. **Risk**: med — the sharp edge is item 2 (settled children are refused, by
design, to protect the review gate): a caesar wanting to correct *already-finished-but-wrong*
work still has no marker for that. That gap is intentionally left to P-D5 (`retry_of`), not to
`CEZ:DIRECT`.

### P-D5 [rank 5] — lineage-tracked retries: enforce `retry_limit`

**Problem**: F-D7 — `retry_limit` is advice a model reads once; nothing counts, nothing
refuses.

**Concrete change**:
- `unitSpawnSchema`'s child object (`contract/src/units.ts:128-146`) gains one more optional
  key: `retry_of: z.string().min(1).optional()` — the run id of the settled sibling this child
  replaces (the parent already has this id from the report it read).
- `unitSchema` (`contract/src/units.ts:101-117`) gains two persisted fields: `retryLimit?:
  number` (copied from the *original* spawn's `retry_limit` once, then carried forward
  unchanged down the whole lineage) and `retryCount?: number` (0 on the original, +1 per
  retry). **Same commit must update the persistence twin in
  `packages/cezar/src/runs/store.ts`** — this is precisely the drift AGENTS.md's own worked
  example warns about for this feature's `unit` field ("has a persistence twin... which imports
  this very value so the two cannot drift").
- `spawnChildren` (`run.ts:1607-1699`): for a child naming `retry_of`, resolve it via
  `this.store.getRun(retry_of)`; refuse (note, all-or-nothing with the rest of the payload)
  unless it is a **settled** (`isTerminalStatus`, `engine.ts:44-46`) child of this **same**
  parent (`childrenOf`, `engine.ts:49-51`). Compute `retryCount = (original.unit?.retryCount ??
  0) + 1`; `retryLimit = original.unit?.retryLimit ?? child.retry_limit` (the inherited value
  always wins over a retry naming a different one — a retry cannot raise its own ceiling).
  Refuse (note, naming the limit and the attempt count) when `retryCount > retryLimit`. On
  success, persist `{ retryOf: original.id, retryLimit, retryCount }` onto the new child's
  `unit` object alongside the fields already written there (`run.ts:1672-1678`).

Requires, as a **follow-up out of this task's write-scope**: `prompts.ts` prose teaching
Caesar/Legate to name `retry_of` on a respawn — without it, this enforcement never fires for any
existing mission.

**Default-path impact**: every existing instruction ("respawn once, within retry_limit" —
`prompts.ts:103, 132`) keeps working exactly as before for a parent that never names
`retry_of` — it is just not *counted*. This is not a replacement of the prompt-only discipline;
it is an opt-in reinforcement layered on top, inert until the `prompts.ts` follow-up ships (see
Open questions).

**Transitions out of new state**: `retryCount`/`retryLimit`/`retryOf` are plain data, read only
at the instant of a future `CEZ:SPAWN` naming that lineage — no timer, no park, no wake source.
The only "transition" is a future spawn refused or allowed-with-incremented-counter, which is
itself the terminal answer.

**Tests to pin**: `retry_of` naming an unrelated run → refused; a retry chain exceeding the
inherited `retryLimit` → the `(limit + 1)`th refused, with the exact count in the note; a
retry's own `retry_limit` disagreeing with the inherited one, both directions → inherited value
wins; a normal spawn naming no `retry_of` → completely unaffected (regression guard, since this
touches the shared `unit:` literal every child, retried or not, goes through).

**Effort**: M–L (schema change plus the contract/store parity requirement AGENTS.md calls out
by name for this exact field, plus the prompt follow-up needed to ever make it fire).
**Risk**: med — the highest-risk part is exactly that parity requirement; missing the
`store.ts` twin ships a lineage the contract accepts and the store silently drops.

## Open questions for the user

1. **P-D4's `'rescope'`** shares `'message'`'s code path entirely (a prefixed string). Keep it
   as its own labelled action for transcript legibility, or fold it into `'message'` and drop
   the third enum value?
2. **P-D3's overlap check** is proposed as note-only, never a refusal. Is there appetite for a
   hard refusal on the one case with no plausible legitimate reading — two children naming the
   *exact same* scope string — while keeping segment-prefix overlap advisory?
3. **P-D4 refuses `CEZ:DIRECT` against an already-settled child** by design, to protect the
   review gate. Is a narrower, explicitly-labelled "reopen a settled child under supervision"
   action wanted later, or should that gap stay closed for the MVP and rely on P-D5 instead?
4. **P-D5 is inert until `prompts.ts` teaches `retry_of`.** Should that prompt change ship in
   the same PR as the schema/engine work (so the feature is load-bearing from day one), or be
   sequenced separately?

## Evidence

- `git diff --stat` against the fork point (`cez/36533222`, which resolves to the same commit as
  `HEAD`, `df73cfa9` — this branch had no prior commits of its own): only this file.
- `npx vitest run packages/cezar/src/units` — 3 test files, 62 tests, all passing, run read-only
  (no test file was modified).
- `retry_limit` grep — every occurrence quoted verbatim in F-D7 above.
- `POST /runs/:id/messages` — `packages/cezar/src/server/server.ts:3831`.
