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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contract and discovery
- [ ] 1.1 Add optional metadata contract and compatibility coverage
- [ ] 1.2 Enrich all discovery paths with bounded validated metadata

### Phase 2: Presentation
- [ ] 2.1 Render accessible ownership and PR status links with tests

### Phase 3: Evidence and handoff
- [ ] 3.1 Validate, review, browser QA and publish ready PR
