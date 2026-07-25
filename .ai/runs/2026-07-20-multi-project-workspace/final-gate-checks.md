# Final gate — spec completion (all 32 Tasks rows `done`)

**Ran:** 2026-07-21T12:00:00Z (om-auto-continue-pr-loop resume)
**Head at gate:** `66a4fe9` (re-run after the review-fix Steps 5.5–5.7)
**Branch:** feat/multi-project-workspace → main

Every row in `PLAN.md`'s Tasks table is `done`: Phases 1–2 from the creator run,
Phases 3–5 across this resume, plus three fix-forward Steps appended during it
(3.8, 4.5, 5.4).

## 1. Full validation gate — `validation.commands`, in order

| Command | Result | Artifact |
|---|---|---|
| `npm run typecheck` | **pass** | `final-gate-artifacts/typecheck.log` |
| `npm test` | **pass** — 191 files, **3131/3131** | `final-gate-artifacts/test.log` |
| `npm run test:unit` | **pass** — 31/31 | `final-gate-artifacts/test-unit.log` |
| `npm run build` (+ `check:pack`) | **pass** — 302 files, 70 under `web/dist` | `final-gate-artifacts/build.log` |
| `npm run test:package` | **pass** — 8/8 | `final-gate-artifacts/test-package.log` |

All commands run with `env -u CEZ_REMOTE`. The operator's shell exports
`CEZ_REMOTE=1`, which breaks a test on `main` too — scrubbing it is the honest
baseline, not a workaround for this branch.

## 2. Full integration suite — `sh .ai/scripts/e2e.sh`

**166 passed / 3 failed / 4 skipped** across 26 files
(`final-gate-artifacts/e2e-full.log`, `TEST_E2E_STATUS=failed`).

### The 3 failures were PROVEN pre-existing, not asserted

Earlier in this run two executor claims of "pre-existing" turned out to be
wrong under scrutiny, so this gate settled the question by experiment rather
than by inspection: a detached worktree was created at the **merge-base**
(`dabbf12`, deps verified identical so `node_modules` was reused), its test env
booted, and the three specs run there.

| Spec | At merge-base | On this branch | Verdict |
|---|---|---|---|
| `repo-git > /git/branches renders the live branch list with the checkout marked current` | **FAILS** — identical failure | FAILS | **Pre-existing.** The suite runs from a linked worktree branch the server's branch enumeration does not list, so no row wears the current marker. |
| `review-gate > shows the banner and the real worktree diff…` | **FAILS at file level** — aborts at setup: `the dry run settled as done — no diff to review?` | Runs, then fails on the PR-URL assertion | **Pre-existing, and partially improved here.** |
| `task-changes > the toolbar comes from the policy…` | **FAILS at file level** — same setup abort | Runs, then fails on the PR-URL assertion | **Pre-existing, and partially improved here.** |

The last two deserve the precision: at merge-base they never executed at all,
because they silently required the operator's shell to carry
`CEZ_REVIEW_GATE=1` (opt-in, default OFF since #489). Step 3.8 pinned that in
the harness, so on this branch they now actually run — and then hit a deeper
limitation this branch never touched: `scripts/mock-claude.mjs:262` emits a PR
URL only on turn ≥ 2, while these specs drive a single turn.

So this branch did not regress them. It partially un-broke them and exposed the
older limitation underneath. `git diff dabbf12..HEAD` confirms
`scripts/mock-claude.mjs`, `src/runs/store.ts` and `src/server/git.ts` are all
**unchanged** by this branch.

Fixing the mock's turn semantics is out of scope for this PR and belongs with
whoever owns `mock-claude.mjs` (main has since moved it under #473).

## 2b. Review rounds and the flake found by re-running

The gate was run **four times** across the review rounds, which is how the
suite's one non-deterministic spec surfaced. On two consecutive full runs the
three constant failures were joined by a rotating fourth — `settings-agents`
once, `project-groups` the next — and `project-groups.e2e.ts` (added by this PR
in Step 4.5) reproduced in isolation at roughly 1 run in 2.

Fixed in Step 5.6: the spec clicked a group header and waited for its body.
The second-pass review then corrected the *diagnosis* — it is not React handler
wiring (React attaches its delegated listener to the root container before any
child exists, so a rendered header cannot drop a click). It is a harness layout
race: `browser.click` resolves the element's centre coordinate and then
dispatches, while the boot group's body is still filling as `useProjectRuns`
resolves and pushes later headers down. No real user loses clicks. The helper
now drives expansion from `aria-expanded` and re-reads it per attempt, so a
slow toggle is observed rather than double-fired. **Four consecutive isolated
runs green**, and three subsequent full-suite runs show only the constant three.

## 3. Style-compliance pass — SKIPPED, with reason

The repository has **no** lint, format, prettier, or design-system script in
`package.json` (checked: no `lint`, `style`, `format`, `prettier`, or `design`
entry), and no design-system compliance skill is installed for it. There is no
tooling to run, so this pass is recorded as skipped rather than faked.

House style was instead held at review time: every executor was instructed to
match the surrounding code's idiom and comment density, and the dispatcher read
the security-sensitive diffs directly (see `checkpoint-6-checks.md`).

## Carry-forward for the reviewer / merger

1. **The branch is 29 ahead / 20 behind `origin/main`.** A merge from `main` is
   wanted before this lands. It was deliberately NOT done in this run: merging
   20 commits of unrelated work (including #473, which rewrites
   `mock-claude.mjs`) is a conflict-resolution decision that belongs to a human
   with merge intent, not to an autonomous resume. Two of the three residual
   e2e failures may simply resolve on that merge.
2. **Known rough edge (Step 5.4):** `GET /api/config` still returns the
   per-repo parsed `worktreeRetention` (10 when unset), so Settings → Worktrees
   can display `10` while the effective limit is the inherited workspace
   default. The enforcement lie is fixed; this display inconsistency needs an
   API/contract change that would break `config-api.test.ts`'s documented
   clear-to-10 behavior, so it was left and surfaced rather than rushed.
3. **Follow-up issue #535** filed for `liveInstancesExist()` (Step 5.3).
4. **Accepted non-blocking review findings** (first round, findings 5-9): no
   in-flight guard on `POST /api/projects/checkout` (N distinct names fork N
   concurrent 10-minute clones, bypassing the workspace semaphore);
   `LegacyPathRedirect` has no error branch, so a failing `/api/health` parks
   every flat legacy URL on a quiet "resolving" screen; hosted `/api/health`
   now enumerates every project *name* cross-origin (same granularity as the
   already-trimmed `repoRoot`, documented in BC §2, but a widening);
   checkout error strings echo absolute paths, contradicting fs-browse's own
   "never echo a resolved path" rule. Second round added: `useSidebarCollapse`
   does not `cancelQueries` before its optimistic write (narrow initial-load
   window); `<Navigate to="/github/prs">` in `routes/github/github.tsx:80`
   drops query+hash (pre-existing, #452, unrelated to this PR).

## Verdict

Validation gate **green**. Integration suite green apart from three failures
**proven** pre-existing by merge-base comparison. Style pass not applicable.
The gate is satisfied.
