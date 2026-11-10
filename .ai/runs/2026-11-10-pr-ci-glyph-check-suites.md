# Execution plan — PR CI glyph reads green while checks are queued (#2036)

**Goal:** the PR checks glyph (GitHub tab rows, merge-panel aggregate tier) and the task reference
chips must not read green while an Actions workflow run is queued, awaiting approval, or died
before its first job.

**Scope:** `packages/cezar/src/server/forge/github.ts` — `prChecksQuery`/`fetchPrChecks`,
`refStatusQuery`/`fetchRefStatuses` (one shared helper `headChecksGlyph`), plus unit tests.

**Non-goals:** merge-panel eligibility; per-check detail under fine-grained PATs (#1004);
`wait-ci` head pinning (#1533); `fetchCommitChecks` per-SHA timeline glyphs; issue rule 4
(`mergeStateStatus = BLOCKED` ⇒ pending), left out because unresolved conversations and other
ruleset conditions also set `BLOCKED` and would pin the glyph to pending.

**Risks:** `checkSuites` needs Checks read; a token without it fails the whole aliased query, so
the suite-enriched query falls back to the rollup-only one (one extra call on a failing chunk).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix

- [x] 1.1 Suite-aware head glyph shared by the tab and the chips, with rollup-only fallback
- [x] 1.2 Regression tests for the four Done-when cases, red without the fix
