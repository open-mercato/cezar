# Fix automation lease reclaim race (#998)

## Goal

Make abandoned automation poll leases safe under competing processes, including crash
recovery and owner-safe release, without changing scheduler or server behavior.

## Scope

- `packages/cezar/src/automations/store.ts`
- `packages/cezar/src/automations/store.test.ts` and lease/concurrency fixtures if needed

Non-goals: workflow, scheduler, server, receipt semantics, or unrelated automation state changes.

## Implementation Plan

### Phase 1: Reproduce and design

- [x] 1.1 Add a deterministic competing-process regression test for abandoned lease reclaim — working tree
- [x] 1.2 Add tests for crash recovery, malformed locks, and owner-safe release — working tree

### Phase 2: Implement

- [x] 2.1 Replace the reclaim TOCTOU sequence with mutually exclusive ownership and fencing — working tree
- [x] 2.2 Preserve malformed/dead-lock fallback behavior and update lease tests — working tree

### Phase 3: Validate

- [x] 3.1 Run targeted automation tests and the configured full validation gate — dependency validation 2026-09-27; all configured commands pass
- [ ] 3.2 Review the diff and record limitations/evidence

## Risks

Lease persistence is a cross-process coordination seam; an incorrect reclaim can either
duplicate automation launches or strand polling. Tests must cover both live ownership and
recovery after a dead owner.

## Progress

PR: #1099

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Reproduce and design

- [x] 1.1 Add a deterministic competing-process regression test for abandoned lease reclaim — a21f1865
- [x] 1.2 Add tests for crash recovery, malformed locks, and owner-safe release — a21f1865

### Phase 2: Implement

- [x] 2.1 Replace the reclaim TOCTOU sequence with mutually exclusive ownership and fencing — cc7ec5e5
- [x] 2.2 Preserve malformed/dead-lock fallback behavior and update lease tests — cc7ec5e5

### Phase 3: Validate

- [x] 3.1 Run targeted automation tests and the configured full validation gate — targeted sidebar test 3/3; sanitized full gate all pass
- [x] 3.2 Review the diff and record limitations/evidence — cc7ec5e5

### Dependency validation evidence (2026-09-27)

- Reused reviewed sidebar test commit `e882054b6300542f36583286e2e1804fcafd0598` unchanged; targeted `packages/web/src/routes/cross-project-task-navigation.test.tsx`: 1 file, 3 tests passed (`/tmp/pr1099-targeted.log`).
- Sanitized sequential gate (`CEZ_*` unset, `TMPDIR=/tmp`): `npm run typecheck` PASS; `npm test` PASS (7951/7951); `npm run test:unit` PASS (36/36); `npm run build` PASS; `npm run test:package` PASS (16/16). Full log: `/tmp/pr1099-full-gate.log`.

### CodeQL follow-up (source review pending)

- CodeQL alert #36 (`js/file-system-race`) identified the metadata pathname write as a real TOCTOU. The source correction is pending review and must preserve exclusive creation, crash recovery, owner-safe release, and compromise/receipt guarantees.
- Dependency validation was recorded on the frozen pre-correction head; it does not approve the new source correction. Full-gate evidence remains in `/tmp/pr1099-full-gate.log` and targeted sidebar evidence in `/tmp/pr1099-targeted.log`.
- Correction `d5c09ceb` adds exclusive descriptor creation (`wx`) after accepted stale cleanup; the replacement regression was red before the fix and green after it. Scoped lease/automation/data-gitignore tests pass 56/56.
- Sanitized sequential gate on the corrected source (`CEZ_*` unset, `TMPDIR=/tmp`) passes: typecheck, npm test 7952/7952, unit 36/36, build/check-pack, and package 16/16. Log: `/tmp/pr1099-codeql-full-gate.log`. Source review remains pending; the earlier independent approval applies only to the pre-correction source.
