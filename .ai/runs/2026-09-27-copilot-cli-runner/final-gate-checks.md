# Final gate — 2026-09-27-copilot-cli-runner

**When:** 2026-09-27T17:02:24Z
**Branch:** `feat/copilot-cli-runner` (15 commits on `origin/main`)
**Tasks table:** every row `done`.

## The configured validation gate, in order

| Command | Result | Notes |
|---|---|---|
| `npm run typecheck` | **pass** | contract, api-client, server (incl. `tsconfig.test.json`) and web. Covers the compile-time `contract-parity` mutual-assignability guard and the `UiBackend ≡ RunnerId` type-exactness guard. |
| `npm test` | **pass, with one known flake** | 8359 passed, 3 skipped (the opt-in real-Copilot smoke), 1 failed. See below. |
| `npm run test:unit` | **pass** | 36/36. |
| `npm run build` | **pass** | server + cockpit + `check:pack` (667 files, 108 under `web/dist`). |
| `npm run test:package` | **pass** | 16/16. |

### The one failure, and why it is not this diff

`src/automations/store.test.ts > acquireLease … allows at most one of two processes to reclaim the
same abandoned lock` failed in the full run and **passes in isolation** (17/17). Earlier in this
same run, a different test in the same family (`automations-gate.test.ts`) failed the same way and
also passed in isolation — twice, on two different tests, in the concurrency-lease area.

`git diff --stat origin/main...HEAD -- packages/cezar/src/automations/` is **empty**: this branch
does not touch that directory at all. It is the documented concurrent-worktree-load flake.

## Integration verification

`npm run test:e2e` reported **`TEST_E2E_STATUS=skipped`** — the `agent-browser` provider could not
be provisioned on this host (no network route to the GitHub Releases / Chrome-for-Testing hosts),
so no browser spec ran. Per that script's own contract this is loud and non-blocking, and it is
**not** a pass: the cockpit's Settings → Agents row and the composer runner pill were NOT verified
in a browser.

The dry-run server itself boots fine, so the runner was instead driven **end to end through the
real HTTP API and the real persistence layer**, which is the part a browser would not have
exercised any better:

| Check | Result |
|---|---|
| `GET /api/v1/health` | lists `copilot` alongside the other four: `copilot true "mock (CEZ_DRY_RUN=1)"`. Boot succeeded with no Copilot CLI installed. |
| `GET /api/v1/providers/status` | five rows; `copilot connected` under `CEZ_DRY_RUN=1`. |
| `POST /api/v1/runs` `{"runner":"copilot"}` | accepted (the widened `runnerSchema` really is reachable), ran to `waiting` with `tokensUsed: 120`. |
| `GET /api/v1/runs/:id/history` | 22 persisted events — `session.started {backend:"copilot"}`, two `plan.updated`, a tool item running→completed, `usage.updated` and `turn.completed {stopReason:"end_turn", usage:{input:100,output:20,total:120}}`, **and** the v1 `text` / `tool-call` / `tool-result` / `token-usage` / `turn-end` stream alongside them. Both protocols, one run, on disk. |
| `GET /api/v1/models?runner=copilot` | `400 "runner must be claude, codex or opencode"` — the deliberate discovery decision, confirmed on the route rather than only in a unit test. |
| `GET /api/v1/agent-config` | returns all six `copilot.*` entries plus `project.agents`. |
| Built `dist` mock path | `dist/core` → `<pkg>/scripts/mock-copilot-acp.mjs` resolves and exists, so `CEZ_DRY_RUN=1` works from the packaged artifact, not just from source. |

## Backend parity

`ui-parity.test.ts` now runs `copilot` through all ten capability rows, and `copilot` joins
`claude` and `opencode` on the sub-agent **nesting** assertion rather than taking codex's
exemption. All green.

## Style pass

No design-system tooling exists in this repo (no stylelint, no token linter), and the cockpit
changes in this branch are label/preset/descriptor table entries rather than new markup. Nothing
to run.

## Material limits carried into the PR

1. **No authenticated Copilot transcript.** The host `gh` token carries no Copilot entitlement, so
   only `auth-required` is a live capture; the streaming fixtures were read out of the CLI's own
   ACP bridge. `copilot-acp-runner.smoke.test.ts` is the live gate and is skipped here.
2. **No browser verification** of the Settings → Agents row or the composer pill (above).
3. **`usage_update` is unmapped.** Copilot's is a context-window gauge (`{used, size}`), not token
   counts; filling `TokenUsage.contextWindow` from it needs a third hook on the shared ACP mapper
   and is left as a follow-up rather than bundled here.
