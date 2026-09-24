# GitHub tab: incremental issue & PR loading (lazy checks + two-tier list/detail)

## TLDR

The cockpit's GitHub tab loads issues/PRs in a **two-shot** pattern: a fast batch of
`FAST_BATCH = 30` paints the tab, then a background `FULL_LIMIT = 1000` "everything open" fetch
replaces it and fixes the `30+` counts. That second fetch is slow because
`gh pr list --json …,statusCheckRollup` eagerly pulls the **CI rollup for every open PR** (the
code already flags *"statusCheckRollup on hundreds of PRs is slow"* and grants it a **60 s**
timeout). Until it lands the tab reads `30+` and the item you want may not be there yet.

This spec removes the slow path by splitting the data into a **light list tier** and a **lazy
detail tier**. Phase 1 (the shippable core for issue #664): drop `statusCheckRollup` from the
list call so the list returns almost instantly even at high limits, collapse the client's
two-shot into a single fast load, and hydrate the PR **checks** glyph in a second, non-blocking
batched pass for on-screen rows — exactly the way comment counts already work. Search works
immediately across everything fetched, and clicking a row still fetches its thread on demand
(with a cheap React Query prefetch on hover). Every `/api/github` change is **additive**
(BACKWARD_COMPATIBILITY.md §2). Cursor pagination + "Load more"/infinite scroll + list
virtualization (proposals B/D) and one-GraphQL-query consolidation + moving `body` out of the
list (proposal C) are the author's explicit "larger follow-up" and are phased out to follow-up
issues.

## Resolved questions (autonomous defaults)

This was filed as a proposal; the autonomous run resolved its open design choices conservatively.
None require human confirmation before merge — each is additive/reversible and matches the issue
author's own "recommended path".

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | Ship full cursor pagination now, or the two-tier / lazy-checks split first? | **Phase 1 = lazy checks + collapse the two-shot** (proposal A + the two-tier split's list side). Pagination/virtualization (B/D) and consolidation (C) are follow-up. | The issue says the split is "independently shippable and low-risk; (B)/(C)/(D) are a larger follow-up." Phase 1 alone removes the 60 s cliff, makes search instant, and stops paying for unseen CI rollups — the primary ask. |
| Q2 | New `/api/github/detail/:kind/:number` route, or reuse the comments endpoint? | For **checks**, add a light **batched** `GET /api/github/checks?prs=…`. For **body**, keep it in the list tier in Phase 1 and move it to the (additively extended) comments endpoint in Phase 3. | Fewer new BC surfaces; reuse over new routes. A batched checks call keeps hydration to one round-trip for the visible window, mirroring `fetchCommentCounts`. |
| Q3 | Drop `body` from the `/api/github` list response to lighten it? | **No — not in Phase 1.** `GithubItem.body` is a required, documented field; removing it from the payload is breaking per BACKWARD_COMPATIBILITY.md. Deferred to Phase 3 behind a deprecation (make `body` optional, README/CHANGELOG note, minor bump called out as breaking). | The dominant cost is `statusCheckRollup`, not the 8 000-char `body` slice. Removing `body` is not needed to win back the wall-clock, and doing it safely needs a BC deprecation window. |
| Q4 | Default page size once pagination lands (Phase 2)? | **50** per page. | The issue's own suggestion; balances round-trips against payload size. |
| Q5 | Checks hydration granularity — every fetched PR, or on-screen only? | **On-screen / visible window**, batched, degrade-to-empty on any failure (same contract as comment counts). | Stops paying for CI data the user never scrolls to — proposal A's explicit goal. |
| Q6 | Virtualization approach (Phase 2)? | Reuse **`virtua`**'s `Virtualizer` (already a dependency, already used by the task thread, commit list, and diff view). | No new dependency; consistent with the house windowing pattern. |

## Problem Statement

`web/app/src/routes/github/github.tsx` loads the tab twice: `useGithub()` (limit 30) for first
paint, then `useGithub({ limit: FULL_LIMIT }, enabled: fast available)` for the full open set,
swapping the full result in only when it is a real answer. `countLabel(count, isFull)` renders a
trailing `+` (e.g. `30+`) until the full batch lands.

`src/server/forge/github.ts` → `fetchGithub(repoRoot, refresh, limit)`:

- Fetches `gh issue list` and `gh pr list --json number,title,author,createdAt,labels,body,url,isDraft,additions,deletions,statusCheckRollup` in parallel with `fetchCommentCounts` (a paginated GraphQL walk). The **`statusCheckRollup`** on the PR list is the dominant cost — the checks only render as a single glyph on the row.
- Grants a **60 s** timeout when `limit > 100` specifically because the rollup is slow.
- Caches the result 60 s keyed by `repoRoot`; a larger cached limit satisfies a smaller request.
- Is all-or-nothing: `gh issue/pr list --limit N` re-fetches the top N by `createdAt DESC`; there is no cursor, so "the next 30" means re-fetching everything.

Net effect: fast to first paint, but a long, heavy, cliff-edge wait to browse past 30, and wasted
work fetching CI data for rows the user may never scroll to.

## Proposed Solution

**Two tiers, with the expensive parts made lazy.**

1. **List tier** (`/api/github`, unchanged response *shape*): the row metadata a list needs to
   render and be searched — `number, title, author, createdAt, labels, isDraft, comments`, plus
   the existing `body`/`additions`/`deletions`. The only change is that the list call **stops
   fetching `statusCheckRollup`**, so it returns almost instantly even at high limits. `checks`
   comes back `null` from the list (already an optional field) and is filled in by the detail
   tier.
2. **Detail tier** (lazy, never inline in the list):
   - **Checks** — a new batched `GET /api/github/checks?prs=…` returns `number → checks` for the
     PR numbers asked for; the client requests it for **on-screen** PR rows and merges the glyph
     into the list cache. Degrades to an empty map on any failure, exactly like comment counts.
   - **Body / comments / timeline** — already served by `GET /api/github/comments/:kind/:number`
     on click; Phase 1 keeps the row `body` in the list for backward compatibility and adds a
     React Query **prefetch on hover/focus** so an opened item is usually warm.

Because the list is now cheap, the client collapses the two-shot into **one fast load**; the
`30+` guesswork disappears (counts come from the counts query, and a single fast fetch returns
the full window under `limit`). This is the whole of Phase 1 and closes the issue's core ask.

Phase 2 turns the single fast load into true incremental loading (cursor pagination + "Load
more"/infinite scroll + row virtualization). Phase 3 consolidates the two list calls + counts
into one GraphQL query per page and moves `body` into the detail tier behind a BC deprecation.

## Architecture

```
                 Phase 1 (this issue)
  ┌──────────────────────────┐        ┌───────────────────────────────┐
  │  /api/github (list tier) │        │  /api/github/checks?prs=…     │
  │  gh issue list           │        │  (NEW, additive, batched)     │
  │  gh pr list  ── NO ──▶    │        │  fetchCheckStates(numbers[])  │
  │     statusCheckRollup     │        │  → { number: checks }         │
  │  + fetchCommentCounts     │        │  degrade → {}                 │
  └──────────────────────────┘        └───────────────────────────────┘
        │ fast, checks:null                    ▲ visible PR rows only
        ▼                                       │
  ┌──────────────────────────────────────────────────────────────────┐
  │  GithubRoute: ONE useGithub() load  ·  useGithubChecks(visiblePrs) │
  │  merge checks glyph into cache  ·  prefetch thread on row hover     │
  └──────────────────────────────────────────────────────────────────┘

                 Phase 2 (follow-up)                Phase 3 (follow-up)
  cursor pagination (issues/pullRequests      one GraphQL query per page;
  first:N after:$cursor) + Load more /         move `body` → detail tier
  infinite scroll + virtua windowing           (BC deprecation for `body`)
```

- **Degrade rule preserved (plan rule 7):** every read still lands on `available: false` +
  reason, never a 5xx. The new checks endpoint degrades to `{ available: false, reason }` /
  empty map and the tab renders exactly as before (glyph simply absent).
- **Cache:** `fetchGithub`'s 60 s `repoRoot`-keyed cache is unchanged. The checks endpoint gets
  its own short cache keyed by `repoRoot` + sorted PR numbers so repeated visible-window
  hydration within a minute is free.

## Data Model

Phase 1 is additive on the wire; the existing `GithubItem` / `GithubData` shapes are unchanged.

New server helper and result (in `src/server/forge/github.ts`):

```ts
/** PR number → collapsed checks glyph, for lazy on-screen hydration. Mirrors the
 *  fetchCommentCounts degrade-to-empty contract: any failure yields {}. */
export async function fetchCheckStates(
  repoRoot: string,
  numbers: number[],           // capped at GH_CHECKS_MAX (e.g. 100)
): Promise<Record<number, GithubItem['checks']>>;
```

New API response type (`web/app/src/api/types.ts` + `src/server/forge/types.ts`):

```ts
export type GithubChecksData =
  | { available: true; checks: Record<number, 'passing' | 'failing' | 'pending' | null> }
  | { available: false; reason: string };
```

Phase 2 (documented, not built here) adds to `ForgeListOptions`:

```ts
export interface ForgeListOptions {
  refresh?: boolean;
  limit?: number;
  issuesCursor?: string;   // additive — opaque GraphQL endCursor
  prsCursor?: string;      // additive
}
```

and to `GithubData` the additive `issuesNextCursor?: string | null` / `prsNextCursor?: string | null`.

Phase 3 makes `GithubItem.body` **optional** and adds `detail?: { body: string }` to
`ForgeCommentsData` (behind the BC deprecation).

## API Contracts

**`GET /api/github`** — response shape byte-identical (BACKWARD_COMPATIBILITY.md §2). Internal
change only: PR rows come back with `checks: null` in Phase 1 (already valid — `checks?` is
optional and today is sometimes `null`). No new query params in Phase 1.

**`GET /api/github/checks?prs=<csv>`** — NEW, additive. `prs` is a comma-separated list of PR
numbers; each is validated numeric and the count is capped (`GH_CHECKS_MAX`, e.g. 100) at the
route boundary (400 on a malformed list). Returns `GithubChecksData`. Registered once and mounted
under both `/api/github/checks` and the project-scoped `/api/p/:projectId/github/checks` mirror,
matching every other `/api/github/*` route (route-parity + BC inventory tests updated). Degrades
in-payload to `{ available: false, reason }`; never a 5xx.

**`GET /api/github/comments/:kind/:number`** — unchanged in Phase 1. Phase 3 extends it additively
with `detail?: { body }`; `comments[]`/`events?` keep their exact shape and caps.

## UI/UX

- **First paint:** one fast list load replaces the two-shot. The list is fully searchable
  immediately across everything fetched (search already runs client-side over
  `filterGithubItems`). No `30+` placeholder — counts are real.
- **Checks glyph:** PR rows render without the checks glyph for a beat, then it fills in as the
  batched checks call resolves for the visible window — the same "fills in a moment later"
  behavior comment counts already have. Tones reuse the existing `ChecksBadge` table.
- **Open on click:** clicking a row fetches its thread immediately (already the case). A React
  Query `prefetchQuery` on row hover/focus warms `githubComments` so the detail is usually
  instant — a cheap bonus, silently best-effort.
- **Refresh:** the refresh mutation keeps busting the server cache; it now re-runs the single
  list query and re-hydrates visible checks rather than invalidating the `FULL_LIMIT` key.
- **No visual redesign.** Phase 2 adds a "Load more" affordance / infinite-scroll sentinel and
  virtualized rows; Phase 1 leaves the layout untouched.

## Edge Cases & Failure Scenarios

- **Checks endpoint down / slow / `gh` missing:** returns `available: false`; rows keep
  `checks: null` and render no glyph — identical to a PR with no checks today. The list is never
  blocked or failed by checks.
- **Empty `prs` param or all-invalid:** 400 with a hint; the client treats it as "no checks" and
  moves on.
- **Very many open PRs:** the visible-window request is capped at `GH_CHECKS_MAX`; the client
  requests checks for the on-screen slice, so cost is O(visible), not O(all open).
- **Dry run (`CEZ_DRY_RUN=1`):** `mockGithub()` already sets `checks` on mock PRs; the checks
  endpoint returns a matching mock map so the offline demo still shows glyphs.
- **Cache staleness:** a PR whose checks changed within 60 s shows the cached glyph until the
  next window hydration or a manual refresh — acceptable (checks are advisory on the row; the
  detail/merge-state view is authoritative).
- **BC drift guard:** adding the route triggers `src/server/bc-route-inventory.test.ts` and
  `src/server/route-parity.test.ts`; both are updated so the new endpoint is inventoried and
  parity-tested across the boot-project / `default` / scoped spellings.

## Risks & Impact Review

- **Risk: a PR row briefly shows no checks glyph, then it appears.** Low — this already happens
  for comment counts and is imperceptible on a fast repo; on a slow one it is strictly better
  than today's 60 s blank-past-30 wait. Mitigation: hydrate the visible window first.
- **Risk: removing `statusCheckRollup` from the list changes cached behavior.** Low — `checks?`
  is optional and already nullable; the only observable change is that the list-tier value starts
  `null` and is filled by the checks call. No consumer can have depended on the list *always*
  carrying a non-null `checks` (it is `null` whenever a PR has no checks).
- **Risk: new route surface.** Low — additive, scoped-mirrored, degrade-only, guarded by the two
  BC tests.
- **Backward compatibility:** Phase 1 is fully additive. Phase 3's `body` move is the only
  breaking change and is explicitly gated behind a README/CHANGELOG deprecation + optional-field
  migration + a minor bump called out as breaking.

## Phasing

- **Phase 1 — lazy checks + collapse the two-shot (THIS issue's implementation PR).** Independently
  shippable, additive, low-risk. Closes #664's core ask.
- **Phase 2 — cursor pagination + "Load more"/infinite scroll + `virtua` virtualization
  (follow-up issue).** Proposals B + D. Turns the single fast load into true incremental loading.
- **Phase 3 — one consolidated GraphQL query per page + move `body` to the detail tier
  (follow-up issue).** Proposal C + the BC-gated `body` deprecation.

Phases 2 and 3 are tracked as follow-up issues, not part of this PR.

## Implementation Plan

**Phase 1 — the deliverable for #664**

1. `src/server/forge/github.ts` — `fetchGithub`: remove `statusCheckRollup` from the `gh pr list`
   `--json` field set (PR list fields become `${fields},isDraft,additions,deletions`); map
   `checks: null` for list rows (drop the eager `rollupToChecks(p.statusCheckRollup)` in the list
   mapper). Drop the `capped > 100 ? 60_000 : 15_000` special case back to the normal timeout now
   that the slow field is gone. Keep the 60 s `repoRoot` cache. Unit tests: list no longer requests
   the rollup field; `checks` is `null` on list rows; existing counts/label-color behavior intact.
2. `src/server/forge/github.ts` — add `fetchCheckStates(repoRoot, numbers)`: one GraphQL query (or
   a bounded batch) resolving `statusCheckRollup` per requested PR number, collapsed through the
   existing `rollupToChecks`, returned as `number → checks`; wrap in try/catch to degrade to `{}`
   (mirror `fetchCommentCounts`). Add `GH_CHECKS_MAX` cap and a short cache keyed by
   `repoRoot` + sorted numbers. Add a `mockGithub`-consistent branch for `CEZ_DRY_RUN=1`. Unit
   tests: happy path map, degrade-to-empty on failure, cap enforcement, dry-run map.
3. `src/server/forge/types.ts` + `src/server/github.ts` (delegate re-export): add `GithubChecksData`
   and export `fetchCheckStates`.
4. `src/server/server.ts` — register `GET /api/github/checks` (and its `/api/p/:projectId/...`
   mirror via the shared handler): parse `prs` CSV with zod (numeric, non-empty, ≤`GH_CHECKS_MAX`;
   400 on invalid), call `fetchCheckStates`, answer `GithubChecksData`, degrade in-payload. Update
   `src/server/bc-route-inventory.test.ts` and `src/server/route-parity.test.ts` to include the new
   route. Route test alongside the existing `/api/github` coverage (valid list, invalid list → 400,
   degrade path).
5. `web/app/src/api/types.ts` + `web/app/src/api/client.ts` + `web/app/src/api/queries.ts`: add the
   `GithubChecksData` type, `getGithubChecks(prNumbers)` client fn (`/api/github/checks?prs=…`), and
   `useGithubChecks(prNumbers, enabled)` query (keyed on the sorted numbers, `staleTime: 60_000`).
6. `web/app/src/routes/github/github.tsx`: replace the two-shot. Remove `FULL_LIMIT`/`FAST_BATCH`
   two-query logic and the `full`/`isFull` swap; use a single `useGithub({ limit })` at a sensible
   default (fetch the open window in one fast call). Simplify `countLabel` to drop the `+`
   placeholder (real counts). Drive `useGithubChecks` from the on-screen PR numbers and merge the
   returned glyphs into the rendered rows (side map keyed by number, or `setQueryData` patch on the
   list). Add a `queryClient.prefetchQuery(githubComments…)` on row hover/focus. Update the refresh
   mutation to invalidate/re-run the single list key + re-hydrate visible checks (drop the
   `FULL_LIMIT` invalidation). Component tests: single load renders rows without `30+`; checks glyph
   appears after the checks query resolves; hover triggers a thread prefetch; refresh re-runs the
   list.
7. Dry-run + gate: verify end-to-end under `CEZ_DRY_RUN=1` (mock issues/PRs render, glyphs present,
   search immediate). Run the full validation gate:
   `npm run typecheck && npm test && npm run test:unit && npm run build && npm run test:package`.
   Capture a screenshot of the tab for QA evidence.

**Phase 2 / Phase 3 (follow-up issues — summarized, not built in this PR)**

8. Phase 2: add `issuesCursor`/`prsCursor` to `ForgeListOptions`; teach `fetchGithub` a GraphQL
   `issues(first:N, after:$cursor)` / `pullRequests(first:N, after:$cursor)` cursor path returning
   `{ items, nextCursor }` per kind; expose additive `issuesNextCursor`/`prsNextCursor` on
   `GithubData` and additive `?issuesCursor=&prsCursor=` params on `/api/github`. Client: page size
   50, `useInfiniteQuery`, a "Load more" button / infinite-scroll sentinel, and row virtualization
   with `virtua`'s `Virtualizer` (reuse the thread-scroller pattern). Hydrate checks per newly
   visible page.
9. Phase 3: fold the two `gh list` calls + `fetchCommentCounts` into one GraphQL query per page;
   move `body` out of the list tier into the (additively extended) comments endpoint
   (`detail?: { body }`), make `GithubItem.body` optional, and land the BACKWARD_COMPATIBILITY
   deprecation (README + CHANGELOG note, migration path, minor bump called out as breaking).

## Out of scope

- Any change to `/api/github`'s response *shape* in Phase 1 (additive-only; shape unchanged).
- Cursor pagination, "Load more"/infinite scroll, and list virtualization (Phase 2 follow-up).
- Consolidating to one GraphQL query per page, and moving `body` to the detail tier (Phase 3
  follow-up, BC-gated).
- Changes to the PR merge-state / changes / comments endpoints beyond the additive Phase 3
  `detail?` extension.
