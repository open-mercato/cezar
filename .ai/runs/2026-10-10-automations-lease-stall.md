# Automation lease guard stall recovery — #1106

## Goal

Prevent a busy event loop plus a concurrent lease contender from falsely compromising a live automation lease, while preserving exclusive ownership, owner-token release fencing, and bounded recovery after a real process kill.

## Scope

- `packages/cezar/src/automations/store.ts`
- `packages/cezar/src/automations/store.test.ts`
- tightly relevant lease fixture changes only

## Non-goals

- No production scheduler or API changes.
- No weakening of exclusivity, owner-token fencing, or real SIGKILL recovery assertions.
- No changes to the parent audit plan or unrelated lease implementations.

## Root cause and design decision

`proper-lockfile` treats the 2-second guard as stale when a contender arrives during an event-loop stall, allowing it to replace the guard before the live-pid check rejects the lease. The original owner then receives `onCompromised`. Raise the guard stale interval to the smallest documented bounded value that covers the regression stall (15 seconds), accepting slower post-SIGKILL guard recovery as the explicit trade-off.

## Implementation Plan

### Phase 1: Reproduce and fix lease liveness

- [ ] 1.1 Reproduce the concurrent-acquirer failure and baseline current exclusivity/recovery tests.
- [ ] 1.2 Raise and document the guard stale interval; add a regression test with a real concurrent contender during a bounded event-loop stall.
- [ ] 1.3 Adjust only the real SIGKILL recovery fixture for the chosen bound and run focused tests.

### Phase 2: Validate and publish

- [ ] 2.1 Run the configured validation gate and inspect the final diff.
- [ ] 2.2 Run authoritative PR review/autofix, finalize the PR, and report exact evidence.

## Risks

The longer stale interval delays recovery from a killed owner; the real SIGKILL test must retain a bounded timeout and prove recovery. The new contender regression must prove the contender is refused and the owner remains valid, without deleting the guard directory.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and fix lease liveness

- [x] 1.1 Reproduce the concurrent-acquirer failure and baseline current exclusivity/recovery tests. — f37a727b
- [x] 1.2 Raise and document the guard stale interval; add a regression test with a real concurrent contender during a bounded event-loop stall. — f37a727b
- [x] 1.3 Adjust only the real SIGKILL recovery fixture for the chosen bound and run focused tests. — f37a727b

### Phase 2: Validate and publish

- [ ] 2.1 Run the configured validation gate and inspect the final diff.
- [ ] 2.2 Run authoritative PR review/autofix, finalize the PR, and report exact evidence.
