# Workflow graphs & node editor

Status: DRAFT (2026-09-30) · Supersedes the builder UI of spec 012 (its portable `skills:` format stays) · Touches: `workflows/types.ts`, `workflows/load.ts`, `workflows/run.ts`, `packages/contract/src/workflows.ts`, `packages/web/src/routes/workflows/`

## Goal

A workflow stops being a linear list of steps and becomes a **graph of typed nodes** edited on a
canvas (n8n / Blender-node style). Every thing a task does — run an agent, dispatch a subtask,
run a check, loop back, open a PR, wait for CI — is one visible block, and the graph shows
*exactly* how the task will execute: which edge is taken on pass vs fail, where a loop returns,
what happens when it gives up.

## Today (what we replace, and what it was load-bearing for)

- `steps[]`: `agent` (prompt/skill/model/runner/tools) XOR `check` (`command`).
- Only control flow: `check.onFail {retry, max}` — a bounded jump to an EARLIER step; the failing
  output is appended to the retried agent's prompt. `stepsIssue` forbids forward jumps.
- Every agent step gets the same `{{task}}`; context flows via the worktree + handoff journal.
  `chainStepNote` stops a later step treating an earlier step's `CEZ:DONE` as the run's.
- Review gate, draft PR, CI monitoring (`CEZ:MONITORING`) and dispatch live OUTSIDE the workflow,
  as run-level mechanisms.

Guarantees the new engine must keep: bounded loops (`max`), failing-output injection on retry,
the chain note, `quick-task` byte-for-byte unchanged, every parked state has an on-by-default exit.

## Decisions (owner, 2026-09-30)

| # | Question | Decision |
|---|---|---|
| D1 | Flow semantics | Directed graph with branches and loops, **one active node at a time** (no fork/join in v1). |
| D2 | File format | New `version: 2` graph format; v1 `steps`/`skills` files keep loading and open in the editor as a linear graph. No migration of user files. |
| D3 | MVP categories | Agents · Flow control · Scripts & checks · Git & GitHub. |
| D4 | Live view | Authoring first. Run-state model designed now, live graph overlay in phase 3. |
| D5 | Conditions | **Named output ports.** A node finishes by emitting exactly one port; the edge from that port is the branch. No expression language. |
| D6 | Agent context | Per node: fresh session (default) or `session: continue <nodeId>`. Worktree + handoff always shared. |
| D7 | Data passing | Node outputs readable in templates: `{{nodes.<id>.<field>}}`. |
| D8 | Run-level mechanisms | Available as nodes; a graph WITHOUT them behaves exactly like today (gate from config, PR button, monitoring). |
| D9 | Loops | Explicit `loop` node. Every cycle in the graph must pass through one; the validator rejects others. |
| D10 | Agent ports | Always `done` / `failed`; optional author-declared `verdicts` the agent picks with an end-of-turn marker. |
| D11 | Editor | React Flow (`@xyflow/react`) canvas + node property panel + two-way YAML pane + path simulator. |
| D12 | Subagent | `dispatch` node = child task through the existing dispatch engine (own worktree, carved budget, 4 in flight). |
| D13 | Agent `done` | **Corrected 2026-09-30 after reading `run.ts`:** keeps today's semantics. A non-terminal agent node emits `done` when its turn ends without parking (no `CEZ:ASK` / `CEZ:MONITORING`), exactly like a non-final v1 step. The *terminal* agent node — whose `done` leads straight to a success `end` (or is unwired) — is interactive like v1's last step: it waits for follow-ups until `CEZ:DONE` / Finish. The original wording (every node waits for `CEZ:DONE`) would have stalled every multi-step workflow after each step. |
| D14 | Missing verdict | One automatic nudge reminding the agent of the required marker (autonomous-nudge path); still none → `failed`. |
| D15 | Review gate | Independent: the config gate still applies at the run's end; `gate.human` is an extra mid-graph decision point. Zero change to the default path. |
| D17 | Verdict syntax | `CEZ:VERDICT <name>` at the end of the turn text (detected on accumulated turn text, like `CEZ:DONE`). A verdict completes the node — no `CEZ:DONE` needed. An undeclared name counts as no verdict (→ D14). The allowed list is injected into the node's prompt. |
| D18 | Loop counter | One counter per loop node for the whole run; never reset. Guarantees every run is finite. Shown as "iteration 2/3". |
| D19 | Built-ins | Ship 2–3 exemplar graphs (implement → test loop; implement → review → PR; fix-CI loop) as built-ins, duplicable in the editor. `quick-task` stays the default and byte-for-byte unchanged. |
| D16 | Budgets | Run-level only in v1 (plus dispatch budgets). Per-node cost is still recorded for the live view. |

## File format v2

```yaml
version: 2
name: implement-test-review-pr
description: Implement, loop on tests, AI review, open a draft PR.
nodes:
  - { id: start, type: start }
  - id: implement
    type: agent
    prompt: "{{task}}"
    runner: claude
  - id: tests
    type: check
    command: npm test
  - id: retry
    type: loop
    max: 3
  - id: fix
    type: agent
    session: { continue: implement }
    prompt: |
      Tests failed (attempt {{nodes.retry.iteration}}/{{nodes.retry.max}}):
      {{nodes.tests.output}}
  - id: review
    type: agent
    skill: code-review
    prompt: Review the changes for {{task}}.
    verdicts: [approve, changes]
  - id: pr
    type: github.draft-pr
  - { id: ok, type: end, status: success }
  - { id: gave-up, type: end, status: failed }
edges:
  - { from: start, to: implement }
  - { from: implement.done, to: tests }
  - { from: tests.pass, to: review }
  - { from: tests.fail, to: retry }
  - { from: retry.repeat, to: fix }
  - { from: retry.exhausted, to: gave-up }
  - { from: fix.done, to: tests }
  - { from: review.approve, to: pr }
  - { from: review.changes, to: retry }
  - { from: pr.created, to: ok }
layout:            # editor-only; ignored by the engine, optional
  implement: { x: 240, y: 80 }
```

Rules:
- `from: <node>` without a port means the node's default port (`next`/`done`/`pass`).
- An output port with no edge: `failed`-type ports end the run as `failed` (today's semantics);
  success-type ports end the run successfully. The validator warns on every unwired port.
- v1 → v2 is a pure, in-memory compile (`compileV1`), so one engine runs both. `check.onFail`
  compiles to `check.fail → loop(max) → retry target`, with the failing output injected as today.
- Saving from the editor writes v2 unless the graph is still expressible as a pure skill stack
  (then the compact `skills:` form, as spec 012 does).

## Node catalog (MVP)

| Category | Node | Config | Output ports | Outputs (`{{nodes.id.*}}`) |
|---|---|---|---|---|
| Flow | `start` | — | `next` | — |
| Flow | `end` | `status: success\|failed` | — | — |
| Flow | `loop` | `max` (required) | `repeat`, `exhausted` | `iteration`, `max` |
| Flow | `gate.human` | `message` | `approve`, `reject` | `comment` |
| Agents | `agent` | prompt/skill, runner, model, tools, `session`, `verdicts` | `done`, `failed`, …verdicts | `summary`, `verdict`, `costUsd` |
| Agents | `dispatch` | prompt, workflow?, budgetUsd?, runner? | `done`, `failed` | `runId`, `summary` |
| Agents | `ask-user` | question | `answered` | `answer` |
| Scripts | `check` | `command`, `timeoutMs` | `pass`, `fail` | `exitCode`, `output` (tail-capped) |
| Git | `git.commit` | message template | `done`, `nothing`, `failed` | `sha` |
| Git | `github.draft-pr` | title/body templates | `created`, `failed` | `url`, `number` |
| Git | `github.wait-ci` | `timeoutMs` (required, default 60 min) | `green`, `red`, `timeout`, `failed` | `status` |
| Git | `github.pr-comment` | body template | `done`, `failed` | — |

Categories are data (`category` on each node definition) so the palette groups them and new
nodes slot in without editor changes. One `NodeDefinition` registry is shared by engine,
validator and editor: `{ type, category, configSchema (zod), ports, outputs }`.

## Engine

- One cursor per run: `graphState { cursor, loopCounters, outputs, visits }` persisted as a new
  OPTIONAL field on `RunRecord` — old records still parse; recovery resumes at `cursor`.
- Both `ActiveRun` construction sites (`execute`, `runContinuation`) and both turn-end handlers
  must go through one `advanceGraph()` helper (AGENTS.md § construction sites).
- Loop counters are per loop node and never reset within a run (D18).
- Every waiting node has a bounded exit: `wait-ci` requires a timeout (uses the monitoring wake
  timer); `gate.human` / `ask-user` park the run as `waiting` exactly like today's asks.
- `CEZ_DRY_RUN=1`: GitHub nodes fake their results (PR URL as today, CI = green).
- Git/GitHub nodes run cezar's own code (not an agent) and degrade like `server/github.ts`:
  no `gh` → the node emits `failed` with a one-line reason, never throws.

## Editor (packages/web)

- `/p/:projectId/workflows/:name` → canvas (React Flow), palette on the left grouped by category,
  property panel on the right (form generated from the node's zod config schema, live validation),
  collapsible YAML pane with two-way sync (server parses YAML via `POST /workflows/parse`).
- Loop node renders its limit and both exits; back-edges drawn distinctly (dashed, curved).
  Ports are colour-coded: success / failure / verdict.
- Auto-layout (elkjs) for v1 files and "tidy up"; manual positions saved in `layout`.
- **Path simulator:** "Simulate" mode — click through ports (pass/fail/verdict) and watch the
  path highlight, with loop counters, until an `end` node. No agent runs.
- Validation surfaced on the canvas: unwired ports, unreachable nodes, cycles without a loop,
  unknown skills/runners, missing required config.

## API / contract

- `packages/contract/src/workflows.ts`: `workflowGraphSchema` (v2) alongside the v1 schema; the
  `workflowDefSchema` persisted on runs gains an optional `graph`.
- Existing `POST /workflows`, `POST /workflows/parse` accept/return v2; new
  `POST /workflows/validate` → `{ issues: [{ nodeId?, edge?, severity, message }] }`.
- Node catalog served by `GET /workflows/nodes` so the palette never hard-codes types.
- Chained route families, middleware validation, BACKWARD_COMPATIBILITY.md §2 inventory.

## Phases

1. **Format + engine**
   - **1a (done):** `workflows/graph.ts` — v2 schema, `graphIssues`, `advance`/`enterGraph`,
     `renderNodeRefs`, `compileV1`, `graphToSteps`; loader accepts `version: 2`; contract
     `workflowDefSchema.graph`; `RunManager.executeGraph` for `start`/`end`/`loop`/`agent`/`check`.
     v1 workflows keep the untouched step loop (swapping them onto `compileV1` is a later,
     separately-proven change). No cursor persistence: recovery already fails-and-continues an
     interrupted run rather than resuming mid-workflow, for v1 and v2 alike.
   - **1b (done):** agent `verdicts` → one port per verdict, `CEZ:VERDICT <name>` parsed from
     the node's last turn, one nudge on the node's own session when missing, then `failed`;
     a verdict node is never the interactive tail. `session: { continue: <agent node> }`
     reopens that node's session (claude/codex/pi); it degrades to a fresh session with a note
     when the target has no session yet, ran on another backend, or the backend cannot resume.
     Agent outputs `summary` (last-turn tail), `verdict`, `costUsd`. Routes:
     `GET /workflows/nodes`, `POST /workflows/validate` (`{ issues: string[] }`),
     `POST /workflows/graph` (save v2; 201 / 400 / 409 `exists`), and `POST /workflows/parse`
     accepts v2 (adds `graph`). BACKWARD_COMPATIBILITY.md §2 and §4 updated. The dry-run mock
     answers `mock:verdict=<name>` and the verdict nudge.
   - **1c (done):** `gate.human`, `ask-user`, `dispatch`, `git.commit`, `github.draft-pr`,
     `github.wait-ci`, `github.pr-comment` (`RunManager.runSystemNode`). Waits with no agent
     session go through one helper, `parkGraphNode`: the run gives its `maxParallel` slot back
     (and an in-place dispatch run its working-tree lease), and every wait has on-by-default
     exits — its own event, cancel, Finish (settles like an abandoned ask park), an optional
     `timeoutMs` (REQUIRED, defaulted to 60 min, on `wait-ci`), and a restart (`askParked`
     waits settle `failed` + Continue, like today's ask parks; mid-graph resume is not built).
     Gates/questions reuse the ask card: a click sends `<header>: <label>`, `cardReply` strips
     the header; a reply starting with "approve" approves, anything else rejects and becomes
     `comment`. Only a USER-authored message answers a wait. `dispatch` awaits its child via
     `reportSettledChildToParent` (a cancelled child takes `failed`). GitHub nodes reuse
     `createDraftPr` / `fetchGithubChecks` and a new `commentOnPr`; under `CEZ_DRY_RUN` the PR is
     faked and CI reports green. System nodes ride the run rail as `check`-kind rows
     (`graphRailSteps`).
2. **Editor (done, 2026-09-30)** at `/p/:projectId/workflows-new[/:name]`, beside the shipped
   builder: `packages/web/src/routes/workflow-graph/` (React Flow, lazy chunk) over pure model
   helpers in `packages/web/src/lib/workflow-graph.ts`. Palette from `GET /workflows/nodes`
   (drag or click to add), wire by dragging port → node (one edge per port), Backspace deletes,
   inspector forms per node type (id rename carries edges/layout/`session.continue`), live
   server validation (debounced; quoted node ids in messages highlight nodes), Tidy up
   (layered auto-layout), path simulator, YAML preview + import (v1 or v2 via
   `/workflows/parse`), save through `POST /workflows/graph`. v1 workflows open compiled to a
   graph; saving one writes a v2 file. Re-saving the opened file overwrites silently; a name
   colliding with another file asks; a built-in name (`quick-task`) asks with an explicit
   "replaces it for every task" warning. Open: replacing `/workflows` with this editor, and
   component tests for the route (React Flow needs ResizeObserver in jsdom).
3. **Live view (done, 2026-09-30):** a **Graph** tab in the task view (`/tasks/:id/graph`,
   shown only for runs of a v2 workflow; `routes/workflow-graph/task-graph.tsx`). The run record
   gained optional `graphState { loops, taken }` — per-loop counters and every edge taken, in
   order (`<node>.<port>-><target>`, capped at 500) — written by `executeGraph` on each
   transition. The view folds it with the rail steps (`runOverlay`): node status (running /
   needs you / done / failed / pending), `run N×`, per-node cost, loop `iteration n / max`,
   taken edges thick with a `×N` count, untaken ones faded. Live with no new channel — the
   record already streams over the global SSE. Node outputs are not shown yet.

## Follow-ups (done, 2026-10-01)

- **One engine.** `execute` always walks a graph: a step-list workflow is compiled on the fly
  (`compileV1`) and walked by `executeGraph`; its record and rail keep the v1 steps. The whole
  v1 run suite passes unchanged through the graph engine — that suite is the equivalence proof.
  Run errors keep the v1 wording (`step "x" failed: …`, `check "x" failed after N attempts`),
  and a loop going back re-opens the rail steps between its target and the failing node.
- **Resume after a restart.** `graphState` also carries `cursor` (the node being run) and
  `outputs`. `recover()` re-queues a run whose cursor is a node cezar runs itself (gate,
  question, check, dispatch, commit, PR, CI wait) and the walk resumes AT that node with loop
  counters and outputs restored. Side effects are idempotent: `dispatch` waits for the child it
  already sent, `draft-pr` reports a PR the run already has. **Deliberately not** for an agent
  node: its interrupted session keeps the Continue path (#1076's guarantee that a parked agent
  is not walked past on a markerless restart turn).
- **Node outputs in the live view.** Clicking a node in the task's Graph tab opens its details:
  status, runs, cost, loop iterations and every `{{nodes.<id>.<field>}}` value. The Graph tab
  shows for every run with a stored definition.
- **The editor is the Workflows page** (`/workflows[/:name]`); `/workflows-new` redirects. The
  old builder is gone; its skill palette lives on as the palette's Skills section. Ask cards
  raised by a gate/question say "The workflow is asking" (`ask.requested.source: 'workflow'`).

- **Fork/join, branching, composition, templates (2026-10-01).** `parallel` (2–4 branches as
  dispatch children; `wait: all|any`, `any` cancels the losers; outputs `<branch>_status` /
  `_summary`), `workflow` (a catalog workflow as an awaited child — `RunManager.dispatch` takes an
  internal `workflow` option; the public dispatch order does not), `if` (`diff-lines`,
  `diff-files`, `paths-changed`, `output`, `branch`; diff reads go through
  `resolveTaskDiffBase`, `worktreeChangedFiles` beside `worktreeShortstat`). Issue/PR **labels**
  are not a condition: the run record stores no labels yet. Built-in templates live in
  `workflows/templates.ts` and are validated at module load; opening one in the editor names the
  canvas `<name>-copy`. Child waits are one helper (`awaitChildren`), resume-safe.

- **More git / GitHub nodes (2026-10-01).** `git.push`, `git.sync-base` (merge the freshest
  base; a conflict is left in progress and the node leaves by `conflict` for an agent to
  resolve), `github.pr-update` (ready, labels, reviewers), `github.issue-comment` (the task's
  issue by default), and `notify.webhook` behind `CEZ_WORKFLOW_WEBHOOKS=1` (off: the node leaves
  by `failed` with a note). **Not built, on purpose:** tracker write nodes (comment, transition) —
  `docs/adding-issue-tracker.md` names vendor writes a separate design change for the connection
  model. Automations already launch any catalog workflow (graphs and built-in templates
  included) through their workflow picker; nothing was needed there.

## Review fixes (2026-10-06)

- **A loop coming back through `fork` / `dispatch` / `workflow` dispatches afresh.** "Wait for the
  children already sent" is for a walk RESUMING at that node after a restart only; on an ordinary
  second visit it returned the first round's children (`review-council` reviewed nothing in round 2).
- **Only a loop's `repeat` port bounds a cycle.** The validator removes `repeat` edges, not loop
  nodes: a way back through `exhausted` is taken on every visit past `max` and never ends.
- **`compileV1` survives any v1 step id.** The start/end nodes take ids no step uses, every
  compiled edge names its port, and `parseEdgeFrom` splits at the LAST dot — a step called `start`
  or `lint.fix` used to end the run after one step.
- **`github.wait-ci` leaves by `failed` when the task has no PR**, not `red`: `red` is the fixer's
  branch, and `fix-ci` on a task without a PR spent three agent rounds on it.

## Builder parity (2026-10-06)

What the old builder did and the editor had dropped when it took over `/workflows`:

- **Delete** — Workflow settings → Delete workflow (file workflows only, behind a confirm).
- **Build from a description** — Workflow settings; `POST /plan` proposes a chain that opens on the
  canvas as its graph (#414). Replaces the canvas; nothing is saved until Save.
- **Compact `skills:` save** — a graph that is nothing but start → skill agents → success end
  (`skillStackOfGraph`, the mirror of `skillStackOf`) saves through `POST /workflows` in the
  portable form; anything richer is a `version: 2` graph. The YAML preview and Export show the
  form Save writes.
- **Export** — a top-bar button downloads `<slug>.yaml`.
- **Route tests** — `routes/workflow-graph/workflow-graph.test.tsx` (ResizeObserver stubbed; the
  canvas itself stays with the e2e suite).

## Open questions

None at the moment.
