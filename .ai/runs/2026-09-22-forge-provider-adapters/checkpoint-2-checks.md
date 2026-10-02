# Checkpoint 2 — Steps 1.6..1.8-review-fix (Phase 1 close)

**When:** 2026-09-22T14:16:23Z
**Steps:** 1.6, 1.7, 1.7-review-fix, 1.8, 1.8-review-fix (`336d55bb`..`7ec3ab5f`)
**Touched areas:** `server/forge/` (index helpers, github driver), `server/server.ts` (`/github/checks`, `/github/ref-status`, `/github/prs/:n/changes`, `POST /runs/:id/pr`), related api tests

Phase 1 acceptance: a GitHub project behaves byte-identically. Full validation gate + real-browser e2e.

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | ✅ pass | |
| `npm test` | ✅ pass (1 flake) | 7 341 / 7 342. The one failure, `workflows/auto-resume.test.ts` "holds the queue while the account is limited", is an `ENOTEMPTY` temp-dir cleanup race under full-suite load; passes 3/3 alone; the branch does not touch `workflows/`. |
| `npm run test:unit` | ✅ pass | 36 / 36 |
| `npm run build` | ✅ pass | incl. `check:pack` |
| `npm run test:package` | ✅ pass | 16 / 16 |
| `npm run test:e2e` (agent-browser) | ⚠️ failed — pre-existing on `main` | Branch: 33 failed / 186 passed / 6 skipped. **Baseline `main` @ 4763447f on the same machine: 35 failed / 184 passed.** Failure lists: `checkpoint-2-artifacts/e2e-failures-{branch,main-baseline}.txt`. GitHub-tab and project-groups failures occur on `main` too. |

## e2e delta vs `main`
- Only-on-branch: `composer-defaults.e2e.ts` "covers cold, interactive, and persisted workspace defaults" — `TypeError: fetch failed … SocketError: other side closed` on the test runner's own `fetch` to `/api/v1/workspace/config`. Re-runs alone: branch 1/3 pass, `main` 3/3 pass. The server did not crash (clean app log; later specs in the same run passed). The same socket error breaks `github.e2e.ts` on `main`. Classified as a suspected pre-existing keep-alive race in the e2e harness (undici pooled socket reused as the server's idle timeout closes it) — **not proven**; re-checked at the final gate.
- Only-on-`main`: 5 specs fail on `main` and pass on the branch (timing-sensitive specs).

## Fix landed at this checkpoint
- 1.8-review-fix (`7ec3ab5f`): 1.8's null-forge early 409 on `POST /runs/:id/pr` skipped `createDraftPr`'s final autosave, its actionable no-remote text and the dry-run fake PR; the route now falls back to `createDraftPr` verbatim when no driver resolves.
- 1.7-review-fix (`5f7bae12`): the 1.7 executor's follow-up typing commit, recorded as its own row; `ea6aada9` alone does not typecheck (bisect gap).
