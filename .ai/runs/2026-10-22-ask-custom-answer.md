# Ask card: custom "Other" answer and "Need more info"

## Goal

Let the user answer an agent's `CEZ:ASK` question with their own text, or say they need more
context before answering, right on the ask card — and make every agent understand both.

## Scope

- Cockpit ask card (`packages/web/src/routes/task-thread/ask-card.tsx`, `ask-selections.ts`):
  every question gets two built-in choices after the agent's options — **Other…** (reveals a text
  field; the typed text is the answer) and **Need more info** (asks the agent to explain the
  question). Both count as an answer, so a card with a question the user cannot answer yet can
  still be sent.
- Agent side: the `CEZ:ASK` instructions (`packages/cezar/src/handoff.ts`) tell the agent the card
  offers both, and that a "need more information" answer means: explain the context and ask that
  question again.
- Codex native `requestUserInput` bridge: a single-select answer is one string, so a custom answer
  containing commas is no longer split into several answers.

## Non-goals

- No change to the `CEZ:ASK` payload schema or the `ask.requested` event shape.
- The composer stays available for a free-form reply to the whole card.

## Implementation Plan

### Phase 1: Cockpit

- 1.1 Per-question answer model (options + custom text + need-more-info) in the selection store
  and the card, with the two built-in choices and answer formatting.
- 1.2 Unit tests for Other / Need more info in one-tap and multi-question cards.

### Phase 2: Agents

- 2.1 Update the `CEZ:ASK` instructions so agents handle custom and need-more-info answers.
- 2.2 Codex bridge: keep a single-select answer whole; tests.

## Risks

- The answer text is line-oriented (`Header: answer`) and Codex parses it back per line — custom
  text is collapsed to one line before sending.

## Progress

PR: #1605

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Cockpit

- [x] 1.1 Per-question answer model with Other and Need more info — 9040b926
- [x] 1.2 Ask card unit tests — 9040b926

### Phase 2: Agents

- [x] 2.1 CEZ:ASK instructions cover custom and need-more-info answers — f84613e7
- [x] 2.2 Codex bridge keeps a single-select answer whole — 3f60ad6b
