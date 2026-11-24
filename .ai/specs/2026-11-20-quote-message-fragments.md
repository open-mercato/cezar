# Quote a fragment of a message and ask about it (task thread + manager chat)

Status: **implemented**. User docs:
`docs/site/content/docs/03-features/tasks-and-sessions/quote-messages.mdx`.

Prior art: no issue, PR, discussion, spec or branch covers it (checked 2026-11-23). The closest
are #1283 (comments on diff lines) and #1194 (copy a whole message).

## Problem

On the Changes tab the user can select one or more diff lines, leave a note on each, and send them
to the agent as one review (#1283). The conversation has no equivalent. To ask about one sentence
of a long agent answer, the user copies it by hand (#1194 copies only the whole message), pastes
it into the composer, adds `>` marks and explains where it came from. With several fragments this
is tedious. The agent also gets no hint of which message the text came from.

## Goals

- Select text in any message of the transcript and turn it into a **quote** in one action.
- Several quotes per message, from different messages, each with an optional note. The same model
  as diff comments.
- The agent receives every quote with its source and the user's note.
- The sent message renders the quotes as cards. A card jumps back to the quoted message.
- Works with mouse, keyboard and touch, in the task thread and in the manager chat.

Non-goals: inline comment threads anchored in the transcript, highlights on the source message,
quoting tool output or terminal panes, and quoting inside sub-agent panels
(`SessionTranscript` `mode: 'panel'`).

## Design

### 1. Selecting

- One `selectionchange` listener per view (coalesced to one frame) watches for a non-collapsed
  selection that lies **entirely inside one message body**. A selection across two messages, or
  one that takes in text outside the body (a tool card, a timestamp, a sub-agent panel), offers
  nothing. A boundary just outside the body with no text in between (a triple-click that ends at
  the next block) still counts as inside. This is the same rule as a diff range, which never spans
  two files.
- The message body gets its own marker, `data-quote-body`, on the element that wraps only the
  rendered text: inside `assistant-message` and `user-bubble` (`thread-items.tsx`), and inside
  `manager-assistant` and `manager-user-bubble` (`manager-message.tsx`). The existing wrappers
  also hold the copy button, attachments, ask cards and session cards, which must not be quotable.
  Selecting inside a fenced code block is allowed and keeps it as code (§ 3). A selection that
  takes in the block's header (language, Copy) quotes only the code, line breaks kept.
- **The quote is captured on `selectionchange`, not on the click.** On touch, a tap on any button
  collapses the selection before `click` fires. The listener keeps the last valid capture (source,
  text, code flag), and the action reads that.
- **Desktop**: a small floating toolbar with one action, **Quote**, sits 8 px above the
  selection's last client rect (below it when it would leave the viewport). Its `pointerdown` is
  `preventDefault`ed so the selection stays. It adds the quote and focuses the composer. The note
  is added from the chip (§ 4). It closes on Esc, a collapsed selection (mouse or keyboard), the
  source row leaving the DOM, or a click elsewhere, and closing it clears the selection. In the
  manager chat it also has a ✕.
- The toolbar follows the text: its position is recomputed on scroll of the transcript scroller
  and on resize of its content. A reader pinned to the tail sees the transcript move under the
  selection on every streamed delta (`thread-scroller.tsx`).
- **Touch** (`matchMedia('(pointer: coarse)')`, `useCoarsePointer`): the native selection
  callout owns the space above the selection, so the toolbar goes **below** it. A "Quote
  selection" chip (`QuoteSelectionChip`) also shows in the composer's `draftItems` row while a
  capture exists; it adds the quote exactly as the toolbar's Quote does. Both are 44 px targets
  and carry `data-quote-action`, so their `pointerdown` keeps the capture. On touch a collapsed
  selection keeps the capture (the tap collapses it before `click`); elsewhere it drops it. In the
  task thread `ThreadView` owns the one `useMessageSelection()` and hands the capture to both the
  transcript's toolbar and the composer's chip; once quoted or dismissed, that capture is hidden
  from both. The manager chat wires the same hook, toolbar and chip. Scrolling keeps a touch
  capture; a tap elsewhere drops it. The real selection callout cannot be proven in the dry-run
  e2e and needs a pass on a real iOS and Android device.
- **Keyboard**: a selection made with Shift+arrows (caret browsing) shows the same toolbar.
  The toolbar is `position: fixed` and is not beside the selection in Tab order, so **Alt+Q**
  (⌥Q, matched by physical key) quotes while it is open; the Quote button announces it with
  `aria-keyshortcuts="Alt+Q"` and a tooltip. Esc closes it.
- The existing "click does nothing while text is selected" guards (`task-workspace.tsx`,
  `line-comments.tsx`) stay as they are.

### 2. What a quote holds

```ts
interface MessageQuote {
  id: string
  /** Task: the seq of the turn the message is in (`turn-seq-<n>` → n), 0 for the task
   *  description. Manager: the message's own `seq`. This is the `#n` the agent's text carries.
   *  Absent for a turn with no seq (§ below): no `#n`, no jump. */
  ref?: number
  /** Task only, while it is a draft: the row's `data-row-key`, for an exact jump from the chip. */
  rowKey?: string
  role: 'assistant' | 'user'
  /** The selected text as rendered (`Selection.toString()`), blank edges trimmed and capped at
   *  QUOTE_MAX by `capQuoteExcerpt` (a code selection keeps its first-line indent). */
  excerpt: string
  /** True when the selection lay inside one <pre><code>: the excerpt is then fenced, not quoted. */
  code: boolean
  body: string // the user's note, may be empty
}
```

- **Rendered text, not Markdown source.** The user selects what they see, and mapping a DOM range
  back to Markdown source offsets is fragile (streaming, Mermaid, tables). The agent still has the
  full message in its own context. Rejected: source offsets on every Markdown node.
- `QUOTE_MAX = 2000` characters per quote and `QUOTES_MAX = 12` per message, for the reason
  `RANGE_EXCERPT_MAX` and `DESIGN_PICKS_MAX` exist: every quote lives in one draft entry capped at
  `DRAFT_TEXT_MAX`, and a rejected write is silent. A longer selection is cut with `…`, and the
  toolbar says "Quote (first 2000 characters)".
- The same `ref` and excerpt twice adds nothing, silently. A 13th quote is refused with a
  toast, "Up to 12 quotes per message — send these first.", and `add` returns `false`.
- The cap applies to a send, not to the draft: a draft merged from two windows may hold more than
  12, a send takes the first 12, and the rest stay as chips for the next message.
- The agent's reply to the task opens before any user message, so its turn has no source seq
  (`turn-fallback-1`). Once the history's oldest page is loaded (and the fallback replay is not
  truncated), its messages quote as assistant ref 0, `your reply to the task`; the jump pages back
  to the oldest page and lands on that first turn. Any other turn with no seq (old recordings, a
  window that starts mid-history) has no stable `ref`: it is sent without the `#n` and its card
  has no jump.

### 3. What the agent receives

`withMessageQuotes(text, quotes)`, a sibling of `withDiffComments`. The typed text leads, so
`/skill` expansion keeps working, and the block follows:

````md
Quoted from the conversation:

- From your message #412:

  > The migration keeps the old column until the backfill finishes.

  Why keep it? Can't we drop it in the same migration?

- From my earlier message #398:

  ```
  npm run db:migrate -- --dry
  ```
````

- The label is written from the agent's side: `your message`, `my earlier message`,
  `the task description` (task row, no number) and `your reply to the task` (the first turn).
- **`#n` is the locator, and it has to be in the text.** A sent message is only its text
  (`POST /runs/:id/messages`, the manager's send), so a card can find its source only through
  what the text carries. Diff comments do the same with path and line. The row key itself is not
  usable: it ends in the backend's item id, about 60 characters (`msg_0527…`). A time is not
  written: the agent has no clock for its own messages, and an assistant row has no timestamp.
- A prose excerpt is a `>` blockquote, with every line prefixed. A code excerpt uses the
  backtick-safe `fence()` already in `diff-comments.ts`. The note is its own paragraph, never part
  of the quote. This is the lazy-continuation trap #1283 fixed.
- `QUOTES_HEADING = 'Quoted from the conversation:'` is the parse anchor. Anything
  `parseQuotesMessage` does not recognise renders as the plain text it always was, as
  `parseReviewMessage` does today.
- **Together with diff comments**: typed text, then the quotes, then the review. The parsers
  compose in that order: `parseReviewMessage` takes the tail and returns the rest as `lead`, and
  `parseQuotesMessage` reads the lead. Every excerpt and note line is indented, so neither heading
  can appear at the start of a line inside the other block.
- The 100 000-character guard (`messageWithQuotesAndReview`, used by both hosts) covers the
  combined message, and its error names what is attached.
- A backend slash command (`/compact`, …) keeps its quotes exactly as it keeps diff comments
  (`commentsRideWith`): they stay as chips and are not sent as its arguments, and a toast says
  so. A quick reply to an ask card is sent without them too. A `/skill` from the registry is a
  message and carries them.

### 4. Chips, sending and persistence

- The quotes are chips in the composer's existing `draftItems` slot, before the diff comments. A
  chip shows a role icon, the first ~60 characters, and a note marker; its tooltip shows up to
  240 characters. Clicking it opens an inline editor with the whole excerpt (scrollable) and the
  note field: Enter or Save keeps the note, Esc drops the edit, and moving focus away (to the
  composer or Send) keeps it too. Focus returns to the chip. ✕ removes it. On touch the chip and
  its ✕ are 44 px targets. This differs from a diff-comment chip, which links to the Changes tab:
  a quote has no place of its own to be edited in.
- **Task: two send paths carry diff comments today, and both carry quotes.** The composer
  (`task-composer.tsx`) and the review panel's Send back (`review-panel.tsx`). Both become
  `quotes.submit((q) => diffComments.submit((c) => deliver(…)))`, so a failed send keeps both
  lists and a successful one drops exactly what it carried.
- **Task persistence**: a new draft surface, `message-quotes`, a JSON list like `diff-comments`:
  three-way merged across windows, refreshed when the window regains focus, cleared only by a
  successful send. It is one more name in `DRAFT_SURFACE_RE` (`packages/contract/src/drafts.ts`);
  `DRAFT_MAX_SURFACES` (16) has room.
- **The store is the diff-comments store, made generic** (`useDraftList` in `diff-comments.ts`:
  seed once, per-run write chain, three-way merge, `submit`), typed over the item and the
  surface. Both lists use it, and `diff-comments-store.test.tsx` pins the diff-comments behaviour.
  A send drops exactly the quotes it carried, as they were sent: one added or re-noted in flight
  stays.
- **Manager chat**: the same chips through the composer's `draftItems` slot. Drafts there are
  in-memory per session (the `drafts` map), and the quotes follow that rule: they survive
  switching chats and are lost on reload, like the typed text. The add, cap and drop-what-was-sent
  rules are the same functions the task store uses (`addMessageQuote`, `dropSentQuotes`).
- **Manager commands**: `parseManagerCommand` matches only a message that is nothing but
  `/name`, and `deliver` runs it before sending. A command, and a prompt button, is sent without
  quotes, and they stay as chips. A message with quotes over the length limit is refused before
  anything is sent, and nothing is lost.

### 5. In the transcript

- A sent message whose text holds a quotes block renders its lead, then `QuoteCards`: the
  label, the excerpt (blockquote or code) and the note. The header has a **Jump to message**
  button when the host can resolve the source; its accessible name carries the label
  (`Jump to message: From assistant message #412`), so a list of buttons is told apart.
- Card labels: `From assistant message #n`, `From your earlier message #n`, and, in the task
  thread only, `From the task description` for a user quote with ref 0 and `From the reply to
  the task` for an assistant quote with ref 0 (`taskDescription`). The manager chat's seq 0 is an
  ordinary message. A card offers the jump for any quote with a `#n`.
- Task: `UserText` in `thread-items.tsx` reads both blocks. Manager: `manager-user-bubble` is a
  plain `whitespace-pre-wrap` paragraph, not Markdown, so its lead stays plain text above the
  cards.
- **The jump, task.** Rows already carry `data-row-key` (`${section.id}:${block.id}`), and
  `revealRow(key, inset)` in `thread-scroller.tsx` scrolls to any row, virtualized or flat. No new
  key scheme is needed. The source row of a selection is `closest('[data-row-key]')`. From a card:
  page back until a row key starts with `turn-seq-<n>:` (the `reveal` loop in
  `use-thread-my-messages.ts`), then among that turn's rows pick the message whose text holds the
  excerpt's first line, else the turn's first row. The search runs on the row models, so a row
  outside virtua's window is found too. A page whose first row only repeats the turn's opening
  message is not proof the whole turn is loaded, so paging goes on. A page that adds nothing ends
  the search with the toast below, and a second jump cancels the first.
- **The jump, manager.** Find the loaded message with that `seq`, else `fetchNextPage` until it
  is loaded (`jumpToQuote` in `manager-chat.tsx`), then reveal `[data-message-id]`.
- In both views the landing is marked with the #2218 ring (`highlightJumpTarget`). The quoted
  words are not highlighted.
- A source that cannot be loaded: a toast, "That message is no longer in this transcript", and
  nothing scrolls.

## Implementation notes

- **Long transcripts**: flat up to 300 rows, virtua above (`VIRTUALIZE_THRESHOLD`). A selected row
  scrolled out of the window unmounts and the selection collapses; the capture is already taken,
  so only the toolbar closes.
- **Streaming**: `Markdown` is memoized per message and Streamdown per block, so a finished message
  does not re-render. A selection inside the block still being written can be lost. Accepted.
  Settled rows are not re-rendered by a live frame either: the props the quote feature adds to a
  row are stable.
- **Server**: never reads the message text. `Quoted from the conversation:` is known only to the
  cockpit, like `Review comments on the diff:`.
- **"Your messages" list (#2218)**: its preview is the first 240 characters, so a quote-only
  message previews as the heading, as a review-only message does.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Message still streaming | Quoting is allowed. The excerpt is what was selected at that moment. |
| Selection holds only a Mermaid diagram or image | No text, so nothing is offered. |
| Quoted message is from an earlier session (Continue) | It is in the same run's NDJSON, and the jump pages back as usual. |
| Run is closed and cannot be continued | Quote still works. The chip waits in the draft, like diff comments. |
| Queued run (#472) | Quotes ride the queued message like diff comments. |
| Remote (hosted) cockpit | Same behaviour: no new route and no new capability. |
| `CEZ_DRY_RUN=1` | Fully exercisable: the mock agent produces assistant messages to quote. |

## Zero config / safety

No setting and no env var. It adds one validated draft-surface name, and no new route, network
call or process. The excerpt is the user's own rendered text going into the user's own message, so
it opens no prompt-injection path that copy-paste does not already have.

## Later, only if asked

Quoting tool output and sub-agent panels, and server-side manager drafts.

## Tests

- Unit (vitest): format/parse round-trip (prose, code with ``` inside, multi-line, empty note,
  no `#n`), the combined block with diff comments in both parse
  directions and its length guard, caps and dedupe, the one-message selection rule, capture
  surviving a collapsed selection on touch and dropped by a keyboard collapse elsewhere, Alt+Q,
  the touch chip in the task composer, distinct Jump names, the task-description card label,
  the 13th-quote toast, the slash-command rule, Send back carrying quotes, a failed
  send keeping both lists, draft merge across two windows, and the unknown-block fallback.
- `diff-comments-store.test.tsx` passes unchanged after the store is made generic.
- Manager: a command or a prompt button keeps the quotes, a too-long message is refused before
  sending, a note edited in flight survives the send, the 13th-quote toast, and the jump paging
  older messages in and ringing the source.
- Contract: the `message-quotes` surface accepted, and `drafts-api.test.ts` extended.
- e2e (`quote-fragments.e2e.ts`, dry run, task and manager): select text in an assistant message
  (including the reply to the task), Quote, add a note on the chip, send, see the card, jump back.
- Manual: the selection toolbar on a real iOS and Android device.

## Decisions

1. Toolbar placement: a floating toolbar at the selection, plus the composer "Quote selection"
   chip on touch.
2. One toolbar action, **Quote**; the note is added from the chip.
3. The user may quote their own messages too.
4. After a jump the source message gets the #2218 ring only; the quoted words are not highlighted.
5. The task thread and the manager chat ship together.
