# Compact subtask header — issue #1237

Goal: fix the remaining Agents dock completion-transition behavior from GitHub issue #1237 while preserving the already-landed bounded Subtasks header.

Scope:

- `packages/web/src/routes/task-thread/agents-dock.tsx`
- `packages/web/src/routes/task-thread/agents-dock.test.tsx`
- No workflow step-rail changes; the issue comments leave that pane ambiguous.

Root-cause evidence: the dock stores an explicit `openByRun` value and never changes it when `done === total`, so a user-expanded dock remains expanded after every agent settles. The Subtasks header is already bounded on `origin/main` by commit `9abefdef` (#1051), with regression tests; duplicating it would be scope creep.

Implementation plan:

1. Add a completion-transition effect that collapses an open dock once all agents settle, without treating initial all-settled state as a transition.
2. Preserve manual reopening after completion and the existing per-run memory semantics.
3. Add focused regression tests for transition collapse and manual reopen, then run the configured validation gate and UI evidence where the browser harness is available.

Risks: completion may be observed on initial render for historical runs; avoid surprising collapse there. Do not alter the workflow step rail.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Implement and verify

- [x] 1.1 Add completion-transition collapse and tests
- [x] 1.2 Run targeted and full validation — local dependency repair made typecheck/build/package green; full Vitest remains blocked by an inherited environment assertion and a long-running suite
- [x] 1.3 Review diff and report limitations

Validation notes:

- `npm test --workspace packages/web -- --run src/routes/task-thread/agents-dock.test.tsx`: 18/18 passed.
- Regression proof without implementation: 1 test failed (`aria-expanded` stayed `true`); restored implementation returns 18/18.
- `npm run typecheck`: passed after local `npm install --ignore-scripts --no-audit --no-fund`; the previous failure came from resolving the parent checkout's node_modules.
- `npm run test:unit`: 42/42 passed after local dependency installation.
- `npm run build`: passed, including Vite web build and `check:pack`.
- `npm run test:package`: 17/17 passed after local dependency installation.
- Full Vitest with `--maxWorkers=2 --no-file-parallelism`, with task variables unset in the test subprocess, did not settle within the bounded run. The previously failing `agent-profile-wiring.test.ts` passes 11/11 with `CEZ_API_URL`, `CEZ_BIN`, `CEZ_PROJECT_ID`, and `CEZ_REMOTE` unset.
- Browser provider was installed from the repository descriptor and launched with staged libraries, `--no-sandbox`, and a short HOME; cockpit smoke screenshot: `.ai/qa/issue-1237-cockpit-smoke.png`. The QA app's `/api/v1/runs` was empty, so a real Agents dock transition could not be exercised without fabricating run state; the focused React transition test remains the behavior evidence.
