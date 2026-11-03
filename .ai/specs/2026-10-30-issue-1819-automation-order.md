# Automation list ordering

## TLDR

Automation owners need to keep frequently used definitions at a chosen position. The current list always follows `AutomationStore.list()`'s alphabetical order. Add a presentation-only Manual / Name / Next run choice and accessible manual placement, saved per project through the existing UI-state endpoint.

## Resolved assumptions (autonomous defaults)

- Q1: Share saved preferences when a cockpit opens or reloads the project, using existing project UI state. No live push; an already-open window may retain its view and its next edit wins, as existing UI preferences do. This meets the requested persistence without a new publisher or subscription.
- Q2: New/unplaced definitions precede hand-placed ones in name order; unknown saved IDs are ignored when displaying but retained until an explicit manual move saves the full live order. This avoids pruning on a stale fetch.
- Q3: Next run sorts valid scheduled times first, enabled continuous polls next, then paused/unavailable-time rows; ties use name and ID. Manual controls appear only in Manual mode.
- Q4: The shipped default remains Name. The three modes are alternate ways of presenting the same list, not independently deployable capabilities.

## Proposed Solution

Reuse project UI state and the existing dnd-kit sortable pattern. Keep the default alphabetical list and the scheduler's chronological execution unchanged.

## Architecture and Data Model

The list applies a pure ordering helper to a copy of `data.automations` before rendering the table. Calendar, Next runs rail, store and scheduler continue consuming their original input. Reuse `@dnd-kit/core` and `@dnd-kit/sortable` pointer/keyboard sensors; no new dependency.

Add optional `automationList` to the open project `uiStateSchema`: `{ sort?: 'manual' | 'name' | 'nextRun', order?: string[] }`, preserving unknown nested fields. Cap order at 200 IDs of 1–200 characters. Define this preference shape in `packages/contract` and reuse it in the existing server write validator. No migration, required setting, or new file. Missing preferences mean Name; malformed client data is normalized before rendering. Existing UI-state keys continue round-tripping.

## API Contracts

Use existing chained `GET/PUT /api/v1/ui-state` and project aliases. PUT shallow-merges top-level keys, so each write sends the complete current `automationList`, including unknown sibling fields. Nothing changes for clients that omit it; older servers preserve it through their open bag. Record the optional preference in `BACKWARD_COMPATIBILITY.md`.

The hook disables writes before the authoritative UI-state GET lands. Capture the project ID and cache key when each write is queued, serialize writes, update optimistically, and apply a response only if it is the newest write for that project. On error show the existing toast and refetch that project's truth. Switching projects cannot retarget an outstanding write or response.

## UI/UX

Show a compact labelled sort selector above the list. Manual mode adds a dedicated grip plus labelled Move up/down buttons; these controls remain available on narrow layouts, prevent row navigation, and disable at the first/last position. Drag uses pointer distance activation and keyboard Space/arrows/Space with cancellation. Changing sort never overwrites manual order. The row's existing navigation/actions retain their behavior. Empty/loading/error states stay usable; loading preferences never prevents reading the list.

## Edge Cases and Failure Scenarios

- A missing, duplicate or removed ID cannot hide or duplicate a live automation. New rows appear deterministically. Explicit movement persists the current complete visible sequence, capped at the documented limit; over-cap lists remain fully visible, and reordering is disabled with an explanation rather than pretending the tail can be persisted.
- Invalid or absent Next run times sort deterministically. Computing the sort and displayed time uses one helper so they agree. Pausing, renaming or receiving fresh list data does not erase the saved manual positions.
- Two windows use existing last-write-wins preference semantics; no scheduler behavior follows these preferences. A failed save restores server truth and reports the failure.

## Risks and Impact Review

This adds an optional project preference to an already open persisted/API bag. It preserves old input/output and zero-config behavior, so it is additive under `BACKWARD_COMPATIBILITY.md` §§2–3. Resetting the sort to Name restores the old presentation. No execution priority, network exposure, process, flag, dependency or automation definition changes.

## Research

GitHub Projects distinguishes saved view sorting/reordering ([view documentation](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/managing-your-views)); cezar needs only one saved list preference, not named views. dnd-kit's [sortable guidance](https://dndkit.com/legacy/presets/sortable/overview/) uses the existing sortable keyboard coordinate getter; reuse the repository's implementation and add explicit Move buttons for discoverability.

## Implementation Plan

### Phase 1: Preference and ordering rules

1. Add optional, bounded list preferences to the existing contract and route validator.
2. Define deterministic display ordering and bounded manual placement.

### Phase 2: List interaction

3. Persist a sort selector and accessible drag/move controls through the existing project-scoped cache.
4. Cover default/order/ties/absent IDs, drag and move interaction, persisted sort/order, failed saves, rapid writes and project switching. Pin unchanged calendar/scheduler inputs. Exercise desktop and narrow layouts in a real browser, then run the configured validation gate, code review and browser QA.
