# Design Mode — point at an element of the task's app, and it rides the next message

> Status: implemented on `main` (2026-10-13), ported from `origin/brutus` (2026-10-09/10).
> Implementation: `packages/cezar/src/server/preview/` (proxy + picker script), the
> `POST /api/v1/preview/design-proxy` route in `packages/cezar/src/server/server.ts`, and
> `packages/web/src/routes/task-preview/` — the frame and toggle (`browser-view.tsx`) the task
> workspace renders as its **Preview** view (`task-workspace/task-workspace.tsx`), the notes (`design-notes.ts`, `design-note-popup.tsx`) and
> the pick format (`design-picks.ts`).
> Prior art: Orca's Design Mode (`onorca.dev/docs/browser/design-mode`).
>
> **What the port to `main` changed (§9).** As on brutus, it lives in the task workspace's Browser
> view (spec `2026-10-07-task-workspace`), labelled **Preview** on `main`: a fixed card on the strip
> (`/tasks/:id/preview`), and a column that can sit beside Chat or Changes in any saved layout.
> Brutus's session prompt queue and preview gateway are not ported: a
> note goes to the agent as a live message (or through Continue), and a hosted cockpit refuses a
> loopback address as before.

## 1. Summary

A task's app could only be looked at, not pointed at. To tell the agent "this button is misaligned" the user had
to describe the button in words and hope the agent found the same one.

Design Mode closes that loop. A **Design Mode** toggle button in the Preview's toolbar — always
shown, disabled with the reason where it cannot work — turns the cursor into a
picker; clicking an element of the app opens a note beside it, and sending the note gives the
agent the user's words followed by the element's selector, the page it is on,
the component that renders it (when the framework says), its box, text, notable computed styles
and its markup. The user types only what they want changed.

## 2. The problem that shapes the design

The Preview tab is an `<iframe>` on a different origin from the cockpit — deliberately: a task's
dev server is untrusted content and must not sit beside the API. The
same boundary means the cockpit cannot read the framed DOM, so it cannot know what was clicked.

The obvious fix, a preview proxy **on the cockpit's own origin**, would put worktree content next
to the API. Design Mode uses a proxy
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
5. The cockpit validates the description (`parseDesignPick`) and opens a note draft for it, kept
   in the run's `design-picks` draft surface (§7a).

Nothing is configured. The port is ephemeral and never shown; a saved Preview tab keeps the
app's real address, never the mirror's, so a restart frames the app directly again. Each Preview
column's tabs are saved with its layout on the host (`/runs/:id/layouts`, task-workspace §7), and
a terminal's detected address opens in one.

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

**Owner decision (2026-10-17).** Design Mode is available on a local cockpit with no setting, but
the toggle starts OFF every time the Preview opens: nothing is mirrored until the user clicks it.
That click is the opt-in AGENTS.md § Zero config asks of a feature that widens exposure — the
listener is loopback-only, mirrors only what was already listening on loopback, and closes when idle.

## 5. States and their exits

- **Mirror listener (server).** Opened by the route. Closed by: 30 minutes with no request and no
  live spliced socket; least-recently-used eviction at 8 listeners; server shutdown (`closeAll`
  via `onDispose`). Nothing is persisted. The cockpit re-asks before every load while Design Mode
  is on, so a listener that was closed for idleness comes back on a new port instead of as a dead
  frame.
- **Design Mode switch (Preview).** On by the toolbar button. Off by the button, by `Esc`
  inside the page, or by a failed proxy request (with a toast). Session-only; not saved.
- **Mirror in use (Preview).** Kept after the switch goes off, so leaving Design Mode does
  not reload the page. Dropped at the next navigation or reload made with the switch off.
- **A note draft.** Created by a click. Gone when discarded (✕ / Esc) or sent. A failed send keeps
  it. Persisted in the run's `design-picks` draft surface.
- **A sent note.** Memory-only, numbered; leaves when the page reloads. Its status is read off the
  run (§7a), never stored.

## 6. Deliberate limits of the first cut

- **No screenshot.** Orca attaches a cropped image. From inside a cross-origin page that means
  re-rendering the DOM to a canvas, which is slow and wrong often enough to mislead. The textual
  description is what locates the element in source; an image can follow if use shows a need.
- **Local `http://` only.** No `https://` loopback (certificate trust) and no external sites.
- **No hosted mode.** On a hosted cockpit a loopback address is refused, not framed (brutus's
  preview gateway, `2026-10-10-preview-gateway`, is not ported).
- **`localStorage` is per-origin.** The mirror keeps the hostname the user typed, so cookies carry
  over (they are not port-scoped), but origin-scoped storage does not: an app that keeps its
  session in `localStorage` shows up logged out in Design Mode.
- **Dev servers that pin their own origin** (a hard-coded HMR port, a strict CSP naming hosts)
  may hot-reload less gracefully through the mirror. The page still loads and picking still works.
- **Two windows on one task:** note drafts are last-write-wins, unlike diff comments' three-way
  merge.
- **A note is not a transcript card.** The sent block renders as the Markdown it is.

## 7. The note popup and numbered marks (second cut, 2026-10-09)

> Rolled out on brutus in stages, with the owner, one behaviour at a time. What is on screen is
> §7a; the earlier, wider design (multi-element notes, a "new task" destination, a queues strip)
> is in brutus history at `59d134b1` and was not ported.

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
  half-written note outlives a reload of the page and of the cockpit. On a new
  document the picker frames the element again from its selector — only when that selector names
  exactly ONE element on the same path; it never guesses. A draft whose element cannot be found
  is offered from a chip in the corner of the frame instead of being lost.
- **Sending.** Session live (`running`/`waiting`) → `POST /messages`, delivered into the session
  at once — mid-turn while the agent works, as the composer's messages are. Session closed →
  "Reopen & send" (`POST /continue`). Task not started → joins its first prompt (`POST /messages`,
  #472). A 409 means this window's run record was stale, so the other path is tried once (the
  composer's `deliver-prompt.ts` recovery). The agent receives the user's words, then the one
  element.
- **After sending.** The frame stays, lime, with the note's number (order sent), until the page
  reloads. Colour never changes; the status is in the note: *In progress → Done*, or *Agent is
  waiting for your answer* when the turn ended on a question. Clicking a numbered frame shows the
  note, read-only.
- **Not in the Chat composer.** A picked element no longer becomes a chip there: one way to send.

**How a sent note's status is known.** It is not stored — it is read off the run: delivered and
the run working → in progress; the run came to rest → done or asking. A note is called done only
after the run has been SEEN working since delivery (or after a grace period), because this
window's copy of the run lags the request that changed it (`advance` in `design-notes.ts`). Sent
notes are memory-only: a receipt for this review.

## 8. Verification

- `packages/cezar/src/server/preview/design-proxy.test.ts` — the proxy against a real loopback
  listener: injection, `Host` refusal, origin rewriting, redirects, WebSocket splice, 502, idle and
  LRU closing, every refused target.
- `packages/cezar/src/server/design-proxy-api.test.ts` — route policy: 200 shape, 400, 409 for
  `CEZ_DESIGN_MODE=0` and hosted mode.
- `packages/cezar/src/server/capabilities.test.ts` — `designMode`: on locally, off with
  `CEZ_DESIGN_MODE=0`, off on a hosted cockpit even with `=1`.
- `packages/web/src/routes/task-preview/design-picks.test.ts` — parsing hostile input, the message
  format, the size refusals.
- `packages/web/src/routes/task-preview/browser-view-design.test.tsx` — the toggle, the mirror
  swap, message filtering by origin and source window, marks, the note popup (opening, anchoring,
  following the page's report, closing, hostile rect reports) and `placeNote`.
- `packages/web/src/routes/task-preview/browser-view-hosted.test.tsx` — a hosted cockpit refuses a
  loopback address and offers no toggle.
- `packages/web/src/routes/task-preview/design-notes.test.tsx` — a note's whole life: the draft
  written through and restored, where Send goes for each session state (live, Continue, the 409
  fallback), numbering, the status following the run, the popup's faces.
- `packages/web/src/routes/task-preview/design-picker.test.ts` — the real picker script in a
  framed DOM: blue on hover, lime on click, the note reopened by a second click, numbers on sent
  frames, a draft's frame restored from its selector and never guessed.
- `packages/web/src/routes/task-workspace/task-workspace.test.tsx` — the `/preview` deep link opens
  the Preview card with its saved tabs and the Design Mode toggle.

## 9. Not ported from brutus

- **The session prompt queue** (`70f9c559`, `a305f641`, `fb46d185`): brutus queues a note sent
  while the agent works and releases it at the next turn end, rewordable and withdrawable while it
  waits. It changes both turn-end handlers in `workflows/run.ts`, so it should land as its own
  reviewed change; until then a note is a live message, which is what the composer already sends.
- **The preview gateway** (`2026-10-10-preview-gateway`): it authenticates through brutus's hosted
  login (`auth/guard.ts`), which `main` does not have.
