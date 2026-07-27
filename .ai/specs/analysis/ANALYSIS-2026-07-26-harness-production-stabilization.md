# Pre-Implementation Analysis: Harness Production Stabilization

## Executive Summary

The specification is ready for phased implementation once durability is kept
ahead of profile and UI work. The highest risks are replaying expensive model
invocations, terminating the wrong or incomplete process tree, and presenting a
contested result as verified. The design addresses these with fail-closed
loading, identity-bound invocation records, additive APIs, and a distinct
contested outcome.

## Backward Compatibility

### Violations Found

| # | Surface | Issue | Severity | Proposed Fix |
|---|---|---|---|---|
| 1 | Ledger schema | A literal v1-only parser currently maps newer ledgers to absence | Critical | Add explicit v1 migration and fail closed on future versions |
| 2 | API route result | `/runs/:id/harness` currently maps every invalid ledger to 404 | Warning | Preserve 404 for absence; add 409 for corrupt/unsupported state |
| 3 | Run status semantics | Adding a public RunStatus value would affect existing clients | Warning | Keep RunStatus stable and represent contested state inside the optional harness ledger/outcome |
| 4 | Profile behavior | Existing role-based runs are persisted as effective `multi` | Warning | Preserve old fields while adding a resolved execution-plan/custom-profile descriptor |

### All Contract Surfaces

| # | Surface | Result |
|---|---|---|
| 1 | Auto-discovery conventions | No rename/removal |
| 2 | Type definitions/interfaces | Additive optional fields only |
| 3 | Function signatures | Preserve compatibility wrappers for existing readers |
| 4 | Import paths | No moves planned |
| 5 | Event IDs | Existing `harness.*` IDs retained |
| 6 | Widget spots | Not applicable |
| 7 | API URLs | Existing URLs retained; one additive mutation |
| 8 | Database schema | Not applicable |
| 9 | DI service names | Not applicable |
| 10 | ACL feature IDs | Not applicable |
| 11 | Notification IDs | Not applicable |
| 12 | CLI commands | Existing commands retained |
| 13 | Generated contracts | No generated export changes |

### Missing BC Section

None. The specification includes an explicit migration and compatibility
section.

## Spec Completeness

### Missing Sections

None. The specification includes architecture, state, APIs, UI, failure modes,
compatibility, risk, phasing, integration coverage, compliance, and changelog.

### Incomplete Sections

| Section | Gap | Recommendation |
|---|---|---|
| Windows supervision | Exact job-object implementation is not yet selected | Use a platform adapter; Unix process groups first, Windows graceful degradation covered by tests |
| Packet resumption | Vendored runtime ledger ownership needs code-level grounding | Reuse `packet-status`/`packet-run` contracts and add adapter checkpoints rather than duplicating packet mechanics |

## AGENTS.md Compliance

### Violations

| Rule | Location | Fix |
|---|---|---|
| State fields must remain optional/additive | Harness ledger currently treats future schema as absent | Introduce version-aware read/migration without rewriting on read |
| Mutating routes validate with zod and return `{ error }` | New contested-acceptance route | Use strict zod body and project-scoped route parity |
| One SSE stream and authoritative reconnect | Harness events currently have no consumer | Add query snapshot plus existing event-stream cache updates; no new socket |
| UI uses React/shadcn/Tailwind semantic tokens | New harness surfaces | Reuse existing primitives and semantic status tokens; run DS review |
| New backend runners must honor `AGENT_PROTOCOL.md` | No new runner is proposed | Keep execution behind existing `AgentRunner` and runtime seams |

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Duplicate invocation after crash | Large token/cost loss | Atomic invocation journal plus input/output hashes and crash-injection tests |
| Orphaned or misidentified processes | Continued cost or unrelated process termination | Dedicated groups, identity tokens, bounded escalation, PID-reuse tests |
| Contested work presented as verified | Unsafe publish/merge | Explicit contested outcome, blocked actions, preserved findings |
| Packet lease recovery | Concurrent edits/corruption | Durable lease identity, expiry/reconciliation, path-conflict tests |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Snapshot/event race | Stale or duplicated UI state | Snapshot-first reducer and sequence/version deduplication |
| Dynamic provider gating drift | Late failures | Derive required providers from the resolved harness execution plan |
| Vendored/upstream divergence | Regeneration overwrites hardening | Record patches in manifest and add parity/security tests |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Larger task-thread bundle | Slower initial route | Lazy-load Review/Packets panes |
| Ledger growth | Larger JSON reads | Store bounded invocation summaries; detailed output remains in artifacts |

## Gap Analysis

### Critical Gaps (Block Implementation)

None after adopting the specification's resolved assumptions.

### Important Gaps (Should Address)

- Define the invocation input-hash version and exact included fields in code.
- Confirm Windows process-group fallback behavior in the supervisor tests.
- Keep v1 ledger migration lossless for loose council/packet rows.

### Nice-to-Have Gaps

- A later operator-facing “retry only failed reviewer” control can reuse the
  invocation journal but is not required for production stabilization.

## Remediation Plan

### Before Implementation (Must Do)

1. Write failing tests for corrupt/future ledger handling and mid-council replay.
2. Ground process and packet changes in existing runtime/RunManager helpers.
3. Keep the local `.ai/agentic.config.json` WIP outside the implementation diff.

### During Implementation (Add to Spec)

1. Update Implementation Status after every completed phase.
2. Record any necessary deviation from the vendored upstream runtime contract.
3. Add integration scenarios before completing the associated API/UI phase.

### Post-Implementation (Follow Up)

1. Run a bounded paid canary only after deterministic fault-injection and soak
   tests pass.
2. Upstream Cezar's vendored-runtime hardening to `open-mercato/skills`.

## Recommendation

Ready to implement in the specified order: durability, supervision/truthful
gates, profiles/packets, UI, runtime hardening, then full verification.
