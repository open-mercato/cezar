# Framework board — implementation contract (shared by all implementers)

Spec: `.ai/specs/2026-11-15-framework-board.md`. Mockups: `assets/framework-board/mockups.html`.
This file fixes the interfaces between the slices so they can be built separately. If you must
deviate, keep the deviation small and say so in your final report.

## Graph extension (packages/cezar/src/workflows/graph.ts AND packages/contract/src/workflows.ts — mirror exactly)

- Every node's base gains optional `stage: string` (stage id regex same as nodeId). The engine
  reads it; the editor ignores it.
- Agent node gains optional `mode: 'conversation'` (absent = autonomous) — D10.
- Three new node types, all executed by cezar (no agent session), all carrying `stage`:
  - `stage.enter` `{ stage, wip?: int>0, precheck?: string /* shell command, run in the worktree */ }`
    ports `['next']`. WIP admission (D13) + framework pre-gate (`sdd.mjs gate <stage>`): when the
    stage is full, or `precheck` exits non-zero, the node PARKS `waiting` (no slot) with
    `card.blocked = { reason: 'wip' | 'precheck', detail }`; re-evaluated on wake (D13 exits,
    boot, framework state change). Cancel/Finish behave like other parked system nodes.
  - `stage.exit` `{ stage, artifacts: string[] /* globs, {{card.<f>}} already rendered at compile */ }`
    ports `['pass', 'missing']`. D14. `missing` normally unwired → run fails with the missing glob named.
  - `gate.framework` `{ stage, approve: string | null /* sdd stage name for `approve`, null = owner confirms via `done` */ }`
    ports `['approve']`. D7/D9: parks `waiting` (no slot, no timeout); only the framework state
    watcher advances it, when `state.command` reports this stage approved/done (never `stale`/`pending`).
- Graph validator: these types are valid anywhere a system node is; `gate.framework` has no
  timeout by design (D8 — human decision, holds no slot, cancellable).

## Framework file (packages/contract/src/frameworks.ts — the zod schema; server re-validates YAML with it)

```ts
frameworkStageSchema = {
  id: nodeId-like, name?: string, description?: string,
  skill?: string, command?: string,          // XOR (refine)
  mode?: 'autonomous' | 'conversation',     // default autonomous
  session?: 'fresh' | { continue: stageId }, // default fresh
  artifacts?: string[],                      // may contain {{card.<field>}}
  gate?: { kind: 'approve', message?: string, onReject?: stageId } | { kind: 'framework', approve: string | null },
  model?: string, runner?: RunnerId,
  wip?: number, checks?: string[], precheck?: string,
  review?: boolean, verdicts?: string[], onVerdict?: Record<verdict, stageId>, loopMax?: number /* default 2 */,
  skipUnless?: string,                       // a boolean cardField name; stage skipped when false
}
frameworkFileSchema = { id, name, description?, provisional?: boolean, detect?: string[],
  requires?: string[] /* default = detect; checked on the fork ref at POST /cards (409) and in the worktree at every stage.enter (park blocked 'precheck'); snapshotted on card.requires */,
  state?: { command: string, watch?: string }, cardFields?: Array<{name,label,type?:'string'|'boolean',pattern?,from?:'title',default?}>,
  stages: frameworkStageSchema[] (min 1) }
```
Refinements: unique stage ids; `onVerdict`/`onReject`/`session.continue` targets must be EARLIER
stages; verdict names valid.

## Compilation (packages/cezar/src/frameworks/compile.ts)

`compileFramework(fw, card: { title, brief, fields, autonomous?, startAt?, skip?: string[], overrides?: Record<stageId,{model?,runner?}> }) → WorkflowGraph`
pure. Per stage, in order: `stage.enter` → agent (prompt generated: title + brief, stage role/skill,
required artifacts, verdicts, and for framework gates "never run approve") → `check` nodes for
`checks` (fail → loop(loopMax) → agent) → `stage.exit` (when artifacts) → gate (`gate.human` for
`approve` with `reject` → loop → onReject stage's `stage.enter` (default previous stage); `gate.framework`
for `framework`) → next stage. `onVerdict` back edges go through a `loop` node (max loopMax).
Every node gets `stage`. Node ids are `<stage>-<role>` (e.g. `spec-agent`, `spec-gate`).
Skipped stages (skip list, startAt, or `skipUnless` false) are not compiled; `card.stages[id] = 'skipped'`.
Autonomous cards: conversation stages compile without `mode: conversation`.
Ship is not compiled — the run's existing review gate.

## Run record (packages/contract/src/runs.ts `runRecordSchema`, optional)

```ts
card?: {
  framework: string; frameworkHash: string; title: string;
  stage: string;
  stages: Record<string, 'pending'|'running'|'waiting'|'done'|'failed'|'skipped'|'stale'>;
  stageOrder: string[];                // column order snapshot (framework stages at creation)
  held?: boolean; order?: number; autonomous?: boolean;
  fields?: Record<string, string | boolean>;
  blocked?: { reason: 'wip' | 'precheck' | 'gate'; detail?: string; since: string };
  frameworkState?: { changeId: string; lastStatus?: unknown };
  history?: Array<{ at: string; text: string }>; // capped (e.g. 50)
  issue?: { provider: string; ref: string; url?: string };
}
```
Ad-hoc runs never get this field. Scheduler: skip `card.held`; among queued cards order by `card.order`.

## Frameworks module (packages/cezar/src/frameworks/)

- `builtins.ts` — `generic`, `open-mercato-sdd`, `openspec` (provisional), `spec-kit` (provisional) as YAML strings or objects; vendor command names for openspec/spec-kit in ONE dated file `vendor-catalog.ts`.
- `load.ts` — `listFrameworks(repoRoot, dataDir)` → built-ins + `.ai/cezar/frameworks/*.yaml` (invalid file → listed with `error`, never thrown); `getFramework(id)`; `frameworkHash(yamlText)`.
- `detect.ts` — `resolveProjectFramework(repoRoot, dataDir) → { id, source: 'explicit' | 'detected' | 'fallback', detectedBy?: string }` (D6: existsSync only; explicit `framework` in `.ai/cezar/config.json` wins).
- `availability.ts` — per stage: skill/command present in this repo (skills discovery from `src/skills.ts`).
- `state.ts` — run `state.command` (execFile, cwd = worktree, timeout), parse SDD `status --json`, map to per-stage statuses; `approveSdd(worktree, stage, changeId, by)` spawns `node .ai/sdd/sdd.mjs approve <stage> --by <name>` with `SDD_NONINTERACTIVE_APPROVAL=<changeId>` set ONLY on that spawn's env, then `git commit` of change.json.
- Project framework choice: `.ai/cezar/config.json` key `framework` (optional string; absent = automatic).
- `.ai/cezar/frameworks/` is committable → `ensureDataGitignore` allowlist like `workflows/`.

## RunManager API (packages/cezar/src/workflows/run.ts) — used by the server slice

```ts
createCard(input: CreateCardBody): Promise<RunRecord>      // compiles, starts as queued (+held unless ready)
patchCard(runId, patch: { held?, order?, autonomous?, fields?, title?, brief? }): RunRecord  // fields/brief only while held
rerunCard(runId, fromStage: string): RunRecord            // waiting/review/failed only
finishStage(runId): void                                   // conversation stage → next node
approveCardGate(runId, by: string): Promise<{ ok: true } | { ok: false; error: string }> // D9, then rechecks state
recheckFrameworkState(runId?: string): Promise<void>       // watcher tick; also called on cockpit focus
```

## HTTP (project-scoped, chained into ONE new family builder; schemas in contract `frameworks.ts`/`cards.ts`)

| Route | Body / response |
|---|---|
| `GET /frameworks` | `{ frameworks: FrameworkSummary[], active: { id, source, detectedBy? } }` |
| `GET /frameworks/:id` | `{ framework, yaml, stages: StageAvailability[], graph: WorkflowGraph, source: 'builtin'|'project' }` |
| `POST /frameworks/:id/duplicate` | `{ newId }` → `{ id, path }` (409 if exists) |
| `PUT /project/framework` | `{ framework: string \| null }` → `{ active }` |
| `POST /cards` | `CreateCardBody { title, brief?, framework?, fields?, issue?, ready?, autonomous?, startAt?, skip?, overrides?, budgetUsd? }` → `{ run }` |
| `PATCH /cards/:runId` | `PatchCardBody` → `{ run }` |
| `POST /cards/:runId/rerun` | `{ fromStage }` → `{ run }` |
| `POST /cards/:runId/finish-stage` | `{}` → `{ ok: true }` |
| `POST /cards/:runId/approve` | `{}` → `{ ok: true }` or 409/422 `{ error }`; 409 when `!capabilities().localHandoff` |
| `POST /cards/recheck` | `{}` → `{ ok: true }` (cockpit focus recheck) |

Board reads the existing runs list + SSE (filter `card` present). No new poll, no new WS topic.
