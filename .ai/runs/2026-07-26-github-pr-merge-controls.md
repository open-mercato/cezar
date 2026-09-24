# GitHub PR merge controls

## Overview

Add scannable requirement status icons to the GitHub pull-request merge box and an explicit, confirmed path for authorized users to ask GitHub to merge without waiting for non-hard requirements.

## Scope

- Show success, failure, pending, and unknown icons for reviews, conflicts, and checks.
- Add an opt-in override control only when cezar's normal merge eligibility is blocked by requirements that GitHub may allow an authorized user to bypass.
- Carry the override intent through the validated HTTP API while preserving exact-head, method, PR-state, draft, and conflict safeguards.
- Cover normalization, API validation/behavior, and UI confirmation with regression tests.

## Non-goals

- Do not bypass merge conflicts, stale-head protection, disabled merge methods, closed/merged PRs, or draft status.
- Do not change GitHub repository rules, permissions, or branch protection.
- Do not add automatic merging or delete branches.

## Implementation Plan

### Phase 1: Merge policy contract

- Extend the additive merge-state and mutation contracts with explicit override eligibility and intent.
- Preserve hard blockers server-side while delegating authorized requirement bypasses to GitHub.
- Add server normalization and API regression tests.

### Phase 2: Visual merge controls

- Render accessible status icons for reviews, conflicts, and individual checks.
- Add a clearly labeled override checkbox and strengthened confirmation copy for blocked-but-overridable PRs.
- Add component tests for visual statuses, normal merge, and override payloads.

### Phase 3: Verification

- Run targeted type and test checks, inspect the final diff for scope, and complete the configured validation gate.
- Run code review and compatibility/security checks, then prepare the tracked PR and QA handoff.

## Risks

- An override affordance could imply permissions cezar cannot know; copy must make clear GitHub still authorizes and may refuse the merge.
- Over-broad bypass logic could weaken conflict or stale-head safeguards; these remain unconditional server-side gates with tests.
- UI status icons must include text or accessible labels so color is never the sole signal.

## Progress

PR: #686

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Merge policy contract

- [x] 1.1 Extend merge contracts and classify overridable requirements — 21a27c92
- [x] 1.2 Enforce hard merge safeguards and test override behavior — 21a27c92

### Phase 2: Visual merge controls

- [x] 2.1 Add accessible requirement status icons — f22b5472
- [x] 2.2 Add explicit override selection, confirmation, and component tests — f22b5472

### Phase 3: Verification

- [x] 3.1 Run targeted and full validation gates — f22b5472
- [x] 3.2 Complete self-review, PR review, and QA handoff — 2196e90f
