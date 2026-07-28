# GitHub Automations implementation

Source doc: .ai/specs/2026-07-25-github-automations.md
Refs #669

## Goal

Implement zero-configuration, bounded GitHub polling automations that launch ordinary cezar tasks and remain fully auditable.

## Scope

- Add compatible automation schemas, persistence, polling, scheduling, receipts, task launch integration, and project-scoped APIs.
- Add the Automations cockpit routes, editor, execution log, live invalidation, accessibility coverage, and final browser evidence.
- Preserve cezar's zero-config behavior, local-only safety defaults, route parity, workspace lifecycle, and existing run contracts.

## Non-goals

- GitHub webhooks, external daemons, GitHub Actions dispatch, or user-authored mandatory configuration.
- Changes to the existing workflow YAML contract or the existing `POST /api/runs` request contract.
- Automatic execution before the spec's explicit baseline and enablement gates.

## Risks

- Cursor, lease, or receipt errors could duplicate autonomous work; durable pre-launch receipts, frozen high-watermarks, and overlap tests are mandatory.
- Polling can consume GitHub quota; requests must be bounded, conditional, serialized, and header-backoff aware.
- GitHub text is untrusted agent input; templates must delimit and bound it without shell or system-prompt interpolation.
- New state is shared by processes; writes must be atomic or append-only, salvageable, compacted, and optional.

## Implementation Plan

### Phase 1: Contracts and persistence

- Add schemas, compatibility fixtures, bounded defaults, and unknown-field tests.
- Add atomic definitions/state persistence, append-only receipts/logs, salvage, compaction, leases, and gitignore maintenance.

### Phase 2: Workspace and API integration

- Add the workspace coordinator, registered-project discovery, context lifecycle integration, and degraded-state tests.
- Add project-scoped CRUD, preview, status, log, and retry routes with validation, origin protection, and route parity.

### Phase 3: Cockpit foundations

- Extract and reuse the New task configuration model and serializer without changing the run API.
- Add Automations navigation, list/editor/log routes, API/query hooks, setup links, responsive states, accessibility, and React tests.

### Phase 4: GitHub detection and scheduling

- Add bounded GitHub polling with fixed argument arrays, filters, caps, ETags, fixtures, and rate metadata.
- Add the workspace due timer, project handles, shared request arbitration, backoff, pagination watermarks, leases, baselines, cursors, and overlap tests.
- Add issue label-event timeline reconstruction and stable event identity with receipt deduplication.

### Phase 5: Launch, live updates, and diagnostics

- Add bounded task templates, untrusted-context delimiters, ordinary run/group launching, optional run provenance, and crash reconciliation.
- Add additive workspace SSE invalidations and run/automation cross-links without UI polling.
- Add log compaction, aggregate health/status, redacted diagnostics, and explicit retry controls.

### Phase 6: Final verification

- Run the full configured validation gate and browser E2E flow for create, preview, baseline, launch, dedupe, and log inspection.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contracts and persistence

- [x] 1.1 Add schemas, compatibility fixtures, bounded defaults, and unknown-field tests. — 4d12fa99
- [x] 1.2 Add atomic definitions/state persistence, append-only receipts/logs, salvage, compaction, leases, and gitignore maintenance. — 365e655d

### Phase 2: Workspace and API integration

- [x] 2.1 Add the workspace coordinator, registered-project discovery, context lifecycle integration, and degraded-state tests. — 2490d1ea
- [x] 2.2 Add project-scoped CRUD, preview, status, log, and retry routes with validation, origin protection, and route parity. — 174fa4ea

### Phase 3: Cockpit foundations

- [x] 3.1 Extract and reuse the New task configuration model and serializer without changing the run API. — a2d80d4e
- [x] 3.2 Add Automations navigation, list/editor/log routes, API/query hooks, setup links, responsive states, accessibility, and React tests. — 03afd2f4

### Phase 4: GitHub detection and scheduling

- [x] 4.1 Add bounded GitHub polling with fixed argument arrays, filters, caps, ETags, fixtures, and rate metadata. — 02f952f2
- [x] 4.2 Add the workspace due timer, project handles, shared request arbitration, backoff, pagination watermarks, leases, baselines, cursors, and overlap tests. — b38c42c8
- [x] 4.3 Add issue label-event timeline reconstruction and stable event identity with receipt deduplication. — 02f952f2

### Phase 5: Launch, live updates, and diagnostics

- [x] 5.1 Add bounded task templates, untrusted-context delimiters, ordinary run/group launching, optional run provenance, and crash reconciliation. — 3ea0055a
- [x] 5.2 Add additive workspace SSE invalidations and run/automation cross-links without UI polling. — 5b1bdbb8
- [x] 5.3 Add log compaction, aggregate health/status, redacted diagnostics, and explicit retry controls. — e05700ea

### Phase 6: Final verification

- [x] 6.1 Run the full configured validation gate and browser E2E flow for create, preview, baseline, launch, dedupe, and log inspection. — 6fac511d
- [x] 6.2 Reapply the completed feature after the package-workspace refactor from PR #695. — a8c5bbb4
- [x] 6.3 Address authoritative review findings in bounded GitHub event draining. — 5b4abfb4
