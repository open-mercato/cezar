# Execution plan — copy button for short commands (#1931)

Source doc: .ai/specs/2026-10-06-tool-card-full-command.md

## Goal

Every execute tool card in the thread offers a copy button for the command the agent ran, short single-line commands included.

## Scope

- `packages/web/src/routes/task-thread/thread-items.tsx`: `CopyCommandButton` gets a `reveal` mode (hidden until row hover/focus on pointer devices, always shown on touch). `ToolCard` renders it whenever `toolCommand(item)` exists, and it copies the raw input, never the capped title.
- `packages/web/src/routes/task-thread/thread-items.test.tsx`: flip the old "no copy button for short commands" test; add cases for a collapsed short card, a collapsed long command and non-execute cards.
- Spec update: the Copy and Validation rules in `2026-10-06-tool-card-full-command.md`.

**Non-goals:** selectable header text; output, exit chip, other tool kinds; server or contract changes.

Decision confirmed by the reporter (2026-11-04): hover-reveal on collapsed rows, as built.

## Risks

- Open PR #1372 also edits `thread-items.tsx`. Whichever lands second rebases.
- Hover-only reveal is invisible on touch; mitigated by `@media (hover: hover)` gating.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Copy button on every command card

- [ ] 1.1 Render CopyCommandButton for every execute command, hover-revealed when collapsed, with tests
- [ ] 1.2 Update the tool-card-full-command spec's Copy and Validation rules

### Phase 2: Validation

- [ ] 2.1 Run the full validation gate
