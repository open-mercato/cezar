# GitHub list: scroll-driven paging

## Goal

The GitHub tab's issue/PR list renders only the first ~13 rows followed by a long blank gap and a
"Load more" button. Make the list render rows as the user scrolls and fetch the next page
automatically near the end, with no button — and nothing at all when there is nothing more to load.

## Root cause

`github.tsx` hands `virtua`'s `Virtualizer` the app shell's `[data-slot="main"]` as its scroll
element, but inside `IssueBrowserLayout` the element that actually scrolls is the
`[data-slot="gh-list"]` pane. `main` never scrolls, so the virtualizer never sees a scroll event:
it keeps the initial window mounted and reserves the full list height as empty space. Unit tests
did not catch it because test mode bypasses the virtualizer.

## Scope

- `packages/web/src/routes/github/github.tsx` — scroll owner fix; replace the button with an
  IntersectionObserver sentinel; no paging while a search/label filter is active.
- `packages/web/src/routes/github/github.test.tsx` — paging coverage.

## Non-goals

- Server paging, page size, the cross-state forge search, the tracker tab.

## Risks

- A list pane that does not actually overflow would make the sentinel always visible; the pane is
  `overflow-y-auto` with a bounded height in `IssueBrowserLayout`, and a fetch only fires once per
  page (the observer re-arms after each page lands).

## Implementation Plan

### Phase 1: Fix and replace paging control

- 1.1 Virtualize against the list pane and auto-load the next page on scroll

## Progress

PR: #1374

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix and replace paging control

- [x] 1.1 Virtualize against the list pane and auto-load the next page on scroll — a3541e48, 454e5e33
