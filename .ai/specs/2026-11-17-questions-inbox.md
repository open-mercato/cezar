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
| dismissed | `POST /api/v1/workspace/questions/:key/dismiss`; undo is a client-side delay before the POST |
| replaced | a newer `CEZ:ASK` in the same chat/run with the same card `id`, or whose headers cover every header of the older card. Partial overlap stays open |
| retracted | `CEZ:ASK-CLOSE <id\|header> [reason]` marker, same source only, parsed next to `CEZ:ASK` |
| expired | **proved** stale: an agent-set `expires` in `CEZ:ASK` (a time, or `{"until":{"pr"\|"task"\|"issue"\|"branch":…,"state":…}}`) was reached, or a PR, task or issue the card links reached a final state (the Approvals stale-merge check, applied to questions) |
| ended | run reaches done/review, is cancelled, archived or deleted. `failed` (idle-closed, awaiting answer, or error) stays open: Continue can still answer it (#2286) |

## Relevance: the main list holds only what still needs an answer

- **Proved stale → closed** (above: expired, replaced, ended, retracted). No model call.
- **Suspected → "Probably handled"**: `probablyHandled: { why, since }`, computed from data the server already has. The
  triggers: the user replied in that chat after the card, the task had more turns or commits without an answer, or the
  manager acted on the same thing since. The card leaves the main list, the badges and push, and stays answerable.
  "Still needs me" puts it back.
- **Agent confirms**: each manager check and each task turn lists the agent's open and probably-handled cards and asks it
  to close what no longer needs the user (`CEZ:ASK-CLOSE <id> <reason>`), or to ask again.
- **Late-answer guard**: answering a probably-handled or Older card first asks for confirmation. The answer that goes out
  says how old the question was and what changed since. Answering a closed card returns 409.

A free-text chat reply does **not** close a card (cezar can't know what it answered). It marks the card probably handled
instead. This changes current behavior: today the manager composer closes every open card.

## Data model

- Manager: `assistant` message gains `askClosed?: { reason, at, replacedBy?, note? }`; `openAsk` excludes it.
- Task: capped `RunRecord.asks[]` (`requestId, askedAt, questions, answeredAt?, closed?`), plus an `ask.closed`
  UiEvent in the run NDJSON so replays draw the quiet card (AGENT_PROTOCOL.md updated).
- Read: `GET /api/v1/workspace/questions` → `{ open[], closed[] }`, keys `m:<managerId>:<messageId>` /
  `r:<projectId>:<runId>:<requestId>`, zod in `packages/contract`, chained single-mount route.
- Older: ui-state `questionsOlderAfterDays` (absent = 7, `0` = off), computed, never stored.

## Telling the agent on dismiss

- Manager: a `note` message ("You skipped «X»"), prepended to the next turn. It starts no turn by itself.
- Task parked `waiting` on that ask: the note is delivered as the user's message (wakes it, one turn).
- Task closed (idle or awaiting answer): queued, sent with the next Continue. The session does not resume.
- Task already past that ask, or replaced/retracted/ended: nothing is sent.

## Counts

One `liveQuestions()` (open, not probably handled, not Older) feeds `pendingQuestions`, the Questions badge, needs-you, the notch,
native notifications and the push badge. One `questions` WebSocket topic publishes `{ live, older }` on change.
Remote mode reconciles over SSE.

## Phase 2 tests

One test for each close rule (replaced by id / by covered headers / partial overlap stays open; retracted; expired by
time, by `until` and by a linked PR merging; ended for done, cancelled and archived; idle-closed stays open). Each
probably-handled trigger, and the agent confirming one; the late-answer 409. Dismiss for each delivery path, undo, and count parity across
summary, badge and push. Before/after screenshots on desktop and mobile.
