# Execution plan — task auto-naming (spec 2026-07-17-task-auto-naming)

Source spec: `.ai/specs/implemented/2026-07-17-task-auto-naming.md`
Tracker issue: #432 (naming quality) + owner direction on PR #479
Branch: `feat/task-auto-naming-spec`
Base: `main`
Run folder: `.ai/runs/2026-07-17-task-auto-naming/`

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Merge PR #442's branch — skill-aware heuristic titles (credit: #442) | done | e925166 |
| 1 | 1.2 | `src/runs/task-refs.ts` — PR/issue-number extraction + tests | done | 5c56731 |
| 1 | 1.3 | `RunRecord.prNumber/issueNumber/titleOrigin` optional fields + PATCH marks user renames | done | 00d7f42 |
| 1 | 1.4 | Number-prefixed heuristic title at creation (task-refs into `makeRunTitle`) | done | 4eff906 |
| 2 | 2.1 | `src/runs/auto-name.ts` — namer prompt, strict-JSON parse, cross-check, post-validation | done | 8e2ebd0 |
| 2 | 2.2 | `[cez-namer]` mock branch + one-shot runner call + `namerModel` config key | done | c38b1f8 |
| 2 | 2.3 | Fire-and-forget wiring in `startRun` — apply rules, SSE, degradation | done | aaa5648 |
| 3 | 3.1 | `liveTitleUpdates` config key + `CEZ_TITLE_UPDATES` env default (ON) | done | 56c44cc |
| 3 | 3.2 | Turn-end refresh via the namer in `recordTurnEnd` + skip conditions | done | e5df17c |
| 3 | 3.3 | Settings → Agents toggle for live title updates (web UI) | done | 53a7d94 |
| 4 | 4.1 | Retire raw turn-text titles (`title-summary.ts`) + update dependent tests | done | b4359fd |
| 4 | 4.2 | Docs: .env.example, README env table + naming section, config key docs | done | 79a29fb |
| 4 | 4.3-review-fix | Dry-run naming off by default (`autoNamingActive`, e2e fix) + AGENTS.md env-doc rule | done | d408880 |

## Goal

Implement the task-auto-naming spec: short `<number>: <gerund phrase>` titles from a one-shot
cheap-LLM namer with regex-cross-checked PR/issue extraction; live on-the-go title refresh
(switchable, settings-based, env default, default ON per owner decision); raw turn-text
titles retired.

## Scope

`src/runs/` (new `task-refs.ts`, `auto-name.ts`; `store.ts` fields), `src/workflows/run.ts`
(startRun + recordTurnEnd wiring), `src/config.ts` (`namerModel`, `liveTitleUpdates`),
`scripts/mock-claude.mjs` (`[cez-namer]`), `src/server/server.ts` (PATCH titleOrigin),
Settings → Agents toggle in `web/app/src/routes/settings/agents-section.tsx`, docs.

## Non-goals

- No "regenerate title" row action (spec phase 6, optional follow-up).
- No ACP `session_info_update` integration.
- No changes to `pullRequestUrl` transcript detection.

## Risks

- PR #442 is merged into this branch (step 1.1) — if #442 lands on main first the final merge
  is trivial; if this PR lands first, #442 becomes redundant and must be closed with credit
  (Supersede Credit Rule applies at changelog time).
- Namer runs per task creation and per turn end (default ON, owner decision) — cost bounded
  by cheap `namerModel`, skip conditions, and dry-run mocks in tests.
- `RunRecord` gains only optional fields — additive-safe per BACKWARD_COMPATIBILITY.md §3.

## External References

None.

## Implementation Plan

Follows the spec's `## Design` and `## Phasing` verbatim; per-step detail lives in the spec.
