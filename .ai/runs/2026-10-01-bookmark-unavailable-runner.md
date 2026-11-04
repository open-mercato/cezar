# Fix bookmarklet autostart for unavailable runners

## Goal

Keep bookmarklet prompts in the editable new-task form when the configured default runner is unavailable or disabled; only valid defaults may autostart.

## Scope

- `packages/web/src/routes/new-task.tsx`
- `packages/web/src/routes/new-task.test.tsx`

Non-goals: changing ordinary composer fallback selection, bookmarklet URL grammar, server runner authorization, or unrelated UI.

## Implementation Plan

### Phase 1: Guard bookmark autostart

- [x] 1.1 Require the configured default runner to remain the resolved runner before bookmark autostart. — 461549a6
- [x] 1.2 Add regression coverage for disconnected and disabled defaults while preserving valid autostart coverage. — 461549a6

### Phase 2: Verify and hand off

- [x] 2.1 Run targeted and configured validation, review the diff, and report limitations. — focused 127/127; typecheck/build/package/unit green; full suite 10 unrelated failures; browser unavailable

## Risks

The provider status cache may be stale; this change follows the current cockpit status and prevents known-invalid fallback launches without changing server-side authorization.

## Progress

PR: #1210

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Guard bookmark autostart

- [x] 1.1 Require the configured default runner to remain the resolved runner before bookmark autostart. — 461549a6
- [x] 1.2 Add regression coverage for disconnected and disabled defaults while preserving valid autostart coverage. — 461549a6

### Phase 2: Verify and hand off

- [x] 2.1 Run targeted and configured validation, review the diff, and report limitations. — 85c34513

## Final verification

Independent reviewer approved code head `8f3f473cd4ee9b596a45623838aa426ee40141b0`: https://github.com/open-mercato/cezar/pull/1210#issuecomment-5922910896.

Browser QA blocker resolved with cached libraries and TMPDIR=/tmp. Inline evidence: https://github.com/open-mercato/cezar/pull/1210#issuecomment-5922915264. Exact code-head CI green; genuine red/green proof and parent 138 tests passed.

This final documentation update supersedes earlier pending review/browser statements without changing implementation. No fix branch was merged; applicable QA/CI still gate merge.
