# Questions inbox, phase 2: WEB (cockpit)

You are one of four parallel sub-tasks implementing the approved Questions inbox design in cezar. You own the cockpit UI. Match the approved design page `.ai/specs/2026-11-17-questions-inbox.html` (open it in a browser; it is interactive) and the existing components.

Scope: `packages/web/**` and `packages/api-client/**` only. The server routes are built by a sibling. Code against the contract (`questionsResponseSchema`, `questionMutationResponseSchema`, `answerQuestionInputSchema`, `questionCountsSchema`), the routes `GET /api/v1/workspace/questions`, `POST /api/v1/workspace/questions/:key/answer`, `POST /api/v1/workspace/questions/:key/dismiss`, and a WebSocket topic named `questions` publishing `{live, older}`. Mock them in tests.

Implement:
1. **Data layer.** API functions plus a TanStack query. Subscribe to the `questions` topic ONCE at the root, the way health does (local mode only; remote mode refetches on SSE run/manager events). Invalidate on answer and dismiss.
2. **Sidebar.**
   - Manager-mode Workspace group: a **Questions** entry between Approvals and Jobs, with the live count (`manager-sidebar.tsx`). Workspace counts use the info fill (`bg-info text-background`) when >0 and the muted pill at 0, for Approvals too.
   - With managers off (`capabilities.managers` false), put the entry in the project sidebar's Workspace group instead.
   - Route `/manager/questions`, and `/questions` when managers are off. Register it in routes.tsx with a page label, lazy loaded, behind the right gate.
3. **The Questions page.**
   - Header with the status line, and a cross-link chip "N approvals waiting →". The Approvals page gets the mirror chip "N questions waiting →".
   - Filter chips: All, Managers, Tasks.
   - The Older toggle and days stepper, which writes workspace ui-state `questions.olderAfterDays` (0 = off).
   - Groups by source: manager avatar or task glyph, plus project; Open chat / Open task.
   - Cards reuse `AskForm` (one-tap, multi-select, Other…, Need more info). They show the age, **Open in context** (`/manager/<id>#decision-<messageId>`, or the task thread `#ask`), **Dismiss** with a 6 s undo (delay the POST; the undo cancels it; a polite live-region announcement), and the **Source task** block (reuse `decision-sources.tsx`) for manager items with sourceTasks.
   - The amber "May be out of date: <detail>" note with **Dismiss as out of date** for `stale` items, sorted last in their group.
   - The "also in <manager>'s chat" chip for `linked` items.
   - Folds for **Older** (not counted) and **Closed** (reason pill plus detail, link to the source task).
   - Empty state.
   - Focus rules from the design notes §E.
4. **Mobile.** The Manager index (CezarBot shell) gets Questions and Approvals rows at the top with counts. The Questions screen is responsive: one-column options, 44px targets.
5. **In chat.**
   - Manager chat (`manager-message.tsx`): a message with `askClosed` renders the quiet closed line (reason, struck-through question, "Go to the newer question" for replaced via `replacedBy`, "Answered in the task: …" for answeredIn). `askStale` adds the amber note on the open card with Dismiss as out of date.
   - Task thread (`task-thread/ask-card.tsx`, `thread-state.ts`): an `ask.closed` event closes the card into the same quiet state, replacing today's "next user message closes the card" rule. Sending from an ask card must pass `askRequestId` in the run message body (already in the contract `messageInputSchema`).
6. **Counts.** The sidebar's "Waiting for N answers" lines and the browser/native notification paths (`lib/notifications.ts`, `manager-heads.ts`) must agree with the live count. `pendingQuestions` keeps its meaning (live manager cards); the workspace badge reads the `questions` topic or query.
7. **Tests** for the page states (empty, grouped, answering, dismiss and undo, stale, older, closed, linked), the sidebar count, the quiet cards, and askRequestId on send.
8. **Screenshots**, before and after, desktop (1440×900) and mobile (390×844), with NO personal data: use `CEZ_DRY_RUN=1` and a throwaway `CEZ_HOME` with fake fixtures (the e2e fixture approach), never the real `~/.cezar`.
   - "Before" = the same screens on `origin/main`: manager sidebar, a manager chat with open cards, the Approvals page.
   - "After" = the sidebar with Questions, the Questions page (grouped, with stale and closed expanded), the mobile Questions screen, and a quiet closed card in chat.
   - Save PNGs into `$CEZ_ARTIFACTS_DIR/questions-inbox/` and list them in your report. They will go into the PR.

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
