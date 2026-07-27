# Execution plan — answering an AskUser card after the session ends resumes the run

**Date:** 2026-07-27
**Slug:** `ask-answer-resumes-session`
**Branch:** `feat/ask-answer-resumes-session`
**Base:** `main`
**Source doc:** `.ai/specs/2026-07-18-askuser-across-runners.md` (the AskUser feature this plan extends)

## Goal

When the agent parks on a `CEZ:ASK` question and the session later ends — idle
timeout, a cezar restart, "Finish", or a cancel — the question card must stay
answerable, and submitting the answer must reopen the agent session with those
answers delivered as the resuming prompt.

## Problem

`AskCard` always delivers its answer through `useSendMessage` →
`POST /api/runs/:id/messages` (`web/app/src/routes/task-thread/ask-card.tsx:27`).
That endpoint has a three-rung ladder — live session, queued-prompt fold,
starting-up buffer — and answers `409 { error: 'session closed' }` for everything
else (`src/server/server.ts:2173`). A `waiting` run whose session closed is
exactly that "everything else":

- `armIdleTimer` closes the parked session after the idle timeout
  (`src/workflows/run.ts:2281`), and the run settles at `review`/`done`;
- startup recovery settles a `waiting` run the same way
  (`src/workflows/run.ts:688`).

The persisted `ask.requested` event outlives both, so the card is rebuilt
unresolved by the thread reducer (`thread-state.ts:566`) and renders its option
chips as usual — but every tap fires `void sendMessage.mutateAsync(...)`, whose
rejection is swallowed. **The user clicks an option and nothing happens, with no
error.** The composer below it already solved this: `ThreadView` routes a closed
but resumable run's draft to `POST /continue` instead
(`task-thread.tsx:386`, `follow-up-engine.tsx`). The ask card never got that seam.

`POST /continue` is the right delivery vehicle: it reopens the last recorded
session on the run's own backend, appends the prompt as a `user-message` event
(`run.ts:1317`) — which is precisely what makes the thread reducer resolve the
pending ask card — and runs in the task's worktree.

## Scope

- One pure delivery-routing module for the ask answer (live session vs. resume vs.
  nothing to resume), unit-tested per run status like `run-actions.ts`.
- `AskCard` delivers through that seam, tells the user when answering will reopen
  the session, surfaces failures instead of swallowing them, and degrades to an
  honest disabled state when there is no session left to resume.
- A stale-cache fallback: a `409` from the live path retries as a resume, so a
  cockpit whose run record is behind (dropped SSE, long-open tab) still delivers.
- Tests for both the routing table and the card's three paths.
- Spec + changelog updates: the AskUser spec currently claims a finished run's card
  "renders resolved/closed", which this run replaces with answer-and-resume.

## Non-goals

- No change to `POST /api/runs/:id/messages`' contract. Its `409 session closed`
  stays a `409` — the auto-resume is an explicit client decision at the ask card,
  not an implicit server-side restart of any run that receives a message.
- No new API endpoint, no `RunRecord` field, no `UiEvent` change.
- No change to attention/"needs you" badging for a closed run holding an
  unanswered question. Worth doing, but it is a separate design question about the
  sidebar's status model and needs its own spec.
- No change to the `CEZ:ASK` marker, its schema, or the system prompt.
- No runner/model pills on the ask card: an answer resumes on the run's own engine,
  which is what `POST /continue` does when the overrides are omitted.

## Risks

- **Unintended agent restart.** Answering a finished run's question now spawns an
  agent session (tokens, a worktree). Mitigated by keeping this to the *ask card*
  (an explicit, unanswered question the agent itself raised) and by labelling the
  button state so the user knows the session reopens.
- **Race on a stale run record.** The cached status can disagree with the server.
  Mitigated by the 409 → resume fallback; if the resume also fails, the server's
  own words are surfaced on the card rather than swallowed.
- **`queued` runs.** A queued run can never hold an ask, but the routing must not
  mis-handle it — it stays on the live/stacking path, unchanged.

## Implementation Plan

### Phase 1: The delivery seam

- 1.1 Add `web/app/src/routes/task-thread/ask-delivery.ts`: a pure
  `askDeliveryMode(run)` → `'live' | 'resume' | 'unavailable'` reusing
  `runActionFlags`/`isRunActive`, plus a `useAnswerAsk(runId)` hook that reads the
  cached run, delivers on the matching path, retries a `409` as a resume, and
  invalidates the run queries on success.
- 1.2 Unit-test the routing table across every run status, with and without a
  recorded session id.

### Phase 2: The card

- 2.1 Wire `AskCard` to `useAnswerAsk`: chips and the combined **Send** go through
  it, the pending state disables the chips, and the copy tells the user when the
  answer reopens a closed session.
- 2.2 Surface a failed delivery inline on the card (polite live region) instead of
  dropping the rejection, and render an honest disabled state when there is no
  session to resume.
- 2.3 Extend `ask-card.test.tsx`: the live path is unchanged, the closed path
  resumes with the same answer text, a `409` on the live path falls back to a
  resume, a failure is shown, and the no-session state is inert.

### Phase 3: Docs and validation

- 3.3 Pin, in the thread reducer's own tests, that a continuation step's `user-message`
  resolves an ask left pending when the session ended — the cross-session half of the
  feature, previously unpinned.
- 3.1 Update `.ai/specs/2026-07-18-askuser-across-runners.md` (the finished-run edge
  case) and add the `CHANGELOG.md` entry.
- 3.2 Run the full validation gate: `npm run typecheck`, `npm test`,
  `npm run test:unit`, `npm run build`, `npm run test:package`.

## Progress

PR: #709

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: The delivery seam

- [x] 1.1 Add the ask-delivery routing module and the `useAskAnswer` hook — ab5d6150
- [x] 1.2 Unit-test the delivery routing table — ab5d6150

### Phase 2: The card

- [x] 2.1 Deliver the ask answer through the new seam — 5d7f0350
- [x] 2.2 Surface delivery failures and the no-session state on the card — 5d7f0350
- [x] 2.3 Extend the AskCard tests for the resume, fallback and failure paths — 5d7f0350

### Phase 3: Docs and validation

- [x] 3.1 Update the AskUser spec (no changelog entry — it is assembled per release) — 1de87482
- [x] 3.2 Run the full validation gate — typecheck ✅, `npm test` 4660 ✅, `npm run test:unit` 36 ✅, `npm run build` ✅, `npm run test:package` 9 ✅
- [x] 3.3 Pin the cross-session resolution in the reducer and verify the loop in a real cockpit
- [x] Post-review fix: split the resolved card from the delivery hook, scope the hint slot to the resume state, and stop the blocked path from echoing a reason the card already shows
