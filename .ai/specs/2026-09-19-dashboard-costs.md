# Dashboard usage, trends and export

Status: implemented. Companion to the [workspace dashboard](2026-09-18-observability-dashboard.md).

## TLDR

Expose reported retained-task usage and export the visible dashboard faithfully. This document
owns usage/cohort calculations and CSV/PDF behavior; layout, preferences and refresh policy
are owned by the workspace dashboard specification.

## Problem statement

Users need to compare reported consumption and share an interpretable snapshot without
mistaking incomplete reporting for zero spend or task completion for business acceptance.

## Proposed solution: reported usage

Usage & cost sums retained tasks across the workspace, including archived tasks and subtasks.
Deleted tasks disappear. Input/output token counters are authoritative persisted directional
usage, never the legacy weighted tokensUsed counter. USD is backend-reported cost, not a
price-list estimate or invoice. Task-level cost may itself be partially reported across steps.
An explicit reported zero is retained; missing, negative or nonfinite measures are unavailable.
A zero aggregate does not establish final cost completeness: dispatch conservatively retains
a settled child’s reservation for zero or missing cost, preserving its pre-dashboard budget behavior.
N of M tasks and its coverage bar mean report availability, not full billing completeness.

Tasks created selects All time, Last 7 days or Last 30 days. Selection and sorting persist in
`usagePeriod` and `usageSort` URL parameters, independently of Overview and Trends. Bounded periods use calendar days
including today, ending at the snapshot time. Day boundaries use the browser's CURRENT fixed
UTC offset for the whole period; historic DST transitions are not reconstructed. A task's
lifetime usage belongs to its creation cohort, not the dates on which spending occurred.
This is not a daily-spend ledger or ROI/productivity measure.

Top 5 projects are ranked by the selected visible metric, unknown values last. Bar length is
relative to the largest project, not its share of total spend. Project/View tasks opens a
paged Sheet (20 per request) with task links and sorting. No implicit global 200-task limit.

## Trends

Independent 7/30-day selector stored in `trendPeriod`, with the same calendar boundaries. Daily usage sums tasks
created that day. Completion counts use finishedAt independently, including tasks created
before the selected period, with status done and a valid finish timestamp.

Cycle time is finishedAt minus startedAt, falling back to createdAt only when startedAt is
absent. Invalid/negative durations are excluded, not clamped into valid measurements.
Completion counts remain intact. cycleReportedTasks supplies the valid-duration denominator;
mean/median use those durations, and the overall mean weights days by that denominator.

Unavailable differs from measured zero in labels/table/CSV. Named focusable bars expose date,
metric/value and coverage; a collapsed View data table disclosure offers a non-hover alternative, with a bounded
scroll region on screen and full expansion in print. Visual
fill height is separate from the interaction target. The PDF preserves charts and expands
this table. Dates use shared relative freshness with localized exact timestamps on demand;
durations use minutes/hours/days, with mean and median still explicitly distinguished. One amount formatter preserves tiny positive USD across cards, table and summary.

## Snapshots and visibility

`packages/contract/src/dashboard-costs.ts` is the shape authority; do not duplicate API types.
`workspace/dashboard-costs.ts` owns full-cohort capture, grouping, totals and pagination.
Keep max 3 snapshots for 60s, retaining the original period and offset. Remove snapshots when
referenced projects/rows disappear (including the independent completion cohort). Explicit
snapshot expiry returns 409; detail queries recover by capturing a fresh snapshot using the
original response tzOffsetMinutes. Older responses without that optional field fall back to
the browser offset rather than silently switching to UTC. Saved snapshot coverage can become
more restrictive when sources fail, but recovery cannot upgrade its completeness without
a fresh capture: the original rows remain fixed. Task Sheets open the displayed accepted cohort, not an unaccepted background update.
Subsequent refreshes remain candidates behind the Sheet’s update control. Changing the Sheet sort keeps the accepted cohort, including when an expired cohort needs explicit replacement. Period and sort controls retain keyboard focus when results change. Task Sheets restore
keyboard focus to the button or project row that opened them. Detail Sheets also qualify nonempty results with their own accepted source coverage,
including after snapshot-expiry recovery. New source failures are shown immediately;
recovery does not clear an accepted warning before the replacement is accepted.

Runtime cost/token visibility applies to summary, projects, rows and series, including cached
snapshots. Optional cost fields on operational task snapshots, pages and feed rows are
also filtered at response time, without mutating the stored snapshot. Cost cards retain an accepted
snapshot together with its source coverage and invalid-date qualifications, and offer newer data
explicitly. New source failures are shown separately; successful recovery does not remove warnings
from the displayed snapshot before acceptance. Pending updates and source timestamps survive export. Trends
refresh independently, so do not imply all cards share a simultaneous observation.

Complete zero-task cohorts show compact empty copy instead of metric cards, rankings and charts;
exports retain the empty-state explanation and scope, without hidden numeric rows. Partial reads
and existing tasks without usage reports remain explicitly qualified. Trends remain populated when
older tasks completed in the period even if no tasks were created in that period.

## Export

Export captures only the active Overview or Usage & cost view. Overview adds
current workload, finish-date outcomes and project metrics; it does not add cost rows.
Export captures visible modules in current order, selected filters and loaded rows, including
rows below scroll. Hidden metrics/modules are excluded; export does not fetch more history or
include task Sheets. This is a dashboard snapshot, not a full selected-scope business report.

PDF report opens native printing/Save as PDF. Optional title, internal-distribution label,
summary, per-metric filter/asOf context and source warnings precede module detail. Controls are
removed, including action-only KPI captions; disclosures become static report headings and
charts/expanded tables remain. Current-state summary counters retain their own scope rather
than inheriting outcome-period filters. Print keeps individual rows and bounded short modules
together, without forcing long tables onto a single page. Browser-supported print margins
supply pagination.
The print document only reuses local styles and contains no task prompts, logs or code.

CSV is UTF-8 BOM, quoted comma-separated long-format data: one metric per row plus module
context. Columns: generated_at, source, module, filters, section, entity, metric, value, unit,
availability, reported_tasks, total_tasks, as_of, notes. Raw numeric precision and missing/zero
distinction survive; textual spreadsheet formulas are escaped. Task rows contain title/status/
creation date; GitHub rows contain identifier/title/time/URL. Automations export the loaded
enabled count and displayed names plus next run/check timestamps (unavailable remains blank).
Context notes omit table cells and controls and do not repeat nested paragraphs. No full-history XLSX or accounting
ledger has been implemented.

## Validation

Guard finish-vs-creation cohorts, calendar boundaries, original snapshot offset, UTC+14,
invalid durations, missing-vs-zero, hidden metrics after refresh, immutable paging and deletion.
Check screen/CSV/PDF precision and freshness, named chart targets, mobile layout and Customize
visibility/order. Latest gate: [verification](../runs/dashboard/verification.md).

## Compatibility

The additive cost routes belong to BACKWARD_COMPATIBILITY.md §2. This feature adds no
credential file, health capability or runtime dependency. Shared dashboard preferences are
covered by §9 and specified in the companion document. CSV column names and missing/zero
semantics are deliberate output contracts; changes should be reviewed as consumer-facing.

## Acceptance criteria

- Creation-cohort usage and finish-cohort completions remain explicitly distinct.
- Missing/hidden amounts never become measured zero or reappear in exports.
- Snapshot paging keeps its original period and offset and recovers explicitly from expiry.
- PDF/CSV capture visible modules, selected filters, loaded rows and source warnings only.
- CSV preserves raw numeric precision and escapes textual spreadsheet formulas.
- PDF removes controls, expands data tables and remains readable across page boundaries.

## Open questions

None blocking the current dashboard snapshot exports. Full-history accounting, invoice
reconciliation, budget forecasting and acceptance-based ROI require separate requirements
and data; they are not promised by these metrics.
