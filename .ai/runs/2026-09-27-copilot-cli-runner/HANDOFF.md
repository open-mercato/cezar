# Handoff — 2026-09-27-copilot-cli-runner

**Last updated:** 2026-09-27T17:12:33Z
**Branch:** `feat/copilot-cli-runner`
**PR:** https://github.com/open-mercato/cezar/pull/1113 (ready, `merge-queue`)
**Current phase/step:** complete — every Tasks row is `done`
**Last commit:** `cce1f2a6` — fix(web): stop the Settings accounts pane dropping the fifth agent

## What just happened

- All 26 planned Steps landed, plus one `6.4-review-fix`.
- The full gate passed: typecheck, `npm test` (8361 passed, 3 skipped), test:unit, build, test:package.
- The review pass found and fixed one **major**: Settings → Agent accounts built its tab list from a
  hand-written `ProviderId[]` literal and so rendered four tabs out of five, omitting Copilot —
  the one runner this branch adds. A `ProviderId[]` literal is under-wide, never wrong, so the
  type system could not catch it the way it caught every `Record<ProviderId, …>` beside it.
- PR flipped to ready, labelled, QA instructions posted.

## Next concrete action

- None from this run. The PR is waiting on a human review and on manual QA (`needs-qa`).
- If a reviewer wants the remaining follow-up: map Copilot's `usage_update` (`{used, size}`) to
  `TokenUsage.contextWindow`, which needs a third hook on the shared ACP mapper.

## Blockers / open questions

- **The ACP layer overlaps draft PR #1049.** `core/acp-client.ts` is byte-identical to #1049;
  `core/acp-ui-mapper.ts` differs only by two additive optional `AcpDialect` hooks
  (`toolStatusOf`, `parentItemOf`) and their two call sites. Whichever PR lands second drops its
  copy — for this one that is a delete, for #1049 it is a rebase that keeps the two hooks.
- **No authenticated Copilot transcript** was available, so the streaming fixtures come from the
  CLI's own ACP bridge rather than a capture. `copilot-acp-runner.smoke.test.ts` is the live gate.
- **No browser verification**: `npm run test:e2e` skipped for want of a provisionable browser.

## Environment caveats

- Dev runtime runnable: yes; the dry-run server boots and serves a `copilot` run end to end.
- Browser / UI checks: skipped — the `agent-browser` provider cannot be provisioned on this host.
- `npm test` needs `TMPDIR`/`TMP`/`TEMP` and `CEZ_*` cleared. Two different tests under
  `src/automations/` flaked once each under concurrent-worktree load and passed in isolation.

## Worktree

- Path: `/home/cezar/cezar/.ai/cezar/worktrees/0da5390a-cd8b-4926-b58d-ac7792074f51`
- Created this run: no (reused the current linked worktree, so nothing to clean up)
