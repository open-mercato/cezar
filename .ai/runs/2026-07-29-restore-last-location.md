# Restore the Last Project Location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the exact last valid project-scoped cockpit URL when Cezar is
opened at the bare root, while preserving explicit deep links.

**Architecture:** Add a bounded `lastLocation` field to the existing workspace
UI-state contract. Pure web helpers validate locations against the live project
registry; the legacy root redirect consumes the saved value, and one root-level
controller persists settled project-scoped navigation through the existing
workspace UI-state API.

**Tech Stack:** TypeScript, React 19, React Router, TanStack Query, Hono, Zod,
Vitest, Testing Library.

Source doc: .ai/specs/2026-07-29-restore-last-location.md
Implementation PR: #729

## Global Constraints

- Restore remembered state only for the exact bare `/` URL with no query or hash.
- Explicit scoped and legacy deep links remain authoritative.
- Store state in `~/.cezar/ui-state.json` through the existing
  `GET/PUT /api/workspace/ui-state` contract.
- `projectId` is 1–64 characters; `pathname` is 1–2,048 characters and starts
  with `/p/`; `search` is optional, starts with `?`, and is at most 4,096
  characters; `hash` is optional, starts with `#`, and is at most 2,048
  characters.
- Record and restore only registered projects whose status is `ok` or `not-git`;
  never restore a `missing` project.
- When the registry is unavailable, only a saved location matching health's boot
  project may be restored.
- Workspace UI-state failures degrade quietly to the boot project's Tasks page.
- Do not add an endpoint, environment variable, configuration key, migration,
  poller, dependency, or visible UI control.
- Keep the API-client workspace Node-free.

## Scope

### In scope

- Typed and runtime-validated workspace UI-state.
- Pure location normalization and equality.
- Bare-root restoration with query/hash preservation.
- Debounced persistence with optimistic cache updates and cleanup flushing.
- Unit, route, API-boundary, and real-browser smoke coverage.

### Non-goals

- Restoring scroll position, transient form state, modal state, or global
  Settings.
- Overriding explicit URLs.
- Validating whether a formerly valid route still exists after an upgrade.
- Synchronizing navigation live between already-open browser tabs.

---

### Task 1: Workspace UI-State Contract

**Files:**

- Modify: `packages/api-client/src/dto/types.ts`
- Modify: `packages/cezar/src/server/server.ts`
- Test: `packages/cezar/src/server/workspace-api.test.ts`

**Interfaces:**

- Produces:

```ts
export interface WorkspaceLastLocation {
  projectId: string
  pathname: string
  search?: string
  hash?: string
}

export interface WorkspaceUiState {
  lastLocation?: WorkspaceLastLocation
  // existing fields remain unchanged
}
```

- The server schema accepts the same shape and rejects malformed known values
  instead of passing them through.

- [ ] **Step 1: Write the failing workspace API tests**

Add a valid round-trip case:

```ts
it('round-trips a bounded last project location', async () => {
  const lastLocation = {
    projectId: 'shop',
    pathname: '/p/shop/tasks/run-1/changes',
    search: '?file=src%2Findex.ts',
    hash: '#L12',
  }
  const response = await putUiState({ lastLocation })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ lastLocation })
  expect(rawUiState()).toMatchObject({ lastLocation })
})
```

Add table cases for an empty/65-character project id, unscoped pathname,
2,049-character pathname, search without `?`, 4,097-character search, hash
without `#`, 2,049-character hash, and non-string values. Each must return
`400` and leave the workspace UI-state file unwritten.

- [ ] **Step 2: Run the boundary test and verify it fails**

Run:

```bash
PATH=/Users/andrzejewsky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  npx vitest run --project server packages/cezar/src/server/workspace-api.test.ts
```

Expected: the valid payload currently passes only as an untyped passthrough and
the malformed known-key cases fail because they return `200`.

- [ ] **Step 3: Add the DTO and Zod schema**

Add `WorkspaceLastLocation` beside `WorkspaceUiState`. Add this known key to
`workspaceUiStateSchema`:

```ts
lastLocation: z
  .object({
    projectId: z.string().min(1).max(64),
    pathname: z.string().min(1).max(2_048).startsWith('/p/'),
    search: z.string().max(4_096).startsWith('?').optional(),
    hash: z.string().max(2_048).startsWith('#').optional(),
  })
  .strict()
  .optional(),
```

Keep the outer workspace schema `.passthrough()` and its existing shallow merge
behavior unchanged.

- [ ] **Step 4: Run the boundary and type checks**

Run:

```bash
PATH=/Users/andrzejewsky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  npx vitest run --project server packages/cezar/src/server/workspace-api.test.ts
PATH=/Users/andrzejewsky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/api-client/src/dto/types.ts \
  packages/cezar/src/server/server.ts \
  packages/cezar/src/server/workspace-api.test.ts
git commit -m "feat(workspace): validate the last project location"
```

### Task 2: Pure Location Semantics

**Files:**

- Create: `packages/web/src/lib/last-location.ts`
- Test: `packages/web/src/lib/last-location.test.ts`
- Reuse: `packages/web/src/lib/project-router.tsx`

**Interfaces:**

- Consumes: `WorkspaceLastLocation`, `ProjectsResponse`,
  `pathnameProjectId(pathname)`.
- Produces:

```ts
export type LocationParts = Pick<Location, 'pathname' | 'search' | 'hash'>

export function locationToSave(
  location: LocationParts,
  registry: ProjectsResponse | undefined,
): WorkspaceLastLocation | null

export function locationToRestore(
  value: unknown,
  registry: ProjectsResponse | undefined,
  bootProject: string | undefined,
): string | null

export function sameLastLocation(
  left: WorkspaceLastLocation | undefined,
  right: WorkspaceLastLocation,
): boolean
```

- [ ] **Step 1: Write failing pure-function tests**

Cover:

- a registered `ok` project path with query/hash normalizes exactly;
- empty search/hash are omitted;
- `not-git` is usable;
- unscoped, unknown, and `missing` projects return `null`;
- malformed persisted objects and project/path id mismatches return `null`;
- registry-unavailable restoration accepts only the boot project;
- equality treats absent optional fields and empty fields consistently.

Use complete `ProjectsResponse` fixtures so the tests encode the same registry
contract as the router.

- [ ] **Step 2: Run the pure tests and verify they fail**

Run:

```bash
PATH=/Users/andrzejewsky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  npx vitest run --project web packages/web/src/lib/last-location.test.ts
```

Expected: FAIL because `last-location.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

Implement runtime guards over `unknown`, use `pathnameProjectId` for decoded
prefix matching, and keep `locationToRestore` free of React, query, or network
dependencies. Return the concatenated `pathname + search + hash` only after all
checks pass.

- [ ] **Step 4: Run the pure tests**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit the helpers**

```bash
git add packages/web/src/lib/last-location.ts \
  packages/web/src/lib/last-location.test.ts
git commit -m "feat(web): normalize remembered project locations"
```

### Task 3: Bare-Root Restoration

**Files:**

- Modify: `packages/web/src/routes.tsx`
- Modify: `packages/web/src/routes.test.tsx`

**Interfaces:**

- Consumes: `locationToRestore`, `useWorkspaceUiState`, `useProjects`,
  `useHealth`.
- Produces: existing `LegacyPathRedirect` behavior plus bare-root restoration.

- [ ] **Step 1: Write failing route tests**

Extend the route harness so it can seed `workspaceQueryKeys.uiState`. Add tests
that prove:

- `/` restores `/p/other/tasks/run-1/changes?file=x#L2`;
- `/tasks/run-2?file=y#L3` still redirects to the boot project even when a
  different saved location exists;
- `/?shared=1#section` remains an explicit boot-project URL;
- malformed, unknown, and `missing` saved projects fall back to `/p/boot/`;
- `not-git` restores;
- registry failure restores a saved boot-project path but not a non-boot path;
- pending state keeps the existing quiet `scope-resolving` surface.

- [ ] **Step 2: Run route tests and verify they fail**

Run:

```bash
PATH=/Users/andrzejewsky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  npx vitest run --project web packages/web/src/routes.test.tsx
```

Expected: bare `/` still lands on `/p/boot/`.

- [ ] **Step 3: Implement restoration in the existing redirect**

Call all hooks unconditionally, but consult workspace state only when:

```ts
const isBareRoot =
  location.pathname === '/' && location.search === '' && location.hash === ''
```

For explicit legacy routes, preserve the existing immediate boot redirect.
For bare root, wait only while the required queries are pending; on query error
use the fallback rules from `locationToRestore`. Render one `<Navigate replace>`
to the restored URL or the existing boot fallback.

- [ ] **Step 4: Run route and web type checks**

Run the route command from Step 2, then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit restoration**

```bash
git add packages/web/src/routes.tsx packages/web/src/routes.test.tsx
git commit -m "feat(web): restore the last location from bare root"
```

### Task 4: Debounced Location Persistence

**Files:**

- Create: `packages/web/src/components/last-location-controller.tsx`
- Create: `packages/web/src/components/last-location-controller.test.tsx`
- Modify: `packages/web/src/app.tsx`

**Interfaces:**

- Consumes: `locationToSave`, `sameLastLocation`, `putWorkspaceUiState`,
  `workspaceQueryKeys.uiState`, `useProjects`, `useWorkspaceUiState`.
- Produces:

```ts
export const LAST_LOCATION_WRITE_DEBOUNCE_MS = 400
export function LastLocationController(): null
```

- [ ] **Step 1: Write failing controller tests**

Render the controller under `QueryClientProvider` and `MemoryRouter`, seed the
registry/UI-state cache, and use fake timers. Prove that:

- a valid scoped location optimistically updates the cache and PUTs after
  400 ms;
- query and hash are sent exactly;
- rapid scoped navigations produce one write for the settled final location;
- an unchanged location does not write;
- unscoped/global/unknown/missing-project locations do not write;
- unmount flushes the pending final write;
- a rejected PUT invalidates the workspace UI-state query without throwing or
  showing a toast.

- [ ] **Step 2: Run controller tests and verify they fail**

Run:

```bash
PATH=/Users/andrzejewsky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  npx vitest run --project web packages/web/src/components/last-location-controller.test.tsx
```

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement and mount the controller**

Mount `<LastLocationController />` inside `BrowserRouter` and outside routed
views so it survives navigation. Keep one timer and one pending value in refs.
On success, adopt the server's merged response unless a newer optimistic
location is already cached; on failure, invalidate quietly. Cleanup must clear
the timer and call the same `flush()` function once.

- [ ] **Step 4: Run controller, route, and app tests**

Run:

```bash
PATH=/Users/andrzejewsky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  npx vitest run --project web \
  packages/web/src/components/last-location-controller.test.tsx \
  packages/web/src/routes.test.tsx \
  packages/web/src/components/app-shell-container.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit persistence**

```bash
git add packages/web/src/app.tsx \
  packages/web/src/components/last-location-controller.tsx \
  packages/web/src/components/last-location-controller.test.tsx
git commit -m "feat(web): persist settled project navigation"
```

### Task 5: Full Verification and PR Completion

**Files:**

- Modify: `.ai/runs/2026-07-29-restore-last-location.md`
- Update PR #729 body, labels, and verification comments.

**Interfaces:**

- Consumes all prior tasks.
- Produces a ready PR with complete Progress, green validation, automated review,
  and browser evidence.

- [ ] **Step 1: Run the configured validation gate**

Use the bundled Node path for every Node/npm command and run, in order:

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Run outside the sandbox where sockets, subprocess sampling, packaging, and
browser storage require host capabilities. Fix any failure caused by this branch
and rerun the failed command plus all later commands.

- [ ] **Step 2: Run the UI smoke suite**

Run:

```bash
npm run test:e2e
```

Then manually open `/`, navigate to a non-boot project task sub-tab with query
and hash, reopen `/`, and verify the exact destination restores without a boot
screen flash. Capture evidence for PR #729.

- [ ] **Step 3: Run authoritative review and address findings**

Apply `om-auto-review-pr 729 --autofix`. Land fixes as new commits, rerun targeted
tests, and rerun the full gate if a fix crosses a single module/test boundary.

- [ ] **Step 4: Complete tracking and PR metadata**

Mark every Progress row complete with its commit SHA, set PR #729 to
`Status: complete`, change linkage to `Closes #715`, update the title/body from
design-only to implementation, apply `review`, `feature`, `needs-qa`,
`priority-medium`, and `risk-medium`, post the comprehensive run summary and UI
evidence, and keep the PR ready for review.

## Risks

- A pending-query condition can create a permanent loading screen; route tests
  cover pending, error, and resolved combinations.
- A malformed workspace file can bypass server PUT validation because reads are
  tolerant; pure runtime guards reject it before navigation.
- Concurrent UI-state writers can race; the controller writes only one top-level
  patch, debounces, preserves newer optimistic cache state, and accepts the
  existing workspace last-writer-wins policy.
- Startup restoration can pollute browser history; every startup hop uses
  `replace`.
- The Node 25 runtime exposed by the default shell has an incomplete global
  `localStorage`; all validation uses the supported bundled Node runtime
  (`v24.14.0`), under which the clean baseline is 4,758 passing tests.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a
> step lands. Do not rename step titles.

PR: #729

### Phase 1: State contract and pure semantics

- [x] 1.1 Add and validate the workspace last-location contract — 5095afc3
- [x] 1.2 Add pure save/restore/equality helpers — 938f8c99

### Phase 2: Route restoration and persistence

- [x] 2.1 Restore valid saved locations from the exact bare root — b136bda7
- [ ] 2.2 Persist settled valid project-scoped navigation

### Phase 3: Verification and hand-off

- [ ] 3.1 Complete the full validation and UI smoke gates
- [ ] 3.2 Complete automated review, evidence, and PR metadata
