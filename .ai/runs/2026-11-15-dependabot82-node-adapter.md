# Patch Node adapter request and upgrade handling

## Goal
Remediate Dependabot82/83 with compatible @hono/node-server2.1.6, preserving Node20, normal HTTP and local cockpit/WebSocket behavior.

Security-Source: open-mercato/cezar:dependabot:82
Security-Source: open-mercato/cezar:dependabot:83
Security-Fingerprint: GHSA-jpvv-r467-5p4w:@hono/node-server:package-lock.json
Security-Fingerprint: GHSA-qv5m-9pm6-hqp3:@hono/node-server:package-lock.json

## Scope and non-goals
One coupled npm dependency remediation group: service manifest, root lockfile and focused adapter regressions/integration. First patched2.1.6 retains Node>=20/Hono4. Existing PR1253 adapter1.x is not a compatible fix for main2.1.3. All other npm alerts duplicate existing PR work. Rust zip/glib/rustls remain blocked: Cargo unavailable and crates.io metadata HTTP403; no compatible resolver/build proof can be obtained. No issues, settings/workflows/env/API/default changes, broad overrides, advisory publication/dismissal, merges or releases.

## Implementation Plan
### Phase1: Patch and proof
1.1 Add focused raw-path and asynchronous-upgrade regressions; demonstrate failure on installed2.1.3 and success on2.1.6; update service range/root lock consistently with no unrelated updates.
### Phase2: Validation
2.1 Run all five configured npm commands in order, plus resolution/security-removal proof and applicable real-loopback/WS integration.
### Phase3: Independent review and publication
3.1 Resume the existing final-review child for authoritative om-auto-review-pr/autofix, validate its verdict/evidence and fix any findings.
3.2 Recheck deduplication/claims, publish exact verification/limitations and normalized labels, promote only after complete gate and independent approve, then release exact owned claim.

## Risks and authorization
Backslashes in raw request paths now intentionally return400, while encoded backslashes and query strings retain behavior. Pending upgrade sockets must tolerate error/close during async handling; existing cezar custom WS handling must remain functional. Regression proof covers the upstream flaw, not a claim of arbitrary internet exposure in cezar. Release/v0.20.x has the same vulnerable adapter and needs backport.

The user explicitly resumed autonomous completion after the pre-claim blocker report. Use the exact already-installed canonical get/acquire/release operations as run-local artifact helpers, together with the repository label guards, without changing repository descriptors/settings/workflows. Preserve atomic create-only ownership, exact-SHA leased release, comments/label/reset checks and inherited review lock. This is a recorded continuation decision overriding the skill's descriptor-upgrade stop; independent review must assess it. Claim run:75c85ed7-d0cd-41e3-86de-20ad34c5b794. Reuse cockpit-owned linked worktree; do not remove it. Two-subtask total already used; resume the existing final reviewer, never dispatch another child.

Engine: om-auto-create-pr (steps: 4, --loop: no)

## Progress

PR: #2204

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Patch and proof

- [x] 1.1 Patch compatible adapter with failing-before/passing-after regressions — fafc3cd2f

### Phase 2: Validation

- [x] 2.1 Complete ordered npm gate and security/integration proof — a4bdc7275

### Phase 3: Independent review and publication

- [x] 3.1 Complete authoritative independent review and any fixes — 1e1f7b986
- [ ] 3.2 Finalize evidence, labels, readiness and claim release
