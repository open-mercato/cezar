# Markdown reasoning and coherent browse roots

## Goal

Render agent reasoning as Markdown and keep the Add Project folder browser immediately consistent with a validated, existing browse-root setting.

## Scope

- Render expanded reasoning content through the thread's shared sanitized Markdown component and prevent Markdown delimiters from leaking into the collapsed preview.
- Require a changed browse root to already exist and be a directory, returning a clear warning without persisting invalid input.
- Preserve recursive directory creation for the checkout root on settings save and clone.
- Invalidate cached filesystem listings after a browse-root save so the next Add Project dialog opens at the new root without a browser refresh.
- Add focused server and cockpit regression tests and update the workspace contract documentation.

## Non-goals

- No changes to OpenCode event mapping or the backend-neutral reasoning protocol.
- No change to checkout-root defaults or checkout-time creation.
- No redesign of the folder picker or settings layout.

## Source doc

`AGENT_PROTOCOL.md` and `.ai/specs/2026-07-20-multi-project-workspace.md`

## Implementation Plan

### Phase 1: Reasoning Markdown

1. Render expanded reasoning through the shared Markdown surface while keeping a compact safe preview.
2. Add component coverage for emphasis, inline code, and multiline reasoning.

### Phase 2: Browse-root validation and cache coherence

1. Validate that browse roots exist without creating them, while checkout roots retain recursive creation.
2. Invalidate filesystem-browser queries after a browse-root save.
3. Add server and UI regression coverage and update the documented contract.

## Risks

- Markdown rendering must retain sanitization and must not introduce interactive elements inside the collapsible trigger.
- Root validation must distinguish the browse-root existence contract from the checkout-root creation contract without weakening atomic settings writes.
- Query invalidation must cover every cached browsed path, not only the `null` root key.

## Progress

PR: #588

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reasoning Markdown

- [x] 1.1 Render Markdown reasoning with a compact preview — a16e01b
- [x] 1.2 Add reasoning Markdown regression coverage — a16e01b

### Phase 2: Browse-root validation and cache coherence

- [x] 2.1 Require an existing browse root and retain checkout creation — 746cbb2
- [x] 2.2 Refresh cached folder-browser listings after save — 746cbb2
- [x] 2.3 Add regression coverage and update contracts — 746cbb2
- [x] Post-review fix: stabilize native watcher scope assertion under full-suite load — 5c93c35
