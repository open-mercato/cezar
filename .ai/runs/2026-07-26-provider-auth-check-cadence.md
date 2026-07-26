# Provider auth and update check cadence

## Goal

Prevent authenticated remote cockpit sessions from being interrupted by recurring Basic Auth challenges by making API credentials explicit and replacing permanent background checks with session-scoped, conservative refresh behavior.

## Scope

- Make same-origin API reads and mutations explicitly include browser credentials.
- Load provider authentication status once per session cache lifetime, then refresh only after a five-minute stale window on focus or explicit user action.
- Let the skills update snapshot start one server-side check per session mount and poll only while that operation is transient, at a one-minute cadence.
- Add focused frontend regression tests for credential forwarding and both query cadences.

## Non-goals

- Do not change provider CLI credential discovery, vendor login flows, or server-side credential storage.
- Do not replace reverse-proxy Basic Auth or introduce a new cezar authentication system.
- Do not change update installation behavior, the six-hour server cache, or WebSocket/SSE protocols.

## Implementation Plan

### Phase 1: Authenticated request boundary

1. Make the typed HTTP client explicitly include same-origin credentials for every request and cover the boundary with client tests.

### Phase 2: Session-safe check cadence

2. Change provider status from interval polling to one cached session load with a five-minute focus refresh window and update query tests.
3. Slow transient skills-update convergence to one minute while preserving the one-time mount check and update query tests.

### Phase 3: Verification and handoff

4. Run the configured validation gate, review compatibility/security/scope, and publish the verified PR for review.

## Risks

- Provider status may remain stale for up to five minutes after credentials change outside cezar; explicit Check again and provider SSE events remain immediate recovery paths.
- A skills update check may take up to one minute to appear complete in the shell after a long-running background operation; explicit controls remain immediate.
- Review blocker: the authoritative review pass found no issues, but GitHub does not permit the PR author to submit an approval review. The PR remains a draft until an independent reviewer approves it and manual Basic Auth QA is completed.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Authenticated request boundary

- [x] 1.1 Make the typed HTTP client explicitly include same-origin credentials for every request and cover the boundary with client tests. — 0f44be53

### Phase 2: Session-safe check cadence

- [x] 2.1 Change provider status from interval polling to one cached session load with a five-minute focus refresh window and update query tests. — f20e572d
- [x] 2.2 Slow transient skills-update convergence to one minute while preserving the one-time mount check and update query tests. — f20e572d

### Phase 3: Verification and handoff

- [ ] 3.1 Run the configured validation gate, review compatibility/security/scope, and publish the verified PR for review.
