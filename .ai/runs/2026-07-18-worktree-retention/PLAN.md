# Worktree Retention & Management (#483) — implementation run

Implements the spec at `.ai/specs/implemented/2026-07-18-worktree-retention.md` (shipped as
the docs PR #486, now extended into the implementation). Driven by
`om-auto-continue-pr-loop` on PR #486 (branch `cez/208500a8`).

Source spec: `.ai/specs/implemented/2026-07-18-worktree-retention.md`
Tracking PR: #486

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 0 | 0.1 | Fix flaky follow-up-template CI test (#413) — robust `chooseTemplate` helper | done | 8e71da3 |
| 1 | 1.1 | `worktreeRetention` config key (config.ts + server setConfigSchema/configAnswer/merge) | done | ebe9543 |
| 1 | 1.2 | `worktreeReclaimedAt` optional field on RunRecord | done | bb729cd |
| 1 | 1.3 | Pure `selectReclaimableWorktrees(runs, keep)` + unit tests | done | 0bc6ab3 |
| 1 | 1.4 | `reclaimWorktrees(repoRoot, store, keep)` I/O enforcer + real-git tests | done | 6a535f2 |
| 1 | 1.5 | Wire enforcer: startup (index.ts) + terminal transitions (run.ts) | done | bca6926 |
| 1 | 1.5a | Clear `worktreeReclaimedAt` + re-materialize dir on resume/continue | done | 24ada5b |
| 1 | 1.6 | Settings → Resources "Keep last N worktrees" input + types + test | done | da9186f |
| 2 | 2.1 | `GET /api/worktrees` (list + du sizes, degrade to null) + tests | done | 070f6ad |
| 2 | 2.2 | `POST /api/worktrees/reclaim` (force enforce) + tests | done | 070f6ad |
| 2 | 2.3 | Worktrees management table in Settings → Resources + component test | done | 0ffa056 |
| 2 | 2.4 | Docs: README settings table + spec citations at touch sites | done | 4cc6ed8 |
| 3 | 3.1 | Integration/E2E: Settings → Resources retention smoke (`web/app/e2e`) | done | 32f8950 |
| 3 | 3.2 | UI-QA polish: sync worktrees-panel keep footer on retention save; Resources subtitle | done | d161978 |

## Notes

- `removeWorktree(repoRoot, path)` (no branch arg) reclaims the directory but keeps `cez/<id8>` — recoverable. Reclaim = directory only.
- Reclaimable finished set = `['done','failed','cancelled']` (reuse `archiveFinished`'s set). `review`/live are excluded.
- `keep === 0` = unlimited (never auto-reclaim). Default 10.
- 1.5a is the must-not-miss behavior: a reclaimed → resumed → re-finished run must be eligible for retention again (no permanent exemption / disk leak).
