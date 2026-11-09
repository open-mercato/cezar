# Execution plan: idle-closed spec as shipped

Source doc: .ai/specs/2026-11-04-idle-closed-attention-state.md
Refs: #1934 (review comment https://github.com/open-mercato/cezar/pull/1934#issuecomment-6689663586), #1935, #1933

## Goal

Make the idle-closed spec describe what #1935 shipped, so a future reader is not steered back
to the stale-flag bug the #1935 review pass caught.

## Scope

One file: `.ai/specs/2026-11-04-idle-closed-attention-state.md`. Every change is taken from the
review comment on #1934, the #1935 PR body, the 2026-11-04 run plan's "Deviations from the spec"
section, and the code on `main` (`db234af6`).

- Engine gate: stamp keys on `state.idleFailed`, set by `executeGraph` when the walk fails on the
  idle close itself, not on the timer flag `state.idleClosed`. The crash edge case is now handled.
- `idleFailed` is the real signal; only the dead branch was removed (A4 reworded).
- Archive keeps `idleClosedAt` (A7, `BACKWARD_COMPATIBILITY.md`).
- CHANGELOG: 0.19.0 lists #1935; the `task_failed` drop is recorded in the #1935 PR body.
- Insights drop idle closes from `finished` too; the step rail's red dot is a follow-up.
- Shipped extras worth naming: the idle step-end flag, the lifecycle note, the footer's
  `idleClosed` argument and the dashboard feed label.
- Replace `file.ts:NNNN` line refs with function, branch or symbol names.

## Non-goals

- No code, test or `BACKWARD_COMPATIBILITY.md` change.
- No fix for the step rail's red dot (named as a follow-up only).
- No edit to the 2026-11-04 run plan, which is a historical record.

## Implementation Plan

### Phase 1: Spec update

1. Rewrite the engine section, the edge cases and A4 around the shipped `idleFailed` gate.
2. Record the archive, Insights, CHANGELOG/telemetry and cockpit deviations, plus the step-rail
   follow-up, in the body and a "Deviations from the spec" section.
3. Replace `file.ts:NNNN` line refs with function, branch or symbol names.

## Risks

- Docs-only. The risk is an inaccurate description; each claim is checked against `main`.
- `validation.commands` has no Markdown lint, and `.ai/specs` is outside `docs:check`; the gate is
  a manual re-read of the diff against the code.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Spec update

- [x] 1.1 Rewrite the engine gate, edge cases and A4 around the shipped idleFailed gate — 00710de4
- [x] 1.2 Record the archive, Insights, CHANGELOG and cockpit deviations and the step-rail follow-up — 00710de4
- [x] 1.3 Replace line refs with function, branch or symbol names — 00710de4
