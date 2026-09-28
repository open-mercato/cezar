# Merge state survives an unreadable `statusCheckRollup` (#969)

- Date: 2026-09-16
- Issue: [#969](https://github.com/open-mercato/cezar/issues/969)
- Branch: `fix/merge-state-fine-grained-pat`
- Engine: om-auto-create-pr (steps: 9, --loop: no)

## Goal

Under a fine-grained PAT the cockpit's merge panel is dark for every PR: `fetchPrMergeState` asks
`gh pr view` for `statusCheckRollup` together with the scalar fields, `gh` exits 1 with empty
stdout because the `CheckRun` contexts are unreadable, and the whole call degrades to
`{ available: false }` — hiding `mergeable`, `mergeStateStatus` and `reviewDecision`, which the
same token *can* read.

Split the query so one unreadable sub-field can never sink the readable ones, and degrade the
check tier to the aggregate `statusCheckRollup { state }` (readable on the same token, and already
what the list tier uses) instead of losing it.

## Scope

- `packages/cezar/src/server/forge/github.ts` — split the `gh pr view` call, add the check tier.
- `packages/cezar/src/server/forge/types.ts` — `ForgePrMergeState` carries the tier.
- `packages/contract/src/github.ts` — the wire schema the cockpit parses.
- `packages/web/src/routes/github/github.tsx` — render a partially-available merge state honestly.
- Tests: `packages/cezar/src/server/forge/github.test.ts`, `packages/web/src/routes/github/github.test.tsx`.

### Non-goals

- The Actions-API fallback for per-check detail (issue's suggestion 2). It is a second data source
  with its own auth shape and its own honest gap (GitHub App check runs are invisible to it); it
  belongs on its own issue, not on the fix that restores the panel.
- The `om-setup-agent-pipeline` tracker-descriptor `get-pr-checks` note (the issue's comment) —
  that lives in the skills collection, not this repo.
- Automations, runners, `workflows/run.ts`, server-install — concurrent work.

## Implementation plan

### Phase 1: the server splits the call and tiers the checks

1.1 Split `fetchPrMergeState`'s single `gh pr view --json …,statusCheckRollup` into a core call
(the ten scalar fields, whose failure is a real failure) and a separate detail call for
`statusCheckRollup` (whose failure costs only the detail). On detail failure, fall back to the
aggregate `statusCheckRollup { state }` on the head commit via GraphQL — the field the fine-grained
PAT can read — collapsed into one synthetic check row so the eligibility ladder still sees a
failing CI as failing.

1.2 Carry the outcome on the state: `checksTier: 'detailed' | 'aggregate' | 'none'` plus an
optional `checksReason`, through `ForgePrMergeState`, `normalizeMergeState` and the contract
schema. `'none'` adds a `checks-unknown` blocker and `unknown` eligibility, so an unreadable check
tier never reads as "ready to merge".

### Phase 2: tests for both token shapes

2.1 Unit tests for the fine-grained-PAT shape: the detail `gh pr view` exits 1 with empty stdout,
the call still returns `available: true` with `mergeable` / `reviewDecision` intact, and the checks
degrade to the aggregate tier.

2.2 Unit tests for the fully-readable classic-token shape (per-check rows, `checksTier: 'detailed'`),
for the both-unreadable case (`'none'` + the `checks-unknown` blocker), and for the core call
genuinely failing (still `available: false`).

### Phase 3: the panel says what it cannot read

3.1 Render the aggregate row and an explicit "per-check detail unavailable" note in
`GithubMergeBox`, with the reason, instead of silently showing one nameless row.

3.2 Cockpit unit test for the degraded panel.

### Phase 4: validation

4.1 Run the full gate: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`,
`npm run test:package`.

## Risks

- The merge preflight reads `checks` — a degraded tier must not turn a red PR green. Mitigated by
  folding the aggregate state into a real check row and by the `checks-unknown` blocker.
- `githubPrMergeStateSchema` is asserted `Exact` against the route's inferred response type
  (`contract-parity.github.test.ts`), so contract and server must move together.
- Additive-only contract change: `checksTier` has a safe default for older clients reading it.

## Progress

PR: #996

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: the server splits the call and tiers the checks

- [x] 1.1 Split the `gh pr view` call and fall back to the aggregate rollup — 791f4e4e
- [x] 1.2 Carry `checksTier` / `checksReason` through types, normalize and the contract — 791f4e4e

### Phase 2: tests for both token shapes

- [x] 2.1 Fine-grained-PAT shape: gh exit 1, empty stdout, panel survives — b193bb14
- [x] 2.2 Classic-token shape, both-unreadable shape, core-call failure — b193bb14

### Phase 3: the panel says what it cannot read

- [x] 3.1 Render the degraded check tier in `GithubMergeBox` — 56f34ae2
- [x] 3.2 Cockpit unit test for the degraded panel — 56f34ae2

### Phase 4: validation

- [x] 4.1 Full validation gate — 3ca33514
