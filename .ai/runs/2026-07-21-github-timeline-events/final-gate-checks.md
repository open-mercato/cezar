# Final gate — all 20 Steps done

**Steps covered:** 3.1 → 3.8 (and the whole run)

## Full `validation.commands` gate

Run with `CEZ_REMOTE` and `CEZ_DRY_RUN` scrubbed from the environment (see the correction below —
this matters).

| # | Command | Result |
|---|---|---|
| 1 | `npm run typecheck` | ✅ clean |
| 2 | `npm test` | ✅ **3043 passed** (175 files), 0 failed |
| 3 | `npm run test:unit` | ✅ 30 passed, 0 failed |
| 4 | `npm run build` | ✅ built; `check:pack ok — 284 files, 73 under web/dist` |
| 5 | `npm run test:package` | ✅ 8 passed, 0 failed |

## Correction to checkpoint 1 — the "pre-existing failure" was an env leak

Checkpoint 1 reported `src/server/request-validation.test.ts` failing `409 ≠ 400` and called it
pre-existing repo drift, having reproduced it on a clean `origin/main` worktree.

**The conclusion was right; the diagnosis was wrong.** It fails only when `CEZ_REMOTE=1` is
inherited from the surrounding cezar session — which it was, in *both* runs, which is exactly why
comparing against `main` did not expose it. With the variable scrubbed the test passes on this
branch, and the whole suite is green at 3043/3043.

So: not this branch's doing (as stated), but also **not repo drift** — a harness variable leaking
into the gate. The lesson is that reproducing on `main` proves "not my change"; it does **not**
prove "not my environment", because the environment is held constant across both.

## Integration / e2e suite

`npm run test:e2e` — **6 failed | 138 passed | 24 skipped**, `TEST_E2E_STATUS=failed`.

**Every failure is pre-existing and none is in the new code.** Proven by isolation rather than
asserted: the same suite on a clean `origin/main` worktree gives **8 failed | 138 passed** — *more*
failures than this branch, not fewer.

Isolating `github.e2e.ts` on both trees settles the one file this PR touches:

| Tree | github.e2e.ts |
|---|---|
| `origin/main` | 2 failed, 2 passed (4 tests) |
| this branch | 2 failed, **3 passed** (5 tests) |

The two failures are the *same two pre-existing specs* on both trees — `/github lists the real
issues and PRs with honest counts` and `opens an issue's detail`. The added test is the extra
pass. Run on its own it is unambiguous:

```
npx vitest run --config web/app/e2e/vitest.config.ts github.e2e -t "activity thread"
  Tests  1 passed | 4 skipped (5)
```

The broad e2e breakage (settings-bookmarklets, settings-appearance, settings-skills, task-thread,
repo-git) is environmental — a linked worktree with an unseeded run store — and is out of scope
here. Recorded rather than silently dropped, because `npm test` does **not** include e2e, so a
green gate above says nothing about the browser.

## UI verification

`.ai/qa/artifacts_e2e/github-thread-timeline.png`, captured by the new e2e spec against the
`CEZ_DRY_RUN=1` cockpit. Visually confirms, in one shot, every user-visible claim in this PR:

- The section header reads **`ACTIVITY · 3 COMMENTS`** — the retitle, with the comment count kept
  as a secondary.
- `ada added the [bug] label` — a label event with the chip **tinted from the label colour**,
  proving the `labelColors` threading.
- `Lin Zhao added 4 commits` — the commit-run **grouping summary**.
- `Lin Zhao committed aaaaaaa fix(session): keep the refresh token on reload ✓` and
  `… test(session): cover the reload path ✗` — per-commit rows with **CI glyphs in two different
  states**, each keeping its own message.
- Events **interleaved between** the two conversation comments, in timestamp order, rendering as
  single muted lines against the comment cards.

## Design-system / style pass

The repo has no lint script, no markdown linter and no style-compliance tool (this is the very
gap Step 3.6's drift guard exists to compensate for on the §2 inventory). No auto-fix Steps to
land. `EventRow` reuses the existing tone tokens (`text-soft-foreground`, `text-success`,
`text-danger`, `text-muted-foreground`) and `CHECKS_GLYPH`/`CHECKS_TONE` rather than introducing a
colour vocabulary, and the label chip reuses `labelChipStyle`.

## Verdict

All 20 Steps done. The five gate commands pass. The new e2e spec passes and produced its
screenshot. No failure anywhere in the run is attributable to this branch, and each such claim
here was proven by isolation rather than asserted.
