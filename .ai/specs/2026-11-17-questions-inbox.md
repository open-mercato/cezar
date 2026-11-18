# Questions inbox, next to Approvals

Status: **design, awaiting approval** (phase 1). Design page: `2026-11-17-questions-inbox.html` (self-contained, interactive).

## Problem

Open questions (manager `CEZ:ASK` decision cards, task ask cards) never close on their own. A card that a newer
one replaced, or whose task moved on, still counts: "Waiting for 3 answers" when 2 are obsolete.

## Decision

- **Questions** is a workspace-level page (`/manager/questions`, or `/questions` with managers off). Its sidebar
  entry sits in the Workspace group next to **Approvals**, with a live count. The two stay separate pages that
  link to each other. They are not tabs in one inbox: the verbs differ, approvals are the risky decision route,
  and the name "Inbox" is already taken by follow-ups.
- Rows are grouped by source (manager or task + project). Each row shows its age, header and question, and is
  answered inline with the existing `AskForm` (one-tap, multi-select, Other…, Need more info). Each row also has
  **Open in context** (`#decision-<id>`) and **Dismiss** (6 s undo).
- **Closed** (collapsed, last 7 days) lists answered, dismissed, replaced, withdrawn and task-ended questions, each
  with its reason. **Older** (toggle, on at 7 days by default) moves stale open questions out of the badges without
  closing them.
- In a chat, a closed card renders as one quiet line: the reason, the struck-through question, and a link to the
  card that replaced it.

## Close rules (server-side; the server decides every reason except Older)

| Reason | Trigger |
| --- | --- |
| answered | an answer from a card (today's `askId` path) |
| answered elsewhere | a manager card relaying a task's question declares `"about": [{"task": "<project>/<runId>", "ask": "<card id>"}]` (the snapshot gives the id). The two are one question: answering either closes both ("Answered in task X" / "in <manager>'s chat"). An answer on the manager card is delivered to the task by cezar directly; an answer in the task reaches the manager as a note on its next turn. Any other close of the task's question closes the copy too |
| dismissed | `POST /api/v1/workspace/questions/:key/dismiss`; undo is a client-side delay before the POST |
| replaced | a newer `CEZ:ASK` in the same chat/run with the same card `id` (prompts ask agents for a stable id and to reuse it when re-asking), or, without ids, whose headers cover every header of the older card. Partial overlap stays open |
| retracted | `CEZ:ASK-CLOSE <id\|header> [reason]` marker, same source only, parsed next to `CEZ:ASK` |
| expired | the card declares what it is about, `"about": [{"pr": 2891}]` (or `task`/`issue`), and that work is merged, closed or finished (the Approvals stale-merge check, applied to questions). No time-based expiry, and a mere mention never closes a card |
| ended | run reaches done/review, is cancelled, archived or deleted. `failed` (idle-closed, awaiting answer, or error) stays open: Continue can still answer it (#2286) |

## Relevance: the main list holds only what still needs an answer

- **Proved stale → closed** (above: expired, replaced, ended, retracted). No model call.
- **Suspected → flagged "may be out of date"**: `mayBeStale: { why, since }`, computed from data the server already
  has. The triggers: the user replied in that chat after the card, the task had more turns or commits without an
  answer, the manager acted on the same thing since, or a PR/task the card only *mentions* (no `about`) finished. The card **still counts**, sorts last in its group with an
  amber note, and offers one-click "Dismiss as out of date".
- **Agent confirms**: each manager check and each task turn lists the agent's open cards and asks it
  to close what no longer needs the user (`CEZ:ASK-CLOSE <id> <reason>`), or to ask again. The list shows any out-of-date flag.
- Answering a card that closed in the meantime (stale tab) returns 409. No confirm step, no age stamp (not chosen).

A free-text chat reply does **not** close a card (cezar can't know what it answered). It flags the card may-be-out-of-date
instead. This changes current behavior: today the manager composer closes every open card.

Evidence (local manager history, 2026-11-17): 208 cards, 9 open. A re-ask with renamed headers slipped past
header matching (hence stable ids). No open card had a natural deadline (hence no time expiry). About 69% of cards
mention a PR or task, often "task X done, what next?" (hence only a declared `about` closes).

## Data model

- Manager: `assistant` message gains `askClosed?: { reason, at, replacedBy?, note? }`; `openAsk` excludes it.
- Task: capped `RunRecord.asks[]` (`requestId, askedAt, questions, answeredAt?, closed?`), plus an `ask.closed`
  UiEvent in the run NDJSON so replays draw the quiet card (AGENT_PROTOCOL.md updated).
- Read: `GET /api/v1/workspace/questions` → `{ open[], closed[] }`, keys `m:<managerId>:<messageId>` /
  `r:<projectId>:<runId>:<requestId>`, zod in `packages/contract`, chained single-mount route.
- Relayed pair: merged into one inbox item under the task (chip "also in <manager>'s chat"), counted once; closing either closes both in one write.
- Older: ui-state `questionsOlderAfterDays` (absent = 7, `0` = off), computed, never stored.

## Telling the agent on dismiss

- Manager: a `note` message ("You skipped «X»"), prepended to the next turn. It starts no turn by itself.
- Task parked `waiting` on that ask: the note is delivered as the user's message (wakes it, one turn).
- Task closed (idle or awaiting answer): queued, sent with the next Continue. The session does not resume.
- Task already past that ask, or replaced/retracted/ended: nothing is sent.

## Counts

One `liveQuestions()` (open and not Older; flagged cards count) feeds `pendingQuestions`, the Questions badge, needs-you, the notch,
native notifications and the push badge. One `questions` WebSocket topic publishes `{ live, older }` on change.
Remote mode reconciles over SSE.

## Phase 2 tests

One test for each close rule (replaced by id / by covered headers / partial overlap stays open; retracted; expired by a
declared `about` PR merging, a mention-only PR merging flags but does not close; ended for done, cancelled and archived; idle-closed stays open). Each
out-of-date flag trigger, and the agent closing a flagged card; the stale-tab 409. Relayed pair: answer in task closes the manager copy and vice versa (task receives the answer once), counted once. Dismiss for each delivery path, undo, and count parity across
summary, badge and push. Before/after screenshots on desktop and mobile.
