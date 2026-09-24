# Per-project resource / concurrency settings

## TLDR
The parallel-task ceiling is a single workspace-global number (`resources.maxParallel`, default 2) enforced by one shared `WorkspaceSemaphore` across every project. This spec makes the ceiling configurable **per project**: a project can be pinned to run strictly one task at a time (heavy memory profile) while another runs up to N at once, all under an overall workspace cap that still protects the host. The per-project limit is an optional field on the existing project registry entry; when unset a project inherits the workspace cap, so no config migration is required and behaviour is unchanged for anyone who never touches the new setting.

## Problem Statement
Concurrency today is governed by exactly one knob. `WorkspaceSemaphore.maxParallel()` (`src/workspace/semaphore.ts:95`) returns the workspace-wide cap, and every `RunManager.pump()` (`src/workflows/run.ts:511`) starts queued runs only while `this.semaphore.busy() < maxParallel` — `busy()` (`semaphore.ts:88`) summing the held slots of every project's manager. That single number cannot express "this project is memory-heavy, run it one-at-a-time" and "that project is light, run four at once" at the same time.

Concretely (the issue's example): the `mercato-development` project should run tasks strictly sequentially (max 1), because each worker's memory footprint is large enough that two concurrent runs risk OOM; the `cezar` project is light and should run up to 4 concurrently. With one global cap you must set the workspace to 1 (starving `cezar`) or to 4 (risking OOM on `mercato-development`). There is no safe single value.

Evidence it matters: memory pressure is already a first-class concern in this codebase — there is a per-task memory guard (`enforceMemoryLimit`, the `onUsage` sampler at `run.ts:334`) and a workspace `memoryLimitMb`. Concurrency is the other half of the same host-protection story, and it is currently host-global only.

## Proposed Solution
Add an **optional per-project `maxParallel`** to the workspace project registry entry (`workspaceProjectSchema` in `src/workspace/config.ts`). Enforcement composes two ceilings that must *both* hold before a manager starts a queued run:

1. **Per-project ceiling** — a manager never runs more than *its own* configured `maxParallel` (its `busySlots()` must be below its project limit).
2. **Workspace ceiling** — the existing overall cap across all projects (`semaphore.busy() < workspace maxParallel`) is unchanged.

When a project has no per-project value, its ceiling *is* the workspace cap — identical to today's behaviour. The per-project number is fed to the manager through the semaphore's **existing cached-and-refreshed snapshot**, so no manager reads config files on the hot path, and a settings change re-pumps live via the existing `refresh()` hook.

**Alternatives considered and rejected:**

- *Revive the legacy per-repo `maxParallel`* (still parsed in `src/config.ts` but ignored by enforcement post-migration, per the note at `semaphore.ts:28-30`). Rejected: it spreads resource governance back across two config files and resurrects a surface the 2026-07-20 multi-project-workspace migration deliberately moved to workspace scope. The workspace registry is now the single home for project metadata; the per-project limit belongs there.
- *Replace the workspace cap entirely with per-project caps.* Rejected: the workspace cap protects the *host* (total concurrent processes/memory across all projects); per-project caps protect a *project*. They are different guarantees and both are needed — a sum of generous per-project limits must still not blow past what the machine can run.
- *Give each project its own semaphore.* Rejected: the workspace cap is a global sum by definition; a single shared counter with per-participant accounting is already the model (`SemaphoreParticipant`), and the per-project ceiling is naturally a local check inside each manager's `pump()`.

## Architecture
Three seams change; the shared-semaphore model and the #347 waiting-run exemption are preserved verbatim.

**1. Config schema (`src/workspace/config.ts`).** Add one optional field to `workspaceProjectSchema` (currently `config.ts:33-46`):

```ts
/** Per-project cap on concurrently running tasks. Absent = inherit the
 *  workspace `resources.maxParallel`. Bounded like the workspace cap. */
maxParallel: z.number().int().min(1).max(16).optional().catch(undefined),
```

`.optional().catch(undefined)` keeps house rules: a bad value degrades to "inherit" rather than a hard default, and `.passthrough()` at the entry level already preserves the key across older/newer cezar round-trips. No `resourcesSchema` change and no `schemaVersion` bump — an absent field is the pre-existing behaviour, so nothing to migrate.

**2. Semaphore snapshot + lookup (`src/workspace/semaphore.ts`).** `refresh()` (`semaphore.ts:111`) already re-reads the whole workspace config on boot and after every config PUT. Extend the cached snapshot to also carry a **root → per-project maxParallel** map built from `config.projects[]`, and add:

```ts
/** The effective per-project cap for a manager's repo root: the project's
 *  own `maxParallel` if set in the registry, else the workspace cap. Answered
 *  from the cached snapshot — never re-reads the file (the #memory-guard rule
 *  the class header states: N managers must not re-read config every tick). */
projectMaxParallel(repoRoot: string): number
```

Keying is by **realpath-normalized root** — the registry stores normalized `root` (normalization is `registerProject`'s job, `projects.ts:124`), so the lookup normalizes the manager's `repoRoot` the same way before matching. A root with no registry entry (an ad-hoc `cezar run` outside the registry) has no per-project value and inherits the workspace cap.

**3. The pump gate (`src/workflows/run.ts`).** The manager already knows `this.repoRoot` (`run.ts:323`) and holds the shared `semaphore` (`:315`). The capacity check at `run.ts:519-520` gains one clause:

```ts
const workspaceMax = this.semaphore.maxParallel();
const projectMax = this.semaphore.projectMaxParallel(this.repoRoot);
const capacity = () =>
  this.semaphore.busy() < workspaceMax &&        // host ceiling (unchanged)
  this.busySlots() < projectMax &&                // NEW: this project's ceiling
  (repo !== null || this.busySlots() < 1);        // non-git degradation (unchanged)
```

`busySlots()` (`run.ts:500`) already subtracts `waiting` runs, so the #347 exemption carries through untouched: a message into a `waiting` run resumes it immediately — resumes never pass through `pump()`, so neither the workspace nor the per-project gate can strand a resume, exactly as today. The non-git `< 1` degradation still wins because it is the tighter bound.

**Data flow:** settings write → project registry entry updated (`mergeWriteWorkspaceConfig`) → `semaphore.refresh()` re-reads config, rebuilds the root→limit map, and pumps every manager → the affected manager's next `pump()` sees the new `projectMax`. Identical to how a workspace-cap change already propagates (`semaphore.ts:104-118`), so raising a project's limit starts its queued runs with no restart, and lowering it simply stops starting new ones (running tasks are never killed — see Edge Cases).

## Data Model
`~/.cezar/config.json`, one new optional key per registry entry (shown with an existing entry for context):

```jsonc
{
  "resources": { "maxParallel": 4, "memoryLimitMb": null },   // workspace cap — unchanged
  "projects": [
    { "id": "cezar", "root": "/home/u/cezar", "name": "cezar" },
    // no maxParallel → inherits workspace cap (4)
    { "id": "mercato-development", "root": "/home/u/mercato",
      "name": "mercato-development", "maxParallel": 1 }        // NEW: strictly sequential
  ]
}
```

- **Type / bounds:** integer `1..16`, matching the workspace cap's bounds (`config.ts:53`). `1` = strictly sequential.
- **Absence semantics:** key omitted ⇒ inherit workspace `resources.maxParallel`. This is the *only* migration story — old files have no key and keep today's behaviour.
- **`memoryLimitMb` stays workspace-global** (out of scope, per the issue). This spec touches concurrency only.

## API Contracts
The project registry today exposes `GET /api/projects` (`server.ts:1058`), `POST /api/projects` (register/add, idempotent, `:1197`) and `DELETE /api/projects/:projectId` (`:1239`) — there is **no** partial-update route. So this is the one genuinely new surface the spec introduces:

- **Write — NEW `PATCH /api/projects/:projectId`.** Body `{ maxParallel: number | null }` where an integer `1..16` sets the per-project ceiling and `null` clears it back to "inherit". Handler validates with a small zod schema (mirroring `registerProjectSchema` at `server.ts:1079`), applies the change to the matching registry entry via `mergeWriteWorkspaceConfig` (`config.ts:169`), and **then calls `deps.semaphore?.refresh()`** — the same live-apply hook `PUT /api/workspace/config` fires at `server.ts:1435` — so the new limit takes effect without a restart. Returns the updated entry (same shape `GET /api/projects` attaches). A `PATCH` (not `PUT`) because it edits one field of an existing entry, and a new route (not an overload of `POST`, which is register-a-folder) to keep the register vs. edit semantics distinct.
- **Read — `GET /api/projects` (`server.ts:1058`), verify field is serialized.** The registry schema is `.passthrough()`, so the new `maxParallel` key survives a load round-trip; confirm the GET returns entries directly (not a fixed field projection) so the value reaches the UI. If the GET projects a fixed field set, add `maxParallel` to that projection — a one-line serializer change, called out here so it is not a hidden step. The workspace `resources.maxParallel` is already available to the settings UI for the "inherit" label.
- **No change to `PUT /api/workspace/config`'s resources shape** — the workspace cap contract is untouched.

## UI/UX
One new control in the **projects section** (`web/app/src/routes/settings/projects-section.tsx`, per-row `ProjectRow` at `:315`) — the natural home, since each project already renders a row there, and worktree retention already demonstrates a project-scoped setting saved from settings (`worktrees-section.tsx`, the pattern to mirror).

- **Control:** a "Max parallel tasks" selector on each project row, options `Inherit workspace (N)` (the default/unset state, showing the live workspace cap `N`) then `1 … 16`.
- **States:** unset shows `Inherit workspace (N)`; an explicit value shows that number. Saving is optimistic with the existing settings save affordance; a failed save reverts.
- **Guidance copy:** a short hint that the workspace cap still applies as an overall ceiling, so a per-project value above the workspace cap is effectively clamped by it (no error — see Edge Cases).
- **Accessibility:** a labelled `<select>`, same as the existing `resources-section.tsx` control (`MAX_PARALLEL_MIN/MAX` bounds at `:30-31`); no new interaction pattern.

Standard CRUD wiring (fetch registry, render rows, PUT on change) is not re-documented here — it mirrors the sibling sections.

## Edge Cases & Failure Scenarios
- **Per-project value > workspace cap:** allowed, no validation error. The workspace gate binds first, so the project simply never exceeds the workspace cap. UI hints at this; it is not an error state (workspace caps can be raised later, at which point the per-project value takes effect without re-editing).
- **Lowering a project's limit below its current running count:** running tasks are **never killed** — enforcement is start-time only (`pump()` gates *starting* runs). The project drains to the new ceiling as running tasks finish. Same semantics as lowering the workspace cap today.
- **`waiting`-run resume (#347):** unaffected. Resumes bypass `pump()` entirely; `busySlots()` already excludes `waiting`, so neither ceiling can block a resume even when a project is at its per-project cap.
- **Non-git directory:** still forced to a single sequential run (`repo !== null || busySlots() < 1`), which is `≤ 1` and therefore always the tighter bound over any per-project value.
- **Root not in the registry (ad-hoc run):** no per-project entry ⇒ inherits the workspace cap. No crash, no special case.
- **Corrupt / bad `maxParallel` value in the file:** `.catch(undefined)` degrades that one key to "inherit"; the per-entry salvage (`config.ts:85-94`) already protects the rest of the entry. Enforcement never degrades to unlimited — a failed `refresh()` read keeps the last good snapshot (`semaphore.ts:112-116`).
- **Root normalization mismatch:** if a manager's `repoRoot` and the registry `root` differ only by symlink/realpath, the lookup must normalize both or it silently falls back to the workspace cap. Covered by a test (Phase 1) that registers a project by a normalized root and asserts the manager keyed by the raw root still resolves its limit.

## Risks & Impact Review
- **Blast radius:** the scheduler's start gate — the one place that decides whether a run begins. The change is additive (one extra `&&` clause) and defaults to today's behaviour when no per-project value exists, so a workspace with no per-project limits is behaviourally identical. Risk is medium because the *surface* is load-bearing, not because the change is large.
- **Compatibility:** no protected contract in scope. The workspace `resources` shape and `PUT /api/workspace/config` are untouched; the new key is additive and optional. `BACKWARD_COMPATIBILITY.md` was checked — no listed protected surface is modified. Old config files load and behave unchanged (no `schemaVersion` bump needed).
- **Rollback:** remove the extra `pump()` clause and the `projectMaxParallel` method; the config key becomes inert (preserved by `.passthrough()`, ignored by enforcement — exactly the state the legacy per-repo key is in today). No data migration to reverse.
- **Performance:** `projectMaxParallel` answers from the in-memory snapshot; the root→limit map is rebuilt only inside `refresh()` (boot + config PUT), never per tick — the class's explicit no-per-tick-file-read invariant (`semaphore.ts:20-26`) is preserved.

## Phasing
- **Phase 1 — Enforcement (config + semaphore + gate).** The per-project ceiling works when set directly in `~/.cezar/config.json`. Shippable and testable with no UI: an operator can hand-edit the file and restart, and per-project limits are honoured.
- **Phase 2 — Live API wiring.** Setting the value through the project-registry route applies it without a restart via `semaphore.refresh()`.
- **Phase 3 — Settings UI.** The per-project "Max parallel tasks" control in the projects section.

Each phase leaves the application fully working; Phase 1 alone already delivers the core capability.

## Implementation Plan

### Phase 1 — Enforcement
1. **Add the schema field.** In `src/workspace/config.ts`, add `maxParallel: z.number().int().min(1).max(16).optional().catch(undefined)` to `workspaceProjectSchema` (`:33-46`); export/adjust the `WorkspaceProject` type (it is `z.infer`, so it updates automatically). *Test:* parsing a config with a valid, an out-of-range, and a missing per-project `maxParallel` yields the value / `undefined` / `undefined` respectively, and other entries survive a bad one.
2. **Cache per-project limits in the snapshot.** In `src/workspace/semaphore.ts`, extend the loader/`refresh()` snapshot to build a `Map<normalizedRoot, number>` from `config.projects[]`, and add `projectMaxParallel(repoRoot: string): number` returning the mapped value or `maxParallel()` when absent. Normalize the lookup key the same way the registry normalizes `root`. *Test (`semaphore.test.ts`):* a stubbed `load` returning two projects (one with `maxParallel`, one without) — `projectMaxParallel` returns the per-project value for the first and the workspace cap for the second and for an unknown root; after a `refresh()` that changes a value, the new value is returned.
3. **Add the per-project clause to the gate.** In `src/workflows/run.ts` `pump()` (`:511`), compute `projectMax = this.semaphore.projectMaxParallel(this.repoRoot)` and add `this.busySlots() < projectMax` to `capacity()` (`:519-520`). *Test (`workspace-semaphore.test.ts`):* two managers sharing a semaphore with workspace cap 4; project A limited to 1 never runs a second concurrent task while project B runs up to the workspace cap; the combined `busy()` never exceeds the workspace cap; a `waiting`-run resume on the capped project still resumes immediately.

### Phase 2 — Live API wiring
4. **Add `PATCH /api/projects/:projectId`.** New route beside `DELETE /api/projects/:projectId` (`server.ts:1239`): a zod body schema `{ maxParallel: z.number().int().min(1).max(16).nullable() }` (null clears the override), apply to the matching entry via `mergeWriteWorkspaceConfig`, return the updated entry, then call `deps.semaphore?.refresh()` (mirroring `server.ts:1435`). 404 when the id is unknown. *Test:* a PATCH setting `maxParallel` writes the entry and triggers `refresh()`; `null` clears it; an out-of-range value is rejected with the standard validation error; an unknown id 404s.
5. **Serialize the field on read.** Confirm `GET /api/projects` (`server.ts:1058`) returns each entry's `maxParallel` — it should via `.passthrough()`; if the response projects a fixed field set, add `maxParallel` to it. *Test:* the read includes the configured value (and null when unset); the workspace cap is already available for the inherit label.

### Phase 3 — Settings UI
6. **Add the per-project control.** In `web/app/src/routes/settings/projects-section.tsx` `ProjectRow` (`:315`), add a labelled "Max parallel tasks" `<select>` with `Inherit workspace (N)` + `1..16`, wired to the Phase-2 route, mirroring the save/optimistic-revert pattern of `worktrees-section.tsx`. Add the workspace-ceiling hint copy. *Test:* a component/integration test that changing the selector issues the project-update request with the chosen value and that selecting "Inherit" sends `null`.

## Resolved assumptions (autonomous defaults)
Every default below is the most reversible, lowest-blast-radius choice; a human can override any of them before merge by commenting on the spec PR.

| # | Question | Resolved default | Rationale |
|---|----------|------------------|-----------|
| Q1 | Where does the per-project limit live — a new field on the workspace registry entry, or revive the legacy per-repo `maxParallel` in `src/config.ts`? | **New optional `maxParallel` on `workspaceProjectSchema`** (`~/.cezar/config.json`). | The 2026-07-20 migration deliberately moved resource governance to workspace scope and the semaphore already caches/refreshes that file; reviving the deprecated per-repo key would spread config across two files. Fully reversible — the field can be relocated later. |
| Q2 | How do the per-project and workspace ceilings interact? | **Both must hold** — per-project is a local upper bound, workspace is the overall host ceiling; a run starts only if it is under both. | Minimal composition (one extra `&&`), matches the issue's intent, and preserves the host-protection guarantee of the workspace cap. |
| Q3 | What happens when a project has no per-project value? | **Inherit the workspace `maxParallel`** — behaviour identical to today. | Backward-compatible; no `schemaVersion` bump and no config migration. |
| Q4 | Should `memoryLimitMb` also become per-project in this work? | **No — defer.** Concurrency only; `memoryLimitMb` stays workspace-global. | Explicitly out of scope in the issue; smallest surface. Can be a follow-up spec if per-project concurrency proves insufficient. |
| Q5 | Bounds for the per-project value? | **Integer `1..16`**, same as the workspace cap. | Reuses the existing bound; `1` gives the strictly-sequential case the issue calls for. |
| Q6 | Reject a per-project value greater than the workspace cap? | **No — allow it; the workspace gate clamps at runtime.** UI hints at the interaction. | Avoids coupling two independently-editable numbers with a validation error; raising the workspace cap later then "unlocks" the per-project value without re-editing. |
| Q7 | How is a manager matched to its registry entry? | **By realpath-normalized root** (the manager holds `repoRoot`; the registry stores normalized `root`). | Reuses `registerProject`'s normalization; an unregistered root simply inherits the workspace cap. A normalization test guards the symlink case. |

No assumption weakens security, data scoping, or a documented compatibility contract, so none is marked `⚠ NEEDS HUMAN CONFIRMATION`. Q1 carries the most architectural weight but is reversible and touches no protected surface.
