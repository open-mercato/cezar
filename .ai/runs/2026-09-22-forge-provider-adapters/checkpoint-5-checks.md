# Checkpoint 5 — Steps 3.6..3.9 + 3.8-review-fix + 3.1-review-fix (Phase 3 close)

**When:** 2026-09-22T16:25:02Z
**Steps:** 3.6, 3.7, 3.8, 3.9, 3.8-review-fix, 3.1-review-fix (`172419f5`..`b9f7d22b`)
**Touched areas:** `server/forge/gitlab.ts` (search, viewUrl), cockpit (`lib/forge-display.ts`, icons, nav items, app shell, command palette, project groups, `routes/github/*`, `lib/git-actions.ts`, `tools-menu.tsx`, `lib/tasks-table.ts`, `api/queries.ts`, task thread, global tasks), merge-state fallback copy in `server.ts`

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | ✅ pass | |
| `npm test` | ✅ pass | 396 files, 7 539 tests (after both fixes). The first run of this checkpoint (before the fixes) had all tests green but one unhandled Radix focus-scope timer after jsdom teardown in `app-shell.test.tsx`; not reproduced in 3 web-suite reruns or 3 isolated runs. |
| `npm run test:unit` | ✅ pass | 36 / 36 |
| Browser pass — GitLab project (dry-run) | ✅ after fixes | Throwaway repo with remote `git@gitlab.com:demo-group/sub/demo-app.git`, `CEZ_DRY_RUN=1`, agent-browser. First pass found leftover GitHub copy → 3.8-review-fix, and "GitHub merge state is unavailable" on an MR → 3.1-review-fix. Re-shot after both: `checkpoint-5-artifacts/screenshot-gitlab-issues.png`, `screenshot-gitlab-merge-requests.png`. |
| Browser pass — GitHub project (dry-run) | ✅ unchanged | `checkpoint-5-artifacts/screenshot-github-unchanged.png` |
| e2e (github, project-groups, task-thread, task-changes, smoke) | ⚠️ pre-existing | Branch 13 failed / 45 passed; `main` 12 / 46. Same set except `github.e2e.ts`, whose failures are the harness `fetch` socket reset (`other side closed`): branch 1 failure in 3/3 isolated runs, `main` 1–2 failures in 3/3 isolated runs — pre-existing on `main`, which also closes the checkpoint-2 `composer-defaults` question as the same harness race. |

## Known gaps carried forward
- The hand-to-agent prompt still says "Fix GitHub issue #N" on a GitLab project — its wording is parsed by `runs/task-refs.ts`, so it changes in Step 4.4 together with the parser.
- "Set up automations" shows on a GitLab project; correct for schedule automations; GitHub-event availability is Step 4.6.
