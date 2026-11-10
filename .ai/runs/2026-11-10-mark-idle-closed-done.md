# Mark an idle-closed task as done (#2053)

Source doc: .ai/specs/2026-11-04-idle-closed-attention-state.md

## Goal

Give an idle-closed run (`failed` + `idleClosedAt`) a **Mark as done** action that settles it as
`done` — run and the idle-closing step — so the sidebar, step rail, Graph tab and stats all read it
as finished.

## Scope

- Engine: a new last case in `RunManager.finish()` for `status === 'failed' && idleClosedAt && !isActive`.
  One write: `status: 'done'`, `completionReason: 'accepted'`, `error: undefined`, `seenAt: now`
  (the user just dealt with it); `idleClosedAt` is cleared by `updateRun`. The idle-closing step
  (the failed step carrying the run's error, latest `finishedAt`) is rewritten to `done`.
  Lifecycle event `marked done by user`.
- Cockpit: `runActionFlags().finish` also true for `isIdleClosed(run)`; `finishTitle` says
  "Mark as done"; the footer reads "Closed after inactivity — Continue to pick it up, or mark it
  done" with "mark it done" a working control; the palette gets a "Mark as done" entry.
- Spec note: extend the "Continue, Finish, cancel and archive retire it" note.

Non-goals: offering it on real failures; a new `RunStatus`/`StepStatus`/completion reason; the
idle-close policy (#1290); re-reporting a dispatched child to its parent.

Decisions on the issue's open questions (proposed defaults, accepted): reuse `'accepted'`; the late
`task.finished` webhook is accepted; a dispatched child is not re-reported.

## Risks

- Picking the wrong step to rewrite. Mitigation: only a `failed` step whose `error` equals the run's
  idle error, latest `finishedAt`; nothing else is touched.
- #2054 edits the same docs paragraph — possible textual conflict; checked at the end.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Engine

- [x] 1.1 Settle an idle-closed run as done in finish() — fc8101ef

### Phase 2: Cockpit

- [x] 2.1 Offer Mark as done in action flags, header and palette — deca6b52
- [x] 2.2 Footer advice with a working mark-it-done control — e80f9763

### Phase 3: Docs

- [x] 3.1 Spec note and feature page — c1f1c3c6
