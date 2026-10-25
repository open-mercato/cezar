# Resizable file tree on the Changes views

## Goal

Let the user drag the border between the Changes file tree and the diff to widen the tree, so long file names can be read in full.

## Scope

- A drag/keyboard splitter on the tree column of the task Changes and Files tabs (`routes/task-git/task-changes.tsx`) and the repo Changes view (`routes/repo-git/repo-changes.tsx`), which share `ChangesTree`.
- Browser-local, persisted width (`localStorage`, like the sidebar width in #788); untouched it keeps today's responsive defaults (`w-60` / `lg:w-72` / `@4xl:w-72`). Double-click resets.

### Non-goals

- The repo Files browser (`repo-files.tsx`) — a different, sticky layout (follow-up if wanted).
- The mobile layout (the tree is hidden below `md`).

## Implementation Plan

### Phase 1: Splitter

- 1.1 Pure width helper `lib/tree-pane-width.ts` (clamp, read/write/clear storage) with tests.
- 1.2 `TreePaneResizeHandle` + `useTreePaneWidth` store, wired into both Changes views and the task Files tab, with component tests.

## Risks

- The tree pane is the scroller other tests and e2e address by `data-slot="changes-tree-pane"`; the handle is a sibling, not a child, so the pane's classes and parent stay as they are.

## Progress

PR: #1650

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Splitter

- [x] 1.1 Pure width helper with tests — 5a8c0d3e3
- [x] 1.2 Resize handle wired into both Changes views — 63f2632b4
