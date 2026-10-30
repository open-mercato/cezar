# Recent automation runs on the detail page (#1623)

## TLDR
Automation owners currently see one last run in the detail rail. Show the five most recent launched tasks inline, preserving Run now and View log, to inspect recent outcomes without leaving the editor. This is proposed behavior for issue #1623.

## Resolved assumptions (autonomous defaults)
| Question | Answer | Reason |
| --- | --- | --- |
| Five or ten rows? | Five | Compact within the existing editor rail; full history remains one click away. |
| Checks without tasks? | Exclude from this list | A task list needs a task link. Skips, failed launches and previews remain in View log. |
| Cost visibility? | Honor AUTOMATION_COST_VISIBLE | Existing owner policy currently hides automation costs; do not change a shared decision for this feature. |
| Missing task metadata? | Show a task-ID fallback and Status unavailable | Retained log entries can outlive their task; never invent a task state. |

The task order resolves the issue comment's product ambiguity in favor of the inline list. All choices are reversible UI defaults; no security, storage or API decisions change.

## Problem Statement
[Issue #1623](https://github.com/open-mercato/cezar/issues/1623) asks to see launched tasks from Automations → details. The existing LastRunCard shows only one outcome even after Run now has been used twice. View log already joins launch records to current run metadata; that existing contract covers this feature.

## Proposed Solution
Replace the detail editor's Last run card with Recent runs for every saved automation, including ones without launches. Read the existing bounded execution log, select records with runId, sort newest first by sequence, deduplicate by runId, then take five. A newer non-launch check must not hide older launches. Manual and catch-up launches count alongside GitHub and tracker launches.

A more visible View log alone would still require leaving the editor to compare recent outcomes. Repeating the entire log or its child-task hierarchy would overcrowd the rail, so those remain in the log.

## Architecture and API Contracts
- Add a recent-runs component and tests under packages/web/src/routes/automations; editor.tsx mounts it only for a saved automation.
- Reuse getAutomationLog and the existing [queryScope(), 'automation-log', automationId] cache key. The response is AutomationLogResponse from the shared contract: records plus runs metadata. No new route, type, storage, dependency, environment variable or migration.
- Follow AutomationLog's onWorkspaceEvent subscription and invalidate only the matching automation on automation-change. Clean up on unmount; no refetchInterval or additional connection. Refetch on normal query focus/reconnect policy.
- Read the existing useRuns cache through a selector limited to the five displayed tasks: shared SSE patches update title/status/cost without polling the log on token updates. The shell already uses this cache; log metadata remains the fallback when a task is absent or the run read fails.
- Reuse project-router Link for task links, StatusDot, statusLabel/statusTone, shortAge, usd, Card and Button. Add no global mechanism.
- Run now retains the saved definition and existing actions.runNow behavior, including paused schedules; View log retains its existing callback.

## UI/UX
The card title is a real heading, Recent runs. A semantic list has up to five rows, each with a keyboard-focusable task-title link (fallback Task <short id>), status dot plus text, relative launch age with the full timestamp available, and optional cost under the existing visibility policy. Long titles truncate visually with the full title available. Use existing token classes and focus styles, no raw colors. The rail stacks below the form on narrow screens.

Loading: Loading recent runs… inside the card, with actions retained. Empty: No runs launched yet. Error with no cached data: Could not load recent runs plus a Retry button; View log and Run now remain reachable. Error after cached data: retain rows and show a refresh warning with Retry. A permission rejection uses the same error path without disabling the editor. Missing run metadata still links to the retained run ID and says Status unavailable.

Run now is shown only when its action exists and is disabled while busy. View log is available for saved automations even with zero launches. New unsaved automations have no card and make no log request. Run links remain project-scoped. Child dispatch runs remain in the full execution log.

## Research
GitHub's [workflow-run history](https://docs.github.com/en/actions/how-tos/monitor-workflows/view-workflow-run-history) uses a recent run list with links to individual summaries and a bounded CLI limit. Adopt the small list-to-details pattern; omit workflow-specific filtering and job trees from this compact rail. The existing cezar log is the canonical local pattern for statuses, costs, task links and event refresh.

## Edge Cases and Failure Scenarios
- Repeated records for one task: show one row at its newest launch position.
- Many preview/no-match entries: filter before applying the five-task cap. The API still only retains/returns its bounded log window; this UI cannot recover launches outside that window.
- A task is removed: show its ID and unavailable state; retain link consistent with the full log.
- Workspace change for a different automation: do not invalidate this query.
- Open another automation: separate scope/id query key prevents cached rows leaking across detail pages.
- Network failure: show local retry state, leaving definition editing and existing actions functional.

## Risks and Impact Review
Low risk: an additive UI read and detail-card replacement. Existing log/task routes, save actions and launch mechanisms remain the source of truth. The existing global cost visibility flag stays unchanged. Rollback is a component import/mount change with no persistent state. Browser QA must cover the actions previously provided by LastRunCard, zero history, errors, long titles, light/dark and narrow layout. No release-line backport is proposed for a new feature.

## Implementation Plan
### Phase 1: Detail recent runs
1. Add the bounded recent-runs card using the existing log query and workspace invalidation; integrate into editor.tsx.
2. Add uniquely named recent-runs tests for multiple launch kinds, non-launch filtering, cap/dedup/order, metadata fallback, project links, empty/loading/error/retry, actions and event cleanup. Verify an editor-level test fails against the old editor.
### Phase 2: Verification and publication
3. Run the configured five-command gate, documenting any independently confirmed platform baseline failures. Review with om-auto-review-pr --autofix and exercise the real browser with om-auto-qa-pr. Publish an independent implementation PR with Closes #1623, link this design-only PR and leave it unassigned, ready and review-labelled with needs-qa.

