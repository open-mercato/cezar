# Fix false offline banner

## Goal

Stop the cockpit from claiming the user is offline when cezar's plain HTTP API is responding successfully, even if the browser's coarse `navigator.onLine` signal is false and the live event stream is disconnected.

## Scope

- Adjust the connection-banner state decision in `packages/web/src/components/cache-status.tsx`.
- Add a focused regression test in `packages/web/src/components/cache-status.test.tsx`.
- Preserve the existing immediate offline state when neither the live stream nor plain requests can reach cezar.

## Non-goals

- Changing the workspace SSE reconnect mechanism.
- Changing CezarBot relay-specific error reporting.
- Redesigning the connection banner or its copy.

## Implementation Plan

### Phase 1: Correct the reachability decision

- Treat a successful plain cezar response as authoritative evidence that the cockpit is reachable, regardless of `navigator.onLine`.
- Cover the false-browser-offline case and retain the genuine unreachable case in component tests.

### Phase 2: Validate and review

- Run the targeted web test and the repository validation gate, then complete the authoritative PR review pass.

## Risks

- A disconnected SSE stream must still be communicated as paused live updates; the fix must not present it as fully live.
- Native relay failures remain authoritative because gateway failures do not count as cezar answers.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Correct the reachability decision

- [x] 1.1 Make successful cezar responses override the browser's offline hint — d7a72f81
- [x] 1.2 Add regression coverage for false and genuine offline states — d7a72f81

### Phase 2: Validate and review

- [x] 2.1 Run targeted and full validation — d7a72f81
- [ ] 2.2 Complete the authoritative automated review pass
