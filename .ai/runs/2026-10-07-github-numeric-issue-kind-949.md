# GitHub numeric issue search kind — 2026-10-07

## Goal

Ensure a numeric search on the Issues tab cannot render a pull request as an issue when `gh issue view` resolves a pull request number.

## Scope

`packages/cezar/src/server/forge/github.ts` and its dedicated tests. No UI changes and no changes to the parent orchestration plan.

## Implementation Plan

### Phase 1: Regression and fix

1. Add a regression fixture proving an issue lookup whose canonical URL is a pull request falls through to text search, while genuine issue and PR paths remain intact.
2. Validate the canonical URL kind returned by the numeric lookup before flattening it for the tab.

### Phase 2: Verification

3. Run the focused forge test, typecheck, and configured validation gate; inspect the diff and report exact evidence.

## Risks

GitHub's `issue view` endpoint accepts pull request numbers because pull requests are issues too. The canonical URL is the stable kind discriminator; malformed or wrong-kind numeric results fall through to the existing text-search path.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Regression and fix

- [x] 1.1 Add wrong-kind numeric-search regression — 871b3be9
- [x] 1.2 Validate numeric lookup URL kind — 871b3be9

### Phase 2: Verification

- [x] 2.1 Run focused tests, typecheck and configured gate — corrected code reviewed at `b37d3240`; CI full gate green; dedicated forge suite 200/200
