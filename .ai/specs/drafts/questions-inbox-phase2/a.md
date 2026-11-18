# Questions inbox, phase 2: MANAGERS side

You are one of four parallel sub-tasks implementing the approved Questions inbox design in cezar. You own manager decision cards (`CEZ:ASK` in a manager chat).

Scope: `packages/cezar/src/managers/**` (engine.ts, prompts.ts, snapshot.ts, store.ts, questions.ts and their tests). `scripts/mock-claude.mjs` only if the dry-run manager turn needs it. Nothing else.

Implement:
1. **Store the card id and about.** Keep `ask.id` and `ask.about` on the assistant message when a manager turn ends with `CEZ:ASK` (the parser already returns them).
2. **Open cards.** `openAsk` excludes `askClosed`. `ManagerSummary.pendingQuestions` counts open cards that are not Older. Older is open longer than `questions.olderAfterDays` days from the workspace ui-state (absent = 7, 0 = off; `QUESTIONS_OLDER_DEFAULT_DAYS`). Find how the engine or server reads workspace ui-state and inject it as an optional dep, defaulting to 7.
3. **Replaced.** A new card in the same manager chat closes every older open card that has the same `id`. When the cards have no ids, it closes those whose headers are ALL covered by the new card's headers. Partial overlap stays open. Store `askClosed { reason:'replaced', at, replacedBy: <new message id> }`.
4. **Withdrawn.** For `CEZ:ASK-CLOSE <id> [reason]` lines in a manager turn's text, close that manager's open card by id, or by header when the card has no id, as `retracted` with `detail` = the reason. Strip the lines from the displayed text. Ignore an unknown id and leave no crash; a one-line note message is fine.
5. **Expired, declared about only.** A card whose `about` has `{pr: N}` closes as `expired` (`detail` "PR #N merged" / "closed") when the existing `onPrClosed` bus or the `pullRequestClosed` path fires for that PR in one of the manager's projects. Reuse #2292's code in engine.ts. `{task: "<projectId>/<runId>"}` closes when that run reaches done, review, cancelled, archived or deleted. A `failed` run does NOT count (idle-closed and awaiting-answer stay open, #2286). Use whatever run-status signal the engine already observes for followed tasks; add no new polling. `{issue: N}` closes only if cezar already observes issue state; otherwise document that it is accepted but never fires.
6. **May be out of date** (`askStale`; the card stays open and counted):
   - `replied-in-chat`: the user sent a composer message (no `askId`) after the card. This REPLACES today's behavior where a composer reply answers every open card. Update the existing tests for that ("a card answers itself alone; the composer closes every open card").
   - `manager-acted`: after the card, the manager started a task, or proposed an approval, for a task or PR the card names.
   - `mentioned-work-ended`: a task or PR the card only mentions (`[[task:…]]`/`[[pr:…]]` or sourceTasks, without `about`) finished.
7. **Dismiss.** Close as `dismissed` and persist a `note`-style message ("You skipped «<header>»") that is prepended to the manager's NEXT turn prompt: "The user skipped your question «X». Don't wait for an answer; decide yourself, or ask again later only if it still blocks you." It starts no turn by itself.
8. **The agent re-checks.** Each manager turn (chat, watch check, job) includes the manager's open cards in its prompt or snapshot: id or header, age, and any stale reason, with "close any that no longer need the user with `CEZ:ASK-CLOSE <id> <reason>`, or ask again". Prompts (prompts.ts) teach a stable card `id` reused when re-asking, `about` for PR/task/issue decisions, `CEZ:ASK-CLOSE`, and relaying: when the manager re-asks a task's open question it must set `about: [{task:"<projectId>/<runId>", ask:"<that question's card id or requestId>"}]`. So the snapshot of a waiting task must expose its open question's id. Read it from `RunRecord.asks` (a sibling adds the field `asks?: TaskAskRecord[]` to RunRecord; read it defensively as optional), falling back to `dispatch.pendingAsk.requestId`.
9. **The provider.** Implement `createManagerQuestionProvider(engine)` per `questions/types.ts`:
   - `list()`: open cards plus those closed in the last 7 days. Answered cards count as closed `answered` with the answer. Include `sourceTasks` from `[[task:…]]` links and message.sourceTasks.
   - `answer()`: the same as answering on the card (engine send with askId).
   - `dismiss()`, as in item 7.
   - `close()`: used when the linked task copy closed. For `answered` with `answeredIn` it also queues a note for the next turn ("answered in the task: <answer>").
   - `onChange`: fires on every open, close and flag, with `closedItem` when something closed, INCLUDING a card answered from the chat.
10. **Tests** for every rule above, in engine.test.ts or a new managers/questions.test.ts.

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
