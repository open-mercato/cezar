# Share SSE event and deletion subscriptions

Goal: replace per-connection RunStore `event`/`deleted` listeners used by the SSE handlers with shared, demand-driven hubs without changing SSE payloads, replay ordering, cursor semantics, or project attachment lifecycle.

Scope: `packages/cezar/src/server/server.ts` SSE handlers, a sibling subscription-hub module, and dedicated server subscription tests. Non-goals: RunStore, run-frame subscriptions, attachment/message routes, SSE framing, or listener limits.

## Implementation Plan

### Phase 1: Shared subscription primitives

- [x] 1.1 Add WeakMap-owned keyed run-event and flat deletion hubs with first/last subscriber lifecycle. — 276774f2
- [x] 1.2 Add focused lifecycle, isolation, and unsubscribe tests. — 276774f2

### Phase 2: SSE integration and verification

- [x] 2.1 Route per-run, project/global, and workspace deletion subscriptions through the hubs while preserving replay and project detach behavior. — 276774f2
- [ ] 2.2 Run focused regression tests and the full repository validation gate.
- [x] 2.3 Complete review and publish the child PR. — independent review of a2b81c3cb880037b6dc0513a909d536205e8da25 approved; see review evidence below

## Risks

The replay-to-live handoff is ordering-sensitive; the handler’s existing buffering and sequence de-duplication must remain unchanged. Workspace project removal/re-add must detach and recreate only that project’s deletion subscription.

## Progress
PR: #1342

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Shared subscription primitives

- [x] 1.1 Add WeakMap-owned keyed run-event and flat deletion hubs with first/last subscriber lifecycle. — 276774f2
- [x] 1.2 Add focused lifecycle, isolation, and unsubscribe tests. — 276774f2

### Phase 2: SSE integration and verification

- [x] 2.1 Route per-run, project/global, and workspace deletion subscriptions through the hubs while preserving replay and project detach behavior. — 276774f2
- [x] 2.2 Run focused regression tests and the full repository validation gate. — b4856ec6
- [x] 2.3 Complete review and publish the child PR. — independent review of a2b81c3cb880037b6dc0513a909d536205e8da25 approved; see review evidence below

## Independent review and final handoff

[Final independent review](https://github.com/open-mercato/cezar/pull/1342#issuecomment-6072578072) approved source head `a2b81c3cb880037b6dc0513a909d536205e8da25` with no findings. GitHub rejected formal approval because the authenticated account authored this PR. This finalization commit changes this plan only; reviewed source is unchanged. No merge was performed.
