# Issue ownership metadata (#1620)

Goal: show GitHub issue assignees and authoritative closing/development PR links before users start duplicate work.
Source doc: https://github.com/open-mercato/cezar/blob/spec/issue-1620-issue-ownership/.ai/specs/2026-10-30-issue-1620-issue-ownership.md
Spec PR: #1844
Engine: om-auto-create-pr (steps: 4, --loop: no)

## Scope
GitHub forge discovery, additive Zod item contract, issue row metadata/tests and private issue-1620 QA. Parent owns the compatibility-file commit. No filters, bulk launching, engine selection, shared configs or other UI areas.

## Implementation Plan
Phase 1: 1.1 Contract and compatibility tests; 1.2 Common bounded metadata enrichment and path/failure tests.
Phase 2: 2.1 Accessible row metadata and dry-run fixtures.
Phase 3: 3.1 Full configured gate, red/green regression, om-auto-review-pr --autofix and real-browser om-auto-qa-pr evidence; ready review-labelled unassigned implementation PR.

## Risks
Optional metadata adds bounded latency. Failure must preserve usable existing rows and cannot imply unassigned. Local Windows full-suite/node:test baseline failures are documented by parent; run all commands, fix attributable failures, require final-head Linux CI for independent supported-platform gate evidence. Missing/pending checks remain explicitly unresolved.

## Progress

PR: #1845

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contract and discovery
- [x] 1.1 Add optional metadata contract and compatibility coverage — 65f00256 (compatibility: 4c43e5f7)
- [x] 1.2 Enrich all discovery paths with bounded validated metadata — 65f00256 (compatibility: 4c43e5f7)

### Phase 2: Presentation
- [x] 2.1 Render accessible ownership and PR status links with tests — 65f00256 (compatibility: 4c43e5f7)

### Phase 3: Evidence and handoff
- [x] 3.1 Validate, review, browser QA and publish ready PR — ad081c57; evidence below


## Evidence

- Spec: https://github.com/open-mercato/cezar/pull/1844 (design-only).
- Browser QA PASS: https://github.com/open-mercato/cezar/pull/1845#issuecomment-6531940001 (head ad081c57, all required states).
- Focused suites: 420/420; corrected unsafe-URL fixture plus guardian: 17/17; four discovery tests fail without the hydration fix.
- Local configured gate: typecheck/build/package (33/33) pass. Full vitest reached its 300s bound amid baseline Windows/load failures; node:test 45 pass / 2 baseline POSIX-tool failures / 1 skip. No unrelated tests changed.
- Supported-platform gate at ad081c57: verify and all three vitest shards passed; CodeQL, Linux and macOS webhook checks passed. Windows webhook check pending when this note was written; final-head CI follow-up is recorded on the PR before reporting completion.
- Production source: 65f00256; compatibility note: 4c43e5f7; test-only guardian fixture correction: ad081c57. The final commit changes this execution record only.
- Independent review and QA remain required: ready PR, review label, no assignees, needs-qa retained, no author approval labels.
