# Linked-PR chips on the GitHub Issues list

## 📝 TLDR

Each row of the cockpit's GitHub **Issues** list gains a clickable `↗ PR #123` chip when a pull request is linked to that issue, tinted by the PR's state (open / merged / closed). The links come from GitHub's real issue↔PR relationships, fetched lazily for the on-screen row window via a new `GET /api/v1/github/issue-prs` endpoint — an additive sibling of the existing lazy checks-glyph endpoint (#664), so the one-shot list fetch stays untouched. The signal lets a triager see, without leaving the cockpit, that an issue already has a PR in flight before handing it to an agent.

## 📝 Problem Statement

On the Issues list (`packages/web/src/routes/github/github.tsx`, the `GithubRow` meta line) there is no way to tell whether an issue already has a pull request. The cockpit's entire job is triaging issues and dispatching agents at them; without this signal a user can hand an agent an issue that is already being worked, wasting a run. Evidence it matters, measured live on `open-mercato/cezar`: **37 of 55 open issues already have a linked PR** — and **22 of those 37** have *only* merged/closed linked PRs (this workflow routinely merges/closes a PR while the issue stays open — follow-ups, partial fixes, reopened issues, or the closing keyword was not used). So the question "is there already a PR for this?" is constant, and the merged/closed case is the majority, not a tail.

## 📝 Proposed Solution

Render a clickable chip per linked PR on each issue row, sourced from GitHub's authoritative issue↔PR links and tinted by PR state. Mirror the established **lazy-hydration** pattern the checks glyphs use (#664): the fast one-shot `GET /api/v1/github` list fetch is *not* extended; instead a new windowed endpoint hydrates the links for the ~100 on-screen rows only, exactly as `GET /api/v1/github/checks` does for PR CI glyphs. The chip links to the cockpit's own PR view (`/github/prs/:n`) when the PR is in the loaded open set, else to the PR on GitHub.

**Alternatives considered and why they lost** (carried from the brainstorm brief, committed beside this spec):

- **cezar's own runs store** (`useRuns()` — each run already carries `issueNumber` + a resolved PR url, free and instant client-side): rejected as the source of truth because it is blind to PRs opened by hand or by any tool other than cezar. It remains a possible *instant-paint* enhancement (see Non-goals / Phasing).
- **Invert the already-fetched open PRs' `closingIssuesReferences`** (near-zero cost — the list already holds every open PR): rejected because it only sees *open* PRs, and the measurement shows ~60% of linked-PR issues here have only merged/closed PRs. It cannot satisfy the "merged/closed counts" requirement. (It is also not available via the `gh` CLI `--json` surface — `gh pr list --json closingIssuesReferences` errors — so it would need GraphQL regardless.)
- **Build nothing**: rejected — the GitHub web UI shows this, but the cockpit is where issues are triaged and dispatched; context-switching to github.com to check defeats the purpose of the tab.

## 📝 Architecture

One additive vertical slice, structurally identical to the checks-glyph slice (#664). Nothing existing is reshaped.

**Data flow.** `GithubRoute` (issues view) derives the on-screen issue-number window → `useGithubIssuePrs(numbers)` → `getGithubIssuePrs` (typed hono client) → `GET /api/v1/github/issue-prs?issues=…` → `fetchGithubIssuePrs(repoRoot, numbers)` (forge) → one GraphQL query over the issues' `timelineItems` → `{ available, links: Record<number, LinkedPr[]> }`. `GithubRow` renders a `LinkedPrChip` per link.

Components, and what changes vs. what is reused:

| Layer | File | Change |
|---|---|---|
| Contract | `packages/contract/src/github.ts` | **New** `linkedPrSchema` + `githubIssuePrsDataSchema` (discriminated union on `available`, mirroring `githubChecksDataSchema`). No change to the §2-protected `githubItemSchema`. |
| Forge | `packages/cezar/src/server/forge/github.ts` | **New** `fetchGithubIssuePrs(repoRoot, numbers, refresh?)` + `GH_ISSUE_PRS_MAX`, a per-issue `issuePrsCache` (60s TTL, mirrors `checksCache`) that `refresh` bypasses, a `mockGithubIssuePrs` **`CEZ_DRY_RUN=1` branch** (mirrors `fetchGithubChecks`'s guard at `:1087` + `mockGithubChecks` at `:1132`, so the offline demo and the e2e suite show chips), a test-only `__clearIssuePrsCacheForTests()` hook (matching the file's `__…ForTests` convention — the three existing hooks are `__clearChecksCacheForTests` / `__clearCommentsCacheForTests` / `__clearRepoHandleCacheForTests`), and the aliased GraphQL builder. Reuses the injected `runGraphql`; uses the cached `resolveRepoHandle` **instead of** `fetchGithubChecks`'s inline `gh repo view` (`:1099`) — a deliberate improvement (one fewer subprocess per window), not a mirror of the sibling. |
| Route | `packages/cezar/src/server/server.ts` | **New** chained `.get('/github/issue-prs', …)` link in the same family as `/github/checks`, same `issues` CSV validation shape, plus an optional `refresh` flag. |
| Client | `packages/web/src/api/client.ts` | **New** `getGithubIssuePrs(numbers, opts)` next to `getGithubChecks` (`:676`), going through `cez.api.v1.p[':projectId'].github['issue-prs'].$get` with `unwrap(...)` exactly as the sibling does. **`packages/api-client` is NOT touched** — it holds only the generic `hc` factory (`createCezarClient`) and deliberately no per-endpoint fetchers (it must stay usable without the server package); the new `LinkedPr` / `GithubIssuePrsData` types reach the web app for free via its `export * from '@open-mercato/cezar-contract'`. |
| Web query | `packages/web/src/api/queries.ts` | **New** `useGithubIssuePrs(numbers, enabled)` + `queryKeys.githubIssuePrs`. |
| Web UI | `packages/web/src/routes/github/github.tsx` | Window derivation (`issuePrNumbers`, mirrors `checkPrNumbers`), the hook wired for `view === 'issues'`, and a `LinkedPrChip` on the `GithubRow` meta line; list-refresh invalidation extended. |

**Boundary / degradation.** The route degrades *in the payload* (`{ available: false, reason }`), never a 5xx — the GitHub-family law in `AGENTS.md` and the sibling endpoints. The chip is purely additive to the row; an unavailable or empty payload renders no chip, exactly as a checks-less row shows no glyph.

## 📝 Data Model

No persistence. One new wire shape (additive; new route added to `BACKWARD_COMPATIBILITY.md` §2 route inventory per the route-inventory test).

```ts
// packages/contract/src/github.ts
/** One pull request linked to an issue (GitHub timeline: connected or cross-referenced). */
export const linkedPrSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(['open', 'merged', 'closed']),
  isDraft: z.boolean().optional(),
});
export type LinkedPr = z.infer<typeof linkedPrSchema>;

/**
 * `GET /api/v1/github/issue-prs?issues=…` — lazy issue→linked-PR map, `number → LinkedPr[]`,
 * hydrated for the on-screen issue rows only (sibling of `/github/checks`, #664). An absent
 * number means "no linked PRs / not found". Links are deduped by PR number and ordered
 * open → merged → closed, then by descending number.
 */
export const githubIssuePrsDataSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), links: z.record(z.number(), z.array(linkedPrSchema)) }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type GithubIssuePrsData = z.infer<typeof githubIssuePrsDataSchema>;
```

## 📝 API Contracts

**`GET /api/v1/github/issue-prs?issues=<csv>`** — mirrors `/github/checks` exactly:

- `issues`: comma-separated positive integers, required (`z.object({ issues: z.string().min(1) })`), each validated `Number.isInteger && > 0 && String(n) === part`; empty or `> GH_ISSUE_PRS_MAX` (100) parts → `400 { error: 'invalid issues query' }`; `?issues=` alone → `400 missing issues query`.
- `refresh` (optional, `refresh=1`): busts the per-issue cache for the requested numbers, mirroring `/github/comments/:kind/:number`'s `refresh` param. This exists because the flagship scenario is "an agent **just** opened a PR for this issue" — without it, the list header's Refresh re-runs the client query but is handed the same ≤60 s server cache, so the new chip would not appear for up to a minute even on an explicit refresh. (`/github/checks` has no such param; this endpoint adds it precisely because its staleness is more user-visible.)
- 200 always on a reachable-but-degraded forge: `{ available: false, reason }` when `gh`/remote/handle is missing.
- 200 happy: `{ available: true, links }` where `links[n]` is present only for issues that have ≥1 linked PR.

**Forge GraphQL** — **one** query over the requested issue numbers, one `issue(number:)` **alias per number** (batched exactly like `prChecksQuery`'s `p${i}: pullRequest(number: ${n})` at `forge/github.ts:1000`, so the whole window is a single round-trip). A bare repeated `issue` field is not a valid document — the aliases (`i0`, `i1`, …) are what make it runnable:

```graphql
repository(owner:$owner, name:$name) {
  i0: issue(number: N0) {
    timelineItems(last: 30, itemTypes: [CONNECTED_EVENT, DISCONNECTED_EVENT, CROSS_REFERENCED_EVENT]) {
      nodes {
        __typename
        ... on ConnectedEvent      { subject { __typename ... on PullRequest { number url state isDraft } } }
        ... on DisconnectedEvent   { subject { __typename ... on PullRequest { number } } }
        ... on CrossReferencedEvent { source  { __typename ... on PullRequest { number url state isDraft } } }
      }
    }
  }
  # i1: issue(number: N1) { … }   — one alias per requested issue number
}
```

Processing per issue: keep only `PullRequest` subjects/sources (issue↔issue references are dropped), map GitHub `OPEN|MERGED|CLOSED` → the schema's `open|merged|closed`, dedupe by PR number (a PR seen as both connected and cross-referenced collapses to one entry), and **subtract any PR number carried by a `DisconnectedEvent`** so a deliberately-unlinked PR stops showing a chip. Then order open → merged → closed, then by descending number.

**Why `last: 30`, not `first: 30`.** The `timelineItems` connection is a single stream of *all three* event types, and `first` would take the **oldest** thirty — on a long-lived, heavily-cross-referenced issue (exactly the kind most likely to already have a PR) the oldest thirty can be entirely issue↔issue mentions, and the row would render no chip while a real PR sits just outside the window. `last: 30` holds the **most recent** references, so a newly opened PR — the case the feature exists to surface — is always in scope. The bound that matters is *total connected/disconnected/cross-referenced events*, not linked-PR count; 30 of those is reachable, so the result is **best-effort under the cap, not exhaustive** (see Edge Cases). No `truncated` signal is surfaced (display-only).

## 📝 UI/UX

`LinkedPrChip` on the `GithubRow` meta line (the `pl-[22px]` row that already holds `#num · author · age · 💬 · checks-glyph · run-queued`), after the comment count:

- Label `↗ PR #123`; monospace, sits inline with the existing meta glyphs.
- **State tint** (reusing existing tokens): open → `text-success` (green); merged → a merged/purple tone (`text-violet`); closed-unmerged → `text-danger`/muted. A **draft** open PR (`isDraft: true`) renders a muted/outlined variant of the open tint — it is a materially weaker "someone is on this" signal, and this is the one consumer of the contract's `isDraft` field (so `contract-parity.github.test.ts` sees the handler actually emit it). A `title` gives the full state word (`draft` when applicable).
- **Link target**: internal `/github/prs/:n` when the PR number is in the loaded open set (`gh.prs`) — instant in-cockpit navigation; else the PR's GitHub `url` (`isHttpUrl`-guarded, `target="_blank"`), since merged/closed PRs are outside the open set.
- **DOM structure — no nested anchors.** `GithubRow` renders the whole row inside one react-router `<Link>` (`github.tsx:513-556`), and an `<a>` inside an `<a>` is invalid HTML and a WCAG 4.1.2 (nested interactive) failure — the Vite SPA has no SSR, so React would emit the nested pair rather than the parser rejecting it, shipping broken-but-silent. **Chosen structure:** make the `<li>` the positioning context, render the row `<Link>` as a stretched-link overlay (`absolute inset-0`, `aria-hidden` decorative wrapper avoided — the link keeps the row's accessible name) behind the content, and render the chips as **ordinary sibling `<a>`s stacked above it** (`relative z-10`). This keeps exactly one interactive element per region, needs **no `stopPropagation`** (the chips are siblings of the overlay, not descendants), and preserves each chip's own `aria-label`. (There is no in-repo precedent for a nested anchor; the nearest pattern, `hand-to-agent.tsx:485`, is a `<button>` inside a cmdk `div`, not an `<a>`.)
- **Multiplicity**: render up to **3** chips inline (open first), then a `+N` overflow chip linking to the issue's GitHub page. Most issues have one.
- **States**: loading → no chip (the row paints immediately; the chip fills in a beat later like the checks glyph, no skeleton); none → nothing; unavailable → nothing.
- **Accessibility**: each chip is a focusable link with an `aria-label` like `Pull request #123, merged`. The `↗` is `aria-hidden`.

Detail pane (right side) is **out of scope** — this spec is the issues *list* row only.

**Visuals** (attached to the spec PR): the list today, `assets/issue-linked-pr-chip/current-01-issues-list.png`; the proposed row with state-tinted chips, `assets/issue-linked-pr-chip/mockup-01-issues-list.png` (source: `mockup-01-issues-list.html`).

## 📝 Edge Cases & Failure Scenarios

- **Forge degraded** (`gh` missing / offline / no remote): `{ available: false }` → no chips; the list itself already shows its own unavailable state.
- **Rate limit / GraphQL error** on the windowed fetch: React Query surfaces an error for that query only; rows render without chips (never blocks the list). Server catches and returns `{ available: false, reason }`.
- **Cross-repo / transferred PRs**: `url` is authoritative for navigation; the in-cockpit link is used only when the number is in *this* repo's open set, avoiding a wrong-repo `/github/prs/:n`.
- **A PR linked to many issues / an issue linked to many PRs**: deduped by number; overflow beyond 3 collapses to `+N`.
- **Selected issue outside the row cap**: the URL-selected issue number is pinned into the window (mirrors `checkPrNumbers` pinning the selected PR), so a deep-linked row still hydrates.
- **Refresh**: the list header's refresh re-hydrates the issue-prs window **with `refresh=1`**, which busts the per-issue server cache — so a PR an agent opened seconds ago shows its chip immediately rather than after the ≤60 s cache expires. Without an explicit refresh the 60 s cache bounds staleness. (`__clearIssuePrsCacheForTests()` is the test-only seam, not a user path.)
- **A PR that was unlinked from the issue** (`DisconnectedEvent`): the original `ConnectedEvent` stays in the timeline forever, so reading only connected/cross-referenced events would keep the chip indefinitely. The fetch subtracts PR numbers carried by a `DisconnectedEvent` (see API Contracts) so an explicitly-unlinked PR loses its chip.
- **Window boundary (`last: 30`)**: results are best-effort under the 30-item-per-issue cap on total connected/disconnected/cross-referenced events. `last` makes the newest references win, so the miss case is only an issue with >30 more-recent non-PR references than PR ones — rare, and it fails safe (no chip, never a wrong one). The unit test feeds an injected `runGraphql` a timeline of 30 issue cross-references followed by a PR and asserts the PR is still found once `last` ordering is applied.
- **Bare `#N` mentions vs real links**: see Resolved assumptions Q1 — the inclusion rule is the connected + cross-referenced PR set (the measured definition), accepted as slightly broad in exchange for matching the counts users see on GitHub.

## 📝 Risks & Impact Review

- **Blast radius**: additive only — a new endpoint, a new query hook, a new chip. No change to any §2-protected shape (`githubItemSchema`, the list payload). The one hard requirement is registering the new route in `BACKWARD_COMPATIBILITY.md` §2 so `bc-route-inventory.test.ts` and the route-parity test pass (the route must be a chained `.get` link, mounted under both `/api/v1/github/...` and the `/p/:projectId/...` alias — `AGENTS.md`).
- **Cost**: one extra GraphQL round-trip per on-screen issue window (≤100 issues, one batched query), gated to the issues view, cached 60s per issue. This is the deliberately-accepted cost the user chose over the near-free-but-incomplete inversion; it never touches the fast list paint.
- **Rollback**: delete the slice; the row falls back to exactly today's meta line. No migration, no persisted state.
- **Risk rating, per artifact**: this *spec* PR ships only a document → `risk-low`. The *implementation* PR that follows adds a route, a contract schema, and a live GraphQL path → it is honestly `risk-medium` (the brief's original rating), and the implementing run should label it so. The two are not in conflict; they describe different diffs.

## 📋 Resolved assumptions (autonomous defaults)

The brainstorm brief's Resolved-unknowns table pre-answered the load-bearing questions (source = GitHub linked PRs; marker = clickable chip; states = open + merged/closed; fetch = per-issue `timelineItems`, lazily hydrated). The following were left open and are resolved here per the autonomous-defaults rule (most reversible, lowest blast radius). All are display-only and reversible; none weakens security or a compatibility contract, so none is marked `⚠ NEEDS HUMAN CONFIRMATION`.

| # | Open question | Resolved default | Rationale |
|---|---|---|---|
| Q1 | Inclusion rule: every referenced PR, or only closing/development-linked PRs? | Include PRs surfaced by **both** `CONNECTED_EVENT` and `CROSS_REFERENCED_EVENT` (subject/source is a `PullRequest`), deduped. | Matches the measured coverage (37/55) and what GitHub itself shows as "linked". Tightening later (to connected-only) is a one-line filter change — reversible; showing a real-but-loosely-linked PR is low-harm. |
| Q2 | Multiple linked PRs per issue: one chip, N chips, or a count? | Up to **3** inline chips (open first), then `+N` overflow → issue on GitHub. | Smallest surface that handles the common (one PR) and the rare (many) without a new expander component. |
| Q3 | Chip link target? | In-cockpit `/github/prs/:n` when the PR is in the loaded open set; else the GitHub `url`. | Reuses the existing PR view for the instant case; merged/closed PRs aren't in the open set, so they open on GitHub. No new detail fetch. |
| Q4 | Closed-unmerged PRs: show or hide? | **Show**, tinted distinctly from merged. | The user explicitly chose "open + merged/closed"; hiding closed would drop part of that. |
| Q5 | Per-issue timeline fetch depth? | `last: 30` over connected/disconnected/cross-referenced events, no `truncated` surfaced. | The bound is *total events of those types*, not linked-PR count; `last` keeps the newest references (a just-opened PR) in scope and fails safe (no chip, never wrong) when it overflows. See API Contracts "Why `last: 30`". |
| Q6 | Window size / cap? | `GH_ISSUE_PRS_MAX = 100`, same window and pinning as the checks glyphs. | Consistency with the on-screen hydration model already in the route. |

## 📋 Phasing

- **Phase 1 — the feature (this spec).** Contract → forge → route → client → query hook → row chip. Independently shippable and complete on its own.
- **Phase 2 (Non-goal here, future) — instant-paint from the runs store.** Optionally paint cezar-created PRs from `useRuns()` immediately, then reconcile with the GitHub-authoritative fetch, removing the one-beat hydration delay for cezar's own work. Deliberately deferred — it is an optimization, not required for the capability.

## 📋 Non-goals

- Extending the one-shot `GET /api/v1/github` list payload with linked-PR data — it stays lazy/windowed to preserve #664's fast paint.
- The runs-store instant-paint enhancement (Phase 2 above).
- A reverse feature (linked issues on PR rows), or linked-PR chips in the issue **detail** pane.
- Linked-PR chips on **closed** issues — the Issues list renders the open set only.

## 📋 Implementation Plan

Each step leaves the app working and is independently testable.

**Phase 1 — Linked-PR chips**

1. **Contract shape.** Add `linkedPrSchema` + `githubIssuePrsDataSchema` to `packages/contract/src/github.ts`; export `LinkedPr` / `GithubIssuePrsData`. *Test*: extend `packages/cezar/src/server/contract-parity.github.test.ts` with a `GithubIssuePrs200 = InferResponseType<typeof client.api.v1.github['issue-prs'].$get, 200>` mutual-assignability assertion alongside the existing `GithubChecks200` one (this is the compile-time guard, run by `npm run typecheck`, that keeps schema and handler exact — there are **no** tests under `packages/contract`, so there is nothing there to "mirror"). Runtime parse coverage of the happy + degraded payloads rides on the route test in step 3.
2. **Forge fetcher.** Add `GH_ISSUE_PRS_MAX`, `fetchGithubIssuePrs(repoRoot, numbers, refresh?)`, the aliased GraphQL builder (`i${i}: issue(number:)`, `last: 30`), the per-issue `issuePrsCache` (60s, `refresh`-bypassable), the `CEZ_DRY_RUN=1` guard returning a new `mockGithubIssuePrs` (synthesise links for a couple of the mock catalog's issues, mirroring `mockGithubChecks` at `:1132`), and the `__clearIssuePrsCacheForTests()` seam. Use the injected `runGraphql` and the cached `resolveRepoHandle`. *Test*: unit test with an injected `runGraphql` returning connected + cross-referenced + disconnected + non-PR + duplicate nodes, asserting dedup, state mapping, disconnected-subtraction, `last`-window ordering (the 30-references-then-a-PR case), and the `{ available: false }` degrade when the handle is missing (mirrors `fetchGithubChecks` tests).
3. **Server route.** Add the chained `.get('/github/issue-prs', …)` link beside `/github/checks` with the CSV `issues` validator, the cap, and the optional `refresh` flag. Register it in `BACKWARD_COMPATIBILITY.md` §2 (the inventory line, `§2` list). *Test*: a route test mirroring `packages/cezar/src/server/github-checks-api.test.ts` — the 400s (`missing`/`invalid issues query`), the happy `{ available, links }` shape, and the `refresh` path; the existing `route-parity` + `bc-route-inventory` suites must stay green (dual-mount + inventory).
4. **Typed client.** Add `getGithubIssuePrs(numbers, opts)` to `packages/web/src/api/client.ts` next to `getGithubChecks` (`cez.api.v1.p[':projectId'].github['issue-prs'].$get`, `unwrap(...)`). **Nothing to add to `packages/api-client`** — its `export * from '@open-mercato/cezar-contract'` already re-exports the new types. *Test*: extend `packages/web/src/api/client.test.ts` (which covers `getGithubChecks` at `:165`) with the new fetcher.
5. **Query hook.** Add `queryKeys.githubIssuePrs` and `useGithubIssuePrs(numbers, enabled)` to `queries.ts`, mirroring `useGithubChecks`. *Test*: covered via the component test below.
6. **Row chip + window wiring.** In `github.tsx`: derive `issuePrNumbers` (mirror `checkPrNumbers`, pin the URL-selected issue), call `useGithubIssuePrs(issuePrNumbers, view === 'issues')`, thread the resolved `links` into `GithubRow`, restructure the row to the **stretched-link overlay** (row `<Link>` as `absolute inset-0` on the `<li>`, chips as sibling `<a>`s at `relative z-10` — no nested anchors, no `stopPropagation`), and render `LinkedPrChip` (state tint incl. draft, in-set-vs-GitHub link target, `+N` overflow). Extend the list-refresh mutation to invalidate the issue-prs window (with `refresh=1`). *Test*: a `github.test.tsx` case asserting chip text, tint (incl. draft), `href`/route target, that clicking a chip navigates to the PR and **not** the row's issue, and no chip when links are empty/unavailable.
7. **E2E.** Add a `packages/web/e2e/github.e2e.ts` assertion that a chip renders on an issue row — enabled by the step-2 dry-run mock, since the whole e2e suite boots under `CEZ_DRY_RUN=1` (`packages/web/e2e/agent-browser.ts:54`).
8. **Validation gate.** Run the configured gate (`npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`) green before the PR is marked ready.
