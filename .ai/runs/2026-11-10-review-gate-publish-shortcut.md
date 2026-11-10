# Execution plan — one-key publish from the review gate (#1760)

## Goal

⌘↵ / Ctrl+↵ on a task resting at `review` opens a confirm dialog previewing the draft PR's title and body; pressing it again opens the draft PR. Never fires while focus is in a text field (composer, review notes, terminal) or while a dialog/menu owns the keyboard. Listed in Settings → Keyboard.

## Scope

- `packages/web/src/routes/task-thread/review-panel.tsx` — the shortcut, the confirm dialog, the kbd hint on Draft PR.
- `packages/web/src/routes/task-thread/review-publish-shortcut.ts` — the pure scope predicate.
- `packages/web/src/routes/settings/keyboard-section.tsx` — a fixed "Review" entry (⌘↵ is reserved, so not rebindable).
- Unit tests beside each.

## Resolved assumptions (triage questions on #1760)

- Draft PR, the gate's own button — same action (agent first, `POST /pr` fallback).
- Only on the task view of a run in `review` (where the gate is mounted).
- The issue's "dialog with title/body preview" is a small confirm dialog: title = the run title, body = the task (what `buildPrBody` puts under `## Goal`); on the agent path it says the agent writes them.
- ⌘↵ in a text field keeps meaning *submit* (Send back stays on the notes box); this fires only outside text fields.

## Non-goals

- No new server route, no contract change, no rebinding of ⌘↵.

## Risks

- Same chord means Send back in the notes box — mitigated by the editable-target guard and the confirm step.

## Progress

PR: #2047

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Shortcut and dialog

- [x] 1.1 Scope predicate with unit tests — 511d739b6
- [x] 1.2 Confirm dialog with preview on the review gate — 511d739b6
- [x] 1.3 List it in Settings → Keyboard — 511d739b6

### Phase 2: Validation

- [x] 2.1 Full validation gate — 511d739b6
