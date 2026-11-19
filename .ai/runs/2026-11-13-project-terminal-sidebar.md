# Project terminal — a Terminal sidebar entry with a shell in the project root

Addresses PR #1526 (feat: project terminal). Written from scratch on our own design — the PR's
code was deliberately not read; only its title/description framed the goal.

## Goal

A project-level **Terminal** item in the sidebar (and ⌘K) that opens tabbed shells in the
project's root folder, independent of any task.

## Scope

- Server: project-scoped terminal routes under `/api/v1/terminal` (and `/api/v1/p/:projectId/terminal`),
  owned by `projectTerminalOwner(project.id)` (already reserved in `terminal/sessions.ts`), cwd = project root,
  same policy gate (`capabilities.terminal`) and cursor-over-HTTP transport as the task terminal.
  Project removal stops that project's shells.
- Contract: a `projectTerminalSessionParamsSchema` (`{ sessionId }`).
- Web: the drawer/pane/command picker take a *terminal scope* (task or project) instead of a bare `runId`;
  a new `/terminal` route renders the drawer full-height; a `Terminal` nav item gated on
  `capabilities.terminal`; page title entry.
- Docs: BACKWARD_COMPATIBILITY.md §2 inventory line.

## Non-goals

- Detected-URL strip / Browser column on the project page (there is no browser column there).
- Sharing tabs between the project page and any task drawer.
- Persisting project shells across a cezar restart.

## Implementation Plan

### Phase 1: Server + contract

1. Contract schema for project terminal session params.
2. Project terminal route family (state, create, output, input, resize, commands, delete) + kill on project removal.
3. Route tests (policy gate, cwd = root, isolation from task sessions, removal) + BC inventory.

### Phase 2: Cockpit

1. API client functions for the project terminal.
2. Terminal scope abstraction for drawer, pane and command picker (task scope unchanged in behavior).
3. `/terminal` route + nav item (gated on `capabilities.terminal`) + page title + ⌘K via `visibleNavItems`.
4. Web tests (nav gating, project terminal route).

## Risks

- Review (2026-11-13) found the task terminal routes matched a session by `:id` alone, so an encoded owner key reached a project shell; tightened to runs of this project (46f6fe586).

- `capabilities.terminal` defaults on locally, so a new nav item appears for every local user — intended.
- The task drawer is refactored to a scope; task behavior must be unchanged (existing tests guard it).

## Progress

PR: #2161

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server + contract

- [x] 1.1 Contract schema for project terminal session params — b8553ce4a
- [x] 1.2 Project terminal route family and kill on project removal — 03b260c6d
- [x] 1.3 Route tests and BC inventory — 52c85f1ed

### Phase 2: Cockpit

- [x] 2.1 API client functions for the project terminal — 35bc0512c
- [x] 2.2 Terminal scope abstraction for drawer, pane and command picker — cefd27f3c
- [x] 2.3 Terminal route, nav item, page title and palette entry — 02d4e7d30
- [x] 2.4 Web tests — 7c835fb34
