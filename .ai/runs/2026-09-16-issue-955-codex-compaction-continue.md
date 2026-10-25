# Execution plan — Codex stalls after context compaction and ignores Continue (#955)

- Issue: open-mercato/cezar#955
- Engine: om-auto-create-pr (steps: 13, --loop: no)
- Base branch: main
- Branch: `fix/issue-955-codex-compaction-continue`

## Goal

A Codex turn that ends only because the app-server compacted its own context must keep the run
**Working** and continue once on the same thread, instead of parking it under **Needs you**; and a
post-compaction follow-up the app-server rejects must become a visible failure instead of a run
that reads as `running` forever.

## Scope

- `packages/cezar/src/core/agent-runner.ts` — one additive optional field on the v1 `turn-end` event.
- `packages/cezar/src/core/codex-app-server-runner.ts` — detect the compaction boundary; make an
  asynchronous `turn/start` / `turn/steer` rejection authoritative.
- `packages/cezar/src/core/codex-ui-mapper.ts` — doc only: record that `contextCompaction` keeps
  its existing v2 tool-item mapping and where the lifecycle meaning now travels.
- `packages/cezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs` — the app-server sequence
  as a fixture, in all three candidate post-compaction shapes.
- `packages/cezar/src/workflows/run.ts` — the turn-end lifecycle, through ONE helper called from
  BOTH turn-end sites.
- Tests: `codex-app-server-runner.test.ts`, `workflows/run.test.ts`.
- Docs: `AGENT_PROTOCOL.md` §2 and `BACKWARD_COMPATIBILITY.md` §7 for the additive field.

### Non-goals

- The OpenCode runner (#897 is concurrent), automations, server-install, forge, web.
- Any `gpt-5.6-luna` conditional. The mitigation keys off verified app-server events and session
  state only.
- Changing what `turn-end`, `turn.completed` or the `contextCompaction` tool item mean today.
- Changing `/messages`, `/continue`, the marker vocabulary or its precedence.
- Redesigning Codex session persistence.

## Wire-contract assumption (no real Luna trace)

**No redacted Luna app-server trace was obtainable for this run.** #955 records the missing frames
as its two open questions, and no trace is attached to the issue or reachable from this task. The
fixture is therefore built from the documented app-server wire contract (`AGENT_PROTOCOL.md` §5,
the existing mock, and the reporter screenshot's item ordering), and the retry policy is chosen so
that it is correct under **all three** candidate follow-up shapes the issue enumerates rather than
betting on one:

| Candidate shape | Fixture | Chosen behaviour |
|---|---|---|
| Follow-up turn succeeds and works | `mock:compaction` | exactly ONE continuation, run keeps Working, then settles normally |
| Follow-up `turn/start` is **rejected** | `mock:compaction-reject` | authoritative `error` → visible failed run, no silent zombie |
| Follow-up compacts **again** | `mock:compaction-repeat` | bounded at `MAX_COMPACTION_CONTINUES`, then parks for the user |

## Implementation Plan

### Phase 1 — Reproduce the sequence on the wire

- 1.1 Extend `mock-codex-app-server.mjs` with the compaction sequence and the three post-compaction
  follow-up shapes, plus a child-thread compaction shape for the #600 guard.
- 1.2 Add failing runner regressions in `codex-app-server-runner.test.ts` that pin what the runner
  must say about a compaction-ended turn (red before Phase 2).

### Phase 2 — Carry the boundary through the runner/manager seam (additive)

- 2.1 Add the optional `reason?: TurnEndReason` field to the v1 `turn-end` event; document it in
  `AGENT_PROTOCOL.md` §2 and `BACKWARD_COMPATIBILITY.md` §7.
- 2.2 Track the compaction boundary in `CodexSession` and emit the reason on `turn/completed`
  only when no later assistant message or native ask established a real handoff; keep the existing
  `contextCompaction` tool item and v2 mapping untouched.

### Phase 3 — Make an async turn rejection authoritative

- 3.1 `sendMessage()`'s rejected `startOrSteerTurn()` emits `error` (the same signal `turn/failed`
  already uses) instead of a quiet note, guarded so cezar's own teardown stays a note.
- 3.2 Runner regression: a rejected post-compaction `turn/start`, and a rejected `turn/steer`.

### Phase 4 — One bounded continuation, at BOTH turn-end sites

- 4.1 Add `MAX_COMPACTION_CONTINUES`, the nudge text, and `ActiveRun.compactionContinues`.
- 4.2 Add `RunManager.tryCompactionContinue()` — the single helper both turn-end handlers call.
- 4.3 Wire it into `runContinuation`'s turn-end, below `CEZ:DONE` / `CEZ:ASK` / `CEZ:MONITORING`,
  dispatch and the autonomous nudge.
- 4.4 Wire the identical decision into `runAgentStep`'s turn-end, including the one-shot
  auto-close gate so a non-final step cannot be closed mid-compaction.

### Phase 5 — Regressions and the gate

- 5.1 `run.test.ts`: compaction-ended markerless turn stays Working and issues exactly one
  continuation; an ordinary markerless codex turn still parks `waiting`.
- 5.2 `run.test.ts`: `CEZ:DONE` / `CEZ:MONITORING` precedence over a compaction boundary;
  cancellation still wins; repeated compaction is bounded; the #600 child-thread filter holds.
- 5.3 `run.test.ts`: a rejected post-compaction follow-up leaves a visibly failed run, and the
  same lifecycle holds on the `runContinuation` site.
- 5.4 Prove the main regression red without the source fix, then run the full validation gate.

## Risks

- **Continuing a turn the user meant to own.** Mitigated by ranking the continuation strictly
  below every explicit marker, dispatch, cancellation and the autonomous nudge, and by requiring
  the compaction item to be the turn's *last* act on *our own* thread.
- **Spinning on repeated compaction.** Mitigated by `MAX_COMPACTION_CONTINUES` consecutive
  attempts, reset by any turn that ends for another reason and by a user message.
- **Escalating a benign async rejection to a failed run.** Mitigated by suppressing the escalation
  once cezar has closed or torn down the session (`stdinOpen` / `terminatedByCezar`).
- **No real Luna trace.** Mitigated by covering all three documented candidate shapes.

## Progress

PR: #1010

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce the sequence on the wire

- [x] 1.1 Extend the mock app-server with the compaction sequences — 71157592
- [x] 1.2 Failing runner regressions for the compaction boundary — 71157592

### Phase 2: Carry the boundary through the runner/manager seam

- [x] 2.1 Additive `turn-end` reason in the v1 protocol + docs — 71157592
- [x] 2.2 Detect the compaction boundary in CodexSession — 71157592

### Phase 3: Make an async turn rejection authoritative

- [x] 3.1 Rejected turn/start|steer emits an authoritative error — 71157592
- [x] 3.2 Runner regressions for both rejection paths — 71157592

### Phase 4: One bounded continuation, at BOTH turn-end sites

- [x] 4.1 Nudge text, bound and ActiveRun state — 7df5186e
- [x] 4.2 The shared tryCompactionContinue helper — 7df5186e
- [x] 4.3 Wire runContinuation's turn-end — 7df5186e
- [x] 4.4 Wire runAgentStep's turn-end and its auto-close gate — 7df5186e

### Phase 5: Regressions and the gate

- [x] 5.1 Working-not-waiting and the markerless control — 2b205150
- [x] 5.2 Marker precedence, cancellation, the bound and the #600 filter — 2b205150
- [x] 5.3 Rejected follow-up and the continuation site — 2b205150
- [x] 5.4 Red-without-fix proof and the full validation gate — 2b205150
