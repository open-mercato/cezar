# Codex reasoning visibility

## Goal

Ensure Codex reasoning is visible in the task thread when the app-server delivers reasoning as completed snapshot arrays, including after persisted-event replay.

## Scope

- Align the Codex UI mapper with the installed app-server v2 `ReasoningThreadItem` shape (`summary: string[]`, `content: string[]`).
- Preserve the existing live delta precedence and persistence behavior.
- Add wire-faithful golden and focused regression coverage for snapshot-only reasoning.
- Document the verified protocol shape where the repository records backend mappings.

## Non-goals

- Expose private chain-of-thought that Codex does not provide through its app-server protocol.
- Change reasoning presentation, disclosure controls, or the thread layout.
- Rework the resumed-step identity fix delivered by PR #564.

## Implementation Plan

### Phase 1: Protocol fidelity

1. Add a golden transcript that reproduces snapshot-only Codex reasoning with array fields.
2. Normalize reasoning snapshot arrays without regressing streamed delta precedence.

### Phase 2: Regression verification

1. Cover persisted replay and mixed snapshot/delta edge cases, and update the protocol note.
2. Run the configured validation gate and review the branch for compatibility and scope.

## Risks

- Joining multiple reasoning parts with the wrong separator could change meaning; preserve part boundaries with newlines.
- Snapshot text must not overwrite a fuller live raw-reasoning stream or concatenate raw reasoning with its summary.
- Empty or malformed wire arrays must continue to degrade to an empty, non-throwing item.
- GitHub rejects a formal approval from the PR author, so a different reviewer must submit the required approval.

## Progress

PR: #573

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Protocol fidelity

- [x] 1.1 Add a golden transcript that reproduces snapshot-only Codex reasoning with array fields. — 0f46997
- [x] 1.2 Normalize reasoning snapshot arrays without regressing streamed delta precedence. — 0f46997

### Phase 2: Regression verification

- [x] 2.1 Cover persisted replay and mixed snapshot/delta edge cases, and update the protocol note. — af72b54
- [x] 2.2 Run the configured validation gate and review the branch for compatibility and scope. — 638b5b2
