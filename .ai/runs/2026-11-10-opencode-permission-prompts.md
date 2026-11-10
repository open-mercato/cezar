# Execution plan — OpenCode permission prompts reach the cockpit (#2042)

Source doc: https://github.com/open-mercato/cezar/issues/2042 · `.ai/specs/2026-07-17-permission-modes.md`

## Goal

An OpenCode permission prompt in an interactive session becomes an ask card the user can answer, instead of a silent `reject`.

## Scope

- `packages/cezar/src/core/opencode-server-runner.ts`: queue prompts `opencodePermissionReply` would refuse, raise each as `ask.requested` (Allow once / Always allow / Reject), and reply with the user's next message; free text is a refusal carrying the words as its message.
- Unchanged: this run's own handoff/attachments/TMPDIR still auto-granted; one-shot `run()` (no one to answer) still refuses with a note.
- Tests + mock fixture; docs that claimed OpenCode auto-approves everything.

## Non-goals

- Permission-mode presets (#475), the `permission.requested` protocol event, a dedicated permission card UI.

## Risks

- An autonomous OpenCode run now parks at `waiting` on a refused prompt, like any native ask (documented gap in `run.ts`); spec 2026-07-17 decided an unanswered prompt parks indefinitely.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix

- [x] 1.1 Ask the user for refused permission prompts in interactive sessions — fc4f143d7
- [x] 1.2 Regression tests and docs — fc4f143d7
