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
| Forge | `packages/cezar/src/server/forge/github.ts` | **New** `fetchGithubIssuePrs(repoRoot, numbers)` + `GH_ISSUE_PRS_MAX`, a per-issue `issuePrsCache` (60s TTL, mirrors `checksCache`), a `resetGithubIssuePrsCache()` hook, and the GraphQL query builder. Reuses the existing `gh`/`runGraphql` injection, `resolveRepoHandle`, and cap/dedup helpers. |
| Route | `packages/cezar/src/server/server.ts` | **New** chained `.get('/github/issue-prs', …)` link in the same family as `/github/checks`, same `issues` CSV validation shape. |
| Client | `packages/api-client/src/client.ts` + `index.ts` | **New** `getGithubIssuePrs(numbers)` + exported `GithubIssuePrsData` / `LinkedPr` types. |
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
- 200 always on a reachable-but-degraded forge: `{ available: false, reason }` when `gh`/remote/handle is missing.
- 200 happy: `{ available: true, links }` where `links[n]` is present only for issues that have ≥1 linked PR.

**Forge GraphQL** — one query over the requested issue numbers via node aliases (batched like `prChecksQuery`), reading each issue's linked PRs:

```graphql
repository(owner:$owner, name:$name) {
  issue(number: N) {
    timelineItems(first: 30, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT]) {
      nodes {
        __typename
        ... on ConnectedEvent      { subject { __typename ... on PullRequest { number url state isDraft } } }
        ... on CrossReferencedEvent { source  { __typename ... on PullRequest { number url state isDraft } } }
      }
    }
  }
}
```

State maps GitHub `OPEN|MERGED|CLOSED` → the schema's `open|merged|closed`. Non-`PullRequest` subjects/sources (issue↔issue references) are dropped; PRs are deduped by number; a PR seen as both connected and cross-referenced collapses to one entry. Per-issue timeline cap of 30 items is sufficient (an issue with >30 linked PRs is not a real case); the `truncated` signal is not surfaced (display-only).

## 📝 UI/UX

`LinkedPrChip` on the `GithubRow` meta line (the `pl-[22px]` row that already holds `#num · author · age · 💬 · checks-glyph · run-queued`), after the comment count:

- Label `↗ PR #123`; monospace, sits inline with the existing meta glyphs.
- **State tint** (reusing existing tokens): open → `text-violet` (matches the PR icon tone); merged → a merged/purple tone; closed-unmerged → `text-danger`/muted. A `title` gives the full state word.
- **Link target**: internal `/github/prs/:n` when the PR number is in the loaded open set (`gh.prs`) — instant in-cockpit navigation; else the PR's GitHub `url` (`isHttpUrl`-guarded, `target="_blank"`), since merged/closed PRs are outside the open set. The chip is a real link nested in the row `Link`; clicking it must `stopPropagation` so it navigates to the PR, not the issue.
- **Multiplicity**: render up to **3** chips inline (open first), then a `+N` overflow chip linking to the issue's GitHub page. Most issues have one.
- **States**: loading → no chip (the row paints immediately; the chip fills in a beat later like the checks glyph, no skeleton); none → nothing; unavailable → nothing.
- **Accessibility**: each chip is a focusable link with an `aria-label` like `Pull request #123, merged`. The `↗` is `aria-hidden`.

Detail pane (right side) is **out of scope** — this spec is the issues *list* row only.

## 📝 Edge Cases & Failure Scenarios

- **Forge degraded** (`gh` missing / offline / no remote): `{ available: false }` → no chips; the list itself already shows its own unavailable state.
- **Rate limit / GraphQL error** on the windowed fetch: React Query surfaces an error for that query only; rows render without chips (never blocks the list). Server catches and returns `{ available: false, reason }`.
- **Cross-repo / transferred PRs**: `url` is authoritative for navigation; the in-cockpit link is used only when the number is in *this* repo's open set, avoiding a wrong-repo `/github/prs/:n`.
- **A PR linked to many issues / an issue linked to many PRs**: deduped by number; overflow beyond 3 collapses to `+N`.
- **Selected issue outside the row cap**: the URL-selected issue number is pinned into the window (mirrors `checkPrNumbers` pinning the selected PR), so a deep-linked row still hydrates.
- **Refresh**: the list header's refresh invalidates the issue-prs window (like it re-hydrates the checks window), and `resetGithubIssuePrsCache()` is available; the per-issue 60s cache otherwise bounds staleness.
- **Bare `#N` mentions vs real links**: see Resolved assumptions Q1 — the inclusion rule is the connected + cross-referenced PR set (the measured definition), accepted as slightly broad in exchange for matching the counts users see on GitHub.

## 📝 Risks & Impact Review

- **Blast radius**: additive only — a new endpoint, a new query hook, a new chip. No change to any §2-protected shape (`githubItemSchema`, the list payload). The one hard requirement is registering the new route in `BACKWARD_COMPATIBILITY.md` §2 so `bc-route-inventory.test.ts` and the route-parity test pass (the route must be a chained `.get` link, mounted under both `/api/v1/github/...` and the `/p/:projectId/...` alias — `AGENTS.md`).
- **Cost**: one extra GraphQL round-trip per on-screen issue window (≤100 issues, one batched query), gated to the issues view, cached 60s per issue. This is the deliberately-accepted cost the user chose over the near-free-but-incomplete inversion; it never touches the fast list paint.
- **Rollback**: delete the slice; the row falls back to exactly today's meta line. No migration, no persisted state.

## 📋 Resolved assumptions (autonomous defaults)

The brainstorm brief's Resolved-unknowns table pre-answered the load-bearing questions (source = GitHub linked PRs; marker = clickable chip; states = open + merged/closed; fetch = per-issue `timelineItems`, lazily hydrated). The following were left open and are resolved here per the autonomous-defaults rule (most reversible, lowest blast radius). All are display-only and reversible; none weakens security or a compatibility contract, so none is marked `⚠ NEEDS HUMAN CONFIRMATION`.

| # | Open question | Resolved default | Rationale |
|---|---|---|---|
| Q1 | Inclusion rule: every referenced PR, or only closing/development-linked PRs? | Include PRs surfaced by **both** `CONNECTED_EVENT` and `CROSS_REFERENCED_EVENT` (subject/source is a `PullRequest`), deduped. | Matches the measured coverage (37/55) and what GitHub itself shows as "linked". Tightening later (to connected-only) is a one-line filter change — reversible; showing a real-but-loosely-linked PR is low-harm. |
| Q2 | Multiple linked PRs per issue: one chip, N chips, or a count? | Up to **3** inline chips (open first), then `+N` overflow → issue on GitHub. | Smallest surface that handles the common (one PR) and the rare (many) without a new expander component. |
| Q3 | Chip link target? | In-cockpit `/github/prs/:n` when the PR is in the loaded open set; else the GitHub `url`. | Reuses the existing PR view for the instant case; merged/closed PRs aren't in the open set, so they open on GitHub. No new detail fetch. |
| Q4 | Closed-unmerged PRs: show or hide? | **Show**, tinted distinctly from merged. | The user explicitly chose "open + merged/closed"; hiding closed would drop part of that. |
| Q5 | Per-issue timeline fetch depth? | `first: 30`, no `truncated` surfaced. | An issue with >30 linked PRs is not a real case; keeps the query cheap. |
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

1. **Contract shape.** Add `linkedPrSchema` + `githubIssuePrsDataSchema` to `packages/contract/src/github.ts`; export `LinkedPr` / `GithubIssuePrsData`. *Test*: a `github.contract.test` case parsing a happy and a degraded payload (mirror the existing github contract tests).
2. **Forge fetcher.** Add `GH_ISSUE_PRS_MAX`, `fetchGithubIssuePrs(repoRoot, numbers)`, the batched GraphQL builder, the per-issue `issuePrsCache` (60s) and `resetGithubIssuePrsCache()` to `forge/github.ts`. Reuse `resolveRepoHandle` + injected `runGraphql`. *Test*: unit test with an injected `runGraphql` returning connected + cross-referenced + non-PR + duplicate nodes, asserting dedup, state mapping, ordering, and the `{ available: false }` degrade when the handle is missing (mirrors `fetchGithubChecks` tests).
3. **Server route.** Add the chained `.get('/github/issue-prs', …)` link beside `/github/checks` with the CSV `issues` validator and cap. Register it in `BACKWARD_COMPATIBILITY.md` §2. *Test*: existing `route-parity` + `bc-route-inventory` suites must pass (dual-mount + inventory); a route test for the 400s and the happy shape.
4. **Typed client.** Add `getGithubIssuePrs(numbers, opts)` to `packages/api-client/src/client.ts` and export the new types from `index.ts`. *Test*: type-check + a client unit test if the sibling has one.
5. **Query hook.** Add `queryKeys.githubIssuePrs` and `useGithubIssuePrs(numbers, enabled)` to `queries.ts`, mirroring `useGithubChecks`. *Test*: covered via the component test below.
6. **Row chip + window wiring.** In `github.tsx`: derive `issuePrNumbers` (mirror `checkPrNumbers`, pin the URL-selected issue), call `useGithubIssuePrs(issuePrNumbers, view === 'issues')`, thread the resolved `links` into `GithubRow`, and render `LinkedPrChip` (state tint, in-set-vs-GitHub link target, `stopPropagation`, `+N` overflow). Extend the list-refresh mutation to invalidate the issue-prs window. *Test*: a `github.test.tsx` case rendering an issues list where the mocked endpoint returns links for some rows — assert the chip text, tint, `href`/route target, and `stopPropagation` (no row navigation on chip click); assert no chip when links are empty/unavailable.
7. **Validation gate.** Run the configured gate (`npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`) green before the PR is marked ready.
