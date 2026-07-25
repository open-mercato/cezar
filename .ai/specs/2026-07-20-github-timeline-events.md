# GitHub tab: full timeline events (commits, labels, merges) with per-commit CI markers

Tracking issue: [#525](https://github.com/open-mercato/cezar/issues/525)

## TLDR

The GitHub tab's detail thread renders conversation comments and PR review summaries and nothing else — the commits, label changes, assignments, merges, force-pushes and cross-references that make up the rest of a tracker's history are never fetched. This spec swaps the thread's comment fetch for GitHub's REST **timeline** endpoint, which returns comments *and* events in one stream, adds a compact `EventRow` alongside the existing `ThreadEntry`, and hangs a ✓/✗/○ CI glyph off each commit row via one batched GraphQL rollup query. The result reads like github.com's conversation tab: discussion interleaved with what actually happened to the branch.

This is the explicitly-named follow-up to [`2026-07-18-github-comment-threads.md`](./2026-07-18-github-comment-threads.md), whose Out of scope ends with *"Timeline events (labels, assignments, cross-references, commits)."*

## Resolved questions (autonomous defaults)

Authored unattended; each default is overridable before implementation starts — comment on #525 to override.

- **Q1 — REST `/issues/{n}/timeline` or GraphQL `timelineItems`?** **REST timeline.** Decisive evidence: a `commented` row from the timeline is shape-identical to a row from today's `/issues/{n}/comments` (verified against PR #517 — same `id`, `user`, `body`, `created_at`, `html_url`), so `normalizeComments` (`github.ts:371`) is reused unchanged and `comments[]` keeps its exact shape — with the comments top-up (§Architecture) covering the one case where the shared fetch budget would otherwise shorten its contents. It also stays inside the established `gh api` + per-boundary-zod discipline (though *not* the `--paginate` flag itself at `:455` — that has no page cap, so the timeline fetch hand-rolls a bounded page loop; see §Architecture "Pagination"). GraphQL `timelineItems` would need inline fragments for each rendered kind plus a second normalization path for comments, for no user-visible gain.
- **Q2 — which events render in v1?** An **allowlist**, not a denylist: `committed`, `labeled`/`unlabeled`, `assigned`/`unassigned`, `merged`, `closed`/`reopened`, `head_ref_force_pushed`, `cross-referenced`, `renamed`. Everything else is dropped silently. Real data confirms the noise this excludes — PR #517's timeline carries `subscribed` (×2), `mentioned` (×2) and `review_requested` (×2), none of which github.com surfaces as conversation rows either. An allowlist also means a new GitHub event type can never crash or clutter the thread; it is simply not rendered.
- **Q3 — do `reviewed` timeline events replace the `/pulls/{n}/reviews` call?** **No — and they are dropped from the allowlist to avoid double-rendering.** Timeline `reviewed` events *do* carry a `body` key (verified — present, though `null` for bare approvals), so they are a technically viable source. The reason to keep the existing `/pulls/{n}/reviews` call (`:458`) is not capability but duplication and churn: it is already normalized to `ForgeComment{kind:'review'}`, already chipped in the UI (`REVIEW_CHIP`, `github.tsx:671`), and already filters empty-bodied `COMMENTED`/`PENDING` reviews (`normalizeReviews`, `:386-405`). Sourcing reviews from both would render each review twice.
- **Q4 — how are per-commit check states fetched?** One **batched aliased GraphQL query** (`repository { c0: object(oid:…) { ... on Commit { statusCheckRollup { state } } } … }`), one alias per commit SHA, chunked at **50 SHAs per query**. Verified against this repo: aliases resolve independently and an unknown SHA returns `null` rather than erroring the whole query, so partial results degrade cleanly. `oid` requires a **full 40-char SHA** in both literal and variable form — an abbreviated value fails with `Could not coerce value "babda63" to GitObjectID` (verified both ways). The timeline supplies full SHAs, so this constrains fixtures and tests, not production data.
- **Q5 — new endpoint or extend the existing one?** **Extend `GET /api/github/comments/:kind/:number`, additively.** One fetch, one cache entry, one client hook; the response gains an optional `events[]` beside the unchanged `comments[]`. A sibling route would double the round-trips and force the client to reconcile two independently-cached streams. The route name becomes mildly inaccurate — accepted over a breaking rename (§2), noted in Out of scope as an optional future alias.
- **Q6 — commit run grouping?** **Collapse consecutive `committed` events by the same author — entirely client-side.** The wire carries a flat list of `committed` events, each with its own `sha`, `message` and `checks`; `EventRow`'s parent groups them for display and expands to the individual commits on click. Keeping the grouping off the wire means no data is discarded by the collapse (each grouped commit keeps its message and CI glyph), the server stays a pure normalizer, and the grouping heuristic can change without a §2 conversation.
- **Q7 — does `ForgeComment.kind` widen to cover events?** **No.** Events get their own `ForgeTimelineEvent` type. Widening `kind` beyond `'comment'|'review'` is additive on the wire but silently breaks client narrowing at `web/app/src/api/types.ts:520` and the `REVIEW_CHIP`/`ThreadEntry` pair (`github.tsx:671-712`) — a type-level break `tsc` catches here but that any external consumer of the documented shape would eat at runtime.
- **Q8 — one spec or two?** **One.** The sibling spec made this its Q1, so it is asked here too. Timeline events and per-commit CI markers are a **layered** pair, not a bundle: the markers have nothing to attach to until commit rows exist, so they cannot ship first or independently, and they are the specific ask that motivated #525 ("displayed with ci markers as they are on GitHub"). Commit-run grouping (Q6) *is* independently separable — it is a pure client-side view — and is bundled into Phase 2 only because an ungrouped 40-commit PR is a worse experience than no commits at all. Split verdict: cohesive, keep together.

## Problem Statement

`fetchGithubComments` (`src/server/forge/github.ts:443-474`) makes exactly two calls: `gh api repos/{owner}/{repo}/issues/{n}/comments --paginate` (`:455`) and, for PRs only, `.../pulls/{n}/reviews --paginate` (`:458`). There is no call to `/issues/{n}/timeline`, `/issues/{n}/events`, `/pulls/{n}/commits`, or GraphQL `timelineItems` anywhere in the repository — commits, label transitions, assignments, merges, force-pushes and cross-references simply do not exist in cezar's data layer.

The practical cost is that the GitHub tab shows *discussion without consequence*. On PR #517 the thread renders nine comments — including agent checkpoint evidence describing commits by SHA — while the two `committed` events those comments describe, the five `labeled` transitions, the `merged` event and the `cross-referenced` link to #520 are all invisible. A reviewer reading cezar cannot tell whether a PR was merged, when CI went green, or that the branch was force-pushed under a comment thread.

CI status compounds this. `ghCheckRunSchema` (`:59-63`) and `rollupToChecks` (`:82-88`) already collapse `gh`'s `statusCheckRollup` array into a single `passing|failing|pending|null` for the *item*, discarding every check's name, conclusion and URL — and that rollup is attached to the PR, never to a commit. So even with commits rendered there is nothing to hang a status marker on.

## Proposed Solution

Three additive changes along the seam the sibling spec established:

1. **Swap the comment fetch for the timeline fetch** — `/issues/{n}/comments` becomes `/issues/{n}/timeline`, split at the zod boundary into `commented` rows (through the existing `normalizeComments`) and allowlisted event rows (through a new `normalizeEvents`). The PR reviews call stays as-is.
2. **Batched per-commit CI** — one aliased GraphQL query resolving `statusCheckRollup { state }` for the commit SHAs in the timeline, attached to `committed` events. Wrapped in try/catch: failure leaves commits unglyphed, exactly as `fetchCommentCounts` (`:167`) degrades to empty maps on failure (`:180`), which the call sites then read as `?? 0` per row (`:250`, `:266`). The parallel is deliberate: the *fetch* degrades to "no data", and the *render* decides what absence looks like — which is why `checks` absent and `checks: null` stay distinct values here.
3. **Render** — `GithubThread` (`github.tsx:602`) interleaves `comments` and `events` client-side and maps the result, branching on a discriminant: `ThreadEntry` (`:680`) for comments and reviews, a new compact single-line `EventRow` for events.

Alternatives considered:

- *GraphQL `timelineItems`* — rejected per Q1: an inline-fragment union plus a second comment-normalization path, replacing a working zod-guarded seam for no user-visible gain.
- *A sibling `/api/github/timeline/:kind/:number` route* — rejected per Q5: two round-trips and two caches for one interleaved list.
- *Reusing `/pulls/{n}/commits` for commits* — rejected: PR-only (issues have no commits), and it returns commits without their timeline position.
- *Merging the two streams server-side into one ordered `entries[]`* — rejected: it would either reshape the protected response or force a combined entry cap that silently drops `comments[]` contents the endpoint returns today (see §Risks). The server stays a normalizer; ordering is presentation.
- *Fetching per-check detail (names, conclusions, logs)* — out of scope; the badge already deep-links to `${item.url}/checks` (#415).

## Architecture

**`src/server/forge/github.ts`** owns everything `gh`, unchanged as a principle. `fetchGithubComments` keeps its signature and its bounded LRU (`commentsCache`, `COMMENTS_CACHE_MAX = 50`, `:420-431`) — the cached value simply carries `events[]` too.

**Two independent caps, never a combined one.** `mergeThread` (`:409-416`) keeps capping comments+reviews at `THREAD_ENTRY_CAP = 200` exactly as today, so the 200-slot window itself is untouched; the top-up below is what makes `comments[]` bit-for-bit what the endpoint returns now on every thread rather than most — subject to the one exception it names for itself. Events get their own separate `TIMELINE_EVENT_CAP = 200`. A combined cap would mean a thread with 150 comments and 100 events returns ~120 comments — silently removing response contents from a §2-protected surface.

**The event cap keeps the NEWEST events — the opposite of the neighbouring function.** This must be stated explicitly because the obvious precedent does the wrong thing here. `mergeThread` slices the *head*:

```ts
// src/server/forge/github.ts:413-415 — oldest-first sort, then slice(0, cap)
const all = parts.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const truncated = all.length > cap;
return { comments: truncated ? all.slice(0, cap) : all, truncated };
```

The timeline is returned oldest-first, so copying `slice(0, cap)` for events would retain 200 stale day-one `labeled` rows and discard the `merged` event and the recent commits — the exact rows #525 asks for. `normalizeEvents` therefore applies `slice(-TIMELINE_EVENT_CAP)` (keep newest; still rendered ascending). For `comments[]` the head-slice stays as-is: it is pre-existing behavior on a §2-frozen surface and changing it is out of scope. Unit test: with 250 events, the retained window ends at the newest event.

**Pagination — `--paginate` cannot be capped, so it is not used for the timeline.** `gh api --paginate` requests pages *"until there are no more pages of results"* and exposes **no page-limit flag** (verified against `gh api --help`). `paginateCounts` (`:144-162`) gets its `GH_COUNTS_MAX_PAGES = 10` cap (`:113`) only because it is a hand-rolled GraphQL cursor loop in JS, not a `gh` flag — so "in the spirit of `paginateCounts`" means *writing the same kind of loop*, not passing `--paginate` and hoping.

`--paginate` is *not* banned outright — it stays on three calls this spec does not reshape: the reviews call (`:458`), the 404 fallback, and the comments top-up below. All three are comment/review streams, where reproducing today's output byte-for-byte matters more than bounding the page count, and all three are pre-existing behavior rather than new exposure.

The timeline fetch is therefore a manual REST page loop: `gh api -H "Accept: application/vnd.github+json" "…/timeline?per_page=100&page=${n}"` for `n = 1…10`, stopping early on a short page.

**The page loop shares one time budget — it does not get 15 s per page.** This is the trap in hand-rolling the loop, and it inverts the naive reading. `gh()`'s `timeout` is **per invocation** (`:90`, `timeout = 15_000`), so ten sequential spawns at the default would put the timeline fetch's ceiling at **150 s**, an order of magnitude worse than the single `--paginate` spawn it replaced — the opposite of a budget improvement. `gh()` already takes the timeout as its third argument, so the loop tracks a deadline and passes the *remaining* budget to each page:

```ts
const deadline = Date.now() + TIMELINE_BUDGET_MS;         // 15_000
let stoppedShort = false;
let page = 1;
for (; page <= TIMELINE_MAX_PAGES; page++) {              // 10
  const remaining = deadline - Date.now();
  if (remaining < TIMELINE_MIN_PAGE_MS) {                 // 2_000
    stoppedShort = true; break;                           // out of budget
  }
  let thisPage;
  try {
    thisPage = parse(await gh(repoRoot, [...], remaining));
  } catch (err) {
    if (page === 1) throw err;      // nothing fetched — let the inner catch decide
    stoppedShort = true; break;     // partial results beat discarding them
  }
  rows.push(...thisPage);
  if (thisPage.length < PER_PAGE) break;                  // short page — real end of timeline
}
if (page > TIMELINE_MAX_PAGES) stoppedShort = true;       // fell out on the page cap
```

**`stoppedShort` is the single term the rest of the spec keys off.** It means *"the timeline may have more rows than we fetched"*, and it has exactly three causes: the page cap, the budget floor, and a failure on page ≥ 2. All three feed `truncated` and all three arm the comments top-up, because all three shorten the `commented` stream the same way — the cause does not change the remedy. Note the short-page `break` is the one exit that does **not** set it: that is the timeline genuinely ending.

Three rules make this coherent, and each exists because the naive version fails quietly:

- **Never spawn a page that cannot finish.** A bare `remaining <= 0` guard only catches the exact boundary; the realistic case is 300 ms left, which spawns `gh` with a 300 ms timeout, throws, and looks indistinguishable from an endpoint failure. `TIMELINE_MIN_PAGE_MS` turns "not enough budget left" into a clean stop instead of a manufactured error.
- **Partial results beat the fallback.** The fallback exists to rescue an *empty* thread, so page 1 is the only page that rethrows. A failure on any later page keeps the pages already fetched — discarding nine good pages to re-fetch comments-only would be strictly worse than what the loop already holds.
- **Page 1 rethrows to the inner catch, which still discriminates.** It does not take the fallback unconditionally: `ENOENT` skips it exactly as the degradation table says. The loop decides *whether there is anything worth keeping*; the inner catch decides *whether substitution can help*.

With all three, the whole timeline fetch is bounded by **one 15 s window**, the per-call worst case matches the pre-change shape, and the paging decision costs nothing in latency ceiling. Unit tests: a loop whose pages each consume most of the budget stops early with `truncated` and does **not** take the fallback; a page-1 404 takes it; a page-1 `ENOENT` does not; a page-5 failure keeps pages 1-4 and arms the top-up; a short page 3 sets neither `stoppedShort` nor `truncated`.

The `Accept` header is carried over from #525 step 2 and is pinned deliberately rather than left to `gh`'s default. Current `gh` already sends a compatible media type, so this changes nothing today. It is pinned because the timeline spent years behind the `mockingbird-preview` media type, so its payload shape has a history of depending on what the client asks for. That history is not unique to it — `/pulls/{n}/reviews` was gated behind `black-cat-preview` and Phase 2's `statusCheckRollup` behind `antiope-preview`, both long since GA — which is precisely why pinning here is a cheap habit rather than a special case. One flag, no behavior change, one less silent dependency on a client default. The existing calls at `:455`/`:458` omit it and are deliberately left alone; retrofitting them is unrelated churn.

The loop walks oldest-first, so the page cap and the entry cap truncate the *same* end: on a thread exceeding 10 pages the newest events are never fetched, and `slice(-cap)` can only keep the newest of what arrived. Accepted for v1 — the `truncated` flag plus the existing "view on GitHub" row covers it, and threads past ~1000 timeline rows are far outside cezar's working set. Revisit with reverse pagination only if it shows up in practice.

**The page cap is a *combined* budget — and that is the one place `comments[]` can still shrink.** The two entry caps are independent, but the fetch budget is not: today's call is an *unbounded* `--paginate` over a comments-only endpoint (`:455`), so every comment is fetched and `mergeThread` picks the oldest 200 from the complete set. Under the timeline the same 200 slots are filled from at most 1000 rows in which events compete with comments for space. On a 1500-row thread carrying 250 evenly-interleaved comments, the first 1000 rows hold ~167 of them — so `comments[]` would return 167 where today it returns 200, silently dropping 33 entries from a §2-protected response. This is the same defect class as a combined *entry* cap, arriving through the source set rather than the slice.

The fetch therefore carries a **comments top-up safeguard**: when the fetch `stoppedShort` (page cap, budget floor, or a page ≥ 2 failure — see §Architecture) *and* fewer than `THREAD_ENTRY_CAP` `commented` rows were seen, re-fetch the comment stream with the legacy `/issues/{n}/comments --paginate` call and use it in place of the timeline's `commented` rows. `comments[]` then stays byte-identical to today's output in every case but one — a thrown top-up, spelled out below — rather than only in the common case.

**The trigger deliberately over-fires, and the prose must not pretend otherwise.** The condition cannot distinguish "comments were cut off by the cap" from "this thread just has few comments", because the second is only knowable by fetching them. So on an event-heavy 1200-row thread with 30 comments — the *typical* shape of a thread that trips the cap, not an exotic one — the top-up fires and re-fetches 30 comments that were already complete. That is a wasted call on most page-capped threads, accepted because the alternative is a §2 regression and because the absolute frequency is what stays low: it fires only past ~1000 timeline rows, behind the 60 s LRU. The threshold is sound in the other direction — with ≥200 `commented` rows already in the oldest-first prefix, `mergeThread`'s oldest-200 cut point provably lies inside that prefix, so skipping the top-up there cannot shorten anything.

**A failed top-up degrades to the timeline's own comments, never to `[]`.** The top-up gets its **own nested `try`/`catch`** — not the inner timeline handler's, and not the outer one's. Both would be wrong for the same reason in opposite directions: the inner handler's remedy is the fallback, which is the very call that just failed, and the outer handler returns `{available: false, comments: []}`, emptying a thread that was about to render. So the top-up swallows its own error: keep the `commented` rows the timeline already returned, leave `truncated: true`, carry on. That is at worst the short list the safeguard existed to avoid — never worse than not having attempted it, which is the bar any safeguard has to clear. Unit tests: a page-capped, comment-poor prefix returns the full pre-change `comments[]`; a top-up that throws still returns the timeline's `commented` rows with `available: true`.

**So the §2 guarantee has exactly one stated exception.** `comments[]` is byte-identical to today's output in every case *except* a thrown top-up, where it may be shorter — the pre-existing failure mode of a thread that large, not a new one. Naming the exception is the point: an "absolute" guarantee with an unlisted hole is worse than a bounded one, and every other section that states the guarantee (§Risks, §Edge Cases, §Performance) should be read against this sentence.

Events keep whatever the fetch allowed. `/issues/{n}/events` would be an unbounded source for the label/assign/close/merge subset, but it carries neither `committed` nor `cross-referenced`, so it cannot stand in for the timeline — which is why the events side accepts truncation and the comments side does not.

One consequence worth stating: after a top-up the client interleaves a **complete** comment list against a **prefix-only** event list, so comments past the cut render with no surrounding events — a merged PR can show late conversation without its `merged` row. The existing single "thread truncated" row (`github.tsx:661`) covers this only generically. Accepted for v1: strictly more information than today, and the alternative (truncating comments to match) is the §2 regression itself.

**The page cap over-reports at exactly 1000 rows, and that is fine.** A thread of exactly 1000 timeline rows returns a *full* page 10, so the loop exits on the page counter rather than on a short page and cannot tell "capped" from "ended exactly here" without an eleventh probe request. It therefore reports `truncated: true` and fires the top-up on a thread where nothing was truncated. Not worth a probe: this is precisely the over-reporting the `truncated` widening argument below already licenses (the flag may only ever claim *too much* is missing, never too little), and the cost is one redundant `--paginate` on a 1-in-1000 thread size, behind the 60 s LRU.

**`truncated` widens in meaning — deliberately, and the UI copy already covers it.** Today the flag means comments+reviews were capped. It is now set when *either* stream caps, or the timeline fetch `stoppedShort` of the end (page cap, budget floor, or a page ≥ 2 failure), so it can be `true` with `comments[]` complete. This is a behavioral widening of an existing field on a §2 surface, not merely an additive one, so it is called out rather than waved through: the flag's contract becomes "this thread is not showing you everything", which remains true in every case that sets it.

The client copy needs no change — checked, not assumed: `github.tsx:661` renders `thread truncated — open on GitHub`, which is already stream-agnostic and never claims comments specifically were hidden.

A separate `eventsTruncated` **would have been cheap**, and it is worth being honest that this is a judgement call rather than a free one: §2 exists for consumers outside this repo (`BACKWARD_COMPATIBILITY.md:19` — "anyone scripting `localhost:4321`"), and for them an added optional boolean costs nothing while a silently-widened field is precisely what §2 asks you to avoid. It is declined because `truncated` has exactly one in-repo consumer, the widened meaning is strictly weaker (it can only over-report, never hide data), and the one user-visible sentence it drives is already correct under both meanings. If a second consumer ever appears, splitting the flag is itself an additive change and can be done then.

**The timestamp trap.** `mergeThread` sorts by raw `createdAt` string compare — correct for ISO-8601 UTC, and every existing entry has one. Timeline events do **not** uniformly: verified against PR #517, `committed` events have `created_at: null` and carry their real timestamp at `author.date`, and `reviewed` events use `submitted_at`. A naive mapping produces `createdAt: null` on every commit, which string-sorts to the top and silently reorders the whole history. `normalizeEvents` therefore resolves the timestamp **per event type**, and any event still lacking one is dropped rather than merged at an arbitrary position. This is the single highest-risk detail in the spec and gets a dedicated unit test.

**Stated assumption — `author.date` is UTC-normalized by the API.** Raw git author dates carry the committer's offset (this repo has commits at `2026-07-20T19:23:27+02:00`), and string-comparing an offset timestamp against a `Z` one sorts wrongly. The REST timeline **normalizes `committed.author.date` to `Z`** — verified across PRs #517 and #521, including commits whose underlying git dates carry `+02:00`. The raw-string sort is therefore safe, but it is safe *because of an API behavior*, not because of anything in this codebase. A unit test asserts the normalization on a fixture captured from the live API, so a regression here fails loudly rather than silently reordering history.

**Actor identity is not uniform either.** Most events carry `actor { login, avatar_url }`, but `committed` carries only a git `author { name, email, date }` — no login, no avatar, and the email may not map to a GitHub account. `ForgeTimelineEvent.actor` is therefore a display string (git author name for commits, login elsewhere) with `avatarUrl` optional. **`author.email` is read for nothing and never leaves `normalizeEvents`** — there is no email field on the wire type, and the boundary schema strips it (see below), so raw addresses do not reach the client or sit in the LRU.

**The repo handle, memoized per `repoRoot`.** The Phase 2 GraphQL query needs `owner`/`name`, which `gh api graphql` does not expand from the `{owner}/{repo}` placeholders the REST calls rely on — this is exactly why `fetchGithub` pays for a separate `gh repo view --json nameWithOwner --jq .nameWithOwner` first (`:212`, parsed at `:213`). `fetchGithubComments` has no handle today, so Phase 2 resolves one via the exported `parseOwnerName` (`:185`) and degrades to no glyphs when the slug is not a clean two-part name.

The handle is **stable in practice** for a given `repoRoot`, so it is cached in a module-level `Map<string, OwnerName>` rather than re-resolved per thread-open. The subprocess then costs once per process instead of once per opened thread — strictly better than hiding it behind the 60 s LRU. (Strictly it *can* change — `git remote set-url`, `gh repo set-default`, a GitHub-side transfer or rename — but the blast radius is "glyphs go stale until restart", which does not justify re-spawning `gh` on every thread-open.) Keying by `repoRoot` rather than a module singleton is also what [`2026-07-20-multi-project-workspace.md`](./2026-07-20-multi-project-workspace.md) (`:98`, `:143`) requires of `forge/github.ts` module-level caches for the one-process-many-projects future, so this shape is forward-compatible rather than merely convenient.

**Only permanent failures are memoized.** Caching every failure would be a bug: `gh repo view` also throws on unauthenticated `gh`, offline, rate limit and timeout, and a cockpit dev server runs for days — so one transient blip at first thread-open would disable CI glyphs until restart. `fetchGithub` avoids this by re-resolving per list call behind its 60 s cache (`:212`); this path must not regress it. Rule: a **parse** that yields no clean two-part name is permanent → cache the negative. A **subprocess throw** is transient → do not cache; retry on the next thread-open. Unit tests: handle parsed and memoized (second call spawns nothing); malformed slug caches its negative and is not retried; a *thrown* `gh` failure is **not** cached and the next call retries.

**Boundary schema.** `ghTimelineEventSchema` is a plain `z.object` with a loose `event: z.string()` and optional kind-specific fields — **extras stripped**, per `CODE_REVIEW.md`'s zod rule and matching `ghIssueCommentSchema` (`:342`). Permissiveness toward unknown event *types* comes from the loose discriminant plus the allowlist, not from `.passthrough()`.

**`web/app/src/routes/github/github.tsx`** gains `EventRow` as a sibling of `ThreadEntry`, sharing the existing tone tables (`CHECKS_GLYPH`/`CHECKS_TONE`, `:746-751`) for the commit glyph rather than a parallel palette, and receiving `labelColors` — which today stops at `GithubDetail` (`:322`) and is not passed into `GithubThread` (`:590`). Both rows carry `data-kind` on their `<li>` so component tests key off one attribute. The client owns the interleave (a stable sort on `createdAt`) and the commit-run grouping.

Cross-cutting: the manual refresh mutation (`github.tsx:112-120`) invalidates only `queryKeys.github({limit: FULL_LIMIT})` and never open `queryKeys.githubComments` keys (`queries.ts:72`) — a pre-existing staleness bug this spec fixes, because it now hides commits and merge state, not just late comments.

## Data Model

Additive to `src/server/forge/types.ts` (`ForgeComment` at `:43-59` and `ForgeCommentsData` at `:63-71` are **unchanged**):

```ts
export type ForgeTimelineEventKind =
  | 'committed' | 'labeled' | 'unlabeled' | 'assigned' | 'unassigned'
  | 'merged' | 'closed' | 'reopened' | 'head_ref_force_pushed'
  | 'cross-referenced' | 'renamed'

export type ForgeTimelineEvent = {
  id: string                    // `evt-${id ?? sha ?? node_id ?? index}` — see "Event identity"
                                // below. Prefixed so ids cannot collide with ThreadEntry's
                                // `${kind}-${id}` keys.
  kind: ForgeTimelineEventKind
  actor: string                 // login, or git author name for `committed`
  avatarUrl?: string            // absent for `committed`
  createdAt: string             // ISO-8601, resolved per event type (see Architecture)
  url?: string
  // kind-specific, all optional:
  sha?: string                  // committed — full 40-char
  message?: string              // committed — first line, capped at 120 chars
  checks?: 'passing' | 'failing' | 'pending' | null   // committed; see below
  label?: { name: string; color?: string }            // labeled / unlabeled
  subject?: string              // assigned/unassigned login; renamed new title
  refNumber?: number            // cross-referenced
  refTitle?: string             // cross-referenced
  refIsPr?: boolean             // cross-referenced
}
```

`checks` distinguishes three states with three renderings: **absent** (the rollup query failed or was skipped) and **`null`** (the commit has no CI configured) both render no glyph but are kept distinct for diagnosis — tests assert the value, not a visual difference; `'passing'|'failing'|'pending'` render the glyph.

**Event identity.** Timeline rows carry identity unevenly — verified against PR #517:

| Event | `id` | `node_id` | Identity used |
|---|---|---|---|
| `labeled`, `unlabeled`, `assigned`, `unassigned`, `closed`, `reopened`, `merged`, `renamed`, `head_ref_force_pushed` | numeric | present | `id` |
| `committed` | *key absent* | present (`C_…`) | `sha` (full 40-char, also the rollup key) |
| `cross-referenced` | `null` | `null` | index — the only kind with no identity at all |

So `normalizeEvents` resolves `evt-${id ?? sha ?? node_id ?? index}`, and the index fallback applies to `cross-referenced` alone. **`sha` is deliberately ahead of `node_id` in that chain**: `committed` rows carry *both*, and a `node_id`-first order would silently key commits by an opaque `C_kwDO…` blob when the SHA is the natural, debuggable, already-used-as-the-rollup-key identifier. `node_id` remains in the chain only as a defensive fallback for a kind that grows one without an `id`. **A bare index is not acceptable as the general scheme**: the id becomes the React key, and an index over the post-sort array shifts for every subsequent row as soon as one new event arrives. On the 60 s refetch — and on the manual refresh that Phase 3 step 13 *adds* — every row below the insertion point would remount, collapsing any commit group the user had expanded. Unit test: ids are stable across a refetch that prepends an event; `cross-referenced` still gets a unique id.

No grouping fields on the wire — commit runs are collapsed client-side (Q6), so each commit keeps its own `message` and `checks` even inside a collapsed group.

`ForgeCommentsData` gains one optional field: `events?: ForgeTimelineEvent[]`. Its existing fields — `available`, `comments`, `truncated?` and `reason?` (`:66`, carrying the degradation message) — are untouched. Mirrored verbatim at `web/app/src/api/types.ts:513-532`, re-exported through `src/server/github.ts` (line `:9`, the `ForgeComment, ForgeCommentsData` re-export), and pinned type-exact in `src/server/api-types.test.ts` with `satisfies Exact<>` (the mechanism already used for `GithubItem`/`GithubData` at `:121-122`, which the sibling spec skipped for `ForgeComment`).

Caps: `message` 120 chars; `TIMELINE_EVENT_CAP = 200` on events, `THREAD_ENTRY_CAP = 200` on comments+reviews, independently. Fetch bounds: `TIMELINE_MAX_PAGES = 10` pages of `per_page=100`, under a shared `TIMELINE_BUDGET_MS = 15_000` with a `TIMELINE_MIN_PAGE_MS = 2_000` floor. `COMMENT_BODY_CAP` untouched.

No persisted state, no migration: fetched, cached in memory for 60 s, never written to `.ai/cezar/`.

## API Contracts

`GET /api/github/comments/:kind/:number` — params and validation unchanged (`server.ts:1429-1439`, zod `commentsParams`, 400 on bad kind/number, `refresh=1` busts the cache). Response gains one optional field:

```jsonc
{
  "available": true,
  "comments": [ /* ForgeComment[] — unchanged shape, contents and cap */ ],
  "events":   [ /* ForgeTimelineEvent[] — NEW, optional, independently capped */ ],
  "truncated": false          // set when EITHER stream is capped, or the fetch stopped short
}
```

Degradation contract, matching the tab's rule that GitHub failures never error the view:

- The **first** timeline page fails for any *endpoint-level* reason (404, 5xx, non-zero `gh` exit other than 403, parse failure) → fall back to `/issues/{n}/comments`; `events` absent; thread renders as today. A failure on a *later* page keeps the pages already fetched and sets `truncated` instead (§Architecture) — the fallback rescues an empty result, not a partial one.
- A `403` (rate limit / auth) → the fallback is attempted but cannot succeed, since a 403 attaches to the token rather than the endpoint; the thread lands on `{available: false, reason}` rather than rendering as today.
- The `gh` binary is missing (`ENOENT`) → no fallback; the existing `{available: false, reason}` path handles it, as today.
- Repo handle unresolvable or checks query fails → events returned, `checks` absent, no glyphs.

**Timeout budget.** `gh()` takes its timeout per invocation, defaulting to 15 s (`:90`); the timeline page loop shares **one** 15 s budget across all its pages rather than taking one per page (see §Architecture, "The page loop shares one time budget"). The fallback is a *substitution*, not a retry — it calls a different endpoint — so the question is never "can retrying fix this?" but "would the comments endpoint still succeed?":

| Failure | Comments fallback? | Why |
|---|---|---|
| `ENOENT` — no `gh` binary | **No** | Nothing will work; a second spawn fails identically and instantly. |
| Timeline **page 1** 404 / 5xx / non-`403` non-zero exit | **Yes** | Endpoint-specific (GHES variance, token scope, endpoint unavailability). `/issues/{n}/comments` is a *different* endpoint and typically still succeeds. Nothing was fetched, so there is nothing to lose by substituting. |
| Timeline **page ≥ 2** fails, for any reason | **No** | Pages 1…n-1 are already in hand. `truncated: true`, keep them, and let the top-up repair `comments[]`. Falling back here would trade real events for a comments-only thread. |
| Rate limit / auth (`403`) | **Attempted**, expected to fail | A 403 attaches to the *token*, not the endpoint, so the fallback cannot succeed either. Not special-cased: it costs one fast-failing spawn (rate-limit replies are immediate, no window burned) and then lands on the existing `{available: false, reason}` path. Detecting it to skip the call would buy nothing. |
| Timeline budget exhausted before page 1 returns | **Yes**, once | Nothing fetched — same case as a page-1 failure. A slow network is exactly when the fallback earns its cost. See the worst-case note below. |
| Timeline budget exhausted mid-loop | **No** | Not a failure at all: the loop stops cleanly at `TIMELINE_MIN_PAGE_MS`, keeps what arrived and sets `truncated` (§Architecture). |

**Worst case is three windows, and the page loop must not make it thirteen.** On a PR the sequence is timeline (15 s *total*, budget-shared) → comments fallback (15 s) → reviews (15 s), plus Phase 2's rollup query, and the route has no overall deadline — so a fully-hanging GitHub costs ~45-60 s of a pending cockpit request. That is pre-existing in shape (today's path is already comments + reviews back to back) and is accepted here rather than fixed. It is *only* pre-existing because of the shared budget: at `gh()`'s per-call default the ten-page loop alone would be a 150 s ceiling and this paragraph would be wrong by an order of magnitude. A route-level deadline remains the obvious follow-up if it ever bites.

Skipping the fallback on a timeline **404** would return `comments: []` on a thread that populates today — silently removing contents from a §2-protected response, and breaking this spec's own `comments[]` guarantee. Only `ENOENT` skips it. Unit tests: 404 takes the fallback and `comments[]` is populated; `ENOENT` does not spawn a second call.

**The catch must be scoped *inside* the existing one.** This is the trap on this path, and it is a nesting mistake rather than a logic one. `fetchGithubComments` already ends in an outer catch that pattern-matches the error message (`:465-473`):

```ts
: /404|not found/i.test(message)
  ? 'not found on GitHub — it may be closed or deleted'
```

Widening that existing `try` to cover the timeline call — the path of least resistance — sends a timeline 404 straight to *this* handler, returning `{available: false, reason: 'not found on GitHub'}` and rendering an empty thread: exactly the regression the row above exists to prevent, reintroduced without touching a line of the fallback logic. The timeline fetch and its fallback therefore get their **own inner `try`/`catch`**, resolving to a comment list before the outer block ever sees an error; the outer handler keeps its current behavior verbatim, for the case where the *fallback itself* fails. Unit test: a timeline 404 whose fallback succeeds returns `available: true`, not a `reason`.

## UI/UX

`EventRow` is deliberately *not* a `ThreadEntry`: single line, muted foreground, no card, no avatar block — icon + actor + phrase + `shortAge`, matching github.com's density so events read as connective tissue between comments rather than competing with them.

| Kind | Rendering |
|---|---|
| `committed` | ⚙ glyph + `{actor} committed {sha:7} {message}` + CI glyph (✓/✗/○, omitted when `checks` is absent or `null`); collapsed runs read `{actor} added {n} commits` and expand to the individual rows, each keeping its own message and glyph |
| `labeled` / `unlabeled` | `{actor} added/removed the {label}` label — chip reuses `labelColors` (newly threaded into `GithubThread`) |
| `assigned` / `unassigned` | `{actor} assigned/unassigned {subject}` |
| `merged` | ⑃ glyph, accent tone — `{actor} merged this` |
| `closed` / `reopened` | `{actor} closed/reopened this` |
| `head_ref_force_pushed` | `{actor} force-pushed` |
| `cross-referenced` | `{actor} referenced this in #{refNumber} {refTitle}` — links out |
| `renamed` | `{actor} renamed this to {subject}` |

The section header at `:646` is **retitled from `Comments · N` to `Activity`**, with the comment count kept as a secondary `· N comments`. Heading a twenty-row list `Comments · 2` would be incoherent. Note this is a different surface from the sibling spec's Q3, which settled the semantics of the **row badge** — that badge is unchanged and still counts conversation comments only.

The empty-state guard at `:638` (`if (data.comments.length === 0) return null`) must become `comments.length + events.length === 0`. Left as-is it would hide the entire feature on its motivating case: a merged PR with commits, labels and a merge event but no conversation comments renders nothing at all.

Keyboard access, light/dark theming and mobile safe areas follow the existing rows; the commit-group expander is a real `<button>` with `aria-expanded`.

## Edge Cases & Failure Scenarios

| Scenario | Behavior |
|---|---|
| Timeline 404s / 5xx / non-zero exit **other than 403** | Fall back to `/issues/{n}/comments`; thread renders as today, `events` absent. Never errors the tab, and **`comments[]` stays populated** — these are endpoint-specific and the comments endpoint still answers. |
| Rate limit / auth (403) | The one non-zero exit the fallback cannot rescue: a 403 attaches to the token, not the endpoint. Fallback is still attempted (not special-cased), fails fast, and the existing `{available: false, reason}` path renders the degradation — no 15 s window burned. |
| `gh` binary missing (`ENOENT`) | No second spawn; the existing `{available: false, reason}` path handles it, as today. |
| Timeline budget (15 s) runs out before page 1 returns | Nothing fetched, so the fallback is taken — preferred over an empty thread. Worst case on a PR is ~45 s (timeline + comments + reviews); the route has no overall deadline. |
| Timeline budget runs out mid-loop | Not a failure: stop at the `TIMELINE_MIN_PAGE_MS` floor, keep the pages already fetched, `truncated: true`, top-up repairs `comments[]`. No fallback — partial events beat a comments-only thread. |
| A timeline page ≥ 2 fails (any reason) | Same handling as the budget floor: keep pages 1…n-1, `stoppedShort`, `truncated: true`, top-up repairs `comments[]`. No fallback — it would trade real events for a comments-only thread. |
| Repo handle unresolvable (not a clean `owner/name`) | Events returned without `checks`; no glyphs. Logged once. |
| Checks GraphQL query fails | Events returned, `checks` absent, no glyph. Logged once, not surfaced. |
| Unknown / new GitHub event type | Dropped by the Q2 allowlist. Never rendered, never throws. |
| Event with no resolvable timestamp | Dropped rather than merged at an arbitrary sort position. |
| Unknown SHA in the rollup query | Alias resolves `null`; that commit renders without a glyph. Verified. |
| Commit with no CI configured | `statusCheckRollup: null` → `checks: null` → no glyph (distinct value from absent). |
| >50 commits | Checks query chunked at 50 SHAs; a failed chunk costs only its own glyphs. |
| >10 pages of timeline | Stops at the cap, `truncated: true`, existing truncation row links to GitHub. Newest *events* are not fetched; **`comments[]` is unaffected unless the top-up itself throws** — the top-up safeguard re-fetches the comment stream from the legacy unbounded endpoint whenever the fetch `stoppedShort` and the timeline prefix was comment-poor. |
| >200 events or >200 comments | Independent caps; `truncated: true`. `comments[]` is never shortened by event volume. Events keep the **newest** 200 (`slice(-cap)`), unlike `mergeThread`'s head-slice. |
| Only events were capped, comments complete | `truncated: true` — the flag means "not showing you everything", not "comments were cut". Existing copy at `github.tsx:661` already reads correctly. |
| Issue (not PR) | No `committed`/`merged`/`head_ref_force_pushed` events exist; reviews call skipped as today. |
| PR with commits but no comments | Renders — the empty guard counts both streams. |
| `CEZ_DRY_RUN=1` | `mockGithubComments` serves fixture events including a mixed-state commit group. |
| No `gh` / no remote / offline | Unchanged: `{available: false, reason}` per the AGENTS.md GitHub rule. |

## Risks & Impact Review

**Blast radius.** One server module (`forge/github.ts`), two type files, one route (response only), one component. No state files, no CLI surface, no runner seam.

**`BACKWARD_COMPATIBILITY.md` §2.** `GET /api/github` is a protected surface (`:31`), and both `src/server/github.ts:1-9` and `forge/types.ts:22-23` annotate `ForgeItem` "do not reshape". Every change here is additive: `events?` is a new optional field, `ForgeComment.kind` does not widen (Q7), and `comments[]` keeps its exact shape, contents **and cap**. That last guarantee rests on three things, not one — the same normalizer over the same source rows (Q1), the two-*independent*-entry-caps rule, and the comments top-up safeguard that repairs the one case where the shared *fetch* budget would otherwise shorten the array (all three in §Architecture). The one stated exception is a top-up that itself throws, where `comments[]` may be short — disclosed rather than papered over, and no worse than omitting the safeguard entirely. No field or content is removed, so §2's required path is satisfied without a deprecation window.

**Housekeeping the spec must land:** `GET /api/github/comments/:kind/:number` postdates the §2 route inventory (`BACKWARD_COMPATIBILITY.md:31`, under the §2 heading at `:17`) and is **not currently listed** there. It gains a second consumer contract in this work and must be added in the same PR.

**And the cause, not just the instance.** That route drifted out of the inventory because nothing checks. The repo has no `lint` script, no markdown linter and no link checker, so every claim in `BACKWARD_COMPATIBILITY.md` is unenforced prose — the next route will drift the same way. Phase 3 therefore adds a unit test asserting that every `/api/*` route registered in `server.ts` appears in the §2 inventory, which would have caught this omission when it happened and costs one test.

**Rollback.** Revert the PR; the endpoint returns to comments-only and the client's `events ?? []` renders an empty event set. No data to migrate back, no state written, no user-authored file touched. There is **no runtime kill switch** — a `CEZ_*` flag is declined on merit (see §Zero config below), so rollback means a revert, not a toggle. (The timeline fallback path is a failure handler, not an operator control.)

**Zero config.** No new `CEZ_*` flag, no new setting, no `.env.example` delta — and the reasoning matters, because `AGENTS.md:14` is mandatory, not permissive: *"Features that widen exposure or cost (network, other processes) are opt-in behind a `CEZ_*` flag, off by default — the zero-config default is also the safe default."*

The claim here is that **this work does not widen exposure**, so the rule's trigger never fires. Opening a thread already spawns `gh` and already talks to the GitHub API using the user's existing auth. Phase 1 is one call for one — `/timeline` replaces `/comments`. Phase 2 adds a rollup query to the *same* host, over the *same* credential, from the *same* binary, only when a thread with commits is opened. No new network destination, no new process class, no new permission, no new data leaving the machine. That is a cost *shift*, not a widened exposure — the same reason the existing `/pulls/{n}/reviews` call at `:458` never needed a flag.

Had this reached for a new host, a new credential, or background polling, the rule would fire and a flag would be mandatory. It doesn't, so the zero-config default stands on `AGENTS.md:13` — "discover it, or default it."

**Performance.** Phase 1 trades one unbounded `gh` spawn for up to ten bounded ones sharing a single 15 s budget: more subprocesses, the same latency ceiling, and a bounded page count where today has none. On the common thread — under one page — it is genuinely one call for one. The comments top-up adds a second spawn on threads past ~1000 timeline rows, and by design fires on most of them rather than a rare few (see §Architecture); the cost is bounded, behind the 60 s LRU, and bought deliberately to keep the §2 guarantee intact in every case but a thrown top-up. Phase 2 adds **one** subprocess call per opened thread that contains commits — the batched rollup query — behind the existing 60 s LRU, so the cost is per-thread-open, not per-render. The `gh repo view` handle lookup is memoized per `repoRoot` (see §Architecture) and so costs once per process, not once per thread; it is the same lookup `fetchGithub` already pays at `:212`.

## Phasing

- **Phase 1 — timeline fetch + event rows** (shippable alone): timeline endpoint, event model, `normalizeEvents`, client-side interleave, `EventRow`. Commits render without CI glyphs.
- **Phase 2 — CI markers + commit grouping** (shippable alone on top of 1): handle resolution, batched rollup query, glyphs on commit rows, client-side run collapsing with expander.
- **Phase 3 — polish + hardening** (shippable alone on top of 2): refresh-invalidation fix, dry-run fixtures, type pins, e2e coverage, §2 route-inventory update.

## Implementation Plan

**Phase 1 — timeline fetch + event rows**

1. `src/server/forge/types.ts`: add `ForgeTimelineEventKind` / `ForgeTimelineEvent`; add optional `events?` to `ForgeCommentsData`. Leave `ForgeComment` untouched. Re-export both through `src/server/github.ts` (the shim `api-types.test.ts:76` imports from). Typecheck only — no behavior change.
2. `src/server/forge/github.ts`: add `ghTimelineEventSchema` beside `ghIssueCommentSchema` (`:342`) — plain `z.object`, extras stripped, loose `event: z.string()`, optional kind-specific fields. Add `TIMELINE_EVENT_KINDS` (the Q2 allowlist, excluding `reviewed` per Q3) and the four new constants: `TIMELINE_EVENT_CAP = 200`, `TIMELINE_MAX_PAGES = 10`, `TIMELINE_BUDGET_MS = 15_000` and `TIMELINE_MIN_PAGE_MS = 2_000` (the last three drive the bounded page loop — see §Architecture). Unit tests: unknown event types parse then drop rather than throw; `reviewed` excluded; extras stripped (assert `author.email` is absent from the parsed object).
3. `src/server/forge/github.ts`: add `normalizeEvents(rows)` returning `{ events, truncated }` — like `mergeThread`, because the cap is applied inside and the caller has no other way to learn it fired (`events.length === 200` is ambiguous on a thread with exactly 200) — allowlist filter, **per-type timestamp resolution** (`committed` → `author.date`, default → `created_at`), per-type actor resolution (`committed` → git author name, default → `actor.login`), kind-specific field mapping, 120-char message cap, `evt-${id ?? sha ?? node_id ?? index}` id resolution (see §Data Model "Event identity"), then **`slice(-TIMELINE_EVENT_CAP)` — keep the newest, not `slice(0, cap)`**. Drop events with no resolvable timestamp. Unit tests: one per event kind against fixtures captured from a real timeline; a dedicated test asserting `committed` lands at `author.date` and never `null`; a test asserting `author.date` arrives UTC-normalized (`Z`); id uniqueness *and stability across a refetch that prepends an event*; cap keeps the newest window, not the oldest.
4. `src/server/forge/github.ts`: in `fetchGithubComments` (`:443-474`), replace the `:455` call with a **manual 10-page loop** over `/issues/{n}/timeline?per_page=100&page={n}`, passing `-H "Accept: application/vnd.github+json"` (per #525 step 2) — **not** `--paginate`, which has no page cap (see §Architecture "Pagination") — stopping early on a short page. **Pass each page the remaining share of one 15 s `TIMELINE_BUDGET_MS`** via `gh()`'s third argument, not the per-call default, or the loop's ceiling becomes 150 s (see §Architecture, "The page loop shares one time budget"). Stop cleanly when the remainder drops below `TIMELINE_MIN_PAGE_MS` rather than spawning a page that cannot finish, and **scope the fallback to page 1**: a failure on any later page keeps the pages already fetched and sets `truncated`. Split rows — `event === 'commented'` through the existing `normalizeComments` (`:371`), the rest through `normalizeEvents`. Keep the `:458` reviews call unchanged. Wrap the timeline fetch in its **own inner** try/catch — *not* the function's existing outer one, whose `/404|not found/i` branch (`:465-473`) would otherwise turn a timeline 404 into an empty thread (see §API Contracts, "The catch must be scoped inside the existing one") — falling back to the old comments call on **every endpoint-level failure including 404**; skip the fallback **only** on `ENOENT` (no `gh` binary), per the degradation table in §API Contracts. Apply the **comments top-up safeguard**: when the fetch stopped short *and* fewer than `THREAD_ENTRY_CAP` `commented` rows were seen, re-fetch via the legacy `/issues/{n}/comments --paginate` and use that in place of the timeline's `commented` rows, so the shared fetch budget cannot shorten `comments[]` (except via the swallowed-throw case immediately below) (see §Architecture, "The page cap is a combined budget"). **A top-up that throws is swallowed** — keep the timeline's own `commented` rows and carry on; it must never fall through to the fallback (which is the same call) or to the outer catch (which would empty the thread). Set `truncated` when **any** of the three triggers fires: the fetch `stoppedShort` (page cap, budget floor, or a page ≥ 2 failure), `normalizeEvents` reports its cap fired, or `mergeThread` reports the pre-existing comments+reviews cap — OR-folded exactly as `:462` does today, so the existing >200-comments trigger is preserved rather than replaced. Unit tests: split correctness; **`comments[]` byte-identical to pre-change output for the same input** (the §2 guarantee); **a timeline 404 still returns populated `comments[]` with `available: true`**; **a page-capped, comment-poor timeline prefix still returns the full pre-change `comments[]`** (the top-up); **a throwing top-up still returns the timeline's `commented` rows with `available: true`**; `ENOENT` spawns no second call; page-cap and budget-exhaustion truncation.
5. `src/server/forge/github.ts`: leave `mergeThread` (`:409-416`) **unchanged** — it keeps capping comments+reviews at 200 exactly as today. Events are returned as their own array; no server-side interleave. Unit test: `mergeThread`'s output is unaffected by event volume.
6. `web/app/src/api/types.ts`: mirror `GithubTimelineEvent` and optional `events` on `GithubCommentsData` (`:513-532`).
7. `web/app/src/routes/github/github.tsx`: add `EventRow` (compact single-line, `data-kind` on the `<li>`); add a client-side interleave (stable sort on `createdAt`) over `comments` + `events ?? []` and map the result at `:649-651`; thread `labelColors` from `GithubDetail` (`:322`) into `GithubThread` (`:590`); retitle the header (`:646`) to `Activity · N comments`; change the empty guard (`:638`) to count both streams. Component tests: one render case per event kind; interleave ordering; label chip colored; header text; **a PR with events but zero comments renders rows** (the H4 case).

**Phase 2 — CI markers + commit grouping**

8. `src/server/forge/github.ts`: resolve the repo handle in `fetchGithubComments` via `gh repo view --json nameWithOwner --jq .nameWithOwner` + the exported `parseOwnerName` (`:185`), mirroring `fetchGithub` (`:212-213`), and **memoize it in a module-level `Map<repoRoot, OwnerName>`** — stable in practice, and keyed per `repoRoot` for multi-project forward-compatibility (see §Architecture). Degrade to no checks when the slug is not a clean two-part name. **Cache only permanent negatives** (a parse that yields no clean two-part name); a *thrown* `gh` failure is transient and must not be cached, or one blip disables glyphs until restart. Unit tests: handle parsed; second call is served from the memo and spawns no subprocess; malformed slug caches its negative and is not retried; a thrown `gh` failure is not cached and the next call retries.
9. `src/server/forge/github.ts`: add `fetchCommitChecks(repoRoot, owner, name, shas)` — batched aliased GraphQL (`c{i}: object(oid:)`), chunked at 50 SHAs, adapting each single `statusCheckRollup.state` enum into the array shape `rollupToChecks` (`:82`) expects (`[{state}]`) so the existing vocabulary is reused rather than duplicated. try/catch → empty map. Unit tests: alias mapping; unknown-SHA `null`; chunk boundary at 50; the `rollupToChecks` adapter; degrade-on-failure.
10. `src/server/forge/github.ts`: call it when `committed` events exist; attach `checks` per SHA. Unit test: events carry `checks`; on failure events still return with `checks` absent (asserting absent, not `null`).
11. `web/app/src/routes/github/github.tsx`: render the CI glyph on commit rows reusing `CHECKS_GLYPH`/`CHECKS_TONE` (`:746-751`). Component tests: glyph per state; no glyph when `checks` is absent and when `null`.
12. `web/app/src/routes/github/github.tsx`: collapse consecutive same-author `committed` runs client-side; expander `<button>` with `aria-expanded`. Unit tests on the grouping helper: author change ends a run; a non-commit event interrupts a run; a single commit is not grouped. Component test: collapsed render, expand reveals per-commit messages **and** per-commit glyphs.

**Phase 3 — polish + hardening**

13. `web/app/src/routes/github/github.tsx:112-120`: fix the refresh mutation to also invalidate open `queryKeys.githubComments` keys (`queries.ts:72`). Component test asserting both invalidations.
14. `src/server/forge/github.ts`: extend `mockGithubComments` (`:478`) with fixture events — a mixed-state commit group, a label change, a cross-reference, a merge — so `CEZ_DRY_RUN=1` demos the feature offline. Fixture SHAs must be full 40-char (Q4).
15. `src/server/api-types.test.ts`: pin `GithubTimelineEvent` / `GithubCommentsData` type-exact with `satisfies Exact<>` alongside the existing `GithubItem`/`GithubData` pins (`:121-122`), closing the drift gap the sibling spec left open for `ForgeComment`.
16. `src/server/github-comments-api.test.ts`: extend the dry-run route assertions (`:43`, `:55`) to cover `events[]` and the unchanged `comments[]` shape.
17. `BACKWARD_COMPATIBILITY.md` §2: add **all three** currently-missing routes to the inventory (`:31`, under the §2 heading at `:17`) — `GET /api/github/comments/:kind/:number` (`server.ts:1433`), `GET /api/worktrees` (`:1220`) and `POST /api/worktrees/reclaim` (`:1243`) — and note `events?` as an additive field. Only the first is this spec's own doing; the other two are pre-existing drift that step 18's guard would otherwise fail on. Fixing them here is what makes the guard shippable in the same PR.
18. `src/server/api-types.test.ts` (or a sibling): add the drift guard — a test asserting every `/api/*` route registered in `server.ts` appears in the §2 inventory. Sizing, so this is not underestimated: `server.ts` registers **54 handlers over 48 distinct `/api/*` paths** (54 `app.<method>` registrations — a naive grep finds 55, because the 55th is the `app.use('/api/health', …)` CORS middleware at `:431`, which is not a route), while §2 lists **30 distinct literal strings** (32 occurrences — `/api/runs/:id` is listed three times, once each for GET/PATCH/DELETE), three of which are brace-compressed groups — `/api/repo/{diff,changes}`, `/api/runs/:id/{cancel,…,git/push}` (11) and `/api/runs/:id/{handoff,…,events}` (6) — expanding to 19 sub-paths, one of which (`/api/runs/:id/events`) also appears standalone and dedupes away → 45 covered. The test therefore needs a small brace-expander, not a substring match, and must normalize path params. With step 17's three additions it goes green on the current tree. This is the guard that would have caught the comments-route omission when it happened.
19. `web/app/e2e/github.e2e.ts`: add thread coverage — currently **none** exists (the sibling spec's step 9 called for it and it never landed). Assert a dry-run thread renders comments, a commit row, and a CI glyph.
20. Full gate: `npm run typecheck && npm test && npm run test:unit && npm run build && npm run test:package`, plus `npm run test:e2e`; manual pass under `CEZ_DRY_RUN=1 npm run dev` with a screenshot for QA evidence.

## Out of scope

- Per-check drill-down (individual check names, conclusions, logs) — the badge already deep-links to `${item.url}/checks` per #415; this spec adds a rolled-up glyph per commit only.
- Posting, editing, or reacting to timeline items — the tab stays read-only, per the sibling spec.
- Inline diff-anchored PR review comments and review-thread resolution state — still deferred to a future diff view.
- Background polling / webhooks for live timeline updates — the 60 s TTL + manual refresh model is unchanged.
- Renaming `GET /api/github/comments/:kind/:number` to something timeline-accurate, or adding a `/timeline` alias — a §2 route change for cosmetics; revisit only if a second consumer appears.
- Rendering `subscribed`, `mentioned`, `review_requested` and other events github.com also omits from the conversation view.
- Reactions on comments, and events GitHub hides behind its own "load more" pagination.
