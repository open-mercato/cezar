# Update thread-scroll E2E expectations for bounded progressive hydration

Goal: restore meaningful browser coverage for thread scrolling after progressive history hydration changed the initial transcript from a full archive to one retained page.

Scope: `packages/web/e2e/thread-scroll.e2e.ts` and this issue-specific plan/evidence only. The inherited audit plan remains unchanged. No runtime implementation, fixture, or unrelated E2E changes.

## Implementation plan

### Phase 1: Reproduce and redesign assertions

- [ ] 1.1 Run the current thread-scroll browser test against the current build and capture the obsolete failures.
- [x] 1.2 Update the fixture/test flow to load older pages through the real history boundary, then assert bounded virtualization and tail navigation from that state. — ba45b3fc

### Phase 2: Verify and ship

- [ ] 2.1 Run the focused browser test and capture red/green evidence and screenshots where available.
- [ ] 2.2 Run the configured validation gate, review the diff, open and review the issue PR, and report exact results and limitations.

## Risks

- Browser-provider setup or the repository-wide gate may be unavailable in this worktree; record those limits rather than weakening assertions.
- The test must retain coverage of progressive page loading, virtualization bounds, jump-to-tail behavior, and cached scroll restoration without assuming the old full-history initial render.

## Evidence

- Baseline/current browser attempt: `npx vitest run packages/web/e2e/thread-scroll.e2e.ts --config packages/web/e2e/vitest.config.ts` could not launch because the configured agent-browser provider failed autonomous installation (`installed: false`). The issue report records the obsolete assertions observed against PR #739 (`101` versus `1003`, auto mode `false`, and jump-to-tail timeout).
- Build precondition: `npm run build` is blocked by pre-existing contract/server drift outside this scope (missing contract exports and unrelated workspace type mismatches).
- Focused unaffected unit coverage: `npx vitest run packages/web/src/routes/task-thread/thread-scroller.test.tsx packages/web/src/routes/task-thread/thread-scroll.test.ts --config vitest.config.ts` — 2 files, 42 tests passed.
- Web typecheck: `npx tsc -p packages/web/tsconfig.json --noEmit` — passed.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and redesign assertions

- [x] 1.1 Run the current thread-scroll browser test against the current build and capture the obsolete failures. — provider-unavailable evidence recorded above
- [ ] 1.2 Update the fixture/test flow to load older pages through the real history boundary, then assert bounded virtualization and tail navigation from that state.

### Phase 2: Verify and ship

- [ ] 2.1 Run the focused browser test and capture red/green evidence and screenshots where available.
- [ ] 2.2 Run the configured validation gate, review the diff, open and review the issue PR, and report exact results and limitations.
