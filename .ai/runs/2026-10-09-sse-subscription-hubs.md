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
- [ ] 2.3 Complete review and publish the child PR.

## Risks

The replay-to-live handoff is ordering-sensitive; the handler’s existing buffering and sequence de-duplication must remain unchanged. Workspace project removal/re-add must detach and recreate only that project’s deletion subscription.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Shared subscription primitives

- [x] 1.1 Add WeakMap-owned keyed run-event and flat deletion hubs with first/last subscriber lifecycle. — 276774f2
- [x] 1.2 Add focused lifecycle, isolation, and unsubscribe tests. — 276774f2

### Phase 2: SSE integration and verification

- [x] 2.1 Route per-run, project/global, and workspace deletion subscriptions through the hubs while preserving replay and project detach behavior. — 276774f2
- [x] 2.2 Run focused regression tests and the full repository validation gate. — b4856ec6
- [ ] 2.3 Complete review and publish the child PR.
