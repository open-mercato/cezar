# Sidebar PR/issue links follow the active project

Goal: the sidebar's task chips (Current tasks + quick list) link to the repository of the project the sidebar shows, not the boot project's.

Root cause: the shell chrome renders outside `ProjectScopeProvider` (routes.tsx), so `useProjectScope().projectId` is always null there. The sidebar lists runs for `useActiveProjectId()` (pathname-derived, e.g. DentalOS), but `useProjectRepoBase()` and `useReferenceProjectId()` read only the context and fall back to the boot project — a chip for DentalOS PR #159 is synthesized as `open-mercato/cezar/pull/159` and its status is read from cezar's #159.

Scope: `useProjectRepoBase` / `useReferenceProjectId` accept an explicit project id; `CurrentTasksContainer` and `TaskQuickListContainer` pass `useActiveProjectId()`. Unit tests.

Non-goals: server changes; other surfaces already inside the scope provider.

Risks: none beyond the sidebar; hooks keep their old behavior when called without an argument.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix

- [ ] 1.1 Let the repo-base and reference-project hooks take an explicit project id
- [ ] 1.2 Sidebar containers pass the active project; regression tests
