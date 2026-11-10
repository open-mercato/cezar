# Execution plan — per-project attachment library

**Engine:** om-auto-create-pr (steps: 11, --loop: no)
**Branch:** `feat/attachment-library`
**Base:** `main` (`f5e93561`)
**Origin of the idea:** community PR [#929](https://github.com/open-mercato/cezar/pull/929) by @Damian-Szczepanski, withdrawn 2026-09-04.

## 🎯 Goal

Keep every document a user attaches to a task in one per-project place — `.ai/cezar/attachments/`, under the file's own name — so a later task can be pointed at `spec.md` by name instead of at `runs/<some-other-run>-images/pasted-3.md`.

## Background

#951 (`ff9c44ed`) landed non-image attachments: the composer takes `image/*`, PDF, TXT and MD, `RunManager.persistAttachment` writes them into `.ai/cezar/runs/<runId>-images/` as `pasted-<n>.<ext>`, and `pastedAttachmentsText` hands the agent their absolute paths. Two things #929 proposed did not come with it:

1. **The per-project library.** Every attachment is reachable only from the run that carried it, and only under a synthetic name.
2. **The original filename.** `attachmentInputSchema` carries `{mediaType, data}` and nothing else, and `attachmentExtension` derives the on-disk name from the media type *alone* — the composer's `PendingAttachment.name` is explicitly commented "Never sent". For a non-image attachment the path is the **only** thing that ever reaches the agent, so `pasted-3.md` is the whole of what it knows about the file.

(2) is why (1) is worth doing at all: a library of `pasted-3.md` files is a pile, not a library. Both are in scope.

The P0 that #929's own review caught: writing into `.ai/cezar/` without a matching entry in `ensureDataGitignore` puts user uploads into the consumer repo's git working tree. It is invisible from inside this checkout, because cezar's own root `.gitignore` ignores `.ai/cezar/` wholesale.

## Scope

- Optional `name` on the attachment wire shape, sanitized server-side before it can reach a path.
- A content-deduped, collision-safe copy of every user **file** attachment into `.ai/cezar/attachments/`, strictly best-effort.
- The library path surfaced to the agent in the note it already receives.
- `attachments/` added to `ensureDataGitignore`, plus a static guard test so the next new state directory cannot repeat the bug.

### Decision: files only, not images (deliberate narrowing of #929)

#929 copied *every* upload. This lands **files only** (PDF/TXT/MD) for two reasons, one product and one structural:

- An image attachment is overwhelmingly a clipboard **paste**, which has no filename — the composer already falls back to the literal string `'pasted image'`. A shared folder of `pasted-3.png` from forty runs is clutter, not a library. A file, by contrast, is always picked or dragged, always has a real name, and that name is the only handle the agent gets.
- Carrying a name on the image path means widening `ContentBlock`, which is the **runner protocol** (`AGENT_PROTOCOL.md`) — an extra key on an image block survives `contentBlocksOf` and reaches the backend, where the vendor APIs reject unknown fields. `FileBlock` is cezar's own type and is converted to a path before anything is handed to a session, so putting the name there costs nothing and risks nothing.

Named image uploads (a dragged `diagram.png`) can join later behind an explicit paste-vs-pick distinction; noted as a follow-up on the PR.

## Non-goals

- **Not** widening the accepted media types. Main's curated allowlist with per-file rejection toasts is deliberate; #929's "any file type" is a separate decision the maintainers have not made. The composer's `accept` attribute and `screenAttachments` rules are untouched.
- No retention, GC or eviction policy for the library — flagged as a follow-up in the PR body.
- No change to `pasted-<n>.<ext>` naming inside `runs/<runId>-images/`. That numbering space is load-bearing for `isImageAttachmentName`, the orphan sweep, restart re-read and the per-stack cap.
- No new route, no new UI surface.

## Risks

- **A user-supplied string reaching a path.** The whole feature is "write a file under a name a browser gave us". Sanitization is the load-bearing part: basename only, no separators, no `..`, no control characters, length-bounded, and the extension pinned to the *validated* `mediaType` so a claimed `.sh` cannot override a `text/plain` upload. Tested as its own unit.
- **Silent regression of message delivery.** The copy is best-effort inside its own `try/catch`, mirroring `persistAttachment`; a failure must lose the library copy and nothing else. Pinned by a test that makes the copy throw.
- **The `.gitignore` P0 recurring.** Addressed by the static guard test, not by care.
- Contract change is additive and optional, so an older client that omits `name` behaves exactly as today (BACKWARD_COMPATIBILITY.md general rule).

## Implementation Plan

### Phase 1 — carry the filename on the wire

- **1.1** Add optional `name` to `attachmentInputSchema` in `packages/contract/src/runs.ts`, plus a `sanitizeAttachmentName(name, mediaType)` helper in the same module (basename, separator/`..`/control-char stripping, length bound, extension pinned to the media type, `null` when nothing usable survives). Unit tests for the sanitizer covering traversal, separators, control chars, extension mismatch, empty and oversize input.
- **1.2** Populate `name` from the composer: `fileToPendingAttachment` already knows `file.name`; send it for file attachments and update the "never sent" comment. Web tests.

### Phase 2 — the library

- **2.1** Add `name?: string` to `FileBlock` and carry it through `toPastedContent`. Tests pinning that the image branch is byte-identical to today.
- **2.2** Add the library writer in `packages/cezar/src/workflows/run.ts`: content dedupe (byte-identical file under that name → reuse, copy nothing), collision rename (`<stem>-2.<ext>`, `-3`, …), best-effort `try/catch`. Its own unit tests.
- **2.3** Call it from the user-attachment persistence path only (`namePrefix === 'pasted'`, file blocks) — never for agent screenshots. Tests, including the failure-isolation case.
- **2.4** Surface the library in `pastedAttachmentsText` without dropping the existing per-run paths (#950 behaviour must not regress). Tests.

  **Landed as a directory hint, not per-file paths.** A `PersistedAttachment.libraryPath` does not survive the dequeue/restart re-read — `readPersistedAttachments` reconstructs an attachment from its URL alone, so the original name is gone by then, and the note built at dequeue would silently lose the library line. Naming the folder needs no per-attachment state, and is a better answer for what the library is actually for: the document the user refers to by name but attached to an earlier task.

### Phase 3 — the `.gitignore` P0

- **3.1** Add `'attachments/'` to the `wanted` list in `ensureDataGitignore` (`packages/cezar/src/index.ts`), with a comment saying why user content must never reach `git status`. Verify the existing append path self-heals a pre-existing install.
- **3.2** Port #929's guard test: a static scan asserting every path the service writes under `.ai/cezar/` is named in `wanted`, with the deliberately committable exceptions (`workflows`, `skills`, `config.json`) listed explicitly.

### Phase 4 — documentation and gate

- **4.1** Update `BACKWARD_COMPATIBILITY.md` — the additive optional `name` key on the attachments bullet (§2), and `attachments/` as a new `.ai/cezar/` directory (§3). Update the `AGENTS.md` `ensureDataGitignore` note if it needs it.
- **4.2** Full validation gate: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.

## Progress

PR: #957

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Carry the filename on the wire

- [x] 1.1 Optional `name` on the contract + `sanitizeAttachmentName` — acaadd8e
- [x] 1.2 Composer sends the filename — e894ca8a

### Phase 2: The library

- [x] 2.1 `FileBlock.name` through `toPastedContent` — 1f21d864
- [x] 2.2 Library writer — dedupe, collision rename, best-effort — 1f21d864
- [x] 2.3 Wire it to user file attachments only — 1f21d864
- [x] 2.4 Surface the library path in the agent's note — 1f21d864

### Phase 3: The .gitignore P0

- [x] 3.1 `attachments/` in `ensureDataGitignore` — 7ea14c09
- [x] 3.2 Static guard test for data-dir coverage — 7ea14c09

### Phase 4: Documentation and gate

- [x] 4.1 BACKWARD_COMPATIBILITY.md and AGENTS.md — cbc63e2e
- [x] 4.2 Full validation gate — verified 2026-09-04

### Phase 5: Review pass (added after code review on PR #957)

- [x] 5.1 Grant the library to the spawned agent — the note NAMES the directory, but `agentDirectories` never passed it to `--add-dir`, so under `--permission-mode dontAsk` the agent's `Read`/`Glob` on the path it was told to look in were refused with no prompt. Asserted end to end against the mock's captured argv.
- [x] 5.2 Stop the composer's `pasted.<ext>` display fallback from reaching the wire — it was being filed as `pasted.md`, `pasted-2.md`, …, the exact numbering the library exists to replace. Only a name the upload itself carried is sent now (`originalName`).
- [x] 5.3 Truncate the stem on a code-point boundary for both bounds at once — the character-first `slice` counted UTF-16 units and could leave a lone surrogate that the byte pass then preserved.
- [x] 5.4 Refuse a non-bare name inside `copyToAttachmentLibrary` itself, so path safety does not depend on a caller two modules away; plus the Windows reserved device names (`CON.txt`), the note's "documents" wording, and comment-stripping in the ignore-list guard's regex.
