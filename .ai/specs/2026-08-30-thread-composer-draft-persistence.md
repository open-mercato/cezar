# In-task drafts survive leaving the task

> Issue #939. Written with `/om-spec-writing` after analyzing the cockpit; the ticket carries the
> same text. § **As built** at the end records where the implementation departed from the sketch
> below and why — the rest of the document is the design as approved.

## 📝 TLDR

Text typed into a task — the thread reply composer above all, but also the review-notes box and
the inline message/prompt editors — lives only in the React component that renders it. Opening
another task unmounts that component, so a half-written message is gone on return, with no warning
and no way back. This spec adds a **server-side, per-run, per-surface draft store**: every in-task
text input is restored exactly as it was left, including pasted image attachments, from any
browser pointed at the same cezar. Drafts are cleared only by sending or emptying them.

## ✅ Resolved decisions

The four gate questions, as answered:

| # | Question | Answer |
| --- | --- | --- |
| Q1 | Scope | **Every text input in a task** — composer, review notes, inline message/prompt editors, title rename. |
| Q2 | Storage | **Server-side**, so a draft follows the user across browsers and survives a reload and a `cez` restart. |
| Q3 | Attachments | **Text + images** — a restored composer draft brings its pasted screenshots back. |
| Q4 | Cleanup | **On send or empty only** — no expiry, no age or count sweep. |

Two consequences of those answers are decided here rather than re-asked, because both readings
lead to the same user-visible behavior:

- **Server-side does not mean inside `ui-state.json`.** The obvious home is the per-repo GUI-prefs
  file, and it is the wrong one: its `PUT` carries a hard `128 KiB` body limit
  (`UI_STATE_BODY_LIMIT`, `server.ts:877`), its merge is shallow at the top level so every write
  would have to re-send *every* run's draft, and the cockpit `GET`s the whole file on every load.
  Drafts get their **own project-scoped route family and their own files** under `.ai/cezar/drafts/`
  — same server, same "shared across browsers" property, without turning a preferences file into a
  message spool. `ui-state.json` is untouched by this spec.
- **"Cleared on send or empty only" is the user-facing policy, not a promise never to delete a
  file.** Two structural guards remain, and neither is an expiry: deleting a run deletes its drafts
  (a draft for a run that no longer exists is unreachable by definition), and the store carries a
  total-bytes backstop. With images in scope a single run's draft can hold 20 MB, and "keep
  forever, in the user's repo directory" without a ceiling is a disk-fill bug, not a feature. The
  backstop evicts least-recently-touched drafts only once the whole store exceeds **64 MiB**, which
  no real usage reaches; see § Data Model.

## 📝 Problem Statement

`ThreadView` renders the shared `<Composer>` **uncontrolled**
(`packages/web/src/routes/task-thread/task-thread.tsx:451`): it passes no `value` / `onValueChange`,
so the text lives in the composer's own `useState('')`
(`packages/web/src/components/composer/composer.tsx:128`) and the images in its
`useState<PendingImage[]>([])` (`:139`). Navigating to another task is a route change,
`TaskThreadRoute` unmounts, and both are discarded. Returning mounts a fresh composer with an empty
box. The same holds for the review-panel notes textarea
(`routes/task-thread/review-panel.tsx:114`), the inline queued-message and prompt editors
(`routes/task-thread/thread-items.tsx:120`) and the title-rename input
(`components/editable-title.tsx`).

This is a parallel-agent cockpit. Checking on another task mid-sentence is not an edge case — it is
the product's core loop, and the sidebar, the command palette and the Tasks table all invite it.
Losing the message is worst precisely when it costs most: a long, carefully-worded correction to a
running agent, typed while the agent works, abandoned the moment the user glances at the task next
to it.

Every neighbouring composer already got this right:

- `/new` keeps its draft across navigation *and* reload (`routes/new-task-draft.ts`, localStorage).
- The GitHub hand-off box keeps a **per-item** prompt keyed by the item URL
  (`routes/github/hand-to-agent-draft.ts`) — explicitly so switching between issues never loses one
  item's text or leaks it into another's.

The thread composer, the highest-traffic text input in the product, is the one that forgets.

## 📝 Research — how the field solves this

| Product | Where the draft lives | What it does that matters here |
| --- | --- | --- |
| **Slack** | Server, synced across devices | Per-conversation drafts, restored on return; drafts are surfaced in a dedicated "Drafts" list so an abandoned message is findable, not just recoverable. Attachments upload at attach time, not at send. |
| **Discord** | Client, per channel | Instant, zero-latency restore; drafts do not follow you to another device — the trade-off cezar is explicitly rejecting in Q2. |
| **Linear / Height** | Client, per entity | Comment drafts restore per issue; an "unsaved" affordance appears in the issue list. |
| **GitHub** | Browser storage, per comment box | Restores a half-written comment after a reload, keyed to the box — the same per-surface keying this spec needs for a task with four editable inputs at once. |
| **ChatGPT / Claude** | Client, per conversation | Confirms the baseline expectation: a conversational input that forgets on navigation reads as a bug, not as a missing feature. |

Worth stealing: **upload attachments when they are attached, not when the message is sent** (Slack).
That is what makes images-in-drafts cheap here — the bytes go to the server once, on paste, and the
draft record only references them.

Worth skipping: cross-device *live* sync (operational transforms, presence, "editing elsewhere"
banners) and a global Drafts inbox. cezar has one user on one machine; last-write-wins between two
tabs is a documented behavior, not a correctness problem, and a Drafts list is a separate feature
with its own spec.

## 📝 Proposed Solution

Three pieces, none of them new mechanisms:

1. **A per-run draft store on the server** (`packages/cezar/src/runs/drafts.ts`) writing plain files
   under `.ai/cezar/drafts/`, in the same "files, not a DB, degrade to empty, never throw" style as
   `ui-state.ts` and `runs/store.ts`.
2. **A project-scoped route family** (`/api/v1/runs/:id/drafts…`, mounted under both the boot and
   `/p/:projectId/` spellings) with every shape declared as a zod schema in `packages/contract`.
3. **Controlled hosts in the cockpit.** The composer already exposes the controlled-text seam that
   `/new` uses (`value` + `onValueChange`, "pass BOTH or neither"); the thread becomes its second
   controlled host. Images need the same seam added (`images` + `onImagesChange`), mirroring the
   text one exactly. Every other input in scope is already a plain controlled `useState` and needs
   only to be seeded from, and mirrored to, the store.

The client writes behind a **debounce**, applies its own state optimistically, and never re-reads
the server draft while the input is mounted — the same discipline the sidebar already uses for its
workspace-ui-state writes.

Alternatives considered and rejected:

- **localStorage** (the `new-task-draft.ts` / `hand-to-agent-draft.ts` pattern). Simplest by far,
  zero server surface, and it is what the existing precedents do — but drafts stay in one browser,
  which Q2 rules out.
- **A `drafts` key inside per-repo `ui-state.json`.** Rejected on the body limit, the shallow
  whole-object merge and the every-load `GET`; see § Resolved decisions.
- **A new field on `RunRecord`.** `runs.json` is the run index — rewritten atomically as a whole and
  read on every listing. Putting a 20 MB attachment draft in it would make every task-list render
  pay for one unsent message.

## 📝 Architecture

```
packages/contract/src/drafts.ts        ← every request/response shape (zod, types inferred)
        ▲                    ▲
        │                    │
packages/cezar/src/runs/drafts.ts      ← the store: read/write/delete, caps, atomic writes
        ▲                                 .ai/cezar/drafts/<runId>/draft.json + images/<imageId>
        │
packages/cezar/src/server/server.ts    ← chained `draftRoutes` family, validated as middleware
        ▲
packages/web/src/api/client.ts         ← typed client calls
packages/web/src/api/queries.ts        ← useRunDrafts(runId)
packages/web/src/routes/task-thread/thread-draft.ts
        ▲                                 ← useDraft(runId, surface): seed once, debounce, flush
        │
ThreadView · ReviewPanel · UserBubble editor · EditableTitle
```

**Boundaries.** The store module knows nothing about HTTP; the routes know nothing about React;
the `useDraft` hook is the cockpit's only entry point, so no component talks to the draft API
directly. `Composer` gains one seam and no knowledge of drafts at all — it stays the shared,
host-agnostic component it is today, which is what lets `/new` keep its localStorage draft
unchanged while the thread uses the server store.

**Surfaces.** A task has several editable inputs at once, so a draft is keyed by
`(runId, surfaceId)`:

| Surface id | Input | Phase |
| --- | --- | --- |
| `composer` | The thread reply composer — text + images | 1 / 2 |
| `review-notes` | Review panel, "Notes for the agent" | 3 |
| `task-prompt` | The queued run's prompt, inline editor | 3 |
| `message:<msgId>` | A queued message's inline editor | 3 |
| `title` | The header's rename input | 3 |

Deliberately **not** drafts: the "Filter changed files" and skill/file search boxes. Those are view
state, not authored content — restoring a stale filter on return would hide files the user came
back to see.

**Data flow (composer, the worked example).**

1. `ThreadView` mounts → `useRunDrafts(run.id)` fetches once (`staleTime: Infinity`,
   `refetchOnWindowFocus: false` — a background refetch must never overwrite what the user is
   typing).
2. `useDraft(run.id, 'composer')` seeds local state from the response the first time it resolves for
   that `(runId, surface)` pair, and only while the input is still pristine.
3. Every edit updates local state immediately and schedules a `PUT` **500 ms** after the last
   keystroke. Writes per surface are serialized through a single in-flight chain, so two rapid
   edits can never land out of order.
4. An attached image is `POST`ed once, on attach; the response's `id` goes into the draft record on
   the next `PUT`. Removing an image `DELETE`s it.
5. On submit the composer optimistically clears — that flows through `onValueChange`, so the draft
   is emptied, which deletes the entry. If the send **fails**, the composer restores the text
   (existing behavior) and the draft is rewritten. Image blobs are deleted only after the send
   resolves successfully.
6. On unmount the pending debounce is flushed immediately; on `visibilitychange → hidden` it is
   flushed with `keepalive: true`, so closing the tab mid-sentence still persists.

## 📝 Data Model

**On disk**, under the project's data dir (`.ai/cezar/`):

```
drafts/
  <runId>/
    draft.json            { surfaces: { <surfaceId>: DraftEntry } }
    images/<imageId>      raw bytes, 0600
```

One directory per run, so deleting a run's drafts is one `rm -rf` and no rewrite of a shared index.

```ts
interface DraftEntry {
  text: string                 // ≤ 100_000 chars — same cap as PATCH /runs/:id `task`
  images: DraftImage[]         // ≤ 4, composer parity (MAX_IMAGES)
  updatedAt: string            // ISO; the backstop's eviction order, and nothing else
}
interface DraftImage {
  id: string                   // opaque, server-minted
  mediaType: string            // /^image\//
  name: string                 // the composer's thumbnail label
  bytes: number                // decoded size, ≤ 5 MiB (MAX_IMAGE_BYTES)
}
```

Rules, all inherited from the neighbouring stores rather than invented:

- **Additive and salvaging.** Every key optional on read; an unknown surface id, a malformed entry
  or a corrupt `draft.json` degrades that draft to absent — never a throw, never a discarded file
  for the sibling surfaces that parsed.
- **Atomic writes.** `atomicWriteJsonSync` (tmp + rename, `0600` —
  `packages/cezar/src/workspace/config.ts:350`), so a crash mid-write cannot leave a truncated
  draft. Image blobs are written the same way.
- **Bounded on every axis**: text length, image count, image bytes, surfaces per run (16), and the
  whole-store backstop.
- **Backstop.** Before a write, if the store exceeds **64 MiB**, evict whole run directories
  oldest-`updatedAt` first until it fits, and log one line. Never age-based, never count-based —
  a user with 500 typed-but-unsent drafts keeps all of them.
- **Gitignored.** `drafts/` joins the `wanted` list in `ensureDataGitignore`
  (`packages/cezar/src/index.ts:664`) in the same commit — unsent messages and pasted screenshots
  must never reach the user's git history.

## 📝 API Contracts

New file `packages/contract/src/drafts.ts`, exported from `index.ts`; types inferred with `z.infer`
(request bodies `z.input`, per the convention in `runs.ts`). All four routes live in one chained
family and are mounted under `/api/v1/…` **and** `/api/v1/p/:projectId/…`, validated as route
middleware via the `jsonZodValidator` / `paramZodValidator` trio.

| Route | Body | Response | Errors |
| --- | --- | --- | --- |
| `GET /runs/:id/drafts` | — | `{ surfaces: Record<string, DraftEntry> }` | `404` unknown run |
| `PUT /runs/:id/drafts/:surface` | `{ text: string, images: string[] }` (image **ids**) | `DraftEntry` | `400` bad body / unknown image id · `404` unknown run |
| `DELETE /runs/:id/drafts/:surface` | — | `{ deleted: true }` | `404` unknown run |
| `POST /runs/:id/drafts/:surface/images` | `imageInputSchema` (reused verbatim) | `DraftImage` | `400` over cap · `404` unknown run |
| `GET /runs/:id/drafts/:surface/images/:imageId` | — | `{ mediaType, name, data }` (base64) | `404` |
| `DELETE /runs/:id/drafts/:surface/images/:imageId` | — | `{ deleted: true }` | `404` |

Notes that keep this inside the repo's laws:

- **An empty `PUT` is a delete.** `{ text: '', images: [] }` removes the entry and its blobs, so the
  Q4 policy ("cleared when emptied") is enforced server-side and not merely by client politeness.
- **`:surface` is validated**, not interpolated: `^(composer|review-notes|task-prompt|title|message:[A-Za-z0-9_-]{1,64})$`.
  It reaches the filesystem as a path segment, so an unvalidated value is a traversal.
- The image `GET` answers **JSON with base64**, not raw bytes: the composer's `PendingImage` is
  base64 already, and every response shape in this repo is a zod schema.
- `POST …/images` rides the global 32 MiB body limit, like `POST /runs/:id/message`; it does **not**
  touch `UI_STATE_BODY_LIMIT`.
- BACKWARD_COMPATIBILITY.md gains the routes in §2's inventory and `drafts/` in §3's state files, in
  the same commit — `bc-route-inventory.test.ts` reads the built app's route table and fails
  otherwise.

## 📝 UI/UX

Deliberately invisible. The feature is correct when nothing is announced: you come back and your
text is there, the caret at the end, the thumbnails intact.

- **No "draft restored" toast, no badge, no confirmation.** Restoration is the expected state, not
  an event.
- **No new UI surface.** A "Draft" indicator on the task list is a real idea (Slack, Linear) and is
  explicitly a **follow-up spec** — it is a separate capability with its own data needs, and this
  spec ships fully without it.
- **Seeding never fights the user.** A draft is applied only into a pristine input. If the fetch is
  slow and the user has already started typing, what they typed wins.
- **Accessibility / keyboard**: unchanged. No new focus management — restoring text does not steal
  focus, because a mount that grabs focus would hijack the page for a user who came back to read.
- **Phase 3 editors** (queued message, prompt, title) re-open with their draft when the task is
  reopened — an editor whose text is restored but stays closed is state the user cannot see. The
  bubble shows the editor open with the unsaved text and its Cancel/Save buttons, which is how the
  same situation reads on GitHub.

## 📝 Edge Cases & Failure Scenarios

| Scenario | Behavior |
| --- | --- |
| Storage unwritable (read-only repo, full disk) | `PUT` fails; the cockpit keeps the draft in memory for the session and stays silent. **No per-keystroke error toast** — a failed draft write must never be louder than the message being written. |
| Corrupt `draft.json` | That run's drafts read as absent; the file is overwritten on the next write. Never a throw, never a boot failure. |
| Run deleted in another tab | `PUT`/`POST` answer `404`; the client drops its draft state for that run without an error. |
| Two tabs, same task | Last write wins. Documented, not defended: only a tab whose input has actually been edited ever writes, so a passive tab cannot clobber an active one. This is precisely the failure that moved `lastLocation`/`sidebar.collapsed` out of workspace ui-state — the difference is that a draft is the user's *content*, which is why Q2 chose the shared answer anyway. |
| Send fails after the optimistic clear | The composer restores the text (existing behavior); the restore flows through `onValueChange` and rewrites the draft. Image blobs are deleted **only** on a resolved-successful send. |
| Tab closed mid-sentence | `visibilitychange → hidden` flushes the pending debounce with `keepalive: true`. |
| Image over 5 MiB / 5th image | Rejected by the composer's existing intake caps before the store sees it; the route re-validates so a non-cockpit client cannot bypass them. |
| Draft written, cezar restarted | Restored — it is a file, not a session. |
| Run finishes while a draft sits in its composer | Kept. The composer may go disabled, the text stays; `Continue` sends it when the user comes back. |
| Orphan blobs (a `POST`ed image never referenced by a `PUT`) | Swept when the run's draft is next written or deleted — blobs not named by any surface are removed. |
| Remote mode | Works unchanged (ordinary HTTP, covered by the existing origin guard). Worth stating plainly: on a remote cezar, unsent drafts rest on the server host, not in the browser. |

## 📝 Risks & Impact Review

- **Blast radius: small and additive.** New store, new routes, one new seam on `Composer`, four
  hosts that pass props they did not pass before. Nothing existing changes shape: `ui-state.json`,
  `runs.json`, the NDJSON streams and the `/new` localStorage draft are all untouched.
- **The composer is shared with `/new`.** The new `images`/`onImagesChange` seam must stay optional
  and behave exactly like the text seam ("pass both or neither"), or the `/new` composer silently
  loses its attachments. This is the one change in the diff that can break a surface nobody edited,
  and it needs a test pinning uncontrolled-images behavior.
- **New unsent-content-at-rest.** A message the user chose not to send now persists to disk, in the
  repo directory, until they clear it. Mitigated by `0600` blobs and the `.gitignore` entry;
  worth a line in the release notes, because "typed but never sent" is exactly the text people
  assume was never written down.
- **Write amplification.** A 500 ms debounce means roughly one small `fsync`-class write per typing
  pause per input. Bounded and local; if it ever shows up in a profile, the debounce is one
  constant.
- **Rollback.** Per phase, each is a self-contained revert: the hosts go back to uncontrolled
  inputs and the routes stop being called. Leftover `drafts/` directories are inert — no migration,
  no schema version, nothing to undo. Deleting `.ai/cezar/drafts/` at any time is safe, which is
  the zero-config contract ("delete any of it and cezar rebuilds what it needs").
- **Zero config.** No new config key, no new `CEZ_*` env var, no setting. The feature is on, or it
  degrades quietly to today's behavior.

## 📋 Phasing

- **Phase 1 — the reported bug, fixed.** Server draft store + routes + **text** drafts for the
  thread composer. Independently shippable and it is the whole user-visible complaint.
- **Phase 2 — attachments.** Pasted images survive with the text (Q3).
- **Phase 3 — the rest of the task's inputs.** Review notes, inline prompt/message editors, title
  rename (Q1). Independently shippable; each surface is one host wiring itself to the existing hook.

## 📋 Implementation Plan

### Phase 1 — text drafts for the thread composer

1. **Contract.** Add `packages/contract/src/drafts.ts`: `draftImageSchema`, `draftEntrySchema`,
   `runDraftsResponseSchema`, `setRunDraftInputSchema`, `draftSurfaceParamSchema`; export from
   `index.ts`. *Test:* the schemas' own unit tests — surface-id regex accepts `message:abc` and
   rejects `../x`; the text cap and the image-count cap reject over-limit input.
2. **Store.** Add `packages/cezar/src/runs/drafts.ts`: `readRunDrafts`, `writeRunDraftSurface`,
   `deleteRunDraftSurface`, `deleteRunDrafts`, and the 64 MiB backstop. Atomic writes, degrade to
   empty on every read error. *Test:* `packages/cezar/test/unit/` — round-trip, empty-write-deletes,
   corrupt-file-reads-empty, unwritable-dir-does-not-throw, backstop evicts oldest first.
3. **Routes.** Chain a `draftRoutes` family into `server.ts` (`GET` list, `PUT` upsert, `DELETE`),
   validated as middleware, mounted under both spellings. *Test:* `contract-parity`,
   `route-parity`, `typed-bodies`, plus handler tests for `404` on an unknown run and `400` on a
   bad surface.
4. **Run deletion cleans up.** `DELETE /runs/:id` also removes `drafts/<runId>/`. *Test:* deleting a
   run with a draft leaves no directory behind.
5. **Gitignore + docs.** `drafts/` into `ensureDataGitignore`; routes into
   BACKWARD_COMPATIBILITY.md §2 and the state file into §3. *Test:* `bc-route-inventory` passes;
   an `ensureDataGitignore` unit test asserts the new entry.
6. **Client + hook.** `client.ts` calls, `useRunDrafts(runId)` (`staleTime: Infinity`,
   no focus refetch), and `routes/task-thread/thread-draft.ts` exposing
   `useDraft(runId, surface)` — seed-once, 500 ms debounce, serialized writes, unmount +
   `visibilitychange` flush. *Test:* fake timers — typing writes once after the pause, not per
   keystroke; unmount flushes; a late `GET` never overwrites typed text.
7. **Wire the composer.** `ThreadView` passes `value` + `onValueChange` from the hook. *Test:*
   `task-thread.test.tsx` — mount with a stored draft renders it; type, unmount, remount, text is
   back; a different `run.id` shows *its own* draft and never the previous one's.
8. **E2E smoke.** `packages/web/e2e/`: type in task A → open task B → return → the text is there.

### Phase 2 — image attachments

9. **Contract + store + routes for blobs.** `POST`/`GET`/`DELETE …/images`, reusing
   `imageInputSchema`; blobs `0600` under `drafts/<runId>/images/`; orphan sweep on write and
   delete. *Test:* upload/read/delete round-trip; over-cap rejected; orphans swept; traversal
   attempt on `:imageId` rejected.
10. **Composer images seam.** Add optional `images` + `onImagesChange` to `ComposerProps`, mirroring
    the text seam exactly. *Test:* uncontrolled behavior unchanged (the `/new` case explicitly
    pinned); controlled mode routes every add/remove through the callback.
11. **Wire it up.** The thread host uploads on attach, deletes on remove, rehydrates thumbnails on
    mount, and deletes blobs only after a successful send. *Test:* attach → remount → thumbnail is
    back; failed send keeps the images; successful send clears them.

### Phase 3 — the remaining in-task inputs

12. **Review notes.** `review-panel.tsx` seeds from and mirrors to `review-notes`. *Test:* type,
    navigate away, return, notes intact; a successful send-back clears them.
13. **Inline prompt / message editors.** `thread-items.tsx` uses `task-prompt` and
    `message:<msgId>`; returning to the task re-opens the editor with the unsaved text. *Test:*
    editing one queued message and switching tasks restores that message's editor only — a
    second message's bubble stays closed and empty.
14. **Title rename.** `editable-title.tsx` uses `title` on the task-thread host only (the Tasks
    table's rename is not in a task and keeps today's behavior). *Test:* a half-typed rename
    survives a round trip; `Cancel` clears the draft.
15. **Cross-surface test.** One task with a composer draft, a notes draft and an open message editor
    survives a round trip with all three intact and none of them leaking into another task.



---

## 📝 As built

Three departures from the sketch above, each because the sketch's shape was worse in a way that
only showed once the code existed. Everything else — the route family, the surface vocabulary, the
500 ms debounce, the seed-once rule, the caps, the 64 MiB backstop, the gitignore entry — landed
as written.

**1. An attachment is ONE self-describing file, not raw bytes plus an index.**
`drafts/<runId>/images/<imageId>.json` holds `{id, mediaType, name, bytes, data}`; `draft.json`
stores only the id list per surface. The sketch's split (raw bytes in `images/<imageId>`, metadata
in the draft record) has two writers for one fact, so a crash between them leaves an index naming a
blob that is not there or a blob nothing can describe. One atomic write per attachment cannot
diverge from itself, and the read path answers base64 either way — `GET …/images/:imageId` is JSON
because the composer's `PendingImage` is base64 and every response in this repo is a zod schema.
The cost is the ~33% base64 overhead on disk, which the byte-counting backstop measures honestly.

**2. The orphan sweep has a grace window.** An attachment is `POST`ed on paste and only NAMED by
the draft record on the next debounced `PUT`, so "sweep blobs no surface references" would delete
the image the user just pasted if any other surface wrote in that gap. Blobs younger than ten
minutes are never swept — far past the 500 ms debounce, far short of mattering to the ceiling.

**3. Two flush paths the sketch did not name.**
- `pagehide` as well as `visibilitychange → hidden`: a full navigation (a typed URL, a reload)
  tears the document down without running React's unmount effects.
- The thread does **not** unmount when the route's `:id` changes — React keeps the component and
  swaps the prop — so `useDraft` carries a pending write across a surface swap explicitly. Without
  it, walking from task A to task B mid-sentence dropped A's last edit, which is precisely the move
  this feature exists to survive. It is pinned by a test.

Two smaller decisions worth recording:

- **The query cache is written from the PUT's response, not only optimistically.** A `GET` that was
  already in flight when the user started typing lands afterwards and would otherwise leave the
  cache holding the PREVIOUS draft — which a remount later in the same session would then seed,
  resurrecting text the user had replaced.
- **Removing a thumbnail deletes its blob; the composer's optimistic clear does not.** The host
  tells them apart without the composer having to say which is which: a send clears the text first
  and the images second, so an emptied array over an already-empty text is the clear. Its blobs
  must outlive the request, because a rejected message is restored with its attachments; they go
  with the empty write that follows a successful send.

`ensureDataGitignore` moved out of `packages/cezar/src/index.ts` into its own module
(`src/data-gitignore.ts`) so that it can be tested at all — importing `index.ts` runs the CLI.
