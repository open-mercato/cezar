# Run plan — GitHub tab: full timeline events with per-commit CI markers

**Source doc:** `.ai/specs/2026-07-20-github-timeline-events.md`
**Tracking issue:** [#525](https://github.com/open-mercato/cezar/issues/525)
**Spec PR:** [#527](https://github.com/open-mercato/cezar/pull/527) (merged, design-only)
**Branch:** `feat/github-timeline-events`
**Base:** `main`
**Engine:** `om-auto-create-pr-loop` (via `om-auto-fix-issue 525` → `om-auto-implement-spec`)

## Tasks

| Phase | Step | Title | Status | Commit |
|---|---|---|---|---|
| 1 | 1.1 | `ForgeTimelineEvent` types + `events?` on `ForgeCommentsData`; re-export via `server/github.ts` | done | |
| 1 | 1.2 | `ghTimelineEventSchema` + `TIMELINE_EVENT_KINDS` + 4 timeline constants | done | |
| 1 | 1.3 | `normalizeEvents()` — allowlist, per-type timestamp/actor, id chain, `slice(-cap)` | done | |
| 1 | 1.4 | `fetchGithubComments`: bounded 10-page timeline loop, shared 15s budget, inner catch, comments top-up | done | |
| 1 | 1.5 | Leave `mergeThread` unchanged + regression test that event volume cannot affect it | done | |
| 1 | 1.6 | Mirror `GithubTimelineEvent` / `events?` in `web/app/src/api/types.ts` | done | |
| 1 | 1.7 | `EventRow` + client-side interleave + `labelColors` threading + header/empty-guard | done | |
| 2 | 2.1 | Repo-handle resolution in `fetchGithubComments`, memoized per `repoRoot` (negatives only) | done | |
| 2 | 2.2 | `fetchCommitChecks()` — batched aliased GraphQL, chunked at 50, `rollupToChecks` adapter | done | |
| 2 | 2.3 | Attach `checks` per SHA to `committed` events; degrade to absent on failure | done | |
| 2 | 2.4 | Render CI glyph on commit rows reusing `CHECKS_GLYPH`/`CHECKS_TONE` | done | |
| 2 | 2.5 | Client-side collapse of consecutive same-author commit runs + `aria-expanded` expander | done | |
| 3 | 3.1 | Refresh mutation also invalidates open `queryKeys.githubComments` keys | done | |
| 3 | 3.2 | Extend `mockGithubComments` with fixture events (full 40-char SHAs) | done | |
| 3 | 3.3 | Pin `GithubTimelineEvent` / `GithubCommentsData` type-exact in `api-types.test.ts` | done | |
| 3 | 3.4 | Extend `github-comments-api.test.ts` dry-run route assertions for `events[]` | done | |
| 3 | 3.5 | `BACKWARD_COMPATIBILITY.md` §2: add 3 missing routes + note `events?` additive | done | |
| 3 | 3.6 | §2 route-inventory drift guard test (brace-expander, param normalization) | done | |
| 3 | 3.7 | `web/app/e2e/github.e2e.ts` — thread coverage (comments, commit row, CI glyph) | done | |
| 3 | 3.8 | Full validation gate + e2e + dry-run manual pass with screenshot | done | |
| 3 | 3.9-review-fix | Review findings: real refresh=1 bust, non-vacuous tests, sha invariant, tie-order | done | |
| 3 | 3.10-review-fix | Re-review findings: refresh follows rendered thread (not `:n`), no skeleton flash | done | |

Checkpoints fire after Steps 1.5, 2.3, 3.2, 3.7 (≈ every 5 Steps / on phase close).

## Goal

The GitHub tab's detail thread renders only conversation comments and PR review summaries. Add
the rest of the tracker history — commits, label changes, assignments, merges, force-pushes,
cross-references — with a rolled-up CI glyph on each commit row, so the thread reads like
github.com's conversation tab.

## Affected areas

| Layer | File |
|---|---|
| Fetch/normalize | `src/server/forge/github.ts` (764 ln) |
| Server types | `src/server/forge/types.ts`, `src/server/github.ts` (shim) |
| Client types | `web/app/src/api/types.ts` |
| Render | `web/app/src/routes/github/github.tsx` (820 ln) |
| Query | `web/app/src/api/queries.ts` |
| Tests | `src/server/forge/github.test.ts`, `src/server/api-types.test.ts`, `src/server/github-comments-api.test.ts`, `web/app/src/routes/github/github.test.tsx`, `web/app/e2e/github.e2e.ts` |
| Docs | `BACKWARD_COMPATIBILITY.md` |

## Load-bearing details (do not re-derive — the spec verified these against the live API)

1. **`committed` and `reviewed` events have `created_at: null`.** Real timestamps live at
   `author.date` / `submitted_at`. A naive mapping string-sorts every commit to the top and
   silently reorders the whole thread.
2. **Events keep the NEWEST window — `slice(-cap)`, not `slice(0, cap)`.** The neighbouring
   `mergeThread` head-slices; copying it would retain day-one `labeled` rows and discard the
   `merged` event and recent commits — exactly what #525 asks for.
3. **`--paginate` has no page cap**, so the timeline fetch hand-rolls a bounded page loop.
4. **`gh()`'s timeout is per invocation.** Ten pages at the 15 s default = a 150 s ceiling. The
   loop tracks one deadline and passes the *remaining* budget to each page.
5. **`comments[]` must stay byte-identical** (§2-protected surface). Guaranteed by three things:
   the same normalizer over the same rows, two *independent* caps, and the comments top-up.
   The one stated exception is a thrown top-up.
6. **The top-up's own `try`/`catch` is nested** — the inner handler's remedy is the very call that
   failed; the outer handler empties the thread.
7. **`oid` requires a full 40-char SHA** in both literal and variable form. Constrains fixtures.
8. **Event id chain is `evt-${id ?? sha ?? node_id ?? index}`**, `sha` deliberately ahead of
   `node_id`. A bare index shifts on refetch and remounts every row below an insertion.
9. **`checks` absent ≠ `checks: null`** — both render no glyph, kept distinct for diagnosis.

## Non-goals

- Posting, editing, or reacting to timeline items (the tab stays read-only).
- Inline diff-anchored review comments and review-thread resolution state.
- Background polling / webhooks; the 60 s TTL + manual refresh model stays.
- A per-check drill-down list — the badge already deep-links to `${item.url}/checks` (#415).
- Reactions, and events GitHub itself hides behind "load more".
- Any runtime `CEZ_*` kill switch (declined on merit in the spec's Zero-config section).

## Risks

- **§2 breakage on `comments[]`** — highest risk. Mitigated by the byte-identical regression test
  in Step 1.4 and the independent caps in 1.3/1.5.
- **Thread reordering** via the `created_at: null` trap — dedicated unit test in Step 1.3.
- **Latency ceiling regression** if the shared budget is mis-wired — unit test in Step 1.4 asserts
  a budget-consuming loop stops early and does not take the fallback.
- **e2e is excluded from `npm test`** — Step 3.8 runs `npm run test:e2e` explicitly.

## External references honored

None. No `--skill-url` was passed; the spec is the sole source doc.
