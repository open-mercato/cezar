# Fix issue #1000: preserve cockpit API ownership

## Goal

Ensure dispatched agents inherit an API URL reachable on the interface where the cockpit listens, and ensure automatic port selection checks that same interface. Add focused regression coverage without changing dispatch protocol or workflow behavior.

## Scope

- `packages/cezar/src/index.ts` startup URL construction and port probe.
- A small testable helper module and unit tests for host-aware API URL and port probing.

## Non-goals

- No changes to `workflows/run.ts`, automation behavior, project registry, or server-install configuration.
- No instance discovery, health identity protocol, or orphan-process lifecycle redesign.

## Implementation Plan

### Phase 1: Reproduce and implement

- [x] 1.1 Extract/test host-aware API URL formatting and port-probe host selection. — 0b5dc705
- [x] 1.2 Wire the helpers into cockpit startup and preserve loopback defaults. — 0b5dc705

### Phase 2: Validate and publish

- [ ] 2.1 Run red-before-fix and green regression tests, then the configured validation gate.
- [ ] 2.2 Run the authoritative PR review/autofix pass and finalize the PR.

### Evidence

- Red regression: with the extracted helper retained but `canListen` restored to the old hardcoded `127.0.0.1` probe, `api-origin.test.ts` failed behaviorally (`expected false, received true` for an occupied non-loopback port; exit 1). This proves the old interface bug rather than a missing-module failure.
- Green regression: `npm exec vitest run packages/cezar/src/api-origin.test.ts` — 3 passed, including host-aware collision detection and startup wiring assertions.
- Configured gate after `npm ci`: `npm run typecheck`, `npm run test:unit`, `npm run build`, and `npm run test:package` pass. Aggregate local `npm test` was re-run and still reports unrelated environment-sensitive failures; the authoritative PR CI previously passed its complete server/cockpit suite, build, packaged E2E, release verification, CodeQL, and snapshot publication. The new commit has triggered a fresh CI run.
- Full-suite environment check: running `npm test` with `TMPDIR=/tmp TMP=/tmp` and all task-injected `CEZ_*` variables unset removed the contamination described by #999, but the suite still hit unrelated `automations-gate.test.ts` failures under concurrent local task load; no source changes were made for that issue. Hosted CI remains the authoritative clean-suite evidence.
- The local skill collection provides `om-auto-review-pr` instructions but no executable command; the PR remains draft/in-progress for the reserved independent review.

## Risks

The bind host may be an IPv6 literal or an unspecified wildcard address; URL formatting must bracket IPv6 literals, while the default must remain dialable loopback. The probe must use the exact configured bind host so a second cockpit cannot claim the same port on a different interface.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and implement

- [x] 1.1 Extract/test host-aware API URL formatting and port-probe host selection. — 0b5dc705
- [x] 1.2 Wire the helpers into cockpit startup and preserve loopback defaults. — 0b5dc705

### Phase 2: Validate and publish

- [ ] 2.1 Run red-before-fix and green regression tests, then the configured validation gate.
- [ ] 2.2 Run the authoritative PR review/autofix pass and finalize the PR.
