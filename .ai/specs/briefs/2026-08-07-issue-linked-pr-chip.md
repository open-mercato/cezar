# Show linked-PR chips on the GitHub issues list

- Date: 2026-08-07
- Category: feature
- Priority signal: medium — a daily-driver signal in the cockpit's GitHub tab; prevents re-dispatching an agent onto an issue that already has a PR in flight.
- Risk signal: medium — adds a per-issue GraphQL hydration path and a §2 contract change; the one-shot list-fetch performance discipline (#664) must be preserved.
- Routing: Next: om-auto-write-spec "Show linked-PR chips on the GitHub issues list — brief: .ai/specs/briefs/2026-08-07-issue-linked-pr-chip.md"

## Problem

On the GitHub **Issues** list (`packages/web/src/routes/github/github.tsx`, the `GithubRow` meta line), there is no way to tell whether an issue already has a pull request associated with it. The user wants each issue row to show, at a glance, whether a PR has been created for that issue — and to click through to it. Concrete evidence it matters: on this repo (`open-mercato/cezar`) **37 of 55 open issues already have a linked PR** (measured live via GraphQL), so the "is someone already on this?" question is a constant one when triaging what to hand to an agent.

## Agreed direction

Render a **clickable chip** on each issue row — `↗ PR #123` — that links to the linked pull request (the cockpit's own `/github/prs/:n` view where the PR is in the open set, else `open on GitHub`), tinted by PR **state** (open / merged / closed). An issue with multiple linked PRs shows multiple chips (or a count that expands) — the exact multiplicity rendering is left to the spec.

Source of truth is **GitHub's real issue↔PR links**, fetched per-issue via GraphQL `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT])`, filtering the `source`/`subject` to `PullRequest` nodes and reading their `number`, `url`, `state`. This is **lazily hydrated for the on-screen row window only**, mirroring the existing checks-glyph pattern (`useGithubChecks` → `GET /api/github/checks`, `CHECKS_WINDOW ≈ 100`), so the fast one-shot list fetch (#664) is untouched. The list-fetch itself must NOT gain this data — that was the whole point of #664.

**Rejected, with why:**
- **cezar-runs-only signal** (each run carries `issueNumber` + a resolved PR url, already client-side via `useRuns()`): free and instant, but blind to PRs opened by hand or outside cezar. User wants completeness.
- **Near-free "invert open PRs' `closingIssuesReferences`"**: the list already fetches all open PRs one-shot, and inverting their closing references would need no per-issue call — BUT it only sees *open* PRs. Measured on this repo: **22 of the 37** linked-PR issues have *only* merged/closed linked PR(s) (issues #404, #475, #498, #512, #515, #530, #540, #542, #545–549, #575–577, #657, #717, #719, #721, #738, #748). That is ~60% of the signal missed, because this workflow merges/closes PRs while the issue stays open. So the near-free path is insufficient given the merged/closed requirement.
- **Build nothing**: the signal directly prevents wasted agent dispatches onto already-in-progress issues; the GitHub web UI shows it but the cockpit is where issues get triaged and handed off, so context-switching to github.com defeats the purpose.

## Resolved unknowns

| Question | Answer (from the conversation) |
|----------|--------------------------------|
| Which PRs count as "created for this issue"? | GitHub's real linked PRs (authoritative), not just cezar's own tasks. |
| What is the marker? | A clickable chip `↗ PR #123` linking to the PR, tinted by PR state. |
| Which PR states light it up? | Open **and** merged/closed (empirically the majority case here). |
| Fetch mechanism? | Per-issue GraphQL `timelineItems` (CROSS_REFERENCED_EVENT + CONNECTED_EVENT → PullRequest nodes), lazily hydrated for the on-screen window like the checks glyphs. Never folded into the one-shot list fetch (#664). |
| Where does the chip link? | The linked PR — prefer the cockpit's `/github/prs/:n` when the PR is in the open set, else the GitHub URL. (Exact rule: spec's call.) |

## Non-goals

- Adding linked-PR data to the one-shot list fetch (`/api/github`) — it stays lazy/windowed to preserve #664's fast paint.
- The cezar-runs "instant paint before hydration" enhancement (challenger W1) — a possible later optimization (show cezar-created PRs from `useRuns()` instantly, then reconcile with GitHub), left OUT unless it falls out cheaply.
- A reverse feature (showing linked issues on PR rows) — this is issues-list only.
- Building a PR chip on **closed** issues — the Issues list renders the open set only; closed issues are out of scope by virtue of not being on screen.

## Affected areas (if known)

- `packages/web/src/routes/github/github.tsx` — `GithubRow` meta line (add the chip); the route's windowed-hydration wiring (new query alongside `useGithubChecks`).
- `packages/web/src/api/queries.ts` + `client.ts` — a new lazy query hook (e.g. `useGithubIssuePrs(numbers)`) and its `queryKeys` entry, mirroring `useGithubChecks`.
- `packages/cezar/src/server/forge/github.ts` — a new forge function issuing the `timelineItems` GraphQL and returning an `issueNumber → LinkedPr[]` map; dedupe a PR that appears via both CROSS_REFERENCED and CONNECTED events.
- `packages/cezar/src/server/server.ts` — a new `GET /api/github/issue-prs` (or similar) route, windowed like `/api/github/checks`.
- `packages/api-client` + `packages/contract` — the §2 response/type for the linked-PR payload.

## Watch-outs (from the challenger gate)

- `closingIssuesReferences` is **not** a `gh` CLI `--json` field — this is GraphQL-only (verified: `gh pr list --json closingIssuesReferences` errors). Use `runGraphql`, as the comment-counts query does.
- Dedupe: a single PR can surface as both a `CrossReferencedEvent.source` and a `ConnectedEvent.subject` on the same issue — collapse by PR number.
- Batchability: the query pages over the `issues()` connection or uses aliased per-number sub-queries; confirm the on-screen window (~100 issues) fits one/few requests and honors the same ≤60s server cache + `refresh` busting the other forge endpoints use.
- The issue→closing-PR relation via `timelineItems` includes *references* that are not strictly "closing" PRs (a mention in an unrelated PR). Decide whether to show all referenced PRs or only development-linked/closing ones — the measurement counted any linked PR; the spec should pin the exact inclusion rule.
