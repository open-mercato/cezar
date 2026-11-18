# Questions inbox, phase 2: TASKS side

You are one of four parallel sub-tasks implementing the approved Questions inbox design in cezar. You own task questions: `CEZ:ASK` in a task run, and the ask card.

Scope: `packages/cezar/src/workflows/**`, `packages/cezar/src/runs/**` (store.ts, questions.ts, event-history.ts and tests), `packages/cezar/src/core/ui-events.ts` (emit helpers only), `packages/cezar/src/dispatch/prompts.ts`, the file(s) that hold the task-facing CEZ:ASK marker instructions (grep "Structured question marker"), `packages/contract/src/runs.ts`, `AGENT_PROTOCOL.md`. Nothing else: no server.ts, no managers, no web, no api-client.

Implement:
1. **`RunRecord.asks?: TaskAskRecord[]`** (contract runs.ts; cap `TASK_ASKS_MAX`, newest kept). First check how an OLDER cezar parses runs.json: `recordAsk` warns of an all-or-nothing index parser. If an older parser would reject a run that has an unknown `asks` key, store the asks in a per-run sidecar file instead and explain why in the report. Record each `CEZ:ASK` in `recordAsk` with requestId, askedAt, cardId, about and questions. Make sure BOTH turn-end handlers (streaming and non-streaming) and BOTH ActiveRun construction sites (execute and runContinuation) reach it.
2. **`ask.closed` UiEvent.** Append it to the run's NDJSON (helper in core/ui-events.ts) whenever a task question closes, with reason, detail, replacedBy and answer, and set `asks[i].closed`. Update AGENT_PROTOCOL.md: it currently says there is no resolution event.
3. **Answered.** A message with `askRequestId` (already in contract `messageInputSchema`) closes that ask as `answered` with the text. A message WITHOUT it no longer closes anything: it flags the open ask `replied-in-chat` (`stale`, still counted).
4. **Replaced.** A new CEZ:ASK in the same run closes older open asks with the same card id, or, without ids, those whose headers are all covered by the new card. Partial overlap stays open.
5. **Withdrawn.** For `CEZ:ASK-CLOSE <id> [reason]` lines in a task turn, close by id, or by header when the ask has no id, as `retracted`. Strip the lines from the transcript text.
6. **Ended.** The run reaches done, review, cancelled, archived or deleted: close its open asks as `ended` with how it ended. A `failed` run does NOT end them: idle-closed (`idleClosedAt`), awaiting-answer and error all stay open (#2286).
7. **Expired, declared about only.** `{pr:N}` uses the `onPrClosed` bus (`server/forge/pr-closed.ts`; import only, do not edit). `{task}` closes when that run reaches a final state, as in item 6. `{issue}` closes only where state is already observed.
8. **May be out of date.** `task-moved-on`: the run had another turn after the ask without an answer, or is no longer waiting on it. `new-commits`: HEAD moved since the ask; a cheap check at turn end, no polling. `replied-in-chat`, as in item 3.
9. **Dismiss delivery**, used by the provider's dismiss:
   - The run is parked `waiting` on that ask: deliver a message "The user skipped your question «X». Don't wait for an answer; decide yourself, or ask again later only if it still blocks you." This wakes the run for one turn.
   - The run is closed (idle-closed or awaiting answer): queue it in `queuedMessages` for the next Continue, without resuming.
   - Otherwise: just close the ask.
10. **The agent re-checks, and the prompts.**
    - Each task turn's continuation context lists the run's open asks (id or header, age, stale reason) with "close any that no longer need the user with `CEZ:ASK-CLOSE <id> <reason>`".
    - The task-facing CEZ:ASK instructions and the dispatch prompts teach a stable card `"id"` reused when re-asking, `"about": [{"pr":N}|{"issue":N}|{"task":"<projectId>/<runId>"}]`, and `CEZ:ASK-CLOSE <id> [reason]`.
11. **The provider.** Implement `createTaskQuestionProvider({ contexts })` per `questions/types.ts`, across all registered projects. ProjectContexts are lazy, so pick a cheap way to cover projects that have runs with open asks, and explain it.
    - `list()`: open asks plus those closed in the last 7 days. The source is the task (title, status). `sourceTasks` stays unset.
    - `answer()`: deliver a message with askRequestId.
    - `dismiss()`, as in item 9.
    - `close()`: used when the manager's linked copy closed. For `answered` it DELIVERS the answer to the task, since the aggregator calls `answer()` for that, so close() just records it.
    - `onChange`: fires on every open, close and flag, with `closedItem`.
12. **Tests** for every rule, including the two turn-end handlers and the restart/Continue path.

## Rules for this sub-task (shared by all four siblings)
- The design is settled; do not re-litigate it. Read `.ai/specs/2026-11-17-questions-inbox.md`, and the interactive page `.ai/specs/2026-11-17-questions-inbox.html` (§04 rules table, §06 notes).
- The foundation is already on your branch (`git show 9e49d2e8d 049f80e86`): `packages/contract/src/questions.ts` (QuestionItem, QuestionClosed, QuestionStale, TaskAskRecord, questionKey/parseQuestionKey, constants); `managerAskSchema.id/about`; assistant message `askClosed`/`askStale`; workspace ui-state `questions.olderAfterDays`; run message `askRequestId`; the `ask.closed` UiEvent (server `core/ui-events.ts` and `api-client/src/protocol/ui-events.ts`); `core/ask.ts` card `id`/`about` plus `parseAskCloseMarkers`/`stripAskCloseMarkers`; `packages/cezar/src/questions/types.ts` (the `QuestionProvider` interface) with STUB providers in `managers/questions.ts` and `runs/questions.ts`.
- FROZEN: `packages/contract/src/questions.ts`, `packages/cezar/src/questions/types.ts`, the new exports in `core/ask.ts`, and the factory signatures `createManagerQuestionProvider(engine)` and `createTaskQuestionProvider({ contexts })`. You may ADD optional deps. If you truly need a frozen change, write a markdown file into the tree's `inbox/root/` explaining it, and carry on with a local workaround.
- Stay strictly inside your scope. Three siblings edit the other areas in parallel, so any file outside your scope breaks the merge.
- Run `npm ci` first: your worktree has no node_modules, and without them imports resolve to an older checkout. Before running tests, unset every inherited `CEZ_*` env var except CEZ_BIN, CEZ_HANDOFF_FILE, CEZ_ARTIFACTS_DIR and CEZ_TREE_DIR, and use `TMPDIR=/private/tmp`.
- Run only the tests relevant to your change (`npm test -- <paths>`), plus `npm run typecheck`. Never `npx vitest`.
- Follow AGENTS.md: short comments that cite the spec, zod at every boundary, no new CEZ_* flag, and the construction-site and two-turn-end-handler warnings in "Changing a mechanism that already works".
- Commit on your branch with Conventional Commits. Do not push, and do not open a PR.
- Every close, flag and link rule you implement needs a test. Prove that the key ones fail without the fix.
- Done means: everything in your list is implemented and tested, typecheck is green, and the relevant tests pass. Report with `node "$CEZ_BIN" task report`, listing changed files, the tests you ran with their result line, and anything a sibling or the root must wire up.
