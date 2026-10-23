# Checkpoint 6 — Steps 4.1..4.4 + 4.2-review-fix

**When:** 2026-09-22T17:02:51Z
**Steps:** 4.1, 4.2, 4.2-review-fix, 4.3, 4.4 (`16dc31b7`..`2a49957a`)
**Touched areas:** `server/forge/draft-pr.ts` (new shared publish prelude), GitLab `createPR`, `server/checkout.ts` (GitLab sources, glab runner, credential helper), `core/{backend-detect,agent-env,secret-redaction}.ts`, `server-install/steps.ts`, `runs/{store,task-refs}.ts`, cockpit clone dialog / app-shell menu / settings hint, `lib/github-task.ts` + hand-to-agent

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | ✅ pass | |
| `npm test` | ✅ pass | 398 files, 7 613 tests |
| `npm run test:unit` | ✅ pass | 36 / 36 |
| Browser pass — GitLab project (dry-run) | ✅ | Hand-off prompt on an MR reads "Address GitLab merge request !1: …" with the `/-/merge_requests/1` URL; the MR merge box reads "Merging from cezar is not supported for GitLab merge requests" (`screenshot-gitlab-hand-off-prompt.png`). Clone menu reads "Clone from a git forge…"; the dialog names gh and glab and derives folder `deploy-bot` from `https://gitlab.acme.internal/platform/tools/deploy-bot` (`screenshot-clone-dialog-gitlab-url.png`). Not exercised: a real `glab mr create` / `glab repo clone` against a live GitLab (fixtures + fake binaries only). |

## Fix landed in this window
- 4.2-review-fix (`b22c4a50`): GitLab clones now persist `credential.<origin>.helper = !glab auth git-credential`, mirroring the GitHub clone's gh helper, so a task worktree's first push authenticates.
