# Safe singleton cockpit handoff — execution plan

Source doc: `.ai/specs/2026-10-28-safe-singleton-cockpit-handoff.md`
Issue: #1732
Spec PR: #1738

## Goal

Make a normal `cezar serve` invocation reuse a verified compatible cockpit, register/open the launch project there, and start a new server only when the role-specific runtime slot has no live owner.

## Scope

- Shared fail-closed process identity and recoverable runtime-slot ownership.
- Disposable per-user cockpit runtime records and role-specific slot resolution.
- Stable per-process health `runtimeId`.
- Serve-specific project registration and verified HTTP handoff.
- CLI, API-contract, ownership, integration, package, and documentation coverage.

## Non-goals

- Merging installed/named service roles into one global server.
- New configuration or environment variables.
- Authentication or remote network discovery outside recorded local origins.
- Browser UI changes.

## Risks

- A false stale-owner decision could start duplicate schedulers; all ambiguous identity states must fail closed.
- Moving ownership primitives can regress webhook exclusivity; existing ownership suites remain mandatory.
- Handoff must occur before any server-only initialization or side effects.
- Runtime cleanup must be token checked so an old process cannot remove a replacement's state.

## Progress

- [x] 1. Generalize OS process identity into a neutral runtime module.
- [x] 2. Add bounded cockpit runtime paths, records, and atomic storage.
- [x] 3. Generalize and verify the recoverable slot lease.
- [x] 4. Expose a stable `runtimeId` through the health contract and topic.
- [x] 5. Acquire ownership before boot and publish/clean runtime state.
- [x] 6. Add serve-specific unconditional launch-project registration.
- [x] 7. Implement verified incumbent discovery with bounded health checks.
- [x] 8. Implement idempotent project handoff and scoped URL output.
- [x] 9. Route `serveCommand` before all server-only initialization.
- [x] 10. Pin default, flag, remote, installed, supervisor, and named-slot modes.
- [x] 11. Document the new recommended default and disposable runtime state.
- [x] 12. Add cross-process/package integration coverage.
- [x] 13. Run the full validation gate and record platform limits.

## Verification

- Existing process-identity and webhook ownership suites.
- Runtime-slot, registration, handoff, route/contract, and CLI regressions.
- `npm run typecheck`
- `npm test`
- `npm run test:unit`
- `npm run build`
- `npm run test:package`

All five commands passed on Linux. The shared process-identity suite pins the macOS and Windows
parsers and fail-closed decisions without claiming an end-to-end launch on those hosts; native
cross-process singleton coverage in this run is Linux-only.

