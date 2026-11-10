# Execution plan — project name in the task header (#2002)

Goal: with two or more registered projects, the task header reads `<Project> / <Title>`, the project linking to its Tasks overview.

Scope: `packages/web` only. Non-goals: document title, sidebar, #1967 rail header, ⌘P palette, API/contract/state.

## Implementation Plan

### Phase 1: Shared name rule + crumb
- Extract the shell's project-name rule into `lib/active-project-name.ts` (`activeProjectName`, `useActiveProject`); the shell's document title reads it.
- Render `ProjectCrumb` (`data-slot="run-project"`) first in `run-identity`: multi-project only, `max-w-[16ch] truncate` + `title`, hidden below `md` (#765).
- Tests in `run-header.test.tsx`: non-boot name + link, boot fallback, rail-folded, single-project absent, phone hiding.

Risks: low — presentation-only; the header reads two queries already warm in the shell.

## Progress

PR: #2049

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Shared name rule + crumb

- [x] 1.1 Shared active-project name helper — b7bfa977a
- [x] 1.2 Project crumb in the run header with tests — b7bfa977a, 563edd466
