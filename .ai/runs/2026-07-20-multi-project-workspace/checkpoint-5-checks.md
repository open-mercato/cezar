# Checkpoint 5 — steps 3.3..3.8 (Phase 3 close)

**Ran:** 2026-07-21T07:30:00Z (om-auto-continue-pr-loop resume)
**Steps covered:** 3.3, 3.4, 3.5, 3.6, 3.7, 3.8 — SHAs `ed8faa3`..`3ccc943`
**Resume point on entry:** 3.3 (Phase 3 was 2/7 done)

## Touched areas

Cockpit UI end to end: sidebar (project groups + persisted collapse), new-task
composer (project pill, per-project drafts, scoped submit), settings (project /
global split + store moves), bookmarklets (scoped URLs + per-project keys),
`BACKWARD_COMPATIBILITY.md` (Phase 3 surfaces), and the e2e harness.

## Validation gate — full `validation.commands`, all green

| Command | Result |
|---|---|
| `npm run typecheck` | **pass** (exit 0) |
| `npm test` | **pass** — 185 files, 3030/3030 |
| `npm run test:unit` | **pass** — 31/31 |
| `npm run build` (+ `check:pack`) | **pass** — 297 files, 74 under `web/dist` |
| `npm run test:package` | **pass** — 8/8 |

All run with `env -u CEZ_REMOTE` — an ambient `CEZ_REMOTE` in the operator's
shell breaks one test on `main` too, so scrubbing it is the honest baseline,
not a workaround for this branch.

## Integration / e2e — the checkpoint's real finding

Phase 3 is entirely UI, so e2e was mandatory here. It surfaced a gap the
per-Step checks could not:

**`npm test` is `vitest run` against the DEFAULT config, which EXCLUDES e2e.**
E2E lives behind `npm run test:e2e` / `web/app/e2e/vitest.config.ts`. Every
Phase 3 executor reported a green gate truthfully and still never ran one e2e
spec. First e2e run of the phase: **16 failed / 51 passed / 1 skipped**.

Triaged and fixed forward as **Step 3.8** (`3ccc943`) — see `NOTIFY.md`. Two
findings were real harness regressions, not stale assertions:

1. **E2E was mutating the operator's real `~/.cezar/config.json`.** The 12
   self-spawning specs passed `{...process.env, CEZ_DRY_RUN:'1'}` without
   pinning `CEZ_HOME`, so since Phase 1 every run auto-registered its
   `/tmp/cezar-e2e-*` fixture into the developer's live registry (16 dead
   entries found and pruned). Second-order: once the registry held >1 project
   the sidebar switched to the grouped shell, so flat-shell specs failed by run
   order. Step 1.5 pinned `CEZ_HOME` for `test-env-up.sh` only; these were
   missed. Fixed in `fixtureServeEnv()`.
2. **Four specs silently depended on the operator's shell** —
   review-gate/task-changes/task-files/variants-compare need
   `CEZ_REVIEW_GATE=1` (opt-in, default OFF since #489). Now pinned.

The rest were genuine stale assertions against the pre-3.2 flat URL grammar.
Legacy-redirect coverage was deliberately KEPT (it is what the PR's
compatibility claim rests on), not deleted.

**Post-fix full e2e: 162 passed / 4 failed / 4 skipped (21 of 25 files green).**

### The 4 residual e2e failures — none caused by this PR

| Spec | Cause | Evidence |
|---|---|---|
| `repo-git > /git/branches` | Suite runs from linked worktree branch `cez/d89e350f`, which the server's branch enumeration does not list, so no row wears the current marker. | Known linked-worktree environment note. |
| `review-gate > shows the banner…` | Wants a run that already carries a PR URL; `scripts/mock-claude.mjs:262` emits one only on turn ≥ 2 and the spec runs one turn. | `git log origin/main..HEAD -- scripts/mock-claude.mjs src/runs/store.ts` is **empty** — this branch never touched either file. |
| `task-changes > toolbar…` | Same mock-turn cause as above. | As above. |
| `settings-appearance` | Passes **4/4 in isolation**; fails only in a full run via `cez-theme` leaking from smoke's `setTheme` through the shared browser profile. | Isolation run green. |

Note: `origin/main` has since moved ahead of this branch by 20 commits
(including #473 work that touches `mock-claude.mjs`), so two of the residuals
may simply resolve on merge. The branch is 29 ahead / 20 behind `main` —
worth a merge from `main` before this lands.

## UI evidence — `checkpoint-5-artifacts/`

Captured against the live dry-run test env (agent-browser 0.32.1, 1440×900)
with three real projects registered, because the headline feature only renders
above one project:

| File | Shows |
|---|---|
| `sidebar-multi-project.png` | Three project groups — `cezar` expanded with its scoped nav + attention badge `1`, `hackon-landing` / `github-janitor` collapsed to one row each with branch chips; NEEDS YOU / RECENT sections; add-project button beside the New task CTA. |
| `new-task-project-pill.png` | Composer scoped to `github-janitor`: the project pill, and the base-branch chip resolved to **that project's** branch (`fix/auto-refresh-skills-repos`) — cross-project scope resolution working, not just a cosmetic label. |
| `settings-global.png` | The global settings area at `/settings/global`. |

The e2e run also refreshed 20+ screenshots under `.ai/qa/artifacts_e2e/`,
including `settings-bookmarklets-legacy-redirect.png` (the legacy flat
bookmarklet URL surviving the redirect).

## Verdict

Phase 3 closes **green** on the full validation gate, with e2e realigned and
two real harness regressions fixed. Residual e2e failures are pre-existing and
individually accounted for above. Next: Step 4.1.
