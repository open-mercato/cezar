# Design Mode — point at an element of the task's app, and it rides the next message

> Status: implemented (2026-10-09), first cut.
> Implementation: `packages/cezar/src/server/preview/` (proxy + picker script), the
> `POST /api/v1/preview/design-proxy` route in `packages/cezar/src/server/server.ts`,
> `packages/web/src/routes/task-workspace/browser-view.tsx` (the toggle and the mirror), and
> `packages/web/src/routes/task-thread/design-picks.ts` + `design-pick-chips.tsx` (the picks).
> Builds on: `.ai/specs/2026-10-07-task-workspace.md` §7, which closed with "Design-mode element
> selection is outside the first Browser release."
> Prior art: Orca's Design Mode (`onorca.dev/docs/browser/design-mode`).

## 1. Summary

The task workspace shows the agent's conversation and the app it is changing side by side, but the
Browser column could only be looked at. To tell the agent "this button is misaligned" the user had
to describe the button in words and hope the agent found the same one.

Design Mode closes that loop. A toggle in the Browser column's toolbar turns the cursor into a
picker; clicking an element of the app adds it to the task's next message as a chip in the Chat
composer. When the message is sent, the agent receives the element's selector, the page it is on,
the component that renders it (when the framework says), its box, text, notable computed styles
and its markup. The user types only what they want changed.

## 2. The problem that shapes the design

The Browser column is an `<iframe>` on a different origin from the cockpit — deliberately, per
workspace spec §7: a task's dev server is untrusted content and must not sit beside the API. The
same boundary means the cockpit cannot read the framed DOM, so it cannot know what was clicked.

Spec §7 also refused the obvious fix, a preview proxy, because serving worktree content **from the
cockpit's own origin** would put it next to the API. That refusal stands. Design Mode uses a proxy
on a **different origin**: its own loopback port.

## 3. Mechanism

1. The user switches Design Mode on for a tab showing a loopback `http://` address.
2. The cockpit asks `POST /api/v1/preview/design-proxy { target, parentOrigin }`. The server opens
   (or reuses) a listener on `127.0.0.1:<ephemeral>` that mirrors exactly that dev server, and
   answers `{ origin }`.
3. The column frames the same path on the mirror instead of on the dev server. The mirror passes
   everything through, splices WebSocket upgrades (hot reload keeps working), and inserts one
   `<script src="/__cezar_design__/picker.js">` into HTML documents.
4. The picker announces itself to its parent window; the cockpit answers `set-active`. While
   active it highlights the element under the cursor, swallows the click, and posts a bounded
   description of the element to the cockpit.
5. The cockpit validates the description (`parseDesignPick`) and appends it to the run's
   `design-picks` draft surface. The Chat composer renders one chip per pick and folds them into
   the message at send time, after the typed text and any diff comments.

Nothing is configured. The port is ephemeral and never shown; the saved Browser tab keeps the
app's real address, never the mirror's, so a restart frames the app directly again.

### What the agent receives

```
Elements selected in the app preview:

- `main > form.settings > button.btn-primary` on http://localhost:5173/settings
  component: SettingsPage › SettingsForm › Button (src/ui/button.tsx:14)
  box: 120×32 at 240,512 (viewport 1280×720)
  text: "Save"
  styles: color: rgb(255, 255, 255); background-color: rgb(37, 99, 235); border-radius: 6px

  ```html
  <button class="btn-primary" type="submit">Save</button>
  ```
```

`component` is best-effort: it reads the component tree a **development** build of React or Vue
hangs off DOM nodes. `file:line` appears only where the framework still exposes it (React ≤ 18's
`_debugSource`, Vue's `__file`). A production build answers neither, and the block simply omits
the line.

## 4. Security

The proxy is the new exposure, so each property below is load-bearing and has a test in
`preview/design-proxy.test.ts`.

| Risk | Answer |
| --- | --- |
| Worktree content next to the API | The mirror is a different origin (its own port). The API's request-origin guard refuses mutating requests from it like from any foreign origin. |
| Open proxy | It forwards only to the one loopback `http://` origin it was opened for. `parseDesignTarget` refuses anything else. |
| DNS rebinding through the mirror | Dev servers check `Host`; the mirror rewrites `Host`, so it checks it first itself (`isLoopbackHostHeader`) and answers 403. |
| Defeating the app's CORS/CSRF | `Origin`/`Referer` are rewritten to the app's only when they are the mirror's own. A foreign origin is forwarded untouched. |
| Mirroring cezar itself | Refused: the cockpit origin from the body and the request's own `Host`, under every loopback spelling. A mirrored cockpit would be the API with `Origin` rewritten to look same-origin. |
| A page driving or reading the picker | The picker posts to, and obeys, one window (its parent) at one origin (the cockpit's, baked in when the mirror was opened). The cockpit accepts messages only from the mirror's origin AND its own frame's window. |
| Hostile element data in a prompt | Every field is length-capped twice — in the picker and again in `parseDesignPick` — and the markup is fenced with a fence longer than any backtick run inside it. It is still text from an untrusted page; it is presented to the agent as data about an element, the same trust level as the diff the agent already reads. |
| Network exposure | `127.0.0.1` only, opened only after a user switches Design Mode on. Off on a hosted cockpit, where a loopback mirror reaches nobody. |

`CEZ_DESIGN_MODE=0` turns the feature off: the toggle disappears and the route answers 409.

**For the owner to ratify.** AGENTS.md § Zero config asks that a feature widening exposure be
opt-in behind a `CEZ_*` flag, off by default. Design Mode ships ON locally with an off switch — the
same line `CEZ_TERMINAL` draws — on the argument that the listener is loopback-only, mirrors only
what was already listening on loopback, and exists only after an explicit click. If that argument
does not hold, the change is one line in `designModeEnabled`.

## 5. States and their exits

- **Mirror listener (server).** Opened by the route. Closed by: 30 minutes with no request and no
  live spliced socket; least-recently-used eviction at 8 listeners; server shutdown (`closeAll`
  via `onDispose`). Nothing is persisted. The cockpit re-asks before every load while Design Mode
  is on, so a listener that was closed for idleness comes back on a new port instead of as a dead
  frame.
- **Design Mode switch (Browser column).** On by the toolbar button. Off by the button, by `Esc`
  inside the page, or by a failed proxy request (with a toast). Session-only; not saved with the
  layout.
- **Mirror in use (Browser column).** Kept after the switch goes off, so leaving Design Mode does
  not reload the page. Dropped at the next navigation or reload made with the switch off.
- **A pick.** Created by a click. Gone when: its chip's ✕ is pressed, or the message that carried
  it lands. A failed send keeps it. A backend slash command (`/compact`) does not carry picks —
  the same `commentsRideWith` rule as diff comments — and says so.

## 6. Deliberate limits of the first cut

- **No screenshot.** Orca attaches a cropped image. From inside a cross-origin page that means
  re-rendering the DOM to a canvas, which is slow and wrong often enough to mislead. The textual
  description is what locates the element in source; an image can follow if use shows a need.
- **Local `http://` only.** No `https://` loopback (certificate trust) and no external sites.
- **No hosted mode.** The hosted-preview gap of workspace spec §7 is unchanged by this.
- **`localStorage` is per-origin.** The mirror keeps the hostname the user typed, so cookies carry
  over (they are not port-scoped), but origin-scoped storage does not: an app that keeps its
  session in `localStorage` shows up logged out in Design Mode.
- **Dev servers that pin their own origin** (a hard-coded HMR port, a strict CSP naming hosts)
  may hot-reload less gracefully through the mirror. The page still loads and picking still works.
- **Two windows on one task:** picks are last-write-wins, unlike diff comments' three-way merge.
  A pick has no typed body to lose and costs one click to redo.
- **A pick is not a transcript card.** The sent block renders as the Markdown it is.

## 7. The note popup and numbered marks (second cut, 2026-10-09)

> **Rolled out in stages, with the owner, one behaviour at a time. What is on screen is §7a
> below; the rest of this section is the earlier, wider design and is NOT built as described** —
> multi-element notes, the "new task" destination and the queues strip were removed from the
> tree when stage 2 replaced them (they are in history at `59d134b1`).

### 7a. What is live (stages 1–2, agreed 2026-10-10)

**One element, one note.** Decided with the owner question by question; each line is a decision.

- **Selecting.** Hover frames an element in blue. A click keeps the frame and turns it lime, at
  once — the page draws it before the cockpit answers; the cockpit stays the authority and a pick
  it refuses loses the frame. A selected element shows no blue frame on hover.
- **The note.** The click opens a small window under the frame (above when there is no room),
  following the element as the page scrolls, with the cursor in it. It holds the element's name
  (component, or e.g. `button.btn-primary`), a text field and Send. `Ctrl/Cmd+Enter` sends;
  an empty note cannot be sent. The window is drawn by the cockpit over the page, never inside
  it: what the user types must not live in an untrusted document.
- **Drafts.** Clicking another element leaves the first one framed WITH its unsent text and opens
  a window on the new one — several drafts at once. Clicking a framed element opens its note
  again; it is never picked twice. `Esc` or ✕ on a draft discards it and deselects the element.
  `Esc` with no note open leaves Design Mode.
- **Drafts survive.** They are written through to the run's draft store (`design-picks`), so a
  half-written note outlives a reload of the page, of the cockpit, and a layout switch. On a new
  document the picker frames the element again from its selector — only when that selector names
  exactly ONE element on the same path; it never guesses. A draft whose element cannot be found
  is offered from a chip in the corner of the frame instead of being lost.
- **Sending.** Agent free → starts now. Agent working → waits in the session's prompt queue (§8)
  and runs when the work before it ends. Session closed → "Reopen & send" (Continue). Task not
  started → joins its first prompt. The agent receives the user's words, then the one element.
- **After sending.** The frame stays, lime, with the note's number (order sent), until the page
  reloads. Colour never changes; the status is in the note: *In queue → In progress → Done*, or
  *Agent is waiting for your answer* when the turn ended on a question. Clicking a numbered frame
  shows the note. While it waits in the queue it can be reworded in place (`PATCH
  /runs/:id/prompt-queue/:msgId`, keeping its turn) or removed; once it is with the agent the
  window is read-only.
- **Not in the Chat composer.** A picked element no longer becomes a chip there: one way to send.

**How a sent note's status is known.** It is not stored — it is read off the run: its entry is
in `promptQueue` → in queue; delivered and the run working → in progress; the run came to rest →
done or asking. Both transitions wait for evidence, not for an absence, because this window's
copy of the run always lags the request that changed it (`advance` in `design-notes.ts`). Sent
notes are memory-only: a receipt for this review. The WORK does not depend on them — a queued
prompt lives on the run record.

The first cut sent picks to the Chat composer only. Reviewing an app means leaving several notes
in one pass, so a pick now opens a note **beside the element it is about**:

- **Marks.** A picked element stays framed in lime with its number, on the page and in the note.
  The cockpit owns the list and the numbers (`set-marks`); the picker owns only the element
  references, so a mark does not survive a reload of the page — the pick stays in the note,
  numbered, without a frame.
- **The note is a popup, drawn by the cockpit over the page** — not by the picker inside it. The
  page is untrusted and is somebody else's document; what the user types and where it is sent
  must not live there. The picker only reports where each marked element is (`rects`, sent when
  they move), and the Browser column anchors the popup to the last element picked: under it when
  there is room, above when there is not, clamped into the frame so an element scrolled away
  keeps its note on screen. A pick whose page has since reloaded has no rect; its note parks in
  the bottom-right corner.
- **Opening and closing.** A pick opens the note with the cursor in it. ✕ closes it without
  discarding anything — the elements stay marked. Clicking a marked element brings the note back
  beside that element (it is not picked twice); removing an element is the ✕ on its chip in the
  note, where a stray click cannot do it. Sending, or emptying the note, closes it.
- **The note.** Numbered elements, a prompt, a destination, Send (`Ctrl/Cmd+Enter`). Elements alone
  are a valid note. The same picks still appear as chips in the Chat composer — one list, two
  places that can send it.
- **The queues** have a strip under the page that exists only while one of them has something in
  it, so the page keeps its full height the rest of the time.
- **Destination — two queues, kept visibly apart:**

  | | Prompt queue · this session | Task queue · cezar |
  | --- | --- | --- |
  | What it is | more work for THIS task's agent | a separate task |
  | Where it runs | this task's worktree and branch | its own worktree, from the project's base |
  | Sees this task's uncommitted work | yes | no |
  | Order | one after another, each when the work before it ends | cezar's scheduler (`maxParallel`) |
  | Options | none | workflow, worktree on/off |

  There is no per-task base branch in `POST /runs`, so the panel does not invent one: a new task
  starts from the project's configured base.
- **Where a session note goes** depends on the run: `running` → the prompt queue; `waiting` → the
  same route, which delivers at once; `queued` → folded into the first prompt (`POST /messages`,
  #472); closed → `POST /continue`. A queue request that loses the race with a closing session
  falls back to Continue.

## 8. The session prompt queue (engine)

**What changed, and what did not.** `POST /runs/:id/messages` still writes into the session
immediately, mid-turn included — steering — and the thread composer still uses it. The queue is a
separate route (`POST /runs/:id/prompt-queue`) and a separate record field (`promptQueue`), so no
existing sender's behaviour moved. It is also not `queuedMessages`, which belong to a run that has
not started and are folded into its first prompt.

**Release.** `tryReleaseQueuedPrompt` delivers the head of the queue as a user message and a turn
of its own. It is called from BOTH turn-end handlers (`runAgentStep` and `runContinuation` — the
twins AGENTS.md warns about), ahead of the `CEZ:DONE` close, the autonomous nudge and the
compaction continue, and from `enqueuePrompt` when the session is already at rest. A released
prompt means the run does not park: the next turn is that prompt.

It refuses, and each refusal protects another mechanism:

| Refusal | Why |
| --- | --- |
| the turn ended on `CEZ:ASK` | a queued prompt would clear the question and be read as its answer |
| a native backend ask is open | same; it parks `waiting` MID-turn, which is why "at rest" is its own flag (`promptRest`) and not derived from status |
| `CEZ:MONITORING`, or the turn dispatched / was re-prompted | the run is still working — the queue waits for a turn that rests |
| dispatch budget brake | a queue must not walk a run past its brake |
| a compaction-only turn end | the work is half done; the compaction continue owns that boundary |
| a non-final step of a chained workflow | its session closes after one turn; a user prompt there derails the chain |

`CEZ:DONE` with prompts still queued does NOT close the session: the next prompt starts.

**States and exits.** An entry leaves the queue when it is released, when it goes straight in at
enqueue, or when the user removes it (`DELETE`, allowed in every run state). The engine never
reopens a closed session to drain a queue — that would override a cancel, a failure, a usage hold
or the review gate. Entries on a run whose session closed first stay on the record, are shown as
"not delivered", and are released by the first turn end of the next Continue. So the queue of a
closed run has two exits: Continue, or remove.

**Known limits.**
- Cursor's runner cannot accept a message into a live session at all, so a release there never
  succeeds and entries wait for a Continue.
- Text only; an attachment belongs on a message sent now.
- 20 entries per run (`PROMPT_QUEUE_MAX`).
- A restart keeps the queue (it is on the record). A run recovered as finished keeps its entries
  undelivered until the next Continue.

**Also fixed on the way (Windows).** `CEZ_DRY_RUN=1` could not start a session on Windows: the
bundled mock is a `.mjs`, which Windows cannot execute by shebang (`spawn EFTYPE`). A script
binary is now run through this process's own Node on `win32` only (`scriptAwareCommand`).

## 9. Verification

- `packages/cezar/src/server/preview/design-proxy.test.ts` — the proxy against a real loopback
  listener: injection, `Host` refusal, origin rewriting, redirects, WebSocket splice, 502, idle and
  LRU closing, every refused target.
- `packages/cezar/src/server/design-proxy-api.test.ts` — route policy: 200 shape, 400, 409 for
  `CEZ_DESIGN_MODE=0` and hosted mode.
- `packages/web/src/routes/task-thread/design-picks.test.ts` — parsing hostile input, the message
  format, the size refusals.
- `packages/web/src/routes/task-workspace/browser-view-design.test.tsx` — the toggle, the mirror
  swap, message filtering by origin and source window, marks, the note popup (opening, anchoring,
  following the page's report, closing, hostile rect reports) and `placeNote`.
- `packages/web/src/routes/task-workspace/design-notes.test.tsx` — a note's whole life: the draft
  written through and restored, where Send goes for each session state, numbering, rewording and
  withdrawing while queued, the status following the run (including both lag guards), the popup's
  three faces.
- `packages/web/src/routes/task-workspace/design-picker.test.ts` — the real picker script in a
  framed DOM: blue on hover, lime on click, the note reopened by a second click, numbers on sent
  frames, a draft's frame restored from its selector and never guessed.
- `packages/cezar/src/workflows/prompt-queue.test.ts` — the engine, dry: one prompt per turn in
  order, straight-in at rest, the continuation twin, DONE with a queue, the ask and monitoring
  refusals, the closed-run exits, the cap. The continuation case was confirmed red with the
  release removed from `runContinuation` alone.
