# Checkpoint 4 — Steps 2.6..2.9 (Phase 2 close)

**When:** 2026-07-20T17:31:20Z
**Steps covered:** 2.6 (`d93de6e`) … 2.9 (`1f00530`)
**Touched areas:** `src/server/forge/github.ts` (list+comments caches keyed by repoRoot), `src/skills-remote.ts` (team-skills per root), `src/server/server.ts` (workspace config/ui-state routes, `GET /api/workspace/events`), `src/workspace/ui-state.ts` (new), `src/server/project-context.ts` (onContextBuilt hook), BACKWARD_COMPATIBILITY.md §2/§3/§9

## Checks

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | PASS |
| Full vitest suite | `env -u CEZ_REMOTE npm test` | PASS — 2895/2895 (179 files; +22 vs checkpoint 3) |
| Unit (node:test) | `npm run test:unit` | PASS — 31/31 |
| Build + pack sanity | `npm run build` | PASS — check:pack ok, 296 files |
| Package e2e (real CLI) | `npm run test:package` | PASS — 8/8 |

Key suites in the window: per-cache isolation regressions (list cache A≠B within TTL incl. zero extra gh calls; comments cache PR #42 in two projects no collision; team-skills per root), workspace config PUT probe (unwritable → 400 + disk unchanged) + semaphore refresh, workspace SSE (stamping, per-project usage split, legacy stream byte-identical regression, dynamic late-context subscription).

## UI verification

Skipped — no UI touched. Phase 3 (next) starts the cockpit work.

## Notes

- Phase 2 complete: the server is fully project-scoped behind byte-identical legacy aliases; cockpit still unprefixed (proves alias parity end-to-end).
- `project-added`/`project-removed` emission wires up when POST/DELETE /api/projects arrive (Phase 4); WorkspaceEventBus seam + envelope tests already in place.
