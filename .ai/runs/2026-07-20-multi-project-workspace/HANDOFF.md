# Handoff — 2026-07-20-multi-project-workspace

**Last updated (run end):** 2026-07-21T14:00:00Z — was 2026-07-21T10:15:00Z (cp6)
**Branch:** feat/multi-project-workspace
**PR:** https://github.com/open-mercato/cezar/pull/521 (three-signal lock held by pkarw)
**Current phase/step:** COMPLETE — every Tasks row is `done`
**Last commit:** 66a4fe9 — fix(projects): split hosted containment so an in-root typo says so (step 5.7)

## What just happened

- **The spec is fully implemented.** All 32 Tasks rows are `done` — Phases 1-2
  from the creator run, Phases 3-5 across this resume, plus five fix-forward
  Steps appended during it (3.8, 4.5, 5.4, 5.5-5.7).
- **Final gate green**: typecheck; vitest **3131/3131** across 191 files;
  test:unit 31/31; build + check:pack; test:package 8/8. Integration suite
  **166 passed / 3 failed**, those three proven pre-existing by a merge-base
  comparison (`final-gate-checks.md`).
- **Two review rounds ran.** The first (full-diff, compatibility + security)
  returned `request-changes` on committed mock debris and a redirect dropping
  query+hash; both fixed in 5.5. The second (re-review of the fix commits)
  returned `approve`, and corrected this run's own diagnosis of an e2e flake.
- **Five real defects were found and fixed during this resume** — see
  `NOTIFY.md`: the latent Step-3.1 scope-provider effect-ordering bug; e2e
  polluting the operator's real `~/.cezar/config.json`; e2e depending on the
  operator's local registry shape; `worktreeRetentionDefault` being a
  do-nothing setting the UI advertised as working; and a hosted-mode
  existence oracle on `POST /api/projects`.

## Blockers / open questions

- None blocking. Carry-forward notes:
  - **Branch is 29 ahead / 20 behind `origin/main`.** Merge `main` before this
    lands; two of the four residual e2e failures trace to `mock-claude.mjs`
    turn semantics that `main` has since changed (#473).
  - The Step-4.3 clone dialog surfaces a missing `gh` as a 503 in the DIALOG
    rather than disabling the menu item (the shell renders without a
    QueryClient). Deliberate; recorded in `NOTIFY.md`.

## Environment caveats

- Always run gates as `env -u CEZ_REMOTE …` — an ambient `CEZ_REMOTE` breaks a
  test on `main` too.
- **`npm test` does NOT include e2e.** E2E is `npm run test:e2e` /
  `web/app/e2e/vitest.config.ts`. Run it at every checkpoint that touched UI —
  checkpoint 5 is why this line exists.
- 4 residual e2e failures are pre-existing and individually accounted for in
  `checkpoint-5-checks.md`; do not chase them as regressions.
- Test env: `env -u CEZ_REMOTE sh .ai/scripts/test-env-up.sh` (reuses a healthy
  env); agent-browser 0.32.1 installed. **Boot it with `CEZ_REMOTE` scrubbed** —
  the operator's shell exports `CEZ_REMOTE=1`, which puts the server in hosted
  mode and narrows `/api/fs/browse`'s root to a `projectsDir` that does not
  exist, so the add-project dialog answers "browse root is not available".
- The shared registry (`.ai/qa/cez-home/config.json`) is now pinned per-run by
  Step 4.5's vitest `globalSetup`, so e2e no longer depends on its local shape.
  Leave it at `projects: []`; do not hand-register projects into it.

## Worktree

- Path: /home/pkarw/Projects/cezar/.ai/cezar/worktrees/d89e350f-8a3f-49a3-aa6d-a485293f1d8e
- Created this run: no (reused a cezar linked worktree; do NOT remove at cleanup)
- **Handover note:** the creator run's worktree (`eeb2f1f6`) went dormant
  2026-07-20T23:38 with status=failed. This resume took the branch over from
  worktree `d89e350f` and pushes to the same remote branch. `eeb2f1f6`'s local
  branch ref now lags far behind — re-sync it before ever resuming there.
