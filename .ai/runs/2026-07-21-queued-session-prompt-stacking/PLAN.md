# Plan — queued-session-prompt-stacking

**Brief:** Implement the spec at `.ai/specs/2026-07-21-queued-session-prompt-stacking.md`
**Source spec:** `.ai/specs/2026-07-21-queued-session-prompt-stacking.md`
**Issue:** #472
**Branch:** `feat/queued-session-prompt-stacking`
**Base:** `main`

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | `queuedMessage` schema + record field | done | 163e6ff |
| 1 | 1.2 | `persistImage` without a session | done | 415d486 |
| 1 | 1.3 | `RunManager` stack mutators | done | 98d1858 |
| 1 | 1.4 | `hydrateQueuedInput` + `pump()` wiring | done | dd83a3b |
| 1 | 1.5 | Routes | done | b7d8b55 |
| 1 | 1.6 | Client types + hooks | done | f0a058e |
| 2 | 2.1 | Composer queued branch | done | 721faa1 |
| 2 | 2.2 | Stacked bubbles | done | 9275471 |
| 2 | 2.3 | Inline edit / remove | done | 5b283ae |
| 3 | 3.1 | E2E | done | 5aea278 |
| 3 | 3.2 | Docs | done | cd0b0f2 |
| 3 | 3.3-review-fix | Review fixes: defer re-buffer + exact 409 | done | 4840978 |

## Goal

Let a run that is waiting for a free agent slot have prompt messages stacked onto it, and let those messages (and the initial prompt) be edited or removed until the run starts. At dequeue the stack is folded into `{{task}}` so every step of a chain sees the amended prompt.

## Scope

- **State** — `src/runs/store.ts`: optional `queuedMessages?: QueuedMessage[]` on `runRecordSchema`; deliberately excluded from `redactPatch`.
- **Engine** — `src/workflows/run.ts`: `enqueueMessage` / `editQueuedMessage` / `removeQueuedMessage` / `editTask` / `deferMessage`; `hydrateQueuedInput()` called from `pump()` before `execute()` and reused by `recover()`; `persistImage` loses its hard `ActiveRun` dependency via `queuedImageSeq`.
- **API** — `src/server/server.ts`: three-rung ladder on `POST /api/runs/:id/messages`; new `PATCH`/`DELETE /api/runs/:id/queued-messages/:msgId`; optional `task` on `patchRunSchema`.
- **Client** — `web/app/src/api/{types,client,queries}.ts`: mirrored types + hooks.
- **Cockpit** — `web/app/src/routes/task-thread/{task-thread,thread-items}.tsx`: queued composer branch, stacked bubbles, inline edit/remove.

## Non-goals

Explicitly not touched (per spec §Future work / §Research):

- Reordering stacked messages (drag-and-drop), per-message scheduling, templating.
- Cross-variant propagation — edits are per run, never fanned across a `groupId`.
- Editing `taskImages` (initial-prompt images) in v1.
- Re-running the LLM `autoNameRun` on a `task` edit.
- Optimistic concurrency (ETag/version) — last-write-wins is deliberate.
- The known `queue[]` vs `createdAt` ordering divergence; queue position is untouched.

## Risks

- **The dual-prompt hazard** (`pendingJobs.input.task` vs `RunRecord.task`) is the one real hazard, and it pre-exists this work. Step 1.4 removes it rather than adding to it. The regression to guard: an edit that "works" in the UI but never reaches the agent — asserted end-to-end by Step 1.4's delivered-`{{task}}` test.
- **Compounding on restart** — `hydrateQueuedInput` MUST be read-only and never write the folded task back to `RunRecord.task`, or every recovery re-appends the stack. Asserted directly by a Step 1.4 test.
- **Image suffix reuse** — the counter must seed from the highest existing numeric suffix in `<id>-images/` (across both `screenshot-*` and `pasted-*`), not the file count, plus exclusive-create + retry. Asserted in Step 1.2.
- **Phase 2 must never ship or revert alone against a live Phase 1** (spec §Rollback): the row builder is the piece that makes stacked messages visible, so reverting it alone leaves the agent receiving a longer prompt than the thread shows.
- **Route ordering** — `queued-messages/:msgId` must register before any conflicting `/:id` route (`server.ts:652-654` pattern).

## External References

None — no `--skill-url` passed.

## Verification strategy

- Unit tests per Step (mandatory), per the spec's inline *Test* clauses.
- Checkpoint after Step 1.5 (5 Steps) and at each ≥3-Step phase close.
- Final gate: full `validation.commands` (`npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`) + full integration suite + `om-code-review`.
- E2E in Step 3.1 forces the queue via `{"maxParallel": 1}` in the throwaway instance's config.
