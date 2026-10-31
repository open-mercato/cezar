# Lift the CEZ:ASK question and option caps

Goal: an agent that genuinely has five (or fifteen) decisions for the user gets an ask card for all of them, instead of having the whole payload refused and its questions dumped as raw JSON.

Reported from a live run: a `CEZ:ASK` carrying 5 well-formed questions was refused with `questions: Too big: expected array to have <=4 items`, and the agent's questions reached the user as unrendered JSON. The brief: "We should not have such restriction."

## Investigation

- `askRequestSchema` (`packages/cezar/src/core/ask.ts:43`) caps `questions` at 4 and `options` at 4. The module header gives the reason: the shape is "modeled 1:1 on Claude Code's built-in `AskUserQuestion` (1–4 questions, 2–4 options each)" so a native bridge could map onto it later.
- That parity argument is the *only* stated reason for either count. `CEZ:ASK` is cezar's own turn-end marker, rendered by cezar's own cockpit — nothing downstream needs AskUserQuestion's limits.
- Nothing downstream enforces them either. `UiAskRequestedEvent.questions` is a plain TS interface in both `core/ui-events.ts` and `api-client`; `AskCard` (`packages/web/src/routes/task-thread/ask-card.tsx`) maps over `questions` and `options` and already has the combined-**Send** path for more than one question. No runtime cap, no layout assumption.
- Two places duplicate the constant instead of deriving it:
  - `codexAskQuestions` (`packages/cezar/src/core/codex-app-server-runner.ts:622`) pre-checks `value.length > 4` before deferring to `parseAskRequest` — a second copy of the bound that would silently stay at 4.
  - `dispatch.pendingAsk.questions` (`packages/contract/src/dispatch.ts:102`) is `z.array(z.string().max(400)).max(4)`, written by `recordAsk` (`packages/cezar/src/workflows/run.ts:2030`) from `ask.questions`. Today the ask schema keeps it under 4; raising the ask cap alone would let a dispatched child park on 5 questions and write a run record that fails `runRecordSchema`. `readRunIndexFromDisk` is all-or-nothing (`return []` on parse failure), so one such record would empty the **whole project's** task index in the workspace palette and search.
- The persisted park list is therefore the one real constraint, and it is a *downgrade* constraint: raising its bound makes a newly written `runs.json` unreadable to an older cezar's index reader, which `BACKWARD_COMPATIBILITY.md` §"run record" treats as the thing to avoid. The record stays within its existing bound instead, and an additive `omittedQuestions` count keeps the blocked-child report honest about what it is not listing. The parent already receives every question in full through the Guard inbox message, which is a markdown file under no schema.
- `ask.test.ts:53` ("rejects more than 4 questions") passes `[q, q, q, q, q]` — five copies of the same question, which also violates the uniqueness refinement, so it would still fail for a second reason after the cap moves. The replacement uses distinct questions.

## Approach

- One source of truth: `ASK_MAX_QUESTIONS = 20` and `ASK_MAX_OPTIONS = 10`, exported from `core/ask.ts` and used by the schema. The bounds stay finite as payload-size and render safety, not as AskUserQuestion parity — and the header comment says so.
- `codexAskQuestions` stops carrying its own copy of the count and lets `parseAskRequest` be the only judge of how many questions are allowed.
- `recordAsk` persists at most `PENDING_ASK_MAX_QUESTIONS` (4, the unchanged contract bound) question texts plus an additive `omittedQuestions` count; `childSettleReport` renders the remainder as `(+N more)`. The inbox message to the parent keeps listing every question.
- Agent-facing text (`handoff.ts` prompt, `AGENT_PROTOCOL.md`) states the new bounds, so an agent does not keep self-censoring to four.

Non-goals: no change to the per-string limits (`header` ≤12, `question` ≤400, `label` ≤60, `description` ≤280), to uniqueness, to strictness, or to either forgiveness layer (`normalizeAskRequest`, `closeUnbalancedJson`); no ask-card redesign for long lists; no change to how answers are composed or delivered.

Scope note: the brief names the question cap. The option cap is raised in the same change because it is the same arbitrary parity bound on the same payload — a 5-option question is as legitimate as a 5th question, and leaving it would reproduce the identical refusal next week.

## Progress

PR: #1312

Review: `om-auto-review-pr --autofix` found two majors in this PR's own diff — the new `PENDING_ASK_MAX_QUESTIONS` not wired to the schema beside it, and `codexAskQuestions` mapping an unbounded array before validation once its length check was dropped. Both fixed in de4a7c5b; the full gate was re-run green after.

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Widen the schema

- [x] 1.1 Named bounds in `core/ask.ts`, raised to 20 questions / 10 options, with the parity rationale retired in the header. — 26efe79e
- [x] 1.2 Drop the duplicated count bound in `codexAskQuestions`. — 26efe79e
- [x] 1.3 Schema tests: a 5-question and an at-the-max payload accepted, over-the-max rejected with distinct questions, option bound likewise. Plus a `mock:ask-many` integration test (6 questions, 6 options) that is red at 4/4. — 26efe79e

### Phase 2: Keep the parked record readable

- [x] 2.1 Persist at most the contract's 4 question texts with an additive `omittedQuestions`, and report the remainder as `(+N more)`. — 9065eb4d
- [x] 2.2 Tests: a 6-question park writes a schema-valid record, keeps the full inbox message, and settles `blocked` naming the omitted count. — 9065eb4d

### Phase 3: Teach and document

- [x] 3.1 New bounds in the `handoff.ts` structured-question prompt and `AGENT_PROTOCOL.md`. — e4478bf3
- [x] 3.2 `BACKWARD_COMPATIBILITY.md`: the marker accepts more, the record shape is unchanged. — e4478bf3
- [x] 3.3 Full validation gate and PR. — typecheck, npm test (8925 passed / 0 failed), test:unit, build, test:package all exit 0 with a cleared env.

## Risks

- **Low.** Widening what the marker accepts cannot reject a payload that works today, and the persisted record shape does not change at all, so no older cezar loses a file it can read now.
- A very long card (20 questions) is a wall of chips to scroll. Deliberate: the agent is told to prefer defaults over asking, and a refused payload — the behavior being replaced — showed the user raw JSON instead.
- The blocked-child settle report lists at most 4 question texts plus a count. The complete list still reaches the parent through the inbox message at ask time.
