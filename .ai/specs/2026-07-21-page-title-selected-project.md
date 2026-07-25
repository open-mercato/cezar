# Project-aware browser page titles

## TLDR

Update the cockpit's single browser-document title writer so every hydrated route identifies the active project and page while retaining `cezar` as the product suffix and pre-hydration fallback. Use the workspace registry name as the authoritative project label, derive static page labels from the project-relative route map, and use an already loaded run title for task-detail routes without ever exposing raw ids or loading placeholders.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Rationale | Confirm? |
|---|----------|-----------------|-----------|----------|
| Q1 | What should a global page with no selected project show? | `${pageLabel} · cezar` | It preserves useful page context while avoiding a guessed project and follows the existing honesty rule. | ok |
| Q2 | Should task subtabs add `Changes`, `Files`, or `Commits` after the task title? | Use the task title alone for every `/tasks/:id/*` route. | The task is the meaningful tab-strip discriminator; omitting subtab text keeps titles compact and avoids expanding the route-label contract. | ok |

## Problem Statement

The static SPA shell title remains `cezar` after hydration, so multiple tabs for different projects or cockpit pages are indistinguishable. The merged multi-project workspace makes the selected project a URL fact and exposes authoritative registry display names, but no runtime seam currently combines that state with route context.

## Proposed Solution

Add a pure title formatter plus a thin React effect hook, add a pure project-relative route-label resolver beside the route table, and call the hook exactly once from `AppShellContainer`. Resolve the active project from the URL-aware project-router helper and registry, fall back to the health repo basename only when registry truth is unavailable, and derive task-detail labels from the shared run-list cache once it has answered.

The static `<title>cezar</title>` in `web/app/index.html` remains the pre-hydration value. The build-hint document in `src/server/static-ui.ts` is a separate non-SPA surface and does not change.

## Research and Alternatives

- The browser-native `document.title` property is sufficient and broadly supported; adding a head-management dependency would create a second abstraction for one string assignment.
- Accessible title guidance recommends a concise, unique page purpose followed by site identity. The proposed format keeps the selected project first because distinguishing several cezar project tabs is the primary use case, then adds page context and the stable product suffix.
- React Router supports route metadata through `handle`/`useMatches` in data-router mode, but this cockpit uses declarative `<BrowserRouter><Routes>` routing. Migrating router modes solely for titles would be disproportionate. A pure ordered pattern table beside `AppRoutes` keeps the metadata adjacent to the route source without changing router architecture.
- Scattered route-level effects were rejected because navigation could briefly expose stale or competing titles. `AppShellContainer` remains the only writer.

References:

- [MDN: Document title](https://developer.mozilla.org/en-US/docs/Web/API/Document/title)
- [MDN: title accessibility guidance](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/title#accessibility)
- [React Router: route handles](https://reactrouter.com/how-to/using-handle)

## Architecture

### Title primitive

Add `web/app/src/lib/use-document-title.ts` with:

```ts
export interface DocumentTitleParts {
  projectName: string | null
  pageLabel: string | null
}

export function documentTitleOf(parts: DocumentTitleParts): string
export function useDocumentTitle(parts: DocumentTitleParts): void
```

`documentTitleOf` treats null, undefined-at-the-call-site, and empty/whitespace-only strings as absent and returns:

| Project | Page | Result |
|---------|------|--------|
| present | present | `${projectName} — ${pageLabel} · cezar` |
| present | absent | `${projectName} · cezar` |
| absent | present | `${pageLabel} · cezar` |
| absent | absent | `cezar` |

`useDocumentTitle` is a thin `useEffect` that assigns the pure result to `document.title` whenever either input changes. It does not restore an intermediate value in effect cleanup: dependency changes must move directly from the old truthful title to the new truthful title without a transient `cezar` write. The app-lifetime owner is `AppShellContainer`.

### Route metadata

Keep a static ordered route-label table next to `AppRoutes` in `web/app/src/routes.tsx`. Export pure helpers that first call `stripProjectPrefix(pathname)` and then match the project-relative route:

| Pattern | Page label |
|---------|------------|
| `/` | `Tasks` |
| `/new` | `New task` |
| `/compare/:groupId` | `Compare` |
| `/git/*` | `Git` |
| `/github/*` | `GitHub` |
| `/skills` | `Skills` |
| `/inbox` | `Inbox` |
| `/workflows/*` | `Workflows` |
| `/settings/*` and `/settings/global/*` | `Settings` |

Task routes are the one dynamic exception: `/tasks/:id` and every `/tasks/:id/*` child expose the decoded `id` only as a lookup key and return the loaded task title as the page label. Until that title is available, the page label is null. Unknown/not-found routes also return null. Neither case renders a raw identifier, `undefined`, `loading…`, nor a guessed label.

The route helper returns enough structured context for the shell to know whether it needs a task lookup, rather than making a second ad-hoc pathname parser in `AppShellContainer`.

### Project and task resolution

`AppShellContainer` already owns `useHealth()` and `useProjects()`. It additionally reads the URL-aware active project id through `useActiveProjectId()`; this is required because the shell sits above `ProjectScopeProvider`, and the boot project intentionally mounts an unscoped API context even though its URL still carries `/p/:projectId`.

Project-name precedence is:

1. The `useProjects()` registry entry whose id matches the active URL project id.
2. The health repo basename from `repoChipOf(health.data)` only when health confirms that the active id is the boot project. This is a safe loading/error fallback for the boot project; it must not label a non-boot project with the boot repo's basename.
3. Null when the route has no project scope (for example `/settings/global/*`), the selected registry entry is unavailable, or no truthful fallback exists.

For task routes, read the active project's run list through the existing explicit-project query seam (`useProjectRuns`), enabled only when a task id exists and the loaded registry identifies the active project. Waiting for that registry fact avoids choosing the wrong boot/non-boot cache key during startup. Pass the boot-project flag so the query shares the same `default`-scoped cache as the boot route; non-boot projects share their project-scoped list cache. Resolve the display value with the canonical `runTitle(run)` helper. React Query deduplicates this subscription with existing list consumers, and SSE/cache updates make task renames update the document title without introducing a second task-title definition.

Finally, call `useDocumentTitle({ projectName, pageLabel })` once in `AppShellContainer`, before rendering the shell.

## Data Model

No persisted data, migrations, configuration, or API response changes. The implementation reads existing `ProjectsResponse`, `HealthResponse`, and run-list data.

## API Contracts

No new endpoints or changes to existing request/response shapes. The registry remains the authority for project display names. Existing `/api/projects`, `/api/health`, and project-scoped run-list queries retain their current error and caching behavior.

## UI/UX

- Before hydration, the tab reads `cezar` exactly as today.
- A scoped tasks page reads, for example, `cezar — Tasks · cezar` when the registered project is named `cezar`.
- A scoped task page reads, for example, `cezar — Implement page titles · cezar` after the run list answers; before that it reads `cezar · cezar` rather than exposing the run id or a loading word.
- A global settings page reads `Settings · cezar` because no project is selected.
- A project registry rename updates the title on the next authoritative query result; navigation between projects or pages updates the existing title writer rather than mounting another writer.
- No visible in-page layout changes are introduced. Static mockups and viewport screenshots are not useful for a browser-tab metadata change; implementation QA should verify the browser-reported title across routes instead.

## Edge Cases and Failure Scenarios

- `/api/projects` pending or failed: show a project name only for the confirmed boot project via the health repo fallback; never show the boot name on a non-boot URL.
- Health pending, unreachable, or `repo: null`: omit the fallback. Page-only context may still render (for example `Settings · cezar`); otherwise use `cezar`.
- Unknown project or route: do not guess a project/page label. The existing routed error surface remains responsible for its visible explanation.
- Legacy flat URL during redirect: retain `cezar` or page-only truth until the boot-project scoped URL is known; the redirect's next render supplies the project label.
- Empty registry names or labels: normalize them as absent so the title never contains blank separators.
- Task deleted, missing, or not loaded: omit the page label and never expose the id.
- Task or project renamed: subscribed query data recomputes the title; no boot-time value is cached locally.
- React StrictMode/effect replay: assignments are idempotent and have no external cleanup resource.

## Risks and Impact Review

- **Risk: route table drift.** A new route could omit title metadata. Keep the ordered label table adjacent to `AppRoutes` and cover every current route family with pure table tests.
- **Risk: wrong project during registry loading.** Restrict the repo-basename fallback to the health-confirmed boot project.
- **Risk: extra task-list traffic or a startup cache-key flip.** Enable the explicit project run-list subscription only on task routes after the registry identifies the project, and reuse its existing query keys so established consumers deduplicate the request.
- **Risk: title flicker/staleness.** Keep one effect writer, derive values from live queries, and do not reset the title during effect cleanup.
- **Compatibility:** no protected API, CLI, state, workflow, environment, or packaging surface changes. The static `web/app/index.html` title and `src/server/static-ui.ts` stay unchanged.
- **Rollback:** remove the hook call and helper modules/tests; the static `cezar` title immediately becomes the only title again. No state rollback is needed.

## Phasing

The feature is one independently deployable UI capability delivered in two small phases: establish the pure title/route contracts, then wire live project/task data into the single shell owner.

## Implementation Plan

### Phase 1: Pure title and route contracts

1. Add `web/app/src/lib/use-document-title.ts` with `documentTitleOf` and the thin `useDocumentTitle` effect. Add table-driven unit coverage for both parts, project-only, page-only, neither, empty strings, and dependency updates.
2. Add the static route-label metadata and pure route-context resolver beside `AppRoutes`. Cover scoped and unscoped paths, every current route family, dynamic task ids, global settings, and unknown routes without mounting the application.

### Phase 2: Live shell integration

1. In `AppShellContainer`, resolve the active URL project, authoritative registry name, safe boot fallback, and task title from the explicit-project run-list cache; call `useDocumentTitle` once.
2. Extend `app-shell-container.test.tsx` to verify scoped project, boot project, global/page-only behavior, `repo: null`, registry-name changes with no stale title, task-title loading/rename behavior, and navigation between representative pages. Keep `web/app/index.html` and `src/server/static-ui.ts` unchanged.
3. Run the repository validation gate in order, then exercise representative boot/non-boot project routes and a task rename in the browser. Record the observed `document.title`; viewport screenshots are optional because browser tab chrome is outside the captured app surface.
