# Per-project Tasks quick and selected-row actions

## TLDR

Proposed: users managing task history can archive/restore and mark tasks read/unread directly on the per-project Tasks page, individually or as a selected set. Today only pin/rename and all-or-nothing header actions are available (issue #1599).

## Resolved assumptions (autonomous defaults)

| Question | Decision | Rationale |
| --- | --- | --- |
| Q1: Actions/screens? | Per-project Tasks only; Archive/Restore and mark read/unread. | Task order explicitly resolves the issue comment's scope questions; no destructive actions. |
| Q2: Mixed/hidden rows? | Report eligible, skipped and failed counts; select only displayed tree rows, prune hidden selections. | Never silently operate on hidden tasks or claim a partial operation fully succeeded. |
| Q3: Split specs? | Keep row and selection actions together as one history-management capability. | Same eligibility, API calls, feedback and responsive row controls; no separate public mechanism. |

## Proposed Solution

Reuse current scoped API calls and eligibility, with accessible row checkboxes and a selection toolbar shared by desktop rows and mobile cards.

## Problem Statement

Issue #1599 describes archiving specific tasks requiring opening each thread. The current per-project table has pin/rename, Archive finished and Mark all read but no selected subset operations. Its All Tasks counterpart already implements row Archive/Restore and read/unread; that screen remains outside this change.

## Architecture and API Contracts

Change `packages/web/src/routes/tasks-overview.tsx` and issue-specific action/selection helpers and tests. Reuse `archiveProjectRun(projectId, id, archived, 'tasks_table')` and `setProjectRunRead(projectId, id, read)` with the original project pinned for the batch, `writePatchedRunToCaches`, authoritative runs invalidation and existing `Button` styles. No schema, API, persisted state, setting, dependency or global UI change. Archive eligibility follows existing done/failed/cancelled status rules; restoring already archived rows remains allowed. Read-state eligibility is exactly `canBeUnread`, with current state from `isUnread`.

## UI/UX

Prototype: .ai/specs/assets/issue-1599-tasks-actions/proposed.html (illustrative static; running-app evidence on implementation PR #1843).

Each displayed desktop row and mobile card gets a labelled native checkbox plus eligible quick action buttons. Controls must not navigate to the thread. A page-level Select displayed tasks checkbox includes filtered, expanded rows across the virtualized list, excluding collapsed children. Its indeterminate state reflects partial selection. Selection changes stay local to the page; changing project remounts the page, changing view/search/facets or collapsing children prunes hidden ids, sorting retains visible selections. No shift-range selection in this delivery: checkboxes and select-all cover the requested subset without another interaction model.

The selected-count toolbar offers Archive (Active) or Restore (Archived), Mark read, Mark unread, and Clear selection. Action labels show eligible counts; zero-eligible actions are disabled. A status region explains that ineligible selected rows are skipped, including running/review tasks for archive and cancelled, archived, scheduled-resume or awaiting-answer rows for read state. Existing all-row header actions remain unchanged. Controls work with keyboard and touch, preserve title links, responsive layout and light/dark themes.

## Edge Cases & Failure Scenarios

Use bounded sequential requests to avoid a request burst. Snapshot eligible selected rows when an action starts, lock row/selection actions until it ends, and refresh eligibility from current records on invocation. Successful responses patch caches and finally invalidate run queries. One rejected request does not stop the rest: status states success/skipped/failure counts and failed task titles; failed selected rows remain retryable. Do not clear successful selections blindly on a later filter/project change. Project navigation must not redirect an in-flight batch to a different project's scoped endpoint; pin the mutation scope for the batch or stop before another request after unmount. This is reversible task metadata: restoring and changing read state use existing inverse operations.

## Research

[GitHub Projects archive/restore guidance](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/archiving-items-from-your-project) uses selecting table items and a selected-items Restore action. Adopt visible subset selection and reversible archive/restore; defer range shortcuts and destructive delete. This is precedent, not evidence of cezar demand; #1599 is the demand evidence.

## Risks & Impact Review

Primary risks are accidental hidden-row actions, treating a mixed selection as fully eligible, duplicate submissions and stale project scope. Explicit visible selection, canonical deciders, pending locks and scoped request lifetime cover them. Large lists retain current virtualization and row memoization. Existing all-row actions, API shapes, data formats and default behavior remain intact. Rollback removes only the new UI; prior metadata still parses. No backport: this is a new feature for main.

## Implementation Plan

Phase 1: scoped actions and selection.
1. Add canonical eligibility and bounded execution helpers, with partial-failure behavior.
2. Wire accessible selection and row/bulk controls to the existing route/cache, preserving virtualization and mobile navigation.

Phase 2: verification and handoff.
3. Add React interaction tests for subset/mixed eligibility, pending/error states, responsive controls, hidden selection and API/cache behavior; prove a key regression red against the old route.
4. Run the configured gate, review/autofix, then real-browser desktop/mobile QA and publish evidence. Record platform baseline failures honestly; final Linux CI must independently pass before claiming a full green gate.

