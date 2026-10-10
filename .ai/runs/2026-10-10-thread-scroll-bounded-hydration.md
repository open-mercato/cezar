# Update thread-scroll E2E expectations for bounded progressive hydration

Goal: restore meaningful browser coverage for thread scrolling after progressive history hydration changed the initial transcript from a full archive to one retained page.

Scope: `packages/web/e2e/thread-scroll.e2e.ts` and this issue-specific plan/evidence only. The inherited audit plan remains unchanged. No runtime implementation, fixture, or unrelated E2E changes.

## Implementation plan

### Phase 1: Reproduce and redesign assertions

- [ ] 1.1 Run the current thread-scroll browser test against the current build and capture the obsolete failures.
- [ ] 1.2 Update the fixture/test flow to load older pages through the real history boundary, then assert bounded virtualization and tail navigation from that state.

### Phase 2: Verify and ship

- [ ] 2.1 Run the focused browser test and capture red/green evidence and screenshots where available.
- [ ] 2.2 Run the configured validation gate, review the diff, open and review the issue PR, and report exact results and limitations.

## Risks

- Browser-provider setup or the repository-wide gate may be unavailable in this worktree; record those limits rather than weakening assertions.
- The test must retain coverage of progressive page loading, virtualization bounds, jump-to-tail behavior, and cached scroll restoration without assuming the old full-history initial render.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and redesign assertions

- [ ] 1.1 Run the current thread-scroll browser test against the current build and capture the obsolete failures.
- [ ] 1.2 Update the fixture/test flow to load older pages through the real history boundary, then assert bounded virtualization and tail navigation from that state.

### Phase 2: Verify and ship

- [ ] 2.1 Run the focused browser test and capture red/green evidence and screenshots where available.
- [ ] 2.2 Run the configured validation gate, review the diff, open and review the issue PR, and report exact results and limitations.
