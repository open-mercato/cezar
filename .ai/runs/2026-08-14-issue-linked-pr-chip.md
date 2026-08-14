# Execution plan — Linked-PR chips on the GitHub Issues list

Source doc: .ai/specs/2026-08-09-issue-linked-pr-chip.md
Spec PR: open-mercato/cezar#816 (merged — design-only, this run ships the implementation)
Engine: om-auto-create-pr (steps: 8, --loop: no)

## 🎯 Goal

Every row of the cockpit's GitHub **Issues** list gains a clickable `↗ PR #123` chip when a pull
request is linked to that issue, tinted by the PR's state (open / merged / closed, with a muted
variant for drafts). The links come from GitHub's authoritative issue↔PR relationships, fetched
lazily for the on-screen row window through a new `GET /api/v1/github/issue-prs` endpoint — an
additive sibling of the existing lazy checks-glyph endpoint (#664), so the fast one-shot list fetch
stays untouched. A triager can then see, without leaving the cockpit, that an issue already has a
PR in flight before handing it to an agent.

## Scope

One additive vertical slice, structurally identical to the checks-glyph slice (#664): contract
schema → forge fetcher → chained server route → typed client → query hook → row chip. Nothing
existing is reshaped; no §2-protected shape changes.

Files this run touches:

| Layer | File |
|---|---|
| Contract | `packages/contract/src/github.ts` |
| Forge | `packages/cezar/src/server/forge/github.ts` |
| Server route | `packages/cezar/src/server/server.ts` |
| BC inventory | `BACKWARD_COMPATIBILITY.md` (§2 route inventory) |
| Typed client | `packages/web/src/api/client.ts` |
| Query hook | `packages/web/src/api/queries.ts` |
| Web UI | `packages/web/src/routes/github/github.tsx` |
| Tests | `contract-parity.github.test.ts`, a new `github-issue-prs-api.test.ts`, the forge unit test, `packages/web/src/api/client.test.ts`, `packages/web/src/routes/github/github.test.tsx`, `packages/web/e2e/github.e2e.ts` |

## Non-goals

Carried verbatim from the spec's Non-goals section:

- Extending the one-shot `GET /api/v1/github` list payload with linked-PR data — it stays
  lazy/windowed to preserve #664's fast paint.
- The Phase 2 runs-store instant-paint enhancement (`useRuns()` painting cezar's own PRs before the
  GitHub-authoritative fetch lands).
- A reverse feature (linked issues on PR rows), or linked-PR chips in the issue **detail** pane.
- Linked-PR chips on **closed** issues — the Issues list renders the open set only.

## Resolved assumptions (carried from the spec)

The spec resolved six open questions autonomously (its "Resolved assumptions" table); this run
implements them as written and does not re-litigate them: inclusion = connected +
cross-referenced PRs deduped (Q1); up to 3 inline chips then `+N` overflow (Q2); in-cockpit
`/github/prs/:n` when the PR is in the loaded open set, else the GitHub url (Q3); closed-unmerged
PRs are shown, tinted distinctly from merged (Q4); `last: 30` timeline depth with no `truncated`
signal (Q5); `GH_ISSUE_PRS_MAX = 100` window, same pinning as the checks glyphs (Q6).

## Risks

- **Route registration.** A loose `app.get(…)` would vanish from `AppType` (AGENTS.md § The HTTP
  API). The route must be a chained `.get` link in the `githubRoutes` family and inventoried in
  `BACKWARD_COMPATIBILITY.md` §2, or `bc-route-inventory.test.ts` / `route-parity.test.ts` fail.
- **Nested anchors.** `GithubRow` renders the whole row inside one react-router `<Link>`; an `<a>`
  inside an `<a>` is invalid HTML and a WCAG 4.1.2 failure that React would emit silently (no SSR
  parser to reject it). The row is restructured to a stretched-link overlay with the chips as
  siblings — this is the one genuinely structural edit in the run.
- **Contract parity.** `contract-parity.github.test.ts` asserts the schema and handler agree in
  BOTH directions; a `key: maybeUndefined` or a non-`as const` discriminant is the known way to
  drift. `isDraft` must actually be emitted by the handler for the optional field to typecheck.
- **Blast radius otherwise low.** Additive only; rollback is deleting the slice.

## Implementation Plan

### Phase 1 — Linked-PR chips

Each step leaves the app working and is independently testable.

1. **Contract shape.** `linkedPrSchema` + `githubIssuePrsDataSchema` (discriminated union on
   `available`) in `packages/contract/src/github.ts`, exporting `LinkedPr` / `GithubIssuePrsData`.
   Test: a `GithubIssuePrs200` mutual-assignability assertion in `contract-parity.github.test.ts`
   alongside the existing `GithubChecks200` one (compile-time, run by `npm run typecheck`).
2. **Forge fetcher.** `GH_ISSUE_PRS_MAX`, `fetchGithubIssuePrs(repoRoot, numbers, refresh?)`, the
   aliased GraphQL builder (`i${i}: issue(number:)`, `last: 30`), the per-issue `issuePrsCache`
   (60 s TTL, `refresh`-bypassable), the `CEZ_DRY_RUN=1` guard returning `mockGithubIssuePrs`, and
   the `__clearIssuePrsCacheForTests()` seam. Uses the injected `runGraphql` and the cached
   `resolveRepoHandle`. Test: unit test with an injected `runGraphql` covering dedup, state
   mapping, disconnected-subtraction, `last`-window ordering, and the degrade.
3. **Server route.** The chained `.get('/github/issue-prs', …)` link beside `/github/checks`, same
   CSV `issues` validator shape plus the optional `refresh` flag; registered in
   `BACKWARD_COMPATIBILITY.md` §2. Test: a route test mirroring `github-checks-api.test.ts`.
4. **Typed client.** `getGithubIssuePrs(numbers, opts)` in `packages/web/src/api/client.ts`.
   `packages/api-client` is NOT touched. Test: extend `packages/web/src/api/client.test.ts`.
5. **Query hook.** `queryKeys.githubIssuePrs` + `useGithubIssuePrs(numbers, enabled)` in
   `queries.ts`, mirroring `useGithubChecks`.
6. **Row chip + window wiring.** In `github.tsx`: derive `issuePrNumbers` (pin the URL-selected
   issue), call the hook for `view === 'issues'`, restructure `GithubRow` to the stretched-link
   overlay, render `LinkedPrChip`, and extend the list-refresh invalidation with `refresh=1`.
   Test: `github.test.tsx` cases for chip text, tint, href target, and the empty/unavailable case.
7. **E2E.** A `packages/web/e2e/github.e2e.ts` assertion that a chip renders on an issue row,
   enabled by the step-2 dry-run mock.
8. **Validation gate.** `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`,
   `npm run test:package` — all green before the PR is marked ready.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Linked-PR chips

- [x] 1.1 Contract shape (`linkedPrSchema`, `githubIssuePrsDataSchema`) + contract-parity assertion — df12ee5b
- [x] 1.2 Forge fetcher (`fetchGithubIssuePrs`, cache, dry-run mock, test seam) + unit test — df12ee5b
- [x] 1.3 Server route (`GET /github/issue-prs`) + BC §2 inventory + route test — 40c40b23
- [x] 1.4 Typed client (`getGithubIssuePrs`) + client test — c4643923
- [x] 1.5 Query hook (`useGithubIssuePrs`, `queryKeys.githubIssuePrs`) — c4643923
- [x] 1.6 Row chip + window wiring + stretched-link restructure + component tests — 9f6de959
- [x] 1.7 E2E assertion on an issue row
- [x] 1.8 Full validation gate green
