# Collapsible subtasks in the task lists (accordion)

Engine: om-auto-create-pr (steps: 8, --loop: no)

## Goal

Dispatched subtask rows in the task lists collapse under their parent like an accordion: collapsed
by default, one click on the parent's subtask chip expands them, another collapses them again.
(User brief, in Polish: "Potrzebuję móc zwinąć i rozwinąć subtaski … defaultowo zwinięte i po
prostu mogę sobie kliknąć i je rozwinąć.")

## Scope

- `packages/web/src/lib/task-tree.ts` — the one place the nesting rule lives grows the one place
  the collapse rule lives: `flattenTaskTree`/`taskTreeRows` accept an optional `isExpanded`
  predicate; a node with children whose id the predicate rejects keeps its row but drops its
  subtree from the flat render list.
- `packages/web/src/routes/tasks-overview.tsx` — per-project table + card stack: expanded-ids
  state (default: none), the `subtask-count` chip becomes the accordion toggle (button, chevron,
  `aria-expanded`), and an active search query force-expands everything so a matching child can
  never hide under a collapsed parent.
- `packages/web/src/routes/global-tasks.tsx` — cross-project list: same state at page level
  (survives regrouping), same chip-toggle on `TaskRow`, same force-expand while a query is active.
- Tests: `task-tree.test.ts`, `tasks-overview.test.tsx`, plus global-tasks table coverage.

## Non-goals

- The sidebar quick-list (`task-quick-list.tsx`) keeps painting children expanded: it is the
  attention surface, its buckets already split parent and child by state, and hiding a working
  child there would hide the very thing the sidebar exists to show.
- No persistence of expanded ids across reloads/navigation — "collapsed by default" is the brief.
- No change to the `subtaskLabel` semantics (direct children, counted).

## Implementation Plan

### Phase 1: collapse rule in the tree lib

- 1.1 Add the optional `isExpanded` predicate to `flattenTaskTree` and `taskTreeRows`; collapsed
  nodes keep their own row (with `childCount`/`descendantCount` intact) and omit their subtree.
- 1.2 Unit tests in `task-tree.test.ts`: collapsed root hides the whole subtree, expanded parent
  with collapsed inner parent hides only the inner subtree, absent predicate keeps today's output.

### Phase 2: per-project table and cards

- 2.1 `TasksOverview` holds `expandedSubtasks` state, defaults empty, derives rows through the
  predicate, force-expands while the search query is non-empty; toggle handler threads to both
  layouts.
- 2.2 The `subtask-count` chip in `TitleCell` and `TaskCard` becomes a toggle button with a
  rotating chevron and `aria-expanded`; row/card click-through must not fire on it.
- 2.3 Tests: children hidden by default, chip click reveals and re-hides them, search shows a
  nested match, chip is a button with correct `aria-expanded`.

### Phase 3: cross-project list

- 3.1 `GlobalTasksPage` holds the same expanded-ids state above its group tables; `TaskTable` and
  `TaskRow` thread it; chip toggle identical to Phase 2; query force-expands.
- 3.2 Tests for the global table's collapse/expand behavior.

## Risks

- Existing tests assert always-visible nested rows and will be updated deliberately, not blindly.
- A collapsed parent hides a child's unread dot/status until expanded — accepted for now; the
  parent still wears its own status and the chip says how many rows are folded.

## Progress

PR: #1110

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: collapse rule in the tree lib

- [x] 1.1 `isExpanded` predicate in `flattenTaskTree`/`taskTreeRows` — e5d22e53
- [x] 1.2 task-tree unit tests for collapsed subtrees — e5d22e53

### Phase 2: per-project table and cards

- [x] 2.1 expanded-ids state + query force-expand in `TasksOverview` — e73f7179
- [x] 2.2 subtask chip becomes the accordion toggle in `TitleCell` and `TaskCard` — e73f7179
- [x] 2.3 tasks-overview tests for default-collapsed and toggling — e73f7179

### Phase 3: cross-project list

- [x] 3.1 expanded-ids state + chip toggle threaded through `TaskTable`/`TaskRow` — de6101f1
- [x] 3.2 global-tasks tests for collapse/expand — de6101f1
