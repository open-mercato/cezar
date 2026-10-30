# Remove-project dialog overflows on a long project path

## Goal

The "Remove <project> from the workspace?" confirm dialog stays inside its box when the project root is a long path.

## Scope

- Root cause: `AlertDialogContent` (and the sibling `DialogContent`) is `display: grid` with an implicit `auto` column. A grid item's min-width is its min-content, and the dialog's `truncate` path span (`white-space: nowrap`) makes that the whole path — so the column widens past `sm:max-w-md`, the description renders on one line, and the footer buttons are pushed off-screen.
- Fix: give both dialog primitives an explicit `grid-cols-1` (`minmax(0, 1fr)`) track so content can never widen the box.
- Show the full path wrapped (`break-all`) instead of truncating it: the path is what tells the user which folder they are deregistering.

## Non-goals

- No wording or behavior change to project removal.
- No restyle of other dialogs beyond the column bound.

## Risks

- Dialog content that previously overflowed now shrinks inside the box; any child that was relying on the overflow would now clip/wrap instead (that was already broken rendering).

## Progress

PR: #1746

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix

- [x] 1.1 Bound the dialog primitives' grid column and wrap the project path — 141c5c6ca
