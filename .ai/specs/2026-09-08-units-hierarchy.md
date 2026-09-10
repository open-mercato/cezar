# Units — a hierarchical army of runs (MVP)

> **Superseded (2026-09-10):** the missions/units feature was removed and replaced by task dispatch — see `2026-09-10-dispatch.md` and `units-research/00-verdict.md`. Kept for the record.


> Slug: `units-hierarchy` · Status: implementing · Opt-in: `CEZ_UNITS=1` → `capabilities.units`

## TLDR

cezar runs are flat: a task is one agent in one worktree. This spec adds a **hierarchy of runs**
named after the Roman army in English — **Caesar → Legate → Centurion**, with **legionaries** being
the centurion's own backend sub-agents. A running unit delegates by ending its turn with
`CEZ:SPAWN <json>`; cezar creates child runs one role below, each in its own worktree forked off the parent's branch.
Children report upward with `CEZ:REPORT <json>`; when a child settles, its report is delivered
into the parent's session. Budgets cap spend per node, cancel cascades, and the existing
`CEZ:ASK` card is the **Guard**: a unit run must ask before anything irreversible, and an
autonomous unit run never auto-continues past its own question. Per-role system prompts ship as
defaults and can be overridden per repo under `.ai/cezar/units/<role>.md` (delete = restore).
The cockpit gains a **Missions** tree, a **New mission** composer with a per-role runner+model
ladder, a **Guard** inbox (a filtered view of waiting unit runs), a role chip in the task thread,
and **Settings → Units** for the prompts.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why |
|---|---|---|---|
| Q1 | Gating | Opt-in `CEZ_UNITS=1`, `capabilities.units` in `/api/v1/health` (the `CEZ_AUTOMATIONS` pattern). Off: no `/units*`/`/missions*` routes, markers not parsed, role prompts not composed. | Widest cost-widening feature so far; AGENTS.md §Zero config. |
| Q2 | Which layers are real runs | Caesar, Legate, Centurion are runs. Legionaries = the centurion's native sub-agents (claude `Task`, added to its `allowedTools`). A centurion's `CEZ:SPAWN` is refused with a transcript note. Max **4 children in flight per parent**. | `maxParallel` defaults to 2 and only 2 monitors are slot-exempt; a four-layer tree of runs starves itself. |
| Q3 | Worktrees | Each child gets **its own worktree as today, forked off the parent's branch**: at spawn the child record is seeded with `baseBranch: parent.branch`, which `execute()` already prefers over the configured base (run.ts ~2661). The parent **merges the child branches it accepts** (`git merge --no-ff cez/<id8>`) in its own worktree; role prompts require committing before spawning and owning sibling conflicts. The mission root's branch accumulates the result and is the one draft PR. | A shared tree needs a lease held across parks (#438), which would block a parent's own children; releasing on park re-derives that guarantee across ~9 resume paths. Own worktrees reuse only shipped mechanisms and keep each child's Changes tab and review gate honest. |
| Q4 | Guard | Reuse `CEZ:ASK`. Role prompts require asking before irreversible actions. The autonomous nudge must **not** fire past an ask on a unit run (both turn-end sites). Guard inbox = unit runs at `waiting` with a pending ask. | No new marker, route, or record field; the resume path is plain `sendMessage`. |
| Q5 | Order of battle preview | None. Caesar's first turn plans and spawns. | A preview Caesar can ignore is worse than none; costs tokens before commitment. |
| Q6 | Budget brakes | All three: refuse a spawn beyond the parent's remaining budget (note in transcript); at turn end an over-budget unit run stops auto-continue, disarms its monitoring wake timer and parks `waiting` with a note; `cancel` cascades to descendants (depth-first, children first). | A cost feature with no working brake fails the "cost-safe AND functional" review. |
| Q7 | Parent wake | `deliverMessage(parent, blocks, false)` if the session is open; else `enqueueMessage`; else `continueRun(parent, …, deferForCapacity: true)`; and **always persist** the report on the parent as `unit.pendingReports[]`, flushed on session open, so a parent recovered after restart cannot lose it. | A `waiting` parent with no `ActiveRun` is reachable by none of the live paths. |
| Q8 | Unit sizes | **Legionary** (a plain task, unchanged), **Squad** (Centurion + legionaries), **Army** (Caesar → Legates → Centurions). Legion is cut for the MVP; `legate` stays in the enum, ladder and prompts. | Two tree shapes to test instead of three; Legion adds no mechanism. |

## Data

`unit` is an optional object on the run record (`packages/contract/src/runs.ts` and its persistence
twin in `packages/cezar/src/runs/store.ts`; parity test must pass). Absent = today's behaviour.

```ts
unitRoleSchema = z.enum(['caesar', 'legate', 'centurion'])
unitLadderEntrySchema = z.object({ runner: z.enum(RUNNER_IDS).optional(), model: z.string().optional() })
unitLadderSchema = z.object({ caesar: …, legate: …, centurion: … }).partial()   // per-role runner+model
unitReportSchema = z.object({
  status: z.enum(['done', 'partial', 'failed', 'blocked']),
  result: z.string().max(4000),
  evidence: z.array(z.string().max(400)).max(12).default([]),
  confidence: z.number().min(0).max(1).optional(),
  side_effects: z.array(z.string().max(400)).max(12).default([]),
  errors: z.array(z.string().max(400)).max(12).default([]),
  recommended_next_action: z.string().max(1000).optional(),
})
unitSchema = z.object({
  role: unitRoleSchema,
  missionId: z.string(),              // the root run's id
  parentRunId: z.string().optional(), // absent on the root
  budgetUsd: z.number().nonnegative().optional(),
  ladder: unitLadderSchema.optional(),
  report: unitReportSchema.optional(),              // this run's own CEZ:REPORT (last wins)
  pendingReports: z.array(z.object({ fromRunId, title, report, at })).optional(), // waiting for this run's next session
  overBudget: z.boolean().optional(),
})
```

Spawn payload (parsed from the marker; zod-validated, unknown keys rejected, a bad payload is a
transcript note and never a crash):

```ts
unitSpawnSchema = z.object({
  children: z.array(z.object({
    title: z.string().min(1).max(120),
    objective: z.string().min(1).max(4000),
    scope: z.string().max(1000).optional(),
    allowed_tools: z.array(z.string()).max(16).optional(),
    max_cost: z.number().positive().optional(),
    success_criteria: z.string().max(1000).optional(),
    required_evidence: z.string().max(1000).optional(),
    retry_limit: z.number().int().min(0).max(3).optional(),
  })).min(1).max(4),
})
```

## Markers (turn-end, both handlers, accumulated turn text)

Precedence: `CEZ:DONE` > `CEZ:SPAWN` > `CEZ:REPORT` > `CEZ:ASK` > `CEZ:MONITORING` > plain end.
A `CEZ:SPAWN` implies the parent keeps working on its own downstream work: after spawning, the
parent is parked exactly like `CEZ:MONITORING` (running + `activity: 'monitoring'`, wake timer
armed) so it surrenders its slot to the children. `CEZ:REPORT` stores `unit.report`; a report
without `CEZ:DONE` leaves the session as today's rules dictate. All markers are stripped from the
persisted text the way `CEZ:ASK` is. Parsed **only** when `capabilities.units` is on and the run
has a `unit`.

## Child run creation

`RunManager.spawnChildren(parentId, spawn)`: for each child, `startRun(single-step '(planned)'
workflow, { task: <envelope text>, systemPrompt: <role prompt>, runner/model from the mission
ladder for the child role, autonomous: true, unit: { role: childRole, missionId, parentRunId:
parentId, budgetUsd: min(max_cost, remaining), ladder } })`, then seed the child record with
`baseBranch: parent.branch` so its worktree forks off the parent's branch (nothing in the worktree
block changes). The envelope text is the objective plus a `## Task order` block listing scope,
allowed tools, max cost, success criteria, required evidence, retry limit, and the parent's branch.
Refusals (centurion spawning; >4 in flight; over budget; malformed) append a `note` event to the
parent's transcript and do not change the parent's state. Role prompts state, because no code does
it for them: commit before spawning (children fork the committed tip); validate then merge each
accepted child branch with `git merge --no-ff`; sibling conflicts are the parent's to resolve.

## Reports and settle

When a child settles (done / review / failed / cancelled) or emits `CEZ:REPORT`, build a compact user-role
message: `Report from <role> "<title>" (<runId>, branch cez/<id8> off <baseBranch>): status … result …
evidence … diff stat … cost $x` — the branch is what makes the report actionable for the merge. Deliver per
Q7. When a parent's session opens (first step or continuation), any `unit.pendingReports` are
prepended to its prompt and cleared.

## Budget

`remaining(parent) = budgetUsd − costUsd − Σ children.budgetUsd` (children read from the store by
`parentRunId`). Spawn refused when a child's `max_cost` exceeds remaining (or when remaining ≤ 0
and the child names no cost). At both turn-end handlers, if `costUsd ≥ budgetUsd`: set
`unit.overBudget`, append a note, skip the autonomous nudge, clear the wake timer, park `waiting`.

## Role prompts

`packages/cezar/src/units/prompts.ts`: `DEFAULT_UNIT_PROMPTS: Record<UnitRole, string>` and
`resolveUnitPrompt(repoRoot, role)` reading `.ai/cezar/units/<role>.md` when present. Composed
into the step system prompt after the handoff contract and before skills. Each default prompt
states: who you are, what you receive (a task order), how you delegate (`CEZ:SPAWN <json>` with the
schema above; centurions dispatch legionaries as native sub-agents instead), how you report
(`CEZ:REPORT <json>`), when to park (`CEZ:MONITORING`), escalation rules (retry ≤ retry_limit on
transient failure; conflicting evidence goes up as a report), and the Guard rule (before anything
irreversible, financial or scope-widening, end the turn with `CEZ:ASK` and stop; never work around a
blocked action; prefer draft PRs; never merge).

## Routes (project-scoped, gated, chained families, validated through the validators trio)

- `POST /api/v1/p/:projectId/missions` body `{ objective, unit: 'legionary'|'squad'|'army', budgetUsd?, ladder?, constraints?: string[] }` → `{ id }`. `legionary` = plain `startRun` with no `unit`. `squad` → root role `centurion`; `army` → root role `caesar`. Root gets `autonomous: true`, `unit.missionId = own id`.
- `GET /api/v1/p/:projectId/units/prompts` → `{ prompts: { [role]: { text, source: 'default'|'file' } } }`; `PUT …/units/prompts/:role` `{ text }`; `DELETE …/units/prompts/:role` (restore default).
- 409 `{ error }` on every route when `capabilities.units` is false (the automations gate pattern), covered by `units-gate.test.ts`.
- Cancel: existing `POST /runs/:id/cancel` cascades when the run has a `unit`.

## Cockpit

- Nav item **Missions** (`/p/:id/missions`, gated on `capabilities.units`), also in the ⌘K Views group by construction (`visibleNavItems`).
- `/missions`: a tree table over `useRuns()`; a child row shows its branch and, when the parent has merged it (`git merge-base --is-ancestor`, exposed later), a merged mark — for the MVP the branch name alone — group by `unit.missionId`, nest by `parentRunId`; columns Mission · Status · Model · Budget (`costUsd / budgetUsd` meter, amber ≥70 %, danger over) · Agents · Updated; a violet banner at the top when any unit run is `waiting` with a pending ask ("waiting for the Guard"). Rows link to the task thread. Status colour lives only in the dot (`StatusDot`/`Pill`).
- `/missions/new`: objective textarea, unit size (three cards), constraints chips, budget, per-role ladder with runner + model pickers fed by the existing model-catalog queries. POST, then navigate to the tree.
- `/guard`: the same rows filtered to unit runs at `waiting` with a pending ask; row → thread (the ask card is the approval UI).
- Task thread run header: role chip (`Caesar`/`Legate`/`Centurion`) and a parent breadcrumb link; a small "Children" list under the header for parents.
- Settings → Units section (gated): one editor per role, `edited`/`default` badge, Save, Restore default.
- Phone: the tree collapses to one level per screen is out of scope for the MVP; the table scrolls.

## Tests (minimum)

- Marker parsers (`units/markers.test.ts`): valid, malformed, unknown keys, too many children.
- Prompts module: default, file override, restore.
- Engine (fake runner, both turn-end sites): a caesar emitting `CEZ:SPAWN` creates N children with the right role/ladder/budget and parks as monitoring; a centurion's spawn is refused; 5th in-flight spawn refused; over-budget spawn refused; child settle delivers a report into an open parent session and persists a pending report for a closed one; over-budget turn end parks without auto-continue and disarms the wake timer; cancel cascades; autonomous unit run does not auto-continue past `CEZ:ASK` while a non-unit autonomous run still does (guard test).
- Routes: missions start for all three sizes; prompts CRUD; gate off → 409; parity/typed-bodies/route-inventory suites pass.
- Web: tree grouping is a pure function with tests; nav gating; settings section renders and saves.

## Out of scope (follow-ups)

Legion size in the composer; signed approval tokens; a mission ledger file; the order-of-battle preview; phone drill-in; codex/opencode legionaries (a centurion on those backends does the work itself, noted in the prompt).
