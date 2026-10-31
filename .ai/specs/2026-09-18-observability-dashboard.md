# Workspace observability dashboard

Status: implemented. This document describes the final behavior; cost/trend semantics and
exports are specified in [Usage, trends and export](2026-09-19-dashboard-costs.md).

## TLDR

A read-only workspace dashboard turns retained task state into actionable queues, outcomes
and source-qualified summaries. This document owns layout, attention, automations and live
update behavior; the companion owns usage calculations, trend cohorts and export formats.

## Problem statement

Users need to identify tasks requiring their input across projects and inspect recent outcomes
without opening every project. Activity and task completion are operational signals, not
proof of accepted business value.

## Proposed solution and scope

A workspace-level `/dashboard` helps users find work requiring attention, inspect current
agent activity and review recent outcomes. It reads registered projects plus the boot project
without requiring registration or creating contexts merely to display historical data.
This is an operational view of retained task state, not an immutable audit log.

Two URL-addressable views separate the questions users ask:
- Overview (default): current attention/running counts, finish-date outcomes, median cycle
  time, Needs you, Recent results & GitHub, Queue & scheduling, Automations and a project comparison table.
  Legacy `?view=operations` opens Overview. CPU/RSS live under collapsed Technical details;
  the telemetry snapshot request is enabled only while those details are expanded.
- Usage & cost (`?view=costs`): Usage & cost and Trends.

Existing saved visibility and full module order are preserved, with each view displaying
only its relevant modules. All modules, including Overview summary and Projects, support
pointer/keyboard drag and drop with persisted order. Summary and Projects stay visible;
Customize lists optional modules for the current view. The eight-module default is Overview,
Needs you, Recent results, Queue & scheduling, Automations, Projects, Usage, Trends.
Adjacent compact modules form pairs; an unpaired module fills its row. The legacy default without Automations
upgrades to this layout; complete saved orders always retain their relative order, including
an intentional move of Automations to the end. Other incomplete orders add missing modules.
Restore-all and reset-order apply only to the current view, preserving the other view's
visibility and order. Cards use existing theme and responsive layout conventions; task links open
the corresponding project thread.

## Overview outcomes

The 7/30-calendar-day selector applies to completed/failed outcomes, including today at the
browser's current fixed UTC offset. Running/Needs you remain current, non-archived counts.
Outcomes include archived tasks and subtasks, select the latest done/failed state by finishedAt,
and exclude scheduled retries. These counts are not attempt history or business acceptance.

Median cycle time uses completed tasks with valid nonnegative finishedAt minus startedAt,
falling back to createdAt only when startedAt is absent. The valid-timing denominator is
shown; no timings means unavailable. Project rows sort by Needs you, then running count.
Unavailable projects show unavailable rather than zero. Coverage and refresh errors qualify
summary claims; no overall system-health score is inferred.

Count buttons and project cells open 20-row task pages from the exact source snapshot used
by the counter. Expiry offers Refresh overview. The overview endpoint projects only task
identity, title, state and timestamps; it neither requests nor exposes cost data. Portfolio
and outcomes are exported only while Overview is visible. Separate live/feed cards retain
their own update timing, so the page is not a simultaneous workspace transaction.

## Queue & scheduling and attention

Non-archived tasks, including subtasks, are counted by current status:
- Running: running; Monitoring is the running subset with activity monitoring.
- Needs you: waiting plus review, counting tasks rather than individual questions.
- Queued: queued.
- Scheduled: failed with autoResumeAt; not all future automations.

Count buttons open the appropriate task list. The Needs you card separates Questions and
Reviews, initially sharing six slots, with independent paging. Groups sort oldest created
first. A complete connected empty queue says no input is needed; partial/unavailable sources
must never produce an unconditional all-clear.

CPU and RSS sum existing fresh process-tree samples for running tasks owned by this server.
CPU may exceed 100%; RSS is summed resident memory, not unique system memory. Coverage shows
measured tasks/running tasks; missing samples are unavailable, never zero. The existing
sampler runs around every 2s, samples expire after 10s and disconnect suppresses live values.

## Recent results

Last 7 × 24 hours, newest first. Task results are done/failed tasks with finishedAt in the window
and no scheduled retry; one latest result per task, including archived tasks. GitHub items
represent issue/PR creation for discovered repositories, not all GitHub activity or proof
of agent authorship. Repository aliases are deduplicated. Source failures preserve cached
results with explicit freshness/availability. GitHub rows removed from the current source or
window disappear immediately from the screen and exports; new rows/reordering remain staged.
Initial 6 rows, Show more in bounded batches,
maximum 60 combined results; upstream/display truncation is disclosed.

GitHub is discovered from project remotes and read through the existing forge-driver seam
(`resolveForge` in `packages/cezar/src/server/forge/index.ts`) — the same host allowlist every
other forge-aware feature gates on, so a remote that merely parses but is not a known forge host
(a self-hosted git server, GitLab today) is treated exactly like "no remote", never surfaced as a
GitHub failure. Adding another forge (GitLab, self-hosted) is one new driver behind that seam;
this widget requires no route or UI change as long as the driver implements `recentCreated`
(optional on `ForgeDriver`, since not every forge need support a creation feed).
A project without a remote is not an error; initial loading is separate from a failed fetch.
Source details use repository/project names and distinguish issues from pull requests.
When every discovered source lacks a remote, the default All view presents task results only.
No sources are connected or configured by this widget.
Dashboard Git identity discovery supports repositories before their first commit through an
explicit read-only option; default shared Git probing preserves task-isolation behavior.
Detached GitHub rows are removed before comparing staged ordering, so their disappearance
does not advertise updates merely because surviving rows shifted indices.

## Automations

The optional Overview widget reads GET /workspace/dashboard/automations?projectId=… across
visible registered projects and the boot fallback, with at most two reads in flight. This workspace
projection reads existing definition/runtime files without opening project contexts or stores,
running recovery, probing GitHub, or arming timers. It returns only names, kinds, enabled flags,
stored deadlines, failure/backoff state and the server time zone; prompts are excluded. Missing
files mean empty state; corrupt/unreadable files or a missing root are explicit read failures. Hidden/unmounted widgets stop
their demand and event subscription. The existing automation-change event invalidates the
snapshot; the local relative-time clock does not poll the server. This is read-only: it never
enables, executes or modifies an automation.

Enabled definitions sort by their next server-provided deadline, with unknown deadlines last.
The first three appear initially; Show all reveals the remainder. Schedules say Next run;
GitHub polls say Next check and explain that a task launches only on a matching event. A future
backoff delays the shown deadline; absent dates remain unavailable and past dates say
Due — awaiting scheduler. Exact times use the server's time zone. Stored failure counts
qualify recent checks; the widget does not infer current GitHub availability. Missing/error projects mark counts as partial; capability-off and no enabled
definitions have distinct empty states. Links open the existing scoped automation details/lists.

## Interaction and persistence

- View, outcome period, All/Tasks/GitHub feed filter and operational panel use URL parameters.
- Overview alone owns the Running/Needs you counters. Both open a task Sheet; Needs you uses the existing live queue even when its widget is visible;
  Queue & scheduling adds only Queued/Scheduled, monitoring context and technical details.
- Snapshot Sheets return keyboard focus to the trigger and use 44px close targets. Initial loading and fetch failures, including Retry, appear inside the Sheet so recovery does not require closing it.
- Task rows use shared attention labels/status dots and relative dates with exact localized
  timestamps on demand. Calculation caveats live in How these metrics work and stay in exports.
- Drag announcements use widget names and positions among visible widgets.
- Insertions/reordering stage behind Updates — Show while current status/actionability is
  reconciled immediately. Removed/resolved rows cannot retain an obsolete action.
  Bounded lists cannot erase a known transition for an absent identity. Fresh task-feed
  and cost captures reconcile positively returned statuses; saved pages cannot roll back
  newer events or authoritative confirmations. Feed filters retain keyboard focus;
  outcome pagination keeps navigation mounted and focuses the loaded page summary.
  Operational error and connection notices appear only while that source is needed.
- Back restores entry-local loaded counts, scroll and focus, bounded to 20 route entries.
  Restoration must work on direct Usage entries and with operational widgets hidden, without
  enabling queries for those hidden widgets.
- Customize checkboxes control visibility. Show all in [view] appears only when an optional tile in that view is hidden.
- Module handles support pointer/keyboard reordering. Reset order appears only for a
  nondefault order within the active view; reset changes only that view's order, not visibility.
- Visibility/order save through workspace UI state, shared across browsers of that workspace.
  Unknown preference keys and widget identifiers survive; failure leaves the local layout usable with Retry saving.
- All-hidden Costs offers Show all tiles. Overview retains its movable summary and
  portfolio. Hiding a module or leaving its view removes its view-specific reads.

## Architecture and implementation boundaries

Contracts live in `packages/contract/src/dashboard.ts`; routes are chained in
`packages/cezar/src/server/dashboard.ts`, mounted at `/api/v1/workspace/dashboard` with
`/tasks`, `/telemetry`, `/feed`, `/overview` and `/costs`. Query validation uses route middleware.
`workspace/dashboard.ts` owns demand-driven projections and bounded 60s snapshots; data comes
from live RunStore or diagnostic index reads. Missing/unreadable records are exposed through
coverage rather than repaired as a side effect of reading. Cold reads preserve recorded
running/queued/waiting states and never synthesize failures or finish dates. Such records
carry partial coverage because this server cannot verify their current live state.

The React route is `packages/web/src/routes/dashboard/index.tsx`. Existing global events
reconcile live changes. The 15-second foreground-only fallback applies to mounted local task
summaries, local feed and usage/trend queries: registered projects read from disk can change
without an event from this process. SSE reconnect alone cannot cover an unowned project
changing while the socket stays
healthy. Hidden modules/views stop their queries; background tabs do not poll. GitHub has no
periodic polling (only explicit demand and one bounded follow-up for initial loading);
manual refresh remains available once a request completes, even if sources are still loading.
Repository probe failures, including remote enumeration failures, retain the last known cached source as stale; a successful probe
that changes or removes a remote detaches the old source identity.
Automations use their existing change event and reconnect reconciliation, with no interval.
Telemetry reuses the existing sampler. No new daemon, socket, required configuration or
external export service is introduced.

## Verification

Maintain contract/route parity, cold-index/boot-project coverage, source failures, immutable
paging, current-action reconciliation, reconnect, layout persistence and export privacy tests.
The latest cleanup gate is recorded in [verification](../runs/dashboard/verification.md).

## Shared widget presentation

Peer widget titles use 14px semibold headings. Overview and Usage share label/icon-first KPI
composition and subtle gradients; actionable Overview tiles explicitly say View tasks.
Operational panels remain neutral. Queue & scheduling uses a compact desktop column; Projects
aligns numeric columns right. GitHub status is expanded for actual errors; source details remain available in a disclosure.
The explanation disclosures preserve report semantics and remain included in exports.

## Compatibility

Protected surfaces: BACKWARD_COMPATIBILITY.md §2 (new workspace routes and optional workspace
usage-event fields) and §9 (optional preferences in existing ui-state.json). No new project
state file (§3), health capability, runtime dependency or event name is introduced.
Unknown stored widget IDs are preserved but not rendered, including on visibility changes,
drag and reset; input allows at most 200 unknown IDs plus one slot per supported widget, each 1–64 characters. Read tolerance
does not make malformed writes valid. Compatibility with earlier local layouts is not evidence
of a released historical format; Operations URL fallback remains useful for local bookmarks.

## Acceptance criteria

- Current counts and snapshot detail pages agree; expiration offers explicit recovery.
- Missing/unavailable sources cannot produce an unconditional all-clear or measured zero.
- Dashboard reads do not start agents, register projects or enable automations.
- Known widget order/visibility persists while unknown preference keys and IDs survive writes.
- Reconnect refreshes active projections; hidden modules stop their demand.
- Workspace telemetry additions preserve legacy scoped SSE payloads.
- Keyboard reorder, task navigation and Sheet focus restoration remain usable.

## Open questions

None blocking this implemented scope. Accounting-grade spend, accepted business outcomes
and a complete historical event ledger remain explicit non-goals, not implied capabilities.
