# GitHub tab: comment counts + full comment threads (markdown & images)

Tracking issue: [#499](https://github.com/open-mercato/cezar/issues/499)

## TLDR

The GitHub tab lists issues and PRs but hides the conversation: comment counts are hard-coded to `0` server-side, and the detail view renders only the opening body. This spec adds (1) real comment counts with a comment icon on every issue/PR row and in the detail meta line, and (2) the full comment thread in the detail view — each comment rendered through the app's existing Streamdown `Markdown` component, which already renders images (Streamdown 2.x defaults to allow-all via rehype-harden), so screenshots in comments show up the moment the thread exists. A user triaging an issue in Cezar gets the whole context without opening github.com.

## Resolved questions (autonomous defaults)

Authored unattended; each default is overridable before implementation starts — comment on #499 to override.

- **Q1 — one spec or two?** Counts and threads ship as one spec: they share the fetch seam (`src/server/forge/github.ts`), the count badge is the entry point to the thread, and each lands as an independently shippable phase (counts alone are useful; threads alone would show a list users can't anticipate from the rows). Split verdict: cohesive, keep together.
- **Q2 — how to fetch counts without shipping bodies?** One extra `gh api graphql` call inside `fetchGithub` returning `number → totalCount` maps for open issues and PRs, merged into the existing items. `gh issue list --json comments` is off the table (it ships full comment bodies for every row — the reason counts are `0` today, `github.ts` L112).
- **Q3 — what does the count mean for a PR?** Conversation comments only (`comments.totalCount`), for both kinds. Review summaries appear in the thread but are not counted in the badge; the badge is a "there is discussion here" signal, not an accounting identity (GitHub's own bubble count may differ slightly on PRs with review comments — accepted).
- **Q4 — thread scope for PRs?** Conversation comments plus submitted reviews that carry a state or a body (APPROVED / CHANGES_REQUESTED / COMMENTED), merged chronologically. Inline diff-anchored review comments (`pulls/{n}/comments`) are **out of scope v1** — they belong in a diff view, not a flat thread; follow-up noted in Out of scope.
- **Q5 — images on private repos?** No server-side proxy in v1. Streamdown 2.5.0's default (allow-all image/link origins via bundled rehype-harden — verified in the installed package) renders GitHub-hosted images as-is; private-repo `user-attachments` redirects that require auth degrade to a broken-image placeholder with the comment's deep link still clickable. A `gh`-authenticated proxy is a named follow-up, not a blocker. Tightening the allow-all default to an origin allow-list is a **separate security-hardening decision** (it would regress currently-rendering non-GitHub images in task threads too) and is deliberately not bundled here.

## Problem Statement

`fetchGithub` deliberately omits the `comments` field (`gh … --json comments` ships every comment body for every row) and builds each `ForgeItem` with `comments: 0` (`src/server/forge/github.ts` L139, L155). The wire type and the detail view already have the field and the `{item.comments} comments` meta line (`web/app/src/routes/github/github.tsx` `GithubDetail`), so with real data the count is always falsy and never rendered. The thread itself is fetched nowhere. Practical effect: the hand-to-agent flow (`githubTaskPrompt`) and human triage both operate on the opening post only — for mature issues the decisive context (maintainer answers, repro confirmations, screenshots) is invisible in Cezar.

Markdown and image rendering need no new engine: the shared `Markdown` wrapper (`web/app/src/routes/task-thread/markdown.tsx`) wraps Streamdown 2.5.0, whose bundled rehype-harden defaults allow all image/link origins — issue-body images render today, and thread comments get the same treatment for free once they flow through the same component. The missing piece is purely the data: counts and thread bodies never reach the frontend.

## Proposed Solution

Three additive changes along the existing seams:

1. **Counts in the list fetch** — a fourth parallel call in `fetchGithub`: one GraphQL query for `comments { totalCount }` on open issues and PRs; merge into the flattened `ForgeItem[]`. Failure of this one call degrades to counts staying `0` — never fails the tab.
2. **Lazy thread endpoint** — `GET /api/github/comments/:kind/:number` shells to `gh api` for conversation comments (+ reviews for PRs), zod-validates, caches 60 s, and returns a normalized `ForgeComment[]`. Fetched by the web app only when a detail view is open.
3. **Rendering** — comment icon + count on rows and detail meta; a thread section under the body in `GithubDetail`, each entry rendered with the shared `Markdown` component unchanged (Streamdown's defaults already render markdown, code fences, and images).

Alternatives considered:
- *`--json comments` on the list calls* — rejected: N×full-bodies on every tab load; the current code comment exists precisely to prevent this.
- *Replacing `gh issue list`/`gh pr list` with one GraphQL query* — rejected for v1: rewrites a working, zod-guarded seam (`statusCheckRollup` mapping, label colors) for no user-visible gain; the extra counts query is additive and independently degradable.
- *Server-rendering markdown via GitHub's `/markdown` API* — rejected: returns raw HTML requiring `dangerouslySetInnerHTML` (banned pattern; none in the app today) and one network call per comment; Streamdown is already the app's markdown engine.

## Architecture

- **`src/server/forge/github.ts`** — owns everything `gh`: the new counts query inside `fetchGithub`, and a new `fetchGithubComments(repoRoot, kind, number)` with its own module-level cache — same 60 s TTL discipline as the list cache, but keyed `kind#number` and therefore **bounded**: a small LRU (cap ~50 threads, evict oldest) so a long browsing session cannot grow it without limit; `refresh=1` busts a key. `CEZ_DRY_RUN=1` returns mock threads for the fixture items so the tab stays demoable offline.
- **`src/server/forge/types.ts`** — `ForgeComment` added next to `ForgeItem`; `ForgeItem` itself is unchanged (the `comments: number` field finally carries real data — additive per `BACKWARD_COMPATIBILITY.md` §2).
- **`src/server/server.ts`** — one new GET route following the house pattern: zod `safeParse` on params, `{ error }` + 400 on garbage, availability degrade in the payload (never a 5xx for gh absence).
- **`web/app/src/api/`** — `ForgeComment`/`GithubCommentsData` mirrored in `types.ts`, `getGithubComments` in `client.ts`, `useGithubComments` in `queries.ts` (enabled only while a detail route is mounted; `staleTime` aligned with the 60 s server cache).
- **`web/app/src/routes/github/github.tsx`** — `MessageSquareIcon` (lucide, already the app's icon set) + count in `GithubRow`'s meta line and `GithubDetail`'s meta line; a `GithubThread` section under the body.
- **`web/app/src/routes/task-thread/markdown.tsx`** — **unchanged.** Streamdown 2.5.0's defaults (rehype-harden allow-all origins, no raw HTML execution) already cover the thread's markdown, code fences, and images; the 1.x `allowedImagePrefixes`/`allowedLinkPrefixes` props no longer exist in 2.x, and tightening via `allowedTags`/`rehypePlugins` is an explicit non-goal here (see Q5).

Data flow: tab mount → `GET /api/github` (now with real counts) → user opens `/github/issues/:n` → `useGithubComments` → `GET /api/github/comments/issue/:n` → `gh api` → cached, normalized thread → `GithubThread` renders each body via `Markdown`.

Zero-config check: no new config, no new env var, no new process. Network exposure is unchanged in kind — the server already shells to an authenticated `gh` for this tab, and the browser renders comment images exactly the way it already renders issue-body and task-thread images (Streamdown's existing defaults), only when the user views that content. Everything degrades: no `gh` → tab already reports `{ available: false }`; counts query fails → counts stay 0; comments fetch fails → thread section shows the one-line reason + "open on GitHub" link.

## Data Model

No persistent state — in-memory caches only (rebuilt on restart, consistent with the existing list cache; nothing under `.ai/cezar/`).

```ts
// src/server/forge/types.ts (additive)
export interface ForgeComment {
  id: number;
  author: string;              // login, '?' fallback
  avatarUrl?: string;          // https://avatars.githubusercontent.com/…
  createdAt: string;           // ISO
  body: string;                // markdown, sliced to 8_000 chars (same cap as item bodies)
  kind: 'comment' | 'review';  // review = PR review summary
  reviewState?: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  url: string;                 // html_url deep link
}

export interface ForgeCommentsData {
  available: boolean;
  reason?: string;             // when unavailable
  comments: ForgeComment[];    // chronological, oldest first
  truncated?: boolean;         // true when the thread exceeded the fetch cap
}
```

Counts query — **two independent paginated queries** (issues and pull requests need separate cursors; a single shared-limit query cannot paginate both), run in parallel and shaped for `gh api graphql --paginate`, which requires `pageInfo { hasNextPage endCursor }` plus an `$endCursor` variable:

```graphql
query ($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $endCursor, states: OPEN,
           orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number comments { totalCount } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

(and the mirror query on `pullRequests`). Page size 100 (GraphQL max); pagination is capped at 10 pages per kind — for the GUI's 1000-item background shot that covers everything, and rows beyond the window keep `comments: 0`, which the UI treats as "no badge", never an error.

## API Contracts

`GET /api/github/comments/:kind/:number` (new; additive — `GET /api/github` untouched)

- `kind`: `issue | pr` (zod enum); `number`: positive int (zod coerce). Invalid → `400 { error }`.
- `?refresh=1` busts the per-thread cache (same convention as `/api/github`).
- Response `200 ForgeCommentsData` always — gh missing/offline/private-repo-denied degrade to `{ available: false, reason, comments: [] }`.
- Sources: `gh api repos/{owner}/{repo}/issues/{n}/comments --paginate` (conversation — GitHub serves PR conversation comments from the issues endpoint too), plus for PRs `gh api repos/{owner}/{repo}/pulls/{n}/reviews`; reviews with an empty body **and** state `COMMENTED`/`PENDING` are dropped, the rest map to `kind: 'review'`. Merged and sorted by `createdAt`.
- Caps: first 200 thread entries, then `truncated: true`; each body sliced to 8 000 chars. Timeout 15 s.
- All `gh` JSON zod-validated at the boundary before normalization (house rule).

## UI/UX

- **Rows** (`GithubRow` meta line): `MessageSquareIcon` (12–13 px, muted) + count appended after the age — rendered only when `comments > 0`, so today's visual stays identical for quiet items. Same glyph+count in `GithubDetail`'s meta line replaces the current dead `{item.comments} comments` text.
- **Thread** (`GithubDetail`, under the body): section header `Comments · N`; each entry shows avatar (16 px, rounded; letter-fallback block when `avatarUrl` is absent or fails), author login, relative age (`shortAge`), review-state chip for reviews (reusing the existing tone tables — green approved / red changes requested), and the body via `Markdown`. Loading → the app's skeleton pattern; error → one-line reason + "open on GitHub ↗"; `truncated` → trailing "thread truncated — open on GitHub ↗" row.
- **Images/links**: no work needed — the shared `Markdown` component already renders images and links from any origin (Streamdown 2.5.0 default), which is exactly how issue-body images render today. Thread comments inherit it by using the same component.
- Accessibility: the icon gets `aria-label="{n} comments"`; thread entries are a semantic list; keyboard scroll works because it is plain document flow.
- Dark/light: avatars and chips inherit the existing token approach; no new colors beyond the tone tables.

## Edge Cases & Failure Scenarios

- **gh absent / unauthenticated / offline** — tab already degrades to `{ available: false, reason }`; the thread endpoint returns the same shape; UI shows the reason line. Never a crash, never a 5xx.
- **Counts query fails, list calls succeed** — log once, counts stay `0`; tab renders exactly as today.
- **GraphQL/REST rate limiting** — 60 s caches bound the call rate (one counts call per list refresh, one fetch per opened thread per minute); a 403 rate-limit response degrades like any gh failure.
- **Issue/PR closed or deleted between list and thread fetch** — gh 404 → `{ available: false, reason: 'not found on GitHub …' }`.
- **Private-repo image attachments** — `<img>` redirect requires auth the browser lacks → broken image; alt text and the comment's `url` deep link remain usable. Documented degrade (Q5), proxy follow-up noted.
- **Huge threads / bodies** — 200-entry cap + `truncated` flag; 8 000-char body slice (same cap as item bodies).
- **Malformed markdown / hostile content** — Streamdown sanitizes through rehype-harden: raw HTML never executes, scripts/iframes are stripped. Its 2.5.0 default does allow images/links from any origin (the app's existing posture for task threads and issue bodies); comment bodies are third-party-authored, so an external image can reveal the reader's IP to the image host — same exposure class as opening the issue on github.com, accepted per Q5, with origin-tightening named as a separate hardening follow-up. No `dangerouslySetInnerHTML` anywhere.
- **`CEZ_DRY_RUN=1`** — `mockGithub()` items already carry non-zero counts; a `mockGithubComments()` fixture returns a small thread (including one image-bearing and one review entry) so the whole feature is demoable and e2e-testable offline.

## Risks & Impact Review

- **Blast radius: small.** New endpoint + one extra parallel call in `fetchGithub`; `ForgeItem` shape untouched. Protected surfaces (`BACKWARD_COMPATIBILITY.md` §2: `GET /api/github`) only gain data in an existing field — additive.
- **`Markdown` untouched** — the task thread (the app's hottest render path) is bit-for-bit unaffected; the GitHub surface only adds call sites.
- **Perf**: counts add one subprocess to a three-subprocess parallel fetch; thread fetches are lazy and cached. The 1000-item background shot's GraphQL pagination is bounded (≤10 pages) and failure-tolerant.
- **Rollback**: revert the commit(s); no state files, no migrations, no config. Phases are independently revertable.

## Phasing

- **Phase 1 — counts + icons** (shippable alone): real counts in `/api/github`, badge on rows and detail meta, dry-run fixtures.
- **Phase 2 — comment threads** (shippable alone on top of 1): endpoint, client hook, thread UI with `Markdown` rendering.
- **Phase 3 — polish** (shippable alone on top of 2): avatars with letter fallback, review-state chips, truncation row, e2e coverage of the dry-run thread (image included — exercising the existing render path).

## Implementation Plan

**Phase 1 — counts + icons**
1. `src/server/forge/github.ts`: add `fetchCommentCounts` (GraphQL query above, `gh api graphql`, zod schema for the response, ≤10-page pagination) as a fourth `Promise.all` entry in `fetchGithub`, isolated so its rejection degrades to empty maps; merge counts into the issue/PR mappers (replace the two `comments: 0` literals). Unit tests: merge logic, degrade-on-failure, pagination cap (`test/unit/` pattern).
2. `web/app/src/routes/github/github.tsx`: `MessageSquareIcon` + count in `GithubRow` meta (render only when `> 0`) and in `GithubDetail` meta. Component test for both visibility states.
3. Verify `mockGithub()` counts flow end-to-end under `CEZ_DRY_RUN=1`; adjust the e2e smoke if it asserts on row meta.

**Phase 2 — comment threads**
4. `src/server/forge/types.ts`: add `ForgeComment` / `ForgeCommentsData`. `src/server/forge/github.ts`: `fetchGithubComments(repoRoot, kind, number, refresh)` — gh calls, zod boundary schemas, review filtering/mapping, chronological merge, 200-entry/8 000-char caps, 60 s keyed cache, `mockGithubComments()` for dry-run. Unit tests: normalization, review filtering, caps, cache, degrade.
5. `src/server/server.ts`: `GET /api/github/comments/:kind/:number` with zod param validation (400 on invalid), `refresh=1`, availability degrade in-payload. Re-export via `src/server/github.ts`. Route test alongside existing `/api/github` coverage.
6. `web/app/src/api/`: mirror types, `getGithubComments`, `useGithubComments` (enabled on detail mount, `staleTime: 60_000`).
7. `web/app/src/routes/github/github.tsx`: `GithubThread` under the body — list, skeleton, error line, review-state chips (existing tone tables), `shortAge`. Component tests: thread render, empty thread, error state.

**Phase 3 — polish**
8. `github.tsx`: avatar rendering with letter fallback; review-state chips wired to the existing tone tables; `truncated` trailing row. Component tests: avatar fallback, chip per review state, truncation row, and an image-bearing mock comment rendering an `<img>` through `Markdown`.
9. e2e: extend the dry-run smoke to open a mock issue detail and assert the thread (count badge → thread entries → image present).
10. Full gate: `npm run typecheck && npm test && npm run test:unit && npm run build && npm run test:package`; manual pass under `CEZ_DRY_RUN=1 npm run dev` (issue with mock thread + image), screenshot for QA evidence.

## Out of scope

- Posting, editing, or reacting to comments from Cezar (read-only view).
- ~~Inline diff-anchored PR review comments and review-thread resolution state~~ — shipped in the task Changes tab; see the follow-up note below. The flat GitHub-tab thread still shows review summaries only.
- Background polling/webhooks for live comment updates — the 60 s TTL + manual refresh matches the tab's existing sync model.
- A `gh`-authenticated server-side image proxy for private-repo attachments (named follow-up; revisit if private-repo usage shows up).
- Tightening Streamdown's allow-all image/link origins to an allow-list — a separate security-hardening decision affecting every markdown surface in the app (task threads included), to be specced on its own if pursued.
- Timeline events (labels, assignments, cross-references, commits).

## Follow-up (2026-11-25): inline review comments in the Changes tab

The Changes tab is the diff view this spec waited for. `GET /api/v1/github/prs/:number/review-comments`
(additive; contract `githubReviewCommentsDataSchema`) fetches `pulls/{n}/comments` through the forge
seam — bounded page loop under one time budget, zod boundary, 60 s LRU, `refresh=1`, in-payload
degrade, `CEZ_DRY_RUN=1` fixtures anchored on the mock agent's `notes.md`. Resolved state comes from
one best-effort GraphQL `reviewThreads(first: 100)` call and is absent when it fails or the thread
is past the first 100.

- Anchor: `path` + side (`RIGHT` → new, `LEFT` → old) + `line`. Replies group under their root by
  `in_reply_to_id`.
- A comment with no current line (outdated), a file-level comment, or one whose line is outside the
  task's displayed hunks is listed in a "not on this diff" group with its original line and a GitHub
  link — never dropped.
- Read-only: never editable or deletable, never part of the user's self-review draft, never sent to
  the agent.
- Line numbers are the PR head's. When the worktree has unpushed edits, a comment can sit on a
  shifted line; the GitHub link is the source of truth.
- A reclaimed worktree leaves the Changes tab empty (known gap, unchanged here), so the GitHub
  comments are not shown there either; the GitHub tab still shows the PR's conversation thread.
