# Automatic Open Mercato skills updates — execution plan

Source spec: `.ai/specs/2026-07-22-automatic-open-mercato-skills-updates.md`
PR: https://github.com/open-mercato/cezar/pull/613

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Add provenance-aware update detection service | done | fc73d70 |
| 1 | 1.2 | Expose cached detection and forced-check APIs | done | a8117a0 |
| 1 | 1.3 | Harden serialized checks and stale-lock recovery | done | 865c22f |
| 2 | 2.1 | Add inherited global auto-update preference | done | 15b0a0b |
| 2 | 2.2 | Add safe update execution and lifecycle scheduling | done | 2308284 |
| 2 | 2.3 | Expose guarded manual apply behavior | done | 97c98f1 |
| 3 | 3.1 | Add global Skills settings surface | done | 2ab458d |
| 3 | 3.2 | Add accessible navigation update marker | done | 6891c74 |
| 3 | 3.3 | Add Manage skills update workflow and states | done | 5f19845 |
| 3 | 3.4 | Add end-to-end coverage and visual evidence | done | 0eac053 |
| 3 | 3.5-final-fix | Inventory the new protected API routes | done | 7be9b78 |
| 3 | 3.6-final-fix | Stabilize full-suite browser fixtures | done | e47f5f0 |
| 3 | 3.7-final-fix | Finish detached-HEAD and teardown stabilization | done | addf3fd |
| 3 | 3.8-final-fix | Wait for asynchronous branch settings state | done | 1c341be |
| 4 | 4.1 | Offer a confirmed upgrade-notes session after update | done | d6126fd |
| 4 | 4.2-final-fix | Prompt only when the update timestamp advances | done | 5417668 |

## Goal

Safely detect and update upstream-CLI-tracked Open Mercato skill installations while preserving local/manual skills, exposing an inherited global preference and actionable cockpit state, and degrading without affecting boot.

## Scope

- Add a fail-closed skills update service for project and global installations.
- Add workspace-level detection/check/apply APIs and post-listen scheduling.
- Extend tolerant workspace configuration with the optional auto-update preference and document the default-on exception.
- Add global Settings, navigation, and Manage skills UI surfaces with tests and browser evidence.

## Non-goals

- Do not alter imported skill curation, discovery precedence, or custom team repositories.
- Do not update untracked, manually copied, symlinked, or non-Open-Mercato skills.
- Do not invoke GitHub CLI or `/om-apply-upgrade-notes` from the service.
- Do not add the upstream skills CLI as a package dependency.

## Risks

- Upstream lock/output formats may change; parsing must fail closed and be fixture-tested.
- Background network and filesystem mutation is a documented exception to the normal opt-in default and must remain bounded, delayed, cached, and disableable.
- Multiple processes may share global installs; in-process serialization and a stale-recoverable cache lock are required.
- Browser requests must never control executable names, arguments, paths, sources, or scopes.

## Implementation Plan

### Phase 1 — Provenance-aware detection

#### Step 1.1 — Add provenance-aware update detection service

Implement `src/skills-update.ts` with tolerant project/global lock readers, canonical source matching, bounded fixed-argument `npx` execution, deduplication, TTL/cache-lock behavior, dry-run state, and focused unit tests covering malformed inputs, mixed provenance, failures, redaction, timeouts, and concurrency.

#### Step 1.2 — Expose cached detection and forced-check APIs

Wire one shared service into server lifecycle; add workspace-level GET/check routes plus client/query contracts. Cover validation, project resolution, cached reads, and rejection of executable input.

#### Step 1.3 — Harden serialized checks and stale-lock recovery

Serialize update-service operations across repositories, recover locks owned by dead processes, expose the complete status union, and cover missing-`npx` plus stale-lock cleanup behavior.

### Phase 2 — Preference and update execution

#### Step 2.1 — Add inherited global auto-update preference

Extend tolerant workspace config and API with nullable stored/effective `skillsAutoUpdate`, implement explicit-over-env-over-true precedence, add tests, and update `.env.example`, README, and compatibility documentation.

#### Step 2.2 — Add safe update execution and lifecycle scheduling

Implement explicit-name serial project/global updates, partial outcomes, locking, forced recheck/catalog invalidation, and post-listen workspace scheduling. Cover argument safety, no-`gh`, lifecycle failures, dry-run, and concurrency. Document the default-on exception in `AGENTS.md` and `BACKWARD_COMPATIBILITY.md`.

#### Step 2.3 — Expose guarded manual apply behavior

Add apply-route validation and 409 conflict behavior with automatic-on/off, no-installation, partial-success, stale-lock, and dry-run coverage.

### Phase 3 — Cockpit surfaces

#### Step 3.1 — Add global Skills settings surface

Register `/settings/global/skills` and implement explicit/inherited preference controls, reset-to-default behavior, no-installation/unavailable states, and component/route tests.

#### Step 3.2 — Add accessible navigation update marker

Generalize navigation badges, source update state once from the app shell, and cover desktop/mobile accessibility plus no-marker states.

#### Step 3.3 — Add Manage skills update workflow and states

Add the update card, check/apply/retry/current/partial states, catalog refresh, upgrade-notes callout, and curation-vs-update copy with mutation ordering tests.

#### Step 3.4 — Add end-to-end coverage and visual evidence

Exercise degraded, scoped, mixed-source, preference, manual-update, and concurrency flows; run the full UI smoke suite and capture Settings, navigation, success, failure, and mobile evidence.

#### Step 3.5-final-fix — Inventory the new protected API routes

Add the workspace skills-update routes and additive workspace-config fields to the protected HTTP API inventory after the final unit gate identified the omission.

#### Step 3.6-final-fix — Stabilize full-suite browser fixtures

Align legacy browser fixtures with project-scoped routes, detached-checkout semantics, deterministic no-PR dry-run policy, and Streamdown's current token-variable contract; split commit-detail settling across navigation and lazy rendering.

#### Step 3.7-final-fix — Finish detached-HEAD and teardown stabilization

Treat a reported branch as current only when it exists in the rendered branch list, and wait for fixture servers to exit before deleting their temporary roots.

#### Step 3.8-final-fix — Wait for asynchronous branch settings state

Wait for the base-branch control's repository query to settle before asserting the Settings → Agents surface.

### Phase 4 — Confirmed post-update migration

#### Step 4.1 — Offer a confirmed upgrade-notes session after update

After a successful manual skills update, show a Yes/No dialog. Start a project-scoped run backed by `om-apply-upgrade-notes` only when the user confirms, navigate to the new session, retain the persistent reminder, and cover both confirmation paths with UI tests.

#### Step 4.2-final-fix — Prompt only when the update timestamp advances

Carry the pre-apply update timestamp with the mutation and open the confirmation dialog only when the response advances it, so a failed retry cannot reuse an older successful timestamp and claim fresh success.
