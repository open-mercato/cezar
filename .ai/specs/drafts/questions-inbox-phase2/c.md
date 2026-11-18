# Questions inbox, phase 2: AGGREGATOR, API, COUNTS

You are one of four parallel sub-tasks implementing the approved Questions inbox design in cezar. You own the piece that merges the manager and task questions and serves them.

Scope: `packages/cezar/src/questions/**` (types.ts is frozen), `packages/cezar/src/server/**` (server.ts route family and boot wiring, ws.ts topic, validators use), `BACKWARD_COMPATIBILITY.md`, `.env.example` only if unavoidable (it should not be), the server-side contract-parity, typed-bodies and route-inventory tests. Do not edit managers/, runs/, workflows/ or packages/web.

Implement:
1. **`questions/inbox.ts`**, the aggregator over two `QuestionProvider`s. The real ones are stubs on your branch and a sibling fills them in, so test with fakes.
   - **Merge.** Merge the providers' lists. Compute `older` from workspace ui-state `questions.olderAfterDays` (absent = `QUESTIONS_OLDER_DEFAULT_DAYS`, 0 = off).
   - **Link pairs.** A manager item whose `about` contains `{task:"<p>/<r>", ask:X}` is the same question as the task item of run p/r whose `cardId === X` or requestId === X. Return ONE open item (the task's), with `linked` = the manager copy's key and source. Counted once. If the manager copy is already closed, show nothing extra.
   - **Propagate closes.** On a provider's `onChange.closedItem` for a linked pair, close the other copy. Task answered: `managerProvider.close(mKey, {reason:'answered', answeredIn:'task:p/r', answer})`. Manager copy answered: `taskProvider.answer(rKey, answer)`, which delivers to the task, then mark `answeredIn: 'manager:<id>'`. Any other task close (replaced, retracted, ended, expired): close the manager copy with the same reason.
   - **Counts.** `live` = open, not older, stale included, linked pair once. `older` likewise.
   - **Closed.** Last 7 days, newest first, max 50.
2. **Routes** (workspace-level, single-mount, chained into a family builder, middleware validators from `server/validators.ts`, contract schemas from `questions.ts`):
   - `GET /api/v1/workspace/questions` → `questionsResponseSchema`.
   - `POST /api/v1/workspace/questions/:key/answer` (`answerQuestionInputSchema`) → `questionMutationResponseSchema`. A linked manager item answers the task copy.
   - `POST /api/v1/workspace/questions/:key/dismiss` → `questionMutationResponseSchema`.
   - 404 unknown key, 409 already closed (`{error}`).
   - Keep contract-parity, typed-bodies, versioned-surface and bc-route-inventory green, and inventory the routes in BACKWARD_COMPATIBILITY.md §2. Also note there the new contract fields (managerAsk id/about, askClosed/askStale, askRequestId, ask.closed event, ui-state questions, RunRecord.asks) as additive.
3. **WebSocket topic `questions`**: publishes `{ live, older }` (questionCountsSchema) only on change, demand-driven (start on first subscriber), counts only so it is safe for loopbackReadable. Follow the `health` topic pattern and `.ai/specs/2026-07-23-websocket-subscriptions.md`.
4. **One count everywhere.**
   - The relay push badge (server.ts, about line 8867, currently sums pendingActions) must add `counts.live`.
   - Find every other server-side consumer of a "needs you"/questions number (desktop notch fixture `packages/desktop/src-tauri/fixtures/notch-model.json` is read-only for you; check what the notch reads from the server) and make it consistent, or report what the web sibling must do.
5. **Wiring.** Construct the providers at boot (`createManagerQuestionProvider(managerEngine)`, `createTaskQuestionProvider({ contexts })`). Managers may be disabled (`CEZ_MANAGERS=0`): then there is no manager provider, and the inbox still serves task questions.
6. **Tests**: aggregator rules (link, count once, propagate each direction, older on/off/days, closed window), routes (200/404/409, validation), topic publish-on-change.

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
