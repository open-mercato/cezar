# Disable the remote health WebSocket

## Goal

Stop reverse-proxy-authenticated remote cockpits from reopening an HTTP Basic Auth challenge every three seconds by never starting the browser WebSocket transport in remote mode.

## Scope

- Gate the session-global health WebSocket on the authoritative `localHandoff` capability returned by authenticated `/api/health` bootstrap.
- Keep the health WebSocket unchanged for local cockpits, where its demand-driven live behavior is safe and useful.
- Keep remote health current through the existing authenticated HTTP bootstrap and SSE reconnect/visibility reconciliation.
- Add regression coverage proving remote mode opens no WebSocket while local mode still subscribes and folds health events into cache.

Source doc: .ai/specs/2026-07-23-websocket-subscriptions.md

## Non-goals

- Do not pass Basic Auth credentials through URLs, WebSocket subprotocols, query strings, or persisted browser state.
- Do not disable the workspace SSE stream, which carries run events and supports browser-managed credentials.
- Do not change the server WebSocket protocol, proxy configuration, or local cockpit behavior.

## Implementation Plan

### Phase 1: Remote-safe health transport

1. Gate the root health subscription on a completed local-mode health bootstrap and update the subscription API without opening a pre-bootstrap socket.
2. Add focused tests for remote no-socket behavior, local subscription behavior, and authenticated HTTP fallback semantics.

### Phase 2: Verification and handoff

3. Run the configured validation gate, review security/compatibility/scope, and publish the verified corrective PR.

## Risks

- A remote foreground tab no longer receives immediate branch/version health pushes; authenticated HTTP reconciliation still runs when the SSE reconnects or the tab becomes visible.
- A malformed or failed health bootstrap must fail closed by opening no WebSocket; the UI already reports the health request failure honestly.

## Progress

PR: #688

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Remote-safe health transport

- [x] 1.1 Gate the root health subscription on a completed local-mode health bootstrap and update the subscription API without opening a pre-bootstrap socket. — 26e2a42b
- [x] 1.2 Add focused tests for remote no-socket behavior, local subscription behavior, and authenticated HTTP fallback semantics. — 26e2a42b
- [x] Post-review fix: explicitly include credentials on workspace and run EventSource reconnects. — a84de0e7

### Phase 2: Verification and handoff

- [x] 2.1 Run the configured validation gate, review security/compatibility/scope, and publish the verified corrective PR. — 091dd4bc
