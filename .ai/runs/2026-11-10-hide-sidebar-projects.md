# Hide projects from the sidebar (#1985)

Source doc: GitHub issue #1985 (and its comment thread — the reporter accepted the proposed defaults).

## Goal

Let a user hide a registered project from the multi-project sidebar without unregistering it, and unhide it from a collapsed "Hidden (n)" section.

## Scope

- `sidebar.hiddenProjects` in workspace ui-state (`packages/contract/src/workspace.ts`), bounded on write like `projectOrder`.
- Sidebar (`packages/web/src/components/project-groups.tsx`): a per-row "Hide from sidebar" control, hidden projects filtered out of the list, a collapsed "Hidden (n)" disclosure at the bottom listing them with Unhide and their needs-you badge.
- One sidebar write path (`use-project-order.ts`) so order and visibility writes cannot race each other.

## Non-goals

- No pin / "show only pinned" view.
- Dashboard, global Tasks, project switcher and ⌘K palette are unchanged (hidden projects stay there).
- No registry change: hiding never unregisters a project or touches its runs.

## Implementation Plan

### Phase 1: Contract

- 1.1 Add `sidebar.hiddenProjects` to the read and write ui-state schemas, with a server round-trip test.

### Phase 2: Cockpit

- 2.1 Visibility in the sidebar controller: `hidden`, `setHidden(id, hidden)` sharing the order's serialized write.
- 2.2 Sidebar UI: hide control per row, filtered list, "Hidden (n)" section with Unhide and attention badge; tests.

## Risks

- A hidden project needing input must stay visible: the Hidden header carries the summed needs-you badge, and the dashboard's workspace-wide "Needs you" is unchanged.

## Progress

PR: #2048

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contract

- [x] 1.1 Add sidebar.hiddenProjects to the ui-state schemas — e545192b3

### Phase 2: Cockpit

- [x] 2.1 Visibility in the sidebar controller — d0d402524
- [x] 2.2 Sidebar UI and tests — cc53abdee
