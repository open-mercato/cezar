# Execution plan — GitHub tab: newest / oldest sort toggle

**Slug:** `github-list-sort-order`
**Branch:** `feat/github-list-sort-order`
**Engine:** om-auto-create-pr

## Goal

Give the cockpit's GitHub tab a one-click way to flip the Issues / Pull requests list between
**newest first** (today's only order) and **oldest first**, and remember the choice across reloads.

## Context

- The list is rendered by `packages/web/src/routes/github/github.tsx`; rows come straight off the
  `GET /api/v1/github` payload in whatever order `gh {issue,pr} list` returned (created-desc), and
  `filterGithubItems` preserves that order. There is no sort anywhere in the path today.
- `LIST_LIMIT` is 1000 and the fetch is one shot, so the client holds effectively the whole open
  set — a client-side sort is honest, needs no new query param, and cannot re-slice which items
  were fetched. `githubItemSchema` already carries `createdAt`, so no contract change is needed
  for the item shape.
- The tab already persists a presentation choice the same way: `githubView` in `ui-state.json`
  (`saveGithubView`, `uiStateSchema`). The sort choice follows that precedent exactly rather than
  inventing a second persistence mechanism.
- `packages/web/src/components/segmented.tsx` (`Segmented`) is the repo's canonical two-option
  control; reuse it instead of a new one.

## Scope

- `packages/web/src/routes/github/github-filter.ts` — new pure `sortGithubItems` helper.
- `packages/web/src/routes/github/github.tsx` — the toggle in the filter row, applied to both the
  open list and the "Found on GitHub" cross-state hits; persisted through `ui-state`.
- `packages/contract/src/workspace.ts` and `packages/cezar/src/server/server.ts` — one additive
  optional `githubSort` key on the ui-state shape.
- Tests beside each of those.

### Non-goals

- No server-side / `gh --sort` change, no new `GET /github` query param, no cache-key change.
- No sort dimensions beyond creation time (no "recently updated", no "most commented").
- No sorting of any other cockpit list (Tasks, Automations, Inbox).
- No URL search-param state for the GitHub tab.

## Risks

- **Ordering must stay deterministic.** `createdAt` ties are possible in fixtures and in real
  bulk-opened PRs; the comparator breaks ties on `number` so the list never reshuffles between
  renders.
- **ui-state PUT merges shallowly** at the top level — the writer sends the whole key, like
  `githubView` does. Additive-only: an old `ui-state.json` without `githubSort` reads as the
  default (`newest`), and an older cockpit ignores the key.
- Sorting a copy, never the payload array in place — the query cache holds that array.

## Implementation Plan

### Phase 1: pure sort helper

- 1.1 Add `GithubSort` (`'newest' | 'oldest'`) and `sortGithubItems` to `github-filter.ts`,
  sorting on `createdAt` with `number` as the tiebreak, returning a new array.
- 1.2 Table tests in `github-filter.test.ts`: both directions, tie determinism, input not mutated,
  malformed/empty `createdAt` tolerated.

### Phase 2: remember the choice

- 2.1 Add the additive optional `githubSort` key to `packages/contract/src/workspace.ts` and to
  `uiStateSchema` in `packages/cezar/src/server/server.ts`.
- 2.2 Server test: `GET`/`PUT /ui-state` round-trips `githubSort` and rejects a bogus value; an
  old file without the key still validates.

### Phase 3: the toggle

- 3.1 Render a `Segmented` "Newest | Oldest" control in the GitHub header's filter row, apply the
  sort to the open list and to the search hits, and persist via `putUiState` mirroring
  `saveGithubView` (optimistic cache patch, toast + invalidate on failure).
- 3.2 Component tests in `github.test.tsx`: default order, clicking Oldest reverses both lists,
  the choice is written to ui-state, a remembered `oldest` renders oldest-first on mount.

### Phase 4: gate

- 4.1 Run the full validation gate (`npm run typecheck`, `npm test`, `npm run test:unit`,
  `npm run build`, `npm run test:package`) and fix anything red.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: pure sort helper

- [x] 1.1 Add `GithubSort` + `sortGithubItems` to `github-filter.ts` — d2eff80c
- [x] 1.2 Table tests for `sortGithubItems` — d2eff80c

### Phase 2: remember the choice

- [ ] 2.1 Additive `githubSort` key in the contract and the server ui-state schema
- [ ] 2.2 Server ui-state round-trip test for `githubSort`

### Phase 3: the toggle

- [ ] 3.1 Segmented Newest | Oldest control wired into the GitHub tab
- [ ] 3.2 Component tests for the toggle and its persistence

### Phase 4: gate

- [ ] 4.1 Full validation gate green
