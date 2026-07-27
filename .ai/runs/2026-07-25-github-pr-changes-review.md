# GitHub PR changes review implementation

## Overview

Goal: implement the read-only, bounded GitHub pull-request Changes view described by the design-only spec in PR #658.

Source doc: .ai/specs/2026-07-25-github-pr-changes-review.md

The source document is read from `origin/pr-658` for this run and intentionally is not committed here.

## Scope

- Extend the forge seam and GitHub driver with structured, bounded PR file changes.
- Add a project-scoped, route-parity-preserving PR changes API with validation, caching, dry-run data, and graceful degradation.
- Add Conversation/Changes navigation and a responsive, accessible changes-review view reusing the existing diff facade.
- Add server, UI, route, and browser coverage for the new read-only workflow.

## Non-goals

- PR merge support or any implementation from the separate merge specification.
- Inline comments, suggestions, reviews, approval/request-changes actions, or persistent viewed state.
- Non-GitHub forge implementations.
- Changes to existing run/repository diff API contracts.

## Implementation Plan

### Phase 1: Server contract

1. Add normalized forge PR-change schemas/types and GitHub driver behavior for pagination, caps, dry-run, schema failures, and graceful degradation.
2. Add head-SHA-aware caching and the project-scoped PR changes route with validation, parity, isolation, and compatibility tests.

### Phase 2: Cockpit view

1. Add API client/query support, PR-only inner navigation, and deep-link routing.
2. Build the responsive Changes view with file navigation, structured patches, completeness states, guarded fallback, refresh behavior, and unit coverage.
3. Extend browser coverage for navigation, keyboard/responsive behavior, and the dry-run review workflow.

### Phase 3: Verification and review

1. Run targeted checks, the complete configured validation gate, and the real-browser GitHub suite.
2. Run `om-code-review`, compatibility/security review, and address all actionable findings.
3. Open the implementation PR, run `om-auto-review-pr` in autofix mode, and finalize labels and reviewer-facing evidence.

## Risks

- Patch payload size and rendering cost are bounded at the forge boundary and mitigated by lazy loading and collapsible files.
- GitHub schema or CLI failures must remain HTTP 200 unavailable responses except for confirmed missing PRs.
- Project cache keys must include repository identity so one project cannot observe another project's data.
- The source spec is design-only in PR #658 and must not enter this implementation branch.

## Progress

PR: #659

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server contract

- [x] 1.1 Add normalized forge PR-change schemas/types and GitHub driver behavior — d74470f
- [x] 1.2 Add caching and the project-scoped PR changes route — d74470f

### Phase 2: Cockpit view

- [x] 2.1 Add client/query support, PR-only navigation, and deep-link routing — c63dc07
- [x] 2.2 Build the responsive Changes view and unit coverage — c63dc07
- [x] 2.3 Extend real-browser coverage — da309ae

### Phase 3: Verification and review

- [x] 3.1 Run the complete validation and browser gates — ab79c589
- [x] Browser note: the new PR Changes E2E passes in full and focused runs; the full suite also reported unrelated existing workflow-picker timeouts and a subsequent test-server socket closure
- [x] 3.2 Run self-review and address findings — ab79c589
- [x] Post-review fix: bound GitHub pagination before normalization and add direct boundary tests — ab79c589
- [x] 3.3 Complete PR review/autofix and final handoff — c7b85dff
- [x] Post-review fix: merge the latest base and preserve scoped Changes-route coverage — c7b85dff
