# Execution plan — folded sidebar becomes an icon rail with a project header

## Goal

When the desktop sidebar is folded (⌘B or the fold button) — or a view holds the Focus rail —
the cockpit keeps its navigation: an icon rail with the cezar mark (no name) on top, a white `+`
New task button, and one icon per project area (Tasks, Git, GitHub, Assets, Automations, Skills,
Workflows, Settings, plus the gated Inbox/Tracker), and the main column gains a header naming the
selected project with a dropdown to switch projects.

## Scope

- `packages/web/src/components/app-shell.tsx` — one `SidebarIconRail` shared by the user fold and
  the Focus rail (they were two components: a bare unfold button and an icon list); a desktop-only
  `ProjectHeader` in row 1 of the main column while railed.
- `packages/web/src/components/app-shell-container.tsx` — feed the header the registry's projects
  and the active one.
- Tests in `app-shell.test.tsx`.

## Non-goals

- The expanded sidebar, the mobile drawer and top bar, and the settings frame are unchanged.
- No new routes, API, or persisted state; the fold key `cez-sidebar-folded` is reused.

## Implementation Plan

### Phase 1: Icon rail + project header

1.1 Replace `SidebarRail` usage and `FocusSidebarRail` with one `SidebarIconRail`.
1.2 Add the project header (name + project dropdown) shown while the rail is up.
1.3 Tests for both.

## Risks

- `data-slot` names (`sidebar-rail`, `focus-sidebar-rail`, `sidebar-unfold`) are kept so tests and
  e2e still address the rail.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Icon rail + project header

- [ ] 1.1 Unify the folded and Focus rails into one icon rail
- [ ] 1.2 Project header with a project dropdown while railed
- [ ] 1.3 Tests
