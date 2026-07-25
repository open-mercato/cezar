# Execution plan: project-aware browser page titles

Source doc: .ai/specs/2026-07-21-page-title-selected-project.md

## Goal

Make the hydrated cockpit browser title identify the selected project and current page or task, using one truthful, live writer while retaining `cezar` as the pre-hydration and no-context fallback.

## Scope

- Add a pure title formatter and thin React effect hook.
- Add a route-adjacent, project-prefix-agnostic page-title context resolver.
- Resolve authoritative project names and loaded task titles in `AppShellContainer` using existing registry, health, router, and query primitives.
- Add focused unit and shell-integration coverage for formatting, routing, loading/fallback states, navigation, and live updates.

## Non-goals

- Changing the static SPA or build-hint HTML titles.
- Adding title badges, unread counts, favicon changes, new APIs, persisted state, or dependencies.
- Showing raw project/task ids or task-subtab suffixes.

## Risks

- Route metadata can drift from `AppRoutes`; table-driven coverage must enumerate every current route family.
- The boot repo basename must never label a non-boot project during registry loading.
- Task title lookup must reuse the correct boot/non-boot run-list cache and avoid a startup cache-key flip.

## Implementation Plan

### Phase 1: Pure title and route contracts

1. Add the document-title formatter/effect and its table-driven unit tests.
2. Add the route title-context resolver beside `AppRoutes` and cover scoped, nested, dynamic-task, global, and unknown paths.

### Phase 2: Live shell integration

1. Wire active project and task/page data into the single `AppShellContainer` title writer.
2. Extend shell tests for scoped, boot, global, no-repo, navigation, and live project/task title updates.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

PR: #592

### Phase 1: Pure title and route contracts

- [x] 1.1 Add the document-title formatter/effect and its table-driven unit tests — 4a7b5de
- [x] 1.2 Add the route title-context resolver beside AppRoutes and cover current route families — b7018ad

### Phase 2: Live shell integration

- [x] 2.1 Wire active project and task/page data into the single AppShellContainer title writer — 368b0af
- [x] 2.2 Extend shell tests for scoped, boot, global, no-repo, navigation, and live updates — 901f649
