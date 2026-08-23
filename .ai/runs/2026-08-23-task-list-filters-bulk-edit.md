# Execution plan — project Tasks list: status filter, reference search, multi-select bulk edit

**Date:** 2026-08-23
**Slug:** `task-list-filters-bulk-edit`
**Branch:** `feat/task-list-filters-bulk-edit`
**Engine:** `om-auto-create-pr (steps: 12, --loop: no)`

## 🎯 Goal

The per-project Tasks list (`/p/:projectId/`, `packages/web/src/routes/tasks-overview.tsx`) can only
be narrowed by the Active/Archived tabs and a free-text box that searches title, branch and
workflow. Three things are missing and all three were asked for: filtering by **status**, finding a
task by its **PR or issue number**, and **selecting rows to edit them together** (archive being the
motivating case). The global cross-project page (`/tasks`) already has facet filters; the project
page — the one people actually live in — does not.

This run brings the project Tasks list up to that bar: a status facet filter with live counts,
reference-number search, and a selection column plus a bulk action bar that can archive, restore,
and mark read/unread any number of selected tasks at once.

## Scope

- `packages/web/src/lib/tasks-table.ts` — the pure filter half: reference-aware search, the
  status-facet model (options, counts, active-filter count).
- `packages/web/src/lib/task-selection.ts` (new) — the pure selection half: toggling, select-all,
  pruning a selection to what is still visible, and which bulk actions a selection supports.
- `packages/web/src/routes/tasks-overview.tsx` — the filter bar, the checkbox column, the bulk
  action bar, and the route-level mutations that fan the bulk action out per run.
- Unit tests beside each of the above (`*.test.ts` / `*.test.tsx`), the repo's convention.

### Non-goals

- **No server or contract change.** Every action already has an endpoint
  (`POST /runs/:id/archive`, `/read`, `/unread`); a bulk action fans out client-side over the
  selected ids. A dedicated batch route would be a contract change for a local server answering
  a handful of requests — not worth it, and reversible if it ever is.
- **No URL-persisted filter state** on this page. The global page keeps its filters in the URL
  because a cross-project view is a thing people share; the project list's existing search is
  local component state and stays that way, so the route's test surface and props do not change
  shape. Revisit if the filters grow.
- **No workflow / branch / tag facets.** Status is what was asked for; more facets are one entry
  each in the same bar once they are wanted.
- **No bulk delete or bulk cancel.** Both are destructive in a way archive is not, and neither
  was asked for.
- The sidebar quick-list and the global `/tasks` page are untouched.

## Implementation Plan

### Phase 1 — the pure filter model

Extend `lib/tasks-table.ts`, which is already "the pure half of the Tasks table", rather than
inventing a second module the component would have to consult separately.

1.1 Teach the search box PR and issue numbers: `#909`, `909`, `pr 909`, `issue 42` all match the
    references `taskReferences()` resolves for a run. Numeric-only needles must not start matching
    random digits inside a title — the reference match is an *additional* haystack, not a
    replacement.
1.2 Add the status-facet model: a `TaskListFilters` shape (`{ query, statuses }`), a
    `filterTaskList()` that ANDs the facet with the search, `statusFacetOptions()` producing
    options with counts computed against the list as the *other* narrowings leave it (the same
    rule the global page's counts follow), and `activeFilterCount()` for the Clear affordance.

### Phase 2 — the pure selection model

2.1 New `lib/task-selection.ts`: `toggleSelected`, `selectAll`/`clearSelection`,
    `pruneSelection` (a selection must never keep ids that scrolled out of the view or got
    archived under it), `selectionState` for the header checkbox's three states, and
    `bulkActionsFor(selectedRuns)` deciding which of archive / restore / mark-read / mark-unread
    apply and to how many rows.

### Phase 3 — the filter bar on the Tasks table

3.1 Render a Status `FacetFilter` (the existing shared component) in the Tasks header, wire it to
    local state beside the existing `query`, and add a Clear control that resets both.
3.2 Update the empty state so "no tasks match" is reported when a *facet* narrowed the list to
    nothing, not only when a search string did, and update the search box's placeholder/aria to
    say numbers are searchable.
3.3 Tests for the bar: filtering by status, combined status + text, counts, clear, empty state.

### Phase 4 — selection and the bulk action bar

4.1 A selection column: a header checkbox (all / none / indeterminate) and a per-row checkbox on
    the desktop table, plus the same affordance on the `<md` cards so mobile is not left behind.
    Row-click navigation must not fire when the click lands on the checkbox.
4.2 The bulk action bar: appears only with a selection, names the count, offers Archive, Restore,
    Mark read, Mark unread — each disabled when no selected row can take it — and a Clear.
4.3 Route wiring: one mutation that fans the chosen action out over the selected ids with
    `Promise.allSettled`, invalidates the runs query once, and reports partial failure honestly in
    a toast rather than silently dropping it.
4.4 Tests: selection mechanics, select-all over the filtered view, action gating, the fan-out
    (including a partial failure), and that navigation is not hijacked.

### Phase 5 — validation and reporting

5.1 Full `validation.commands` gate: `npm run typecheck`, `npm test`, `npm run test:unit`,
    `npm run build`, `npm run test:package`.
5.2 `om-auto-review-pr --autofix`, then the summary comment.

## Risks

- **Row-click hijacking.** The table row navigates on click and already excludes
  `a, button, input`; a checkbox is an `input`, so it is covered — but the card list's guard only
  excludes `a`, and that one must be widened or the first tap on a card checkbox would navigate
  away. Covered by a test.
- **A stale selection.** Ids selected before a filter change, an archive, or an SSE patch can
  reference rows that are no longer on screen; acting on them would archive something the user
  cannot see. `pruneSelection` against the visible list is the guard, and it is tested.
- **Partial bulk failure.** N independent requests can fail independently. The fan-out reports
  "3 of 5 archived" rather than a blanket success or a blanket error toast.
- **Search widening.** Matching numbers must not make unrelated rows appear; the reference
  haystack is limited to the references the row's own chip resolves.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: The pure filter model

- [x] 1.1 Reference-number search in `filterRuns` — 97a5ecb6
- [x] 1.2 Status-facet model (`TaskListFilters`, `filterTaskList`, `statusFacetOptions`, `activeFilterCount`) — 97a5ecb6

### Phase 2: The pure selection model

- [x] 2.1 `lib/task-selection.ts` with toggling, pruning, header state and action gating — 557126a1

### Phase 3: The filter bar on the Tasks table

- [ ] 3.1 Status facet + Clear in the Tasks header
- [ ] 3.2 Filter-aware empty state and reference-aware search affordance
- [ ] 3.3 Filter-bar tests

### Phase 4: Selection and the bulk action bar

- [ ] 4.1 Selection column on the table and the mobile cards
- [ ] 4.2 Bulk action bar (archive / restore / mark read / mark unread)
- [ ] 4.3 Route-level bulk mutation fan-out with honest partial-failure reporting
- [ ] 4.4 Selection and bulk-action tests

### Phase 5: Validation

- [ ] 5.1 Full validation gate green
- [ ] 5.2 `om-auto-review-pr --autofix` clean
