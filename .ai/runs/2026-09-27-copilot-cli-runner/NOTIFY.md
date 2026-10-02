# Notify — 2026-09-27-copilot-cli-runner

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-09-27T15:54:57Z — run started
- Brief: implement issue #582 — GitHub Copilot CLI as a first-class cezar runner over ACP
  (source spec `.ai/specs/2026-09-19-runner-seam-native-backends.md`, Phase 3 only).
- External skill URLs: none.

## 2026-09-27T15:54:57Z — decision: engine routed to the loop
- `om-auto-create-pr` drafted 26 Steps against `engine.loopStepThreshold` 20, so the run was
  handed to `om-auto-create-pr-loop` before anything was written.

## 2026-09-27T15:54:57Z — decision: this run carries the shared ACP layer
- Spec Phase 0 has not landed and spec Phase 2 (`gemini`, #581) is open **draft** PR #1049, so
  per the spec's § Phasing rule Phase 3 carries Steps 2.2–2.3.
- To avoid forking a second ACP client, `core/acp-client.ts` and `core/acp-ui-mapper.ts` are
  taken from PR #1049 **verbatim**; whichever PR lands second drops its copy.

## 2026-09-27T15:54:57Z — decision: spec Step 3.1 settled before planning
- Verified against the real `@github/copilot` 1.0.88 binary. The spec's `copilot --acp --stdio`
  is wrong — there is no `--stdio` flag; the invocation is `copilot --acp`.
- Confirmed the `initialize` capabilities, the `-32000 Authentication required` frame, the
  `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` precedence and the tool-filter flags.

## 2026-09-27T15:54:57Z — blocker (non-fatal): no authenticated Copilot transcript
- The host `gh` token carries no Copilot entitlement, so `session/new` answers
  "Authentication required" and no live streaming frames could be recorded. Fixtures are derived
  from the ACP schema (`PROTOCOL_VERSION = 1`) and from strings in the installed
  `@github/copilot-linux-x64` binary, each cited in its fixture header — the same offline method
  the source spec used for codex. Step 3.4's opt-in smoke test is the live gate.

## 2026-09-27T16:32:59Z — checkpoint 1 (steps 1.1, 1.2, 2.1, 2.2 + the union commit)
- `npm run typecheck` and the full `npm test` (490 files, 8296 tests) both green.
- UI verification skipped: the repo has no `.ai/qa/test-env.json` descriptor and nothing in this
  window is user-drivable — `createRunner` deliberately refuses `copilot` until Step 3.1.
- Record: `checkpoint-1-checks.md`.

## 2026-09-27T16:32:59Z — decision: the union widening is one commit, not ten
- Steps 4.1–4.5, 4.7, 4.8, 5.1, 5.3 and 5.5 landed together. `Record<RunnerId, …>` tables and the
  compile-time contract-parity guard make the widening atomic; splitting it would have produced a
  chain of commits that do not typecheck. Reasoned out in PLAN.md § Deviation.

## 2026-09-27T16:32:59Z — decision: two additive hooks on the shared ACP dialect
- `AcpDialect` gains optional `toolStatusOf` and `parentItemOf`. Copilot reports a STARTED tool as
  ACP `pending` and never sends `in_progress`, and it attributes a subagent's tool calls to the
  delegating `task` call under `_meta["github.com/copilot"]`. Neither is expressible through the
  hooks #1049 shipped. Both are inert for a dialect that omits them, so `acp-client.ts` stays
  byte-identical and `acp-ui-mapper.ts` differs from #1049 only by those two members and their
  two call sites.

## 2026-09-27T16:32:59Z — three spec corrections from the verified surface
- `copilot --acp --stdio` is wrong; there is no `--stdio` flag.
- Copilot HAS a native `plan` `session/update` channel — no `write_todos` side-reading needed.
- Per-turn usage is a top-level `usage` on the `session/prompt` result, in exactly the shape the
  shared mapper's `standardUsage` already reads, so the spec's "documented substitute" for
  `usage.updated` is not needed. Its separate `usage_update` frame is a context-window gauge
  (`{used, size}`) and is deliberately not mapped — noted as a follow-up, not a gap in parity.

## 2026-09-27T17:02:24Z — final gate
- `npm run typecheck`, `npm run test:unit`, `npm run build`, `npm run test:package`: all pass.
- `npm test`: 8359 passed, 3 skipped (opt-in smoke), 1 failed — `automations/store.test.ts`, which
  passes in isolation and sits in a directory this branch does not touch. Known concurrent-worktree
  flake; a second test in the same family flaked identically earlier in this run.
- `npm run test:e2e`: `TEST_E2E_STATUS=skipped` — the agent-browser provider could not be
  provisioned on this host. NOT a pass; the cockpit rows were not verified in a browser.
- Substituted real integration evidence instead: the runner was driven end to end through the
  live HTTP API (health, providers/status, POST /runs, the persisted event history, the models
  400, agent-config), and the built `dist` mock path was confirmed. Record: `final-gate-checks.md`.

## 2026-09-27T17:02:24Z — deviation: no CHANGELOG entry (step 6.3)
- This repository writes `CHANGELOG.md` at release time from the merged PRs; no recent feature or
  fix PR touches it. Adding a line here would collide with the release draft. The README backends
  row, which IS this PR's to write, is done.

## 2026-09-27T17:12:33Z — review pass: one major found and fixed
- `om-auto-review-pr 1113 --autofix`. The Settings → Agent accounts pane built its tab list from a
  hand-written `ProviderId[]` literal, so it rendered four tabs out of five and the missing one was
  Copilot. Fixed in `cce1f2a6` by deriving from an exported `RUNNER_ORDER`; three parameterized
  tests that also enumerated four runners now cover `copilot`.
- Full gate re-run clean afterwards: 8361 passed, 3 skipped.

## 2026-09-27T17:12:33Z — run complete
- PR #1113 flipped to ready, pipeline label `merge-queue`, `needs-qa` retained (no browser QA was
  possible here). Manual QA instructions posted. Lock released.
