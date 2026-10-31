# Checkpoint 1 — the shared ACP layer, the verified surface, the union, the dialect

**When:** 2026-09-27T16:32:59Z
**Steps covered:** 1.1, 1.2, 2.1, 2.2 — and, in one commit, 4.1–4.5, 4.7, 4.8, 5.1, 5.3, 5.5
**Commits:** `e70442da..75f013ae` (5 commits on top of the run-folder commit `d92adea1`)

## Touched areas

- `packages/cezar/src/core/` — the shared ACP transport and mapper, the Copilot dialect, the
  runner union, detection, provider auth, credentials, model identity/presets, the model catalog.
- `packages/contract/src/` — `runnerSchema`, `backendCheckSchema`, and every per-runner zod record.
- `packages/api-client/src/protocol/ui-events.ts` — the `UiBackend` mirror.
- `packages/web/src/` — provider status, auth alert, tools menu, open-in menu, composer runner and
  model lists, thread state, automations editor, Settings accounts/provider rows.
- `.env.example`, `docs/reference.md` — `CEZ_COPILOT_BIN`.
- No UI *behavior* was designed in this window; the cockpit changes are the runner union reaching
  its hand-mirrored copies.

## Checks

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` (contract, api-client, server, web) | **pass** | Clean, including the `tsconfig.test.json` pass and the compile-time `contract-parity` mutual-assignability guard. |
| `npm test` (full vitest run, 490 files) | **pass** | 8296 passed, 0 failed. |
| `npm run build` | not run in this window | Deferred to the final gate (step 9); nothing here changes the build graph. |
| `npm run test:package` | not run in this window | Same. |
| Integration suite / browser UI verification | **skipped** | The repo has no `.ai/qa/test-env.json` descriptor, and no Step in this window changed UI behavior — the cockpit edits are label/preset/guard entries for a runner that cannot yet start a session (`createRunner` deliberately refuses `copilot` until Step 3.1). There is nothing to drive in a browser yet. Recorded in `NOTIFY.md`. |

## Notable results

- **One run of `npm test` reported `automations-gate.test.ts` failing**; it passes in isolation
  (`npx vitest run packages/cezar/src/server/automations-gate.test.ts` → 22 passed) and is
  unrelated to this diff. Known flake under concurrent-worktree load. The full run was repeated
  after the last edit and came back 490/490 green.
- **39 pre-existing tests had to be updated**, all of them assertions that pinned "four providers"
  by literal. Where the count was structural it is now derived (`PROVIDER_IDS.length`), so the
  sixth runner will not repeat the churn; where the assertion names providers it gained `copilot`.
- **`createRunner` refuses `copilot`** for the next two Steps rather than falling through to the
  `default` case and silently running Claude. That is stricter than `main`, not looser.

## Artifacts

None — no browser session and no captured logs worth keeping. Command output is reproducible from
the table above.
