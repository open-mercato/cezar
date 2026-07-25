# Execution plan — task name spacing root cause

## Overview

### Goal

Prevent separate assistant messages from being concatenated into `CEZ:TITLE` marker values, so task names remain terse and readable across both initial and resumed agent sessions.

### Scope

- Correct the shared turn-text assembly behavior in `RunManager`.
- Cover both execution paths that accumulate assistant text.
- Add regression tests using the observed marker-followed-by-commentary shape.
- Verify that PR #627 is present and retain its downstream malformed-title protections.

### Non-goals

- Do not rewrite existing `runs.json` records.
- Do not change the `CEZ:TITLE` marker syntax or precedence.
- Do not broaden heuristic camel-case detection, which could damage valid identifiers and user-authored titles.

## Root cause

PR #627 is merged into and present in this instance. It rejects malformed namer output and falls back from legacy auto titles containing punctuation followed immediately by uppercase text. The screenshot instead contains marker-owned titles such as `linking per-project limitsThe verificat…`.

The persisted NDJSON contains a valid standalone marker, `CEZ:TITLE=linking per-project limits`, followed by a separate commentary message beginning `The verification…`. Both `RunManager` session loops currently assemble `turnText` with `turnText += event.text`, so adjacent message events lose their boundary. The marker parser then correctly—but undesirably—reads the fused line as one marker title. The fix belongs at this shared event-assembly seam.

## Implementation Plan

### Phase 1: Preserve assistant message boundaries

1. Update both `RunManager` turn-text accumulators to retain a newline between separate text events without altering streaming chunks within an event.
2. Add focused regression coverage proving a title marker cannot absorb the following assistant message in initial and resumed execution.

### Phase 2: Verify compatibility and delivery

1. Run targeted tests and the full configured validation gate.
2. Complete the authoritative PR review, record verification evidence, and finalize the PR.

## Risks

- Blindly inserting separators between every streamed delta could alter marker and completion detection. The implementation must distinguish message/event boundaries from chunks that already form one message, or otherwise prove the runner event contract makes the separator harmless.
- Turn-text feeds completion, monitoring, structured-question, reference-marker, and live-title logic; regression tests must cover the shared assembly behavior rather than only the UI fallback.

## Progress

PR: #636

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Preserve assistant message boundaries

- [x] 1.1 Update both `RunManager` turn-text accumulators to retain a newline between separate text events without altering streaming chunks within an event — aaaf6f9
- [x] 1.2 Add focused regression coverage proving a title marker cannot absorb the following assistant message in initial and resumed execution — aaaf6f9

### Phase 2: Verify compatibility and delivery

- [x] 2.1 Run targeted tests and the full configured validation gate — aaaf6f9
- [x] 2.2 Complete the authoritative PR review, record verification evidence, and finalize the PR — 21bac17
