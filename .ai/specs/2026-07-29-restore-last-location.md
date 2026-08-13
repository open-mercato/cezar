# Restore the Last Project Location

> **Superseded on storage (2026-08-04):** the remembered location moved from
> `~/.cezar/ui-state.json` to the browser's own `localStorage`
> (`packages/web/src/lib/last-location.ts`, key `cez-last-location`). The rejected
> alternative below — "localStorage would give each browser a different answer" —
> turned out to be the requirement, not the objection: a workspace-wide value let
> whichever client navigated last decide where every *other* client's next launch
> landed, so opening the cockpit on a phone moved the desktop. Everything else in
> this spec still holds — the same validation against the live registry, the same
> exact-bare-root-only restore, the same deep-link precedence and `replace`
> semantics — minus the debounce, the write-ordering guard, and the wait on the
> UI-state read, none of which a synchronous local write needs. The server keeps
> accepting the `lastLocation` key for older cockpits.

## 📝 TLDR

Cezar remembers the last valid project-scoped cockpit location in the existing
workspace UI-state file and restores it when the cockpit starts at the bare root
URL. Explicit deep links remain authoritative, so bookmarks and shared URLs never
get replaced by remembered state.

## 📝 Problem Statement

The cockpit already gives every project and task view a durable URL, so an
ordinary browser refresh preserves context. Some hosts reopen the cockpit at `/`,
however, which currently redirects to the boot project's Tasks page and loses the
project, task, sub-tab, query, and fragment the user was working in.

## 📝 Proposed Solution

Persist the most recent valid `/p/:projectId/...` location in
`~/.cezar/ui-state.json`. On the bare `/` entry only, restore that location when
its project remains registered and usable; otherwise keep the existing boot
project Tasks fallback.

This follows the same durable-serialized-state pattern recommended for host-owned
webviews by [Visual Studio Code's Webview API][vscode-webview-state], while keeping
the URL as the authoritative navigation contract. Restoration uses a replace
navigation, matching [React Router's documented replace semantics][react-router-replace],
so startup does not leave the transient `/` entry in browser history.

Alternatives considered:

- Browser `localStorage` would restore synchronously, but would give each browser
  a different answer and bypass Cezar's established workspace preference store.
- Inferring the destination from project `lastOpenedAt` and recent runs would
  avoid a new UI-state key, but cannot recover the exact task sub-tab, query, or
  fragment and can guess the wrong session.

## 📝 Architecture

### Workspace UI-state contract

Extend the canonical `WorkspaceUiState` contract schema in `packages/contract`
with one optional top-level key. The api-client re-exports the inferred type:

```ts
interface LastLocation {
  projectId: string
  pathname: string
  search?: string
  hash?: string
}
```

`projectId` is 1–64 characters, matching the registry bound. `pathname` is a
1–2,048-character absolute path that must start with `/p/`. When present,
`search` starts with `?` and is at most 4,096 characters; `hash` starts with `#`
and is at most 2,048 characters. Empty search and hash strings are omitted during
normalization. These bounds keep a malformed client from turning the small
preference file into an unbounded write. The server continues to use the
existing shallow top-level merge and atomic workspace UI-state writer. No
endpoint, environment variable, configuration file, migration, or polling
mechanism is added.

The client owns semantic validation because it has the live project registry:

1. `pathnameProjectId(pathname)` must decode to the stored `projectId`.
2. The project must still exist in `GET /api/v1/projects`.
3. Its status must be usable (`ok` or `not-git`), never `missing`.

Unknown keys continue to round-trip, and an older file without `lastLocation`
keeps today's behavior.

### Location persistence controller

Add one root-level controller inside `BrowserRouter`, beside the other
application-lifetime controllers. It observes `useLocation()` and records only
locations whose pathname has a valid `/p/:projectId` prefix and whose decoded
project is present and usable in the loaded registry. Consequently:

- task pages and sub-tabs, Git, GitHub, Skills, Workflows, Automations, Inbox,
  project Settings, query strings, and fragments are remembered;
- `/`, legacy unscoped URLs, unknown unscoped paths, and global Settings do not
  overwrite the last project context;
- the controller never invents a project from API scope or the boot project—the
  URL is the source of truth.

The controller compares the normalized candidate with the cached value and does
nothing when they are equal. A short debounce coalesces redirect chains and rapid
navigation. It optimistically updates the workspace UI-state query cache, sends
`PUT /api/v1/workspace/ui-state` with only the top-level `lastLocation` patch, adopts
the merged response on success, and invalidates the cache quietly on failure.
Unmount flushes a pending final write.

### Bare-root restoration

Refine the existing legacy redirect rather than adding a parallel router:

1. Explicit unscoped routes keep the current boot-project redirect, including
   their query and fragment.
2. Only the exact bare entry (`pathname === '/'`, empty search, empty hash)
   consults `lastLocation`.
3. The redirect waits while health, the project registry, or workspace UI-state
   is still pending. It does not wait forever after an error.
4. A semantically valid saved location navigates with `replace`.
5. Missing, malformed, unavailable, or unusable saved state falls back to
   `/p/<bootProject>/`, also with `replace`.

If the project registry is unavailable, a saved boot-project location may be
restored when it matches the boot project reported by health. A saved non-boot
project cannot be validated in that state and therefore falls back to the boot
project. This preserves the cockpit's existing degraded behavior without routing
blindly into a potentially removed project.

## 📝 Data Model

Example workspace UI-state:

```json
{
  "sidebar": {
    "collapsed": {
      "cezar": false,
      "shop": true
    }
  },
  "lastLocation": {
    "projectId": "shop",
    "pathname": "/p/shop/tasks/20260729-abc123/changes",
    "search": "?file=src%2Fcatalog.ts",
    "hash": "#L42"
  }
}
```

The state contains only route identity, not prompt text, repository contents,
credentials, or other sensitive data. Deleting the key—or the entire optional
workspace UI-state file—restores the current boot-project default. No migration
is required because the field is additive and optional.

## 📝 API Contracts

Existing endpoints remain the only public surface:

```text
GET /api/v1/workspace/ui-state
→ WorkspaceUiState

PUT /api/v1/workspace/ui-state
{ "lastLocation": { "projectId", "pathname", "search?", "hash?" } }
→ merged WorkspaceUiState
```

The PUT remains protected by the global request-origin guard and body-size/key
caps. Zod validation returns the established `{ "error": string }` response with
status `400` for an empty/oversized project id, a non-project pathname, oversized
search/hash data, or non-string fields. The route remains workspace-level and is
never mounted below `/api/v1/p/:projectId`.

## 📝 UI/UX

There is no new control or visual state. When the host reopens Cezar at `/`, the
user sees the same project and exact page they last used rather than a flash of
the boot project's Tasks page. The quiet existing resolving view remains until
the destination is known.

Browser Back does not return to the transient root because restoration replaces
that history entry. Pasted and bookmarked deep links are never superseded by
remembered state. Global Settings deliberately leaves the remembered project
location intact, so returning to the workspace still has a meaningful project
context.

## 📝 Edge Cases & Failure Scenarios

- **No saved state or pre-feature install:** use the boot project's Tasks page.
- **Malformed or forward-incompatible state:** ignore it and use the boot
  project; never throw during render.
- **Saved project unregistered or missing on disk:** use the boot project.
- **Saved project is `not-git`:** restore it because Cezar treats that status as
  usable.
- **Workspace UI-state GET fails:** retain today's boot-project redirect.
- **Workspace UI-state PUT fails or home is read-only:** navigation continues;
  the preference may not survive the next startup, and the cache is reconciled
  without a blocking error or toast.
- **Project registry GET fails:** restore only a saved boot-project location that
  health can validate; otherwise use boot Tasks.
- **Rapid redirects/navigation:** debounce and equality checks persist only the
  settled final location.
- **Two open cockpits navigate concurrently:** last successful workspace write
  wins, consistent with other workspace-global UI preferences.
- **A formerly valid route is removed in a later version:** the saved project is
  still restored and the existing Not Found route reports the stale path; a
  subsequent valid project navigation replaces it.

## 📝 Risks & Impact Review

The change touches startup routing, so an incorrect validation or pending-state
condition could create a redirect loop or a permanent Loading screen. Keeping
restoration inside the existing legacy redirect, requiring an exact bare root,
and testing every query state bounds that risk.

Workspace-global last-writer-wins behavior means one browser can change what
another browser restores later. This is intentional and matches the selected
workspace-wide preference semantics. Debouncing and no-op equality checks reduce
write volume.

Rollback is removal of the controller, redirect branch, DTO field, and known Zod
field. Existing files may retain an unknown `lastLocation` key, which the
passthrough contract safely preserves and ignores; users can also delete
`~/.cezar/ui-state.json` and Cezar rebuilds defaults.

There are no breaking changes to routes, API spellings, configuration, or stored
run records.

## 📋 Phasing

### Phase 1 — Persist and restore the last project location

Ship the additive workspace UI-state contract, pure location validation, root
restoration, and debounced persistence together. The feature is not useful in a
partially enabled state, but each implementation step below leaves existing
startup behavior working.

## 📋 Implementation Plan

1. **Add the typed workspace UI-state field and boundary validation.** Extend the
   canonical contract and server route schema with bounded `lastLocation`, then
   add server tests for valid round-trip, malformed input, and size limits.
   Existing clients and files remain valid because the field is optional.
2. **Add pure location normalization and root restoration.** Implement helpers
   that compare/validate saved locations against the registry, then update the
   legacy redirect to consult them only for exact `/`. Add router tests for exact
   restore with query/hash, explicit deep-link precedence, unknown/missing
   project fallback, `not-git`, and errored-query degradation.
3. **Persist settled project-scoped navigation.** Mount the application-lifetime
   controller, add debounce/equality/unmount-flush behavior, and test that valid
   navigation writes the exact location while unscoped/global routes do not
   overwrite it.
4. **Run the repository validation gate.** Execute typecheck, Vitest, node unit
   tests, build/package checks, and the UI smoke suite because startup navigation
   is user-facing. Verify ordinary deep-link reloads and bare-root restoration in
   the real cockpit.

[react-router-replace]: https://reactrouter.com/api/hooks/useNavigate
[vscode-webview-state]: https://code.visualstudio.com/api/extension-guides/webview#persistence
