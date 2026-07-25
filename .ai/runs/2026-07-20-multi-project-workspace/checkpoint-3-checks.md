# Checkpoint 3 — Steps 2.1..2.5

**When:** 2026-07-20T17:03:13Z
**Steps covered:** 2.1 (`29bab9f`) … 2.5 (`9abbf6e`)
**Touched areas:** `src/server/project-context.ts` (new), `src/server/server.ts` (context-resolver refactor, 53-route table mounted at `/api/p/:projectId/*` + legacy aliases), `src/todos.ts` (per-dataDir watchers), `src/workflows/run.ts` (dispose, usage filtering, workspace-semaphore gating), `src/core/process-usage.ts`, `src/workspace/semaphore.ts` (new), `src/index.ts`

## Checks

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | PASS |
| Full vitest suite | `env -u CEZ_REMOTE npm test` | PASS — 2873/2873 (177 files; +30 vs checkpoint 2) |
| Build + pack sanity | `npm run build` | PASS — check:pack ok, 293 files |
| Package e2e (real CLI) | `npm run test:package` | PASS — 8/8 |

Key suites in the window: route-parity (24-GET sweep + POST/SSE + 404/409 cases, manifest-driven), todos cross-dataDir isolation, usage-scope split-not-stamp, workspace-semaphore cross-project cap + #347 waiting-resume exemption.

## UI verification

Skipped — no UI touched (server-side only). Phase 3 begins cockpit work.

## Notes

- Step 2.2's executor was cut off once by a session limit; resumed from transcript, no partial state ever reached the tree (worktree verified clean at 29bab9f before resume).
- The #347 exemption is preserved structurally (slot accounting = active + starting − waiting; sendMessage bypasses the slot gate) and tested cross-project.
