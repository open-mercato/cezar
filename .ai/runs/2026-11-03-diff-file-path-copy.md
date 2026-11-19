# Execution plan — copy button for a diff file's path

**Goal:** a reader can copy a changed file's path from its header in the diff view (Changes tab, commits, repo Git) in one click.

**Scope:** `packages/web/src/components/diff/diff-view.tsx` (`DiffFileCard` header) + its unit test.

**Non-goals:** copying the patch/file contents; touching other copy buttons.

## Implementation Plan

### Phase 1: Copy button
- 1.1 Add a copy button beside the header's toggle (a sibling — a button cannot nest one), using `writeClipboard`, with a check-mark confirmation and a failure toast; copies `file.path` (the new path for renames). Unit test it.

## Risks
- The header is sticky and one `<button>` today; splitting it into toggle + copy must keep `data-slot="diff-file-header"` on the toggle so existing tests/selectors keep working.

## Progress

PR: #1915

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Copy button

- [x] 1.1 Add copy-path button to the diff file header — b05c1a41f
