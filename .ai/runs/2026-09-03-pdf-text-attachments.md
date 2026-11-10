# Execution plan — PDF/TXT/MD attachments in the composer

Issue: #950
Slug: `pdf-text-attachments`
Branch: `feat/pdf-text-attachments`
Engine: om-auto-create-pr (steps: 12, --loop: no)

## Goal

The composer takes a `.pdf`, `.txt` or `.md` file the same way it already takes a screenshot: picked
with the paperclip, pasted, or dropped. The file is persisted into the run's attachment folder and
the agent is handed its **absolute path**; its bytes never enter the prompt.

## Scope

Everything a non-image attachment touches on its way from the file picker to the agent:

- the wire contract (`packages/contract/src/runs.ts`) and the four routes that carry attachments
  (`POST /runs`, `POST /runs/:id/messages`, `PATCH /runs/:id/queued-messages/:msgId`,
  `POST /runs/:id/continue`);
- the attachment serving route `GET /runs/:id/images/:file`;
- the run engine (`packages/cezar/src/workflows/run.ts`): persistence, the restart/dequeue re-read,
  and the on-disk-paths note the agent receives;
- the cockpit: composer intake, the composer's attachment row, and the thread bubbles that render a
  persisted attachment back.

### Non-goals

- Extracting or OCR-ing PDF text server-side — the agent reads the file from the path it is given.
- Office formats (`.docx`, `.xlsx`), archives, CSV, JSON, or any type outside PDF/TXT/MD.
- Raising the 4-attachment cap or the per-message size bounds.
- A PDF preview inside the cockpit — a named chip is the deliverable.
- Reviving #929's "any file type, no allowlist" approach.

## Design decisions

1. **One attachment list, one wire key.** The element schema behind the existing `images` key widens
   from `mediaType: /^image\//` to an allowlist that keeps every `image/*` and adds `text/plain`,
   `text/markdown`, `text/x-markdown` and `application/pdf`. Additive: an old client is unaffected,
   and the on-disk shape (`taskImages`, `queuedMessages[].images`) does not change at all, so a
   record written here still parses on an older cezar.
2. **The extension comes from the media type, never from the user's filename.** No filename reaches
   the wire or a path, which removes the whole sanitization/traversal question: `application/pdf` →
   `pasted-<n>.pdf`, `text/markdown` → `.md`, `text/plain` → `.txt`, in the same numbering space as
   `pasted-<n>.png` and `screenshot-<n>.png`.
3. **A non-image attachment is never inlined.** It has nothing for the model to look at, so it
   travels as a path — the form the agent's own file tools want, the only form that survives the
   codex/opencode backends (which drop image blocks before the model sees them), and the one that
   keeps a multi-megabyte document out of the prompt bounds.
4. **Reading code branches on the name's extension**, never on which list the entry came from
   (`isImageAttachmentName`). That keeps the orphan sweep, the restart re-read, the per-stack cap
   and the bubble rendering on one code path.
5. **Serving is binary-safe.** A non-image attachment is served with `X-Content-Type-Options:
   nosniff` and `Content-Disposition: attachment`, so user-controlled bytes can never render as an
   active document on the cockpit's own origin.

## Risks

- **The engine seam is `ContentBlock[]`** — the runner-protocol type. A file block must never reach
  a backend, so the widened type (`PastedContent`) is converted to `ContentBlock[]` inside the
  RunManager before anything is delivered; the runner protocol itself is untouched.
- **The path note is currently gated on an image block existing** (`if (images?.length)` in
  `runAgentStep`). Left alone, an attachment-only task would hand the agent a brief about a file it
  was never told the path of. Mitigated in Phase 2, with a test.
- **Older cezar reading newer state**: a `.pdf` entry in `taskImages` renders as a broken `<img>` on
  an older cockpit and would be re-encoded as `image/png` by an older engine. Documented in
  `BACKWARD_COMPATIBILITY.md` §3 rather than avoided — the alternative (a second on-disk list) is
  the larger break.
- **Overlap with the in-flight #948** (external contribution, changes-requested, CLA unsigned),
  which covers the TXT/MD half. Implemented independently here from the publicly described design;
  whichever lands first, the other rebases.

## Implementation Plan

### Phase 1 — Wire contract and routes

- 1.1 Widen the attachment element schema in `packages/contract/src/runs.ts` (allowlist + helpers
  `isImageMediaType` / `attachmentExtension`), keeping `imageInputSchema`/`ImageInput` as aliases.
- 1.2 Mirror the widening in `packages/cezar/src/server/server.ts`'s local schemas and map each
  attachment to an image block or a file block through one shared helper, on all four routes.
- 1.3 Serve non-image attachments safely from `GET /runs/:id/images/:file` (correct content type,
  `nosniff`, attachment disposition), leaving image responses byte-identical.

### Phase 2 — Run engine

- 2.1 Add the `PastedContent` file block plus the extension/media-type round trip
  (`persistAttachment`, `mediaTypeFor`, `isImageAttachmentName`) in `packages/cezar/src/workflows/run.ts`.
- 2.2 Widen the RunManager seams (start, live delivery, queued stack, edit, continue) so a file
  block is persisted to disk and kept out of the `ContentBlock` stream.
- 2.3 Make the restart/dequeue re-read return a non-image attachment as a path only, never as a
  re-encoded image block.
- 2.4 Give the agent the paths: emit the note for attachment-only messages and cover stacked
  attachments; engine e2e proving the path reaches the prompt and the bytes do not.

### Phase 3 — Cockpit intake

- 3.1 Widen the composer's intake (`composer-images.ts` → `composer-attachments.ts`): accept PDF/TXT/MD, fall back to the file
  extension when the browser reports no or an unknown type, and refuse anything else out loud.
- 3.2 Wire it through `composer.tsx`: the `accept` filter, paste and drop, and a named chip instead
  of a thumbnail for a non-image attachment.

### Phase 4 — Cockpit rendering

- 4.1 Render a persisted non-image attachment as a named chip in the thread bubbles and the
  new-task plan preview, never as a broken `<img>`.

### Phase 5 — Docs and gate

- 5.1 Record the widened surfaces in `BACKWARD_COMPATIBILITY.md` §2/§3.
- 5.2 Run the full validation gate and remove any scope creep from the diff.

## Progress

PR: #951

**Review (2026-09-03):** `om-auto-review-pr 951 --autofix` — APPROVE, no blockers or majors; three
minor findings fixed in-review as `fa758d07`. GitHub refuses self-approval, so the verdict is a
comment and the `review` label stays until a second reviewer converts it.

**Gate (2026-09-03, re-run at head `fa758d07`):** `npm run typecheck` ✓ · `npm test` 6252 passed / 329 files ✓ ·
`npm run test:unit` 36 ✓ · `npm run build` (incl. `check:pack`) ✓ · `npm run test:package` 16 ✓.
Every command was run with `TMPDIR=/tmp`: this machine's `TMPDIR` points *inside* the checkout, which
makes six pre-existing "outside a git repository" cases (`git`, `git-changes`, `git-worktree`,
`health-forge`, `projects-api`, plus one automations preview-timing case) fail on `main` too.

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Wire contract and routes

- [x] 1.1 Widen the attachment media-type contract — 653f3518
- [x] 1.2 Carry non-image attachments through the four routes — d5d7abc0
- [x] 1.3 Serve non-image attachments safely — d5d7abc0

### Phase 2: Run engine

- [x] 2.1 File blocks and the extension/media-type round trip — c7f6a206
- [x] 2.2 Persist file blocks across every RunManager seam — c7f6a206
- [x] 2.3 Restart re-read returns a path, never a re-encoded image — c7f6a206
- [x] 2.4 The agent gets the paths, including attachment-only and stacked messages — c7f6a206

### Phase 3: Cockpit intake

- [x] 3.1 Composer intake accepts PDF/TXT/MD and refuses the rest out loud — cbe43a2e
- [x] 3.2 Paperclip, paste, drop and the attachment row take both kinds — cbe43a2e

### Phase 4: Cockpit rendering

- [x] 4.1 Thread bubbles render a non-image attachment as a chip — cbe43a2e

### Phase 5: Docs and gate

- [x] 5.1 Backward-compatibility notes — d085fd03
- [x] 5.2 Full validation gate — d085fd03
