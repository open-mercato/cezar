# Optional review gate — default-off env, Settings override, auto-skip when autonomous

Status: proposed · Date: 2026-07-18 · Issue: #489 · Relates: spec 009 (the diff-first review gate this makes optional), spec 2026-07-17 task-auto-naming (the `liveTitleUpdates` env/config/Settings precedent mirrored here)

## TLDR

The diff-first review gate (spec 009) currently fires for **every** successful run whose
worktree has changes — the task parks at `review` and waits for a human to press **✓ Accept**,
**↩ Send back**, or **🚀 Draft PR**. Issue #489 makes that gate **opt-in**: off by default,
turned on by an env var (`CEZ_REVIEW_GATE`) overridable by a Settings toggle (`reviewGate`), and
**always skipped for autonomous runs** (the "autonomous" checkbox on task start) — even when the
gate is on — because an autonomous task must land its changes with zero human intervention. When
the gate does not apply, a successful run with changes settles straight to `done`; the diff stays
in the worktree exactly as it does today.

## Resolved defaults (Open Questions closed autonomously per owner direction 2026-07-18)

- **Q1 — names?** Config key `reviewGate: boolean`; env `CEZ_REVIEW_GATE` (`'1'` → on; unset/`'0'`/anything-else → off). **Default OFF**, the same default as `liveTitleUpdates`.
- **Q2 — one spec or split?** One independently-deployable capability (make the gate optional, and auto-skip it when autonomous). Not split.
- **Q3 — gate off + changes present → what status?** `done`. No new "apply"/commit step is introduced; the worktree diff is already on disk and simply stays there, unchanged from today's behavior. "Auto-applied with no user intervention" = the run finishes without parking at `review`.
- **Q4 — Settings placement?** Settings → Agents, next to *Live title updates* (`agents-section.tsx`).
- **Q5 — precedence when gate ON but run is autonomous?** Autonomous wins → skip. Autonomous is the stronger signal.
- **Q6 — persist `autonomous`?** Yes. It currently lives only on in-memory workflow `state`; add an additive `autonomous?: boolean` to `RunRecord` so `settleSuccess`, the group-pick winner-park, and `recover()` all honor it (and `recover()` re-threads it into a recovered queued run's `input` — H2).

## Problem Statement

Two concrete failures today, both rooted in `settleSuccess` (`src/workflows/run.ts:1381`), which
parks any successful run with a non-empty worktree diff at `review` regardless of context:

1. **The gate is mandatory.** Every changed run stops for a human accept, even for users who want
   cezar to just run and leave the changes in the worktree. There is no way to turn the gate off.
2. **Autonomous runs still park at `review`.** The "autonomous" checkbox (`new-task.tsx`,
   `AutonomousToggle`) only suppresses the *mid-run* `waiting` pause (auto-nudge at
   `src/workflows/run.ts:744-766`). It does **not** reach the terminal review gate — `settleSuccess`
   takes only `runId` and never reads `state.autonomous`. So a run explicitly started as
   "don't ask me" still ends up waiting for a human to accept. This is the core bug in #489.

The `autonomous` flag is not even persisted: `runRecordSchema` (`src/runs/store.ts`) has no
`autonomous` field. So the two other places that apply the review-park rule — `recover()`'s
`settleSuccess` call for `waiting` runs (`src/workflows/run.ts:419`) and the group-pick winner-park
(`src/server/server.ts:636-654`) — have no way to know a run was autonomous, and `recover()` even
drops autonomy entirely when it rebuilds a re-queued run's `input` (`run.ts:385-393`).

## Proposed Solution

Gate the `review` transition on a resolved boolean instead of unconditionally:

```
park at review  ⟺  worktreeHasDiff  AND  reviewGateEnabled(config)  AND  NOT run.autonomous
otherwise        → done
```

- **`reviewGateEnabled(config, env)`** — a new resolver mirroring `liveTitleUpdatesEnabled`
  (`src/runs/auto-name.ts:42`), but defaulting **off**: `config.reviewGate` wins when set, else
  `env.CEZ_REVIEW_GATE === '1'`, else `false`.
- **`autonomous` persisted on `RunRecord`** so `settleSuccess`, the group-pick winner-park, and
  `recover()` can read it (and `recover()` re-threads it into a recovered queued run's `input`).
- The **Settings toggle** and **env** thread through exactly like `liveTitleUpdates`
  (config → GET/PUT `/api/config` → Settings → Agents Switch).

Alternatives considered and rejected:

- **Skip the gate in the UI only (hide the ReviewPanel).** Rejected — the run would still sit at
  `review` in the store, still show the violet "needs review" pill (`attention.ts:99`), and still
  survive restarts at `review`. The decision belongs in the engine (`settleSuccess`), not the view.
- **Reuse permission modes (`acceptEdits`).** Rejected — permission mode is the Claude-CLI init
  field (`src/core/__fixtures__/claude/*.ndjson`), unrelated to cezar's `autonomous` flag, and the
  `permission` attention bucket is a reserved always-false stub (`attention.ts:56`). Keep distinct.

## Architecture

What changes vs. what is reused:

| Layer | File | Change |
|---|---|---|
| Config schema | `src/config.ts` (near `:48`) | **add** `reviewGate: z.boolean().optional()` |
| Env/config resolver | new `src/runs/review-gate.ts` (mirror `src/runs/auto-name.ts:42`) | **add** `reviewGateEnabled(config, env=process.env)`; default-off sense (`=== '1'`) |
| Engine settle | `src/workflows/run.ts:1381` `settleSuccess(runId)` | make it `await loadConfig(this.repoRoot)` (the `maybeRefreshTitle` pattern at `run.ts:1346`), read the run's persisted `autonomous`; park at `review` only when `diff && reviewGateEnabled(config) && !run.autonomous`, else `done` |
| Persisted record | `src/runs/store.ts` — inside `runRecordSchema` (spans ~`:34`–`:130`) | **add** `autonomous: z.boolean().optional()` (additive-safe) |
| Record write | `src/workflows/run.ts:257` — `startRun`'s `this.store.createRun({...})` | pass `autonomous: input.autonomous === true` (NOT `:843`, which is the in-memory `ActiveRun` state) |
| Recovery re-thread | `src/workflows/run.ts:385-393` — `recover()` rebuilds a queued run's `input` | **add** `autonomous: run.autonomous` to the rebuilt `input` so a recovered queued run stays autonomous (see H2 below) |
| Group-pick winner park | `src/server/server.ts:636-654` — `POST /api/groups/:groupId/pick` | this endpoint **inlines** the settleSuccess review-park rule (`:651-654`); gate it the same way (skip the `review` flip when gate off or `winner.autonomous`) |
| Config GET | `src/server/server.ts:1215` | **add** `reviewGate: config.reviewGate ?? null` |
| Config PUT | `src/server/server.ts:1243,1272-1274` (`app.put('/api/config')` at `:1245`) | **add** `reviewGate: z.boolean().nullable().optional()` + write/clear |
| Client types | `web/app/src/api/types.ts:580,596` | **add** `reviewGate` to GET + PUT config shapes |
| Settings UI | `web/app/src/routes/settings/agents-section.tsx` (near `:200`) | **add** a *Review changes before finishing* Switch mirroring live-title-updates |
| Env docs | `.env.example` (near `:52`), `README.md` (env table near `:343`) | document `CEZ_REVIEW_GATE` (default off) |

Reused unchanged: the whole `web/app/src/routes/task-thread/review-panel.tsx` UI, `finish`/`continue`/`pr`
endpoints (`server.ts:736/745/970`), `deriveAttention` (`web/app/src/lib/attention.ts:89`), the
`RunStatus` union (`store.ts:7`). This spec changes *when* `review` is entered, not the review
experience itself.

**Restart-recovery note (verified 2026-07-18).** The real restart path is `RunManager.recover()`
(`run.ts:367`), whose filter is `['queued','waiting','running']` (`run.ts:370`) — a run already
resting at `review` is **excluded** and survives a restart untouched (see Edge Cases: grandfathering).
For a `waiting` winner, `recover()` calls `settleSuccess` (`run.ts:419`), so fixing `settleSuccess`
fixes waiting-run recovery for free — no separate edit there. The only *other* place that inlines the
review-park rule is the group-pick endpoint above; that one does need the same gate.

## Data Model

`RunRecord` gains one additive optional field:

```ts
// src/runs/store.ts — inside runRecordSchema (spans ~:34–:130)
autonomous: z.boolean().optional(),   // set at creation from WorkflowInput.autonomous; read by settleSuccess + group-pick
```

Additive-safe per the store's existing additive rule (same pattern used for `prNumber`/`issueNumber`
in spec 2026-07-17). No migration: absent = falsy = "not autonomous".

**Two consumers must be wired, not one.** Persisting the flag lets `settleSuccess` and the group-pick
endpoint read it after the fact. But `execute()` reads autonomy from `input.autonomous`
(`run.ts:843`), not from the record — and `recover()` rebuilds a re-queued run's `input` *without*
autonomous (`run.ts:385-393` carries only task/model/runner/generateFollowups). So a **queued**
autonomous run recovered after a restart would run non-autonomously (no auto-nudge, and post-fix it
would wrongly park at `review`). The fix therefore threads the persisted flag back into the rebuilt
`input` in `recover()` — this is the one layer easy to miss (H2 in the Phasing plan).

Config file gains one optional key: `reviewGate?: boolean` (absent ⇒ env default ⇒ off).

## API Contracts

- **`GET /api/config`** — response gains `reviewGate: boolean | null` (`null` = no config key, env
  decides). Mirrors `liveTitleUpdates` at `server.ts:1215`.
- **`PUT /api/config`** — the config route is `app.put('/api/config')` (`server.ts:1245`; there is no
  PATCH handler — the client type comment confirms PUT at `types.ts:583`). Body accepts
  `reviewGate?: boolean | null`; `null` deletes the raw key (revert to env default), a boolean writes
  it. Mirrors `server.ts:1272-1274`.
- No change to `/api/runs/:id/finish`, `/continue`, `/pr`, or the create-run body — `autonomous`
  is already accepted (`server.ts:131`) and passed to the workflow (`server.ts:572`); the only new
  work is persisting it onto the record and threading it through `recover()`.

## UI/UX

Settings → Agents gains one row beside *Live title updates*:

- **Title:** *Review changes before finishing* (help text: "When on, a task with changes pauses so
  you can Accept, Send back, or open a Draft PR. Autonomous tasks always skip this and finish on
  their own. Default: off — tasks finish without asking.").
- **Control:** `<Switch data-slot="agents-review-gate" checked={config.reviewGate ?? false}>` —
  note `?? false` (default off), the mirror-image of live-title-updates' `?? true`.
- **Label:** On / Off with `(default)` annotation when the config key is unset, matching
  `agents-section.tsx:218-219`.

No change to the task-thread review flow, the `AutonomousToggle` on task start, or the status pills.
When the gate does not apply, the user simply sees the task go to `done` with its diff still visible
on the Changes tab.

## Edge Cases & Failure Scenarios

- **Gate off, run has changes** → `done`; diff stays in worktree; no PR, no prompt. (The primary #489 outcome.)
- **Gate on, non-autonomous, changes** → `review` (today's behavior, now opt-in).
- **Gate on, autonomous, changes** → `done` (autonomous wins; the #489 headline fix).
- **Gate off but run is autonomous** → `done` (both point the same way).
- **No changes in worktree** → `done` regardless of gate/autonomous (unchanged; the diff check stays first).
- **Restart while a run already rested at `review`** → **grandfathered, no change.** `recover()`'s
  filter (`run.ts:370`) excludes `review`, so the run survives the restart untouched and the user
  resolves it via the existing Finish/Send-back/Draft-PR actions. There is no "re-park at review on
  restart" path to gate — the earlier assumption was wrong.
- **Restart of a `waiting` autonomous run with changes** → `recover()` settles it via `settleSuccess`
  (`run.ts:419`), which now reads the persisted `autonomous` + gate and lands it at `done`.
- **Restart of a `queued` autonomous run** → `recover()` re-threads `autonomous` into the rebuilt
  `input` (H2), so it runs autonomously and later settles to `done`. Without that thread it would run
  non-autonomously and wrongly park at `review`.
- **Group compare → "Pick this one" on an autonomous / gate-off winner with changes** → the group-pick
  endpoint (`server.ts:636-654`) must **not** flip the winner to `review`; it settles/stays `done`
  under the same gate rule.
- **`config.reviewGate` set to `false` explicitly vs. absent** → both resolve to off; PUT `null`
  clears the key so the env default governs again.
- **Env `CEZ_REVIEW_GATE` malformed** (`'true'`, `'yes'`) → treated as off (only `'1'` enables);
  documented in `.env.example`.

## Risks & Impact Review

- **Behavior change / blast radius:** flipping the default from "gate everyone" to "gate no one" is
  a user-visible workflow change. Anyone relying on the implicit review pause loses it until they
  turn the Settings toggle on. This is the explicit owner decision in #489; call it out in the
  CHANGELOG entry when this ships. Not a code-contract break — no protected surface in
  `BACKWARD_COMPATIBILITY.md` is touched (verify at implementation time; if that file lists the
  run-status state machine or `/api/config` shape, flag the additive `reviewGate` key + the
  default-flip there).
- **Grandfathered in-flight runs:** runs already resting at `review` when this ships stay there
  (`recover()` never drains them); users clear them through the existing Finish/Send-back/Draft-PR
  actions. The default flip only affects runs that settle *after* the change.
- **Additive-only schema:** `reviewGate` (config) and `autonomous` (RunRecord) are optional adds;
  old configs and old run records parse unchanged.
- **Rollback:** revert is clean — remove the resolver call in `settleSuccess` (falls back to the
  unconditional park) and drop the config key; the additive fields are inert if unread.
- **Reversibility of state:** no new persisted state transition to undo — a run that settled to
  `done` under gate-off can still be reopened via the existing Continue path.

## Phasing

Each phase leaves the app working and is independently shippable.

**Phase 1 — Engine + persistence (the actual bug fix).**
1. Add `autonomous?: boolean` to `runRecordSchema` (`store.ts`, inside the ~`:34`–`:130` schema) and
   persist it from `startRun`'s `store.createRun({...})` (`run.ts:257`) as
   `autonomous: input.autonomous === true`. Test: a created record round-trips `autonomous`.
2. Add `reviewGateEnabled(config, env)` (new `src/runs/review-gate.ts`) with the default-off
   precedence (`config.reviewGate` wins, else `env.CEZ_REVIEW_GATE === '1'`, else `false`). Unit test
   the matrix (config `true`/`false` wins / env `'1'` / env `'0'`/unset), mirroring
   `src/runs/auto-name.test.ts:129-150` (save/restore `process.env.CEZ_REVIEW_GATE`).
3. Thread both into `settleSuccess(runId)` (`run.ts:1381`): `await loadConfig(this.repoRoot)` (the
   `maybeRefreshTitle` pattern at `run.ts:1346`), read the run's `autonomous`, and park at `review`
   only when `diff && reviewGateEnabled(config) && !run.autonomous`, else `done`. This also fixes the
   `waiting`-run restart path for free (`recover()` → `settleSuccess`, `run.ts:419`). Engine test
   under `CEZ_DRY_RUN` (`run.test.ts`): autonomous+changes → `done`; gate-off+changes → `done`;
   gate-on+non-autonomous+changes → `review`.
4. Re-thread `autonomous` through recovery: add `autonomous: run.autonomous` to the `input` that
   `recover()` rebuilds for a re-queued `queued` run (`run.ts:385-393`), so a recovered autonomous
   run stays autonomous (H2). Test: a `queued` autonomous run recovered post-restart runs
   autonomously (no auto-nudge park) and later settles to `done`.
5. Gate the group-pick winner-park: `POST /api/groups/:groupId/pick` (`server.ts:636-654`) inlines
   the review-park rule; guard the `status: 'review'` flip with the gate resolver + `winner.autonomous`
   so an autonomous / gate-off winner stays `done`. Test: pick an autonomous winner with changes →
   stays `done`, not `review`.

**Phase 2 — Config surface (env + Settings).**
6. Add `reviewGate` to the config schema (`config.ts`), GET `/api/config` (`server.ts:1215`), and the
   PUT `/api/config` set-schema + write/clear (`server.ts:1243,1272-1274`). Test in
   `src/server/config-api.test.ts` (mirror the `liveTitleUpdates` block at `:135-168`): PUT
   `true`/`false`/`null` round-trips + clears the raw key.
7. Add `reviewGate` to the client GET/PUT config types (`web/app/src/api/types.ts:580,596`).
8. Add the Settings → Agents Switch (`web/app/src/routes/settings/agents-section.tsx` near `:200`)
   with `checked={config.reviewGate ?? false}` (default off — the mirror image of live-title-updates'
   `?? true`) and the On/Off/`(default)` label. Test in `agents-section.test.tsx` (mirror
   `:42,:63-64,:133`): toggling PUTs `{ reviewGate: true }`.

**Phase 3 — Docs.**
9. Document `CEZ_REVIEW_GATE` (default off) in `.env.example` (near `:52`) and the `README.md` env
   table (near `:343`).

## Implementation Plan

The Phase/Step numbering above is the execution order for `om-auto-create-pr`
(`Source doc:` = this file). Every step is independently testable and leaves the app green:

- Steps 1–5 deliver the #489 fix behind the default-off resolver; even before the Settings UI
  exists, `CEZ_REVIEW_GATE` + the autonomous skip work end-to-end (including recovery and group-pick).
- Steps 6–8 add the Settings override on top; the engine already reads `config.reviewGate`.
- Step 9 is docs-only.

## Test Plan (consolidated)

- **Unit:** `reviewGateEnabled` precedence matrix (`src/runs/review-gate.test.ts`, template
  `src/runs/auto-name.test.ts:129-150`, save/restore `process.env.CEZ_REVIEW_GATE`); config schema
  parse (`src/config.test.ts`).
- **Engine (`src/workflows/run.test.ts`, `CEZ_DRY_RUN=1`, `scripts/mock-claude.mjs`):** the four
  `settleSuccess` outcomes (gate-off / autonomous / gate-on+manual / no-diff); a recovered `queued`
  autonomous run keeps autonomy and settles to `done` (H2); a `waiting` autonomous run recovered via
  `settleSuccess` → `done`.
- **API (`src/server/config-api.test.ts`):** GET exposes `reviewGate`; PUT `true`/`false`/`null`
  round-trip and raw-file clear.
- **Server group-pick:** picking an autonomous / gate-off winner with changes stays `done`, not
  `review` (`POST /api/groups/:groupId/pick`).
- **UI (`web/app/src/routes/settings/agents-section.test.tsx`):** Switch reflects
  `config.reviewGate ?? false`, toggling PUTs the key; `(default)` annotation when unset.
  `review-panel.test.tsx` and `run-header.test.tsx:158` stay green (unchanged review experience when
  the gate does apply).

## Out of scope

- Redesigning the review panel, per-line comments, or the Draft-PR flow (spec 009 owns those).
- A per-task override of the gate (this is a global env/Settings default; the per-task signal is
  already `autonomous`).
- Any change to permission modes / `acceptEdits` — explicitly kept separate.
