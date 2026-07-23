# Execution plan — Per-project resource / concurrency settings

Source doc: `.ai/specs/2026-07-22-per-project-concurrency.md`
Closes #608

## Goal

Make the parallel-task concurrency ceiling configurable **per project** instead of a single workspace-global limit: a project can be pinned to run strictly one task at a time (heavy memory profile) while another runs up to N at once, all under an overall workspace cap. The per-project limit is an optional field on the existing workspace project registry entry; when unset a project inherits the workspace cap, so there is no config migration and behaviour is unchanged for anyone who never touches the new setting.

## Scope

- **In scope:** an optional per-project `maxParallel` on `workspaceProjectSchema`; a semaphore snapshot lookup for it; the extra `pump()` gate clause; a new `PATCH /api/projects/:projectId` route to set/clear it live; serializing the field on `GET /api/projects`; and a "Max parallel tasks" control on each project row in the settings projects section.
- **Non-goals:** per-project `memoryLimitMb` (stays workspace-global — deferred, out of scope per the issue); reviving the legacy per-repo `maxParallel` in `src/config.ts`; any `schemaVersion` bump or config migration; changing the workspace `resources` shape or `PUT /api/workspace/config`.

## Implementation Plan

### Phase 1 — Enforcement (config + semaphore + gate)

1. **Add the schema field.** In `src/workspace/config.ts`, add `maxParallel: z.number().int().min(1).max(16).optional().catch(undefined)` to `workspaceProjectSchema` (~`:33-46`). The `WorkspaceProject` type is `z.infer`, so it updates automatically. Test: parsing a config with a valid, an out-of-range, and a missing per-project `maxParallel` yields the value / `undefined` / `undefined`, and other entries survive a bad one.
2. **Cache per-project limits in the snapshot.** In `src/workspace/semaphore.ts`, extend the loader/`refresh()` snapshot to build a `Map<normalizedRoot, number>` from `config.projects[]`, and add `projectMaxParallel(repoRoot: string): number` returning the mapped value or `maxParallel()` when absent. Normalize the lookup key the same way the registry normalizes `root` (realpath). Test: a stubbed `load` returning two projects (one with `maxParallel`, one without) — `projectMaxParallel` returns the per-project value for the first and the workspace cap for the second and for an unknown root; after a `refresh()` that changes a value, the new value is returned.
3. **Add the per-project clause to the gate.** In `src/workflows/run.ts` `pump()` (~`:511`), compute `projectMax = this.semaphore.projectMaxParallel(this.repoRoot)` and add `this.busySlots() < projectMax` to `capacity()` (~`:519-520`). Test: two managers sharing a semaphore with workspace cap 4 — project A limited to 1 never runs a second concurrent task while project B runs up to the workspace cap; combined `busy()` never exceeds the workspace cap; a `waiting`-run resume on the capped project still resumes immediately.

### Phase 2 — Live API wiring

4. **Add `PATCH /api/projects/:projectId`.** New route beside `DELETE /api/projects/:projectId` (~`server.ts:1239`): zod body `{ maxParallel: z.number().int().min(1).max(16).nullable() }` (null clears the override), apply to the matching entry via `mergeWriteWorkspaceConfig`, return the updated entry, then call `deps.semaphore?.refresh()` (mirroring `server.ts:1435`). 404 when the id is unknown. Test: a PATCH setting `maxParallel` writes the entry and triggers `refresh()`; `null` clears it; an out-of-range value is rejected with the standard validation error; an unknown id 404s.
5. **Serialize the field on read.** Confirm `GET /api/projects` (~`server.ts:1058`) returns each entry's `maxParallel` (should via `.passthrough()`); if the response projects a fixed field set, add `maxParallel` to it. Test: the read includes the configured value (and null/absent when unset).

### Phase 3 — Settings UI

6. **Add the per-project control.** In `web/app/src/routes/settings/projects-section.tsx` `ProjectRow` (~`:315`), add a labelled "Max parallel tasks" `<select>` with `Inherit workspace (N)` + `1..16`, wired to the Phase-2 route, mirroring the save/optimistic-revert pattern of `worktrees-section.tsx`. Add the workspace-ceiling hint copy. Test: a component/integration test that changing the selector issues the project-update request with the chosen value and that selecting "Inherit" sends `null`. Capture UI screenshots of the new control.

## Risks (brief)

- **Blast radius:** the scheduler start gate (`pump()`) is load-bearing. The change is additive (one extra `&&` clause) and defaults to today's behaviour when no per-project value is set, so a workspace with no per-project limits is behaviourally identical. Risk-medium because the surface matters, not the size.
- **Root normalization mismatch:** a manager's `repoRoot` and the registry `root` differing by symlink/realpath would silently fall back to the workspace cap — guarded by a Phase-1 normalization test.
- **Compatibility:** additive optional key; no protected surface touched (checked against `BACKWARD_COMPATIBILITY.md`); no `schemaVersion` bump; old files load unchanged. Rollback = remove the gate clause and lookup; the key becomes inert.

## Progress

PR: #609 (link: https://github.com/open-mercato/cezar/pull/609)

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Enforcement

- [x] 1.1 Add the schema field to workspaceProjectSchema — 5ea394e
- [x] 1.2 Cache per-project limits in the semaphore snapshot + projectMaxParallel lookup — 5ea394e
- [x] 1.3 Add the per-project clause to the pump() gate — 5ea394e

### Phase 2: Live API wiring

- [x] 2.1 Add PATCH /api/projects/:projectId — 31b1107
- [x] 2.2 Serialize maxParallel on GET /api/projects — 31b1107

### Phase 3: Settings UI

- [x] 3.1 Add the per-project "Max parallel tasks" control in the projects section — 032e2f8
