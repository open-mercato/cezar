# Implement Jira and Linear tracker browsing

Source doc: .ai/specs/2026-09-18-jira-linear-tracker-browsing.md
Design reference: #1026 (design-only; local revised spec materialized, not committed here).
Engine: om-auto-create-pr (steps: 13, --loop: no)
Status: complete

## Goal and scope

Implement the approved read-only tracker integration, safe paginated discovery, project association,
browsing and context-preserving agent handoff. Jira Cloud first; Linear behind the same contract.
Preserve GitHub behavior. No vendor writes, OAuth, comment/attachment ingestion or sync.

User override: LOCAL ONLY. No push, PR creation/edit/comment, labels, screenshots upload or other
publication. Keep all evidence locally. Local commits permitted. Existing linked worktree reused;
implementation branch split from locally resolved origin/main, leaving design branch untouched.

## Implementation Plan

Phase 1 (steps 1.1–1.3): contract, Jira transport/driver and tests. Gate: targeted tests and typecheck.
Phase 2 (2.1–2.4): persisted association, classification, typed routes, invalidation. Gate: route tests.
Phase 3 (3.1–3.3): project Settings, tracker UI, handoff and docs. Gate: web tests and typecheck.
Phase 4 (4.1–4.3): Linear adapter, shared scenarios, full validation and local UI evidence/review.

Validation: npm run typecheck; npm test; npm run test:unit; npm run build; npm run test:package.
Run validation with `TMPDIR=/tmp`: the inherited harness TMPDIR is inside another Git worktree,
which invalidates tests that deliberately create non-repository directories.
UI verification separately through repository browser setup, dry-run without real credentials.

## Risks and rulings

- Live vendor-account acceptance requires separately provisioned credentials; mocked/protocol tests
  and dry-run UI evidence must not be presented as live-account verification.
- Skill remote delivery steps are superseded by explicit user no-publication instruction.
- Phase4 Linear backend is implemented alongside Phase3 UI to keep independent work moving; final acceptance remains after both.
- Local skill collection resides in bare cache; git show reads it without fetch/install.

## Progress

PR: #1045

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contract and Jira driver

- [x] 1.1 Define tracker schemas, inferred types and contract tests
- [x] 1.2 Implement bounded Jira transport, discovery and scoped driver
- [x] 1.3 Verify Jira failures, context conversion and dry-run fixtures

### Phase 2: Association and API

- [x] 2.1 Persist and validate local associations
- [x] 2.2 Wire capabilities and every project classification path
- [x] 2.3 Chain typed API routes with parity and boundary tests
- [x] 2.4 Reconcile caches and document route inventory

### Phase 3: Cockpit and documentation

- [x] 3.1 Build Settings picker and tracker browse/detail flows
- [x] 3.2 Preserve full handoff context and engine/workflow choices
- [x] 3.3 Document configuration and verify UI regressions

### Phase 4: Linear and acceptance

- [x] 4.1 Implement Linear protocol adapter with failure tests
- [x] 4.2 Enable Linear and verify cross-provider isolation
- [x] 4.3 Run full validation, review and local UI evidence

## Publication follow-up (2026-09-20)

The scope now includes project-managed dotenv connections, demand-driven visible-list refresh,
and Jira/Linear event automations through the existing scheduler. Jira creation/status events,
Linear creation events and exact required-label filters are implemented. Vendor status changes
remain agent-driven, not transactional scheduler actions. Live Linear and complete real-agent
acceptance remain manual QA items.

Local autosave history was consolidated with a backup retained; generated screenshots, debug
probes and historical reports were archived locally instead of published. Rebased onto current
upstream main, retaining review triggers, agent profiles and scheduler lease/liveness fixes.

### Phase 5: Publication and current-base validation

- [x] 5.1 Consolidate local history and remove transient evidence from the change
- [x] 5.2 Integrate current main without removing its automation safeguards
- [x] 5.3 Run configured validation and synthetic browser acceptance on the final tree
- [x] 5.4 Publish implementation PR, run authoritative review and record QA handoff

Final publication validation: typecheck; 7,613 tests / 425 files; unit36; build/check-pack;
package16; synthetic browser paused-save/preview/per-event launch/deduplication all passed.
Independent backend integration review: 81 focused tests, no blocker/major found.
Review of 225278ca is recorded on PR1045. Manual live-provider/real-agent QA remains pending.
GitHub denied pipeline labels and assignment with HTTP403; a collaborator must apply
review/feature/documentation/needs-qa/priority-medium/risk-high. No merge performed.
