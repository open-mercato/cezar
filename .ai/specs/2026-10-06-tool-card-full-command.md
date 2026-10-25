# Full command in expanded tool cards

Issue: #1306 · Extends `2026-07-14-cockpit-ui-redesign.md` (tool cards, #381)

## Goal

Let a user read and copy the exact command an agent ran. Today an execute tool card shows
`Ran <command>` on one truncated line, and expanding it reveals only the output, so long or
multi-line commands (loops, `&&` chains, heredocs) cannot be read anywhere in the cockpit.

## Design

- **Source of the command.** `toolCommand(item)` in `packages/web/src/routes/task-thread/thread-items.tsx`,
  for `toolKind === 'execute'` only:
  1. `item.input.command` as a string (Claude Bash, ACP backends);
  2. `item.input.command` as a string array, joined with spaces (Codex argv);
  3. otherwise the title's detail from `splitToolTitle(item.title)`.

  The title alone is not enough: the protocol layer caps it at ~120 characters
  (`tool-display.ts`, pinned in `tool-display-mirror.test.ts`).
- **The header grows; the body does not repeat.** Collapsed, the header stays one truncated
  line. Expanded, the header's `<code data-slot="tool-command">` renders the full command
  (`whitespace-pre-wrap break-all`, newlines kept) in place of the truncated detail. The chevron,
  icon, verb and status chips pin to the first line (`items-start`).
- **Height cap.** The expanded command is capped at `max-h-48` (~10 lines) and scrolls
  inside the header, so a giant heredoc cannot take over the thread.
- **Copy.** A `CopyCommandButton` renders beside the trigger (a sibling, since a button cannot
  nest a button), only while the full command is expanded. It writes the full command with
  `navigator.clipboard.writeText`, shows a check mark for 1.5 s, and never toggles the card.
- **When the command alone makes a card expandable.** Only when the one-line header cannot
  show it whole: the command differs from the title's detail, contains a newline, or is longer
  than 80 characters. A short command with no output stays locked as before (chevron hidden,
  trigger disabled). A short command with output still expands to its output, with no copy
  button and no header change.
- **Empty body.** When the command is the only detail, the body wrapper is hidden
  (`empty:hidden`), so no empty strip renders under the header.
- **Default-open policy is unchanged.** `defaultOpen` still opens only a running execute with
  output. The user's toggle and the per-run open-card cache work as before.

## Alternatives rejected

- **A `$ command` block at the top of the expanded body.** Built and tried; rejected because the
  command then appears twice (truncated in the header, full in the body).
- **A hover tooltip only.** It cannot be copied, does not work on touch, and handles multi-line
  commands badly.
- **Build nothing.** The command is otherwise only in the raw NDJSON event log.

## Non-goals

- No server, protocol or contract change: `UiToolItem.input` already carries the command.
- No change to output rendering, streaming, the exit-code chip, or non-execute tool kinds.

## Risks

`risk-medium` (per the #1306 triage): the change alters when a card can be expanded,
how a running card behaves, and adds a clipboard action, all in one component.

- A long running command can now be expanded before output arrives. The live tail still
  follows `defaultOpen` once output streams in.
- `navigator.clipboard` is absent in insecure contexts; the button then does nothing
  (optional chaining), and the command can still be selected by hand.
- Selecting text inside the header is awkward because the header is the toggle; the copy
  button is the supported path.
- Screen readers announce the full command as the trigger's name while expanded.

## Validation

Unit tests (`thread-items.test.tsx`):

- the full command shown exactly once when expanded, never alongside the capped title;
- argv input joined; title fallback when the input has no command;
- a long running command expandable before any output;
- a short command with output: no copy button, no header change;
- short commands with no output, and declined cards with no detail, stay locked;
- copy writes the full command, leaves the card open, and shows "Copied".

Browser: before/after screenshots on #1306 (folded, expanded, expanded past 10 lines)
cover the wrapping and the scroll cap.
