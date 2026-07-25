# Worktree File Editing from the Files Tab (#530)

## TLDR

The cockpit's **Files** tab can browse a run's worktree but not change it: `GET
/api/runs/:id/files` is the only file-content route and there is no write path
anywhere in the server. So changing one variable means spending a full agent
turn — slow, expensive, and absurd for a one-character edit (#515). This spec
adds an **additive `PUT /api/runs/:id/files`** (plus a small `GET
…/edits/:hash` to read a snapshot back) that writes a single text file
back into the run's worktree, reusing `readWorktreePath()` for containment —
with a small additive change to it, plus a **write-only deny rule** for `.git`
and `node_modules` at any depth, since its own `.git` check is root-only
and writing those paths is code execution rather than editing — an atomic
tmp+rename write, and a **stale-base guard** so a manual edit cannot be written
on top of content the user never saw. Every saved edit is recorded
twice — a metadata `file-edited` run event for visibility, and a bounded
byte-exact snapshot for recovery — so a human mutation of a live agent worktree
is both auditable and restorable. Writing is a **local-machine capability**: every write refuses under
hosted mode (`CEZ_REMOTE`), enforced server-side. The editor is the `CodeEditor`
component from #404 / PR #418 — no new dependency, no Monaco — highlighting the
open file through the same `langForPath()` + Shiki pipeline the preview already
uses, with a **debounced** editor-side tokenizer, because the preview's hook
re-tokenizes the whole file synchronously on every content change
(§Syntax highlighting in edit mode). Mockups of every state are in
`.ai/specs/assets/2026-07-20-worktree-file-editing/` (§UI/UX).

## Open Questions — resolved autonomously

Written in autonomous mode (`om-spec-writing --autonomous`). These were **not**
answered by a human; each carries the conservative default applied. Override by
commenting on #530.

| # | Question | Applied default | Why conservative |
|---|---|---|---|
| Q1 | Depend on PR #418's `CodeEditor`, or vendor a copy? | **Depend on #418.** If #418 has not merged when this spec's implementation reaches the UI step, vendor `code-editor.tsx` at that commit and open a follow-up to de-duplicate. | Two overlay editors is the outcome nobody wants — but an unmerged PR must not be able to kill the only phase with user value. The fallback is stated so a stalled #418 triggers a decision instead of a silent block. |
| Q2 | Version token: content hash, or `mtime`+`size`? | **Content hash** (sha-256 of the bytes). | `mtime` granularity loses sub-second edits and is not portable across filesystems; a hash cannot produce a false "unchanged". |
| Q3 | Allow editing while the run is `running`? | **Yes**, with the stale-base guard plus the divergence watch and the edit event below. | Blocking breaks the main use case — watching an agent work and correcting one value. |
| Q4 | Auto-commit a manual edit? | **No.** But the saved bytes are kept as an edit snapshot (§Audit & recovery), which is what actually makes it recoverable. | Auto-committing surprises users and pollutes the branch — **but see §Alternative considered: reuse `autosaveCommit()`, which weakens that reasoning substantially.** This is the answer most worth a human overriding, because taking it the other way deletes the largest subsystem in Phase 1. |
| Q5 | Gate behind a new `CEZ_*` flag? | **No new flag to enable it; one to disable it.** `CEZ_NO_FILE_EDIT=1` refuses all writes. | AGENTS.md § Zero config forbids knobs users must set to get working behavior — it does not forbid an operator kill switch for a write primitive. Off-by-default would be the knob; on-with-an-off-switch is not. |
| Q6 | Reuse the `localHandoff` capability, or add one? | **Add `fileEdit`**, sharing the same predicate. | Conflating two capabilities means a change to one silently changes the other. |
| Q7 | Extend to the repo-level `/api/repo/*` surfaces? | **No — out of scope.** | The repo checkout is the user's real working tree, with no worktree isolation to fall back on. Separate capability, separate spec. |
| Q8 | Put the saved content in the run event, or in a side file? | **Side file** (`runs/<id>-edits/`, content-addressed), with the event carrying metadata only. Bounded: 20 snapshots / 5 MB per run. | Audit and recovery have opposite requirements. The event path redacts every event type by default, so content in the event cannot be the exact-bytes recovery record; and it is sync-appended and replayed to every SSE client, so embedding up to 512 KB per save is a real cost on the run's hot path. Splitting them is the only option that keeps both properties honest (§Audit & recovery). |

## Problem Statement

A run's Files tab (`web/app/src/routes/task-git/task-files.tsx`, route
`/tasks/:id/files`) renders a lazy directory tree (`files-tree.tsx`) and a
read-only preview (`file-preview.tsx`) with Shiki highlighting, image inlining,
and binary / too-large states. It is backed by exactly one route:

- `GET /api/runs/:id/files?path=[&raw=1]` — `src/server/server.ts:1107-1140`,
  delegating to `readWorktreePath()` (`src/server/git-changes.ts:504`).

There is **no** `POST`/`PUT`/`PATCH` for file content anywhere. The only
mutating file-adjacent routes are git-level (`POST /api/runs/:id/git/commit`,
`/git/push`) or hand off to an external editor (`POST /api/runs/:id/open-in`),
which needs a local desktop and is disabled in hosted mode anyway.

From #515: *"It would be great to edit the files inside cezar — sometimes it is
faster to do manually like changing one variable."* Today that one variable
costs a full agent turn: a prompt, a model round-trip, tokens, and tool-call
latency — to do what a two-second keystroke would, in a file the user already
has open at the right line.

## Current state (what exists today)

| Piece | Location | Status |
|---|---|---|
| Directory listing + file read | `readWorktreePath()`, `src/server/git-changes.ts:504` | Traversal-safe and reused — but needs a small additive change (§Changes to `readWorktreePath()`), and its `.git` rule is root-only (below) |
| Read route | `src/server/server.ts:1107` | Read-only |
| API client | `getRunFile()`, `web/app/src/api/client.ts:294-296`; `useRunFile()`, `api/queries.ts:155` | Read-only |
| Tree + preview UI | `task-files.tsx`, `files-tree.tsx`, `file-preview.tsx`, `worktree-files.ts` | View-only |
| Language for highlighting | `langForPath()`, `web/app/src/lib/highlighter.ts:150` | Exists — no new mapping needed |
| Whole-file tokenizer | `useFileTokens()`, `web/app/src/routes/task-git/file-preview.tsx:134` | Exists — but **not reusable as-is** for an editor: it re-tokenizes on every `text` change, synchronously on the render path (§Syntax highlighting in edit mode H3) |
| Highlighted **editable** control | `CodeEditor`, `web/app/src/components/code-editor.tsx` | **Only on PR #418's branch** |
| Hosted-mode predicate | `resolveCapabilities()`, `src/server/capabilities.ts:42` (predicate at `:44`) | Exists (`localHandoff`) |
| Atomic write precedent | `src/runs/store.ts:689-692` (tmp+rename) | Pattern exists — but fixed tmp name, no mode preservation |
| Autosave commit | `autosaveCommit()` (`git-worktree.ts:234-254`), called at turn end (`src/workflows/run.ts:943`), finish (`:1166`), `:1653`, and pre-PR (`forge/github.ts:534`) | Exists — see §Audit & recovery |

`readWorktreePath()` is the load-bearing asset: it rejects NUL bytes,
dot-segment escapes and absolute paths, refuses the worktree-root `.git`,
refuses symlinks **and symlinked intermediate directories** (a full `realpath`
re-containment check), applies a content cap, and sniffs binary by NUL byte in
the first 8 KB. **The write must go through it, not around it.**

**But its `.git` rule is narrower than it reads, and that gap is load-bearing
for a write.** `git-changes.ts:515-517` computes `gitDir = join(rootAbs,
'.git')` and rejects only `target === gitDir || target.startsWith(gitDir +
sep)`. A **nested** `.git` is not covered — verified by running the resolver:

```
.git/config                 => invalid   (.git internals are not browsable)
sub/.git/config             => file
sub/.git/hooks/pre-commit   => file
node_modules/pkg/index.js   => file
```

The existing tests (`git-changes.test.ts:325-326`) assert only the root case, so
"already covered" is true of the test file and false of the property. For the
read route this is a disclosure of files the user already owns. For a **write**
route it is arbitrary code execution: any worktree containing a submodule, a
vendored fixture repo, or a test fixture with its own `.git` lets a `PUT` land
in `sub/.git/hooks/pre-commit` or set `core.sshCommand` / `core.fsmonitor` in
`sub/.git/config`, executed the next time git runs in that subdirectory. The
same argument applies to `node_modules/**`, which the validation gate executes
on every `npm run`.

This spec cannot wave that off with "the user already has a shell" (§Risks):
§Security 5 explicitly admits a *browser-reachable* attacker via CSRF / DNS
rebinding, and admits the mitigation is not yet in the tree. So the write path
gets its own containment rule — see §Write-path containment. It is **new work
with its own tests**, not an inherited property.

It does, however, need a **small additive change** to serve this feature — see
§Changes to `readWorktreePath()`. The earlier framing of "second caller, zero
modification" was wrong on both counts: it already has two callers
(`server.ts:1112`, the `GET`, and `server.ts:951`, the `open-in` default-app
path that hands a file to the OS launcher), and this feature does need it
changed. Pretending otherwise would hide the one place this spec touches a
security boundary.

## Proposed Solution

One additive write route, one small read route, one shared resolver, one reused editor.

- **`PUT /api/runs/:id/files?path=…`** with body `{ content, baseHash }`,
  resolving through `readWorktreePath()` — the same call the `GET` makes — so
  the write inherits the read's entire safety envelope from one implementation
  rather than a second, drifting one. Not literally "by construction": the
  write re-derives its absolute target from the sanitized relative path the
  resolver returns. §Changes to `readWorktreePath()` states exactly what that
  costs and what it leaves open.
- **Stale-base guard.** The `GET` gains an additive `hash` field (sha-256 of the
  bytes). The `PUT` must echo it as `baseHash`; a mismatch is a `409`. Read
  §Concurrency for what this does and does **not** guarantee — the honest
  scope of the guard matters more than the mechanism.
- **Atomic write.** tmp file in the target's directory + `rename`, preserving
  mode. A crashed write cannot truncate a source file. `src/runs/store.ts` is
  the precedent for the *pattern* only — `store.ts:689-692` uses a **fixed**
  tmp name and does **not** preserve mode, so both the randomized
  `.<file>.cez-tmp-<rand>` name and the mode preservation are **new work with
  their own tests**, not inherited behavior.
- **Overwrite only — no file creation.** A nonexistent path resolves to
  `missing` and is refused (`409`), and `baseHash` is required from day one, so
  the route cannot create a file. Creating files is a different interaction
  (a name to choose, a directory to pick, a tree to refresh) and is out of
  scope for this spec; the Files tab has no "new file" affordance either.
- **Every saved edit is recorded twice**: a metadata-only `file-edited` run
  event (the audit trail) and a byte-exact snapshot file (the recovery path).
  They are split deliberately — §Audit & recovery explains why one record
  cannot be both.
- **Hosted-mode refusal.** `409` whenever hosted mode is active, re-derived
  server-side per request.
- **Editor.** `CodeEditor` from PR #418 — a transparent-text `<textarea>` over a
  `<pre>` of Shiki tokens, sharing the highlighter singleton. Language from the
  existing `langForPath(path)`. Zero new deps.

Alternatives considered:

- **Monaco / CodeMirror.** Rejected: a multi-MB dependency in a codebase that
  carries none, for a feature whose premise is "change one variable quickly".
- **Last-write-wins, no guard.** Rejected: the concurrent writer is an
  autonomous agent, not a human who will notice.
- **Write through git (`git apply`).** Rejected: needs the file tracked and
  clean, fails on new/ignored files, buys nothing.
- **A generic `PUT /api/files` keyed on absolute path.** Rejected: keying on
  `:id` makes the worktree boundary structural.

## Changes to `readWorktreePath()`

The resolver must change. Three of this spec's requirements cannot be met from
its current return value:

```ts
// src/server/git-changes.ts:572-573 — today
const content = await readFile(target, 'utf8');
return { kind: 'file', path: display, size, binary: false, tooLarge: false, content };
```

1. **The UTF-8 gate cannot be evaluated downstream.** `readFile(…, 'utf8')`
   decodes with U+FFFD substitution *before* returning. By the time a caller
   sees `content`, the latin-1 corruption §Encoding exists to prevent has
   already happened — and is indistinguishable from a file that legitimately
   contains U+FFFD. Deciding `editable` needs the bytes.
2. **`hash` must be over the bytes** (§Data Model), and the current function
   returns only the decoded string.
3. **The write needs the absolute target.** `FilesResult.path` is the sanitized
   *relative* path (`display`, `git-changes.ts:519`), not `target`.

**The change:** `readWorktreePath()` reads the file as a `Buffer`, attempts a
strict (`fatal: true`) UTF-8 decode, and returns two additional fields on the
`kind: 'file'` variant — `utf8: boolean` and `abs: string`. **When the strict
decode throws, `content` is still populated with the existing lossy
(U+FFFD-substituting) decode and `utf8` is set `false`** — the strict decode
decides *editability*, it does not gate the field. Dropping `content` for
invalid-UTF-8 files would remove a response field
(`BACKWARD_COMPATIBILITY.md:34`, breaking) and blank the preview for files the
UI renders as text today (`previewKind()`, `worktree-files.ts:27-32`). `abs` is the
`resolve()`d `target` (`git-changes.ts:511`), **not** the `realpath`'d
`realTarget` (`:537`): the write must operate on the path the user named, with
containment already proven, and the race-3 analysis below assumes exactly that. `content` keeps its
exact current meaning and value for valid-UTF-8 files, so the `GET` route, the
`raw=1` branch, and every existing test are unaffected. This is the whole
modification; it is Phase 1 step 1, with its own tests.

Point 3 needs one honest caveat. `join(worktree, result.path) === target` holds
because `display` is sliced from the already-validated `target`, and the
`raw=1` branch relies on exactly this today (`server.ts:1125`) — so returning
`abs` is a convenience, not a new guarantee. Either way the write **re-derives
or re-uses a path validated at an earlier instant**, which is the source of
residual race 3 below.

## Write-path containment

`readWorktreePath()` proves the target is *inside the worktree*. That is
necessary and not sufficient for a write, because some paths inside the
worktree are executed by git or by the toolchain (§Current state). The write
therefore applies one additional rule, in `writeWorktreeFile()`, over the
sanitized **relative** path the resolver returns:

```ts
// reject `.git` at ANY depth, not just the worktree root
const segments = result.path.split('/');
if (segments.includes('.git')) return refuse('git internals are not editable');
if (segments.includes('node_modules')) return refuse('installed dependencies are not editable');
```

- **`.git` at any depth** — refused. Closes the nested-repo hook/config
  execution path. Deliberately a **write-only** rule: the `GET` keeps its
  current behavior, so no existing reader or test changes. Widening the read
  route's rule is a separate, breaking change (it would remove content the
  preview serves today) and is out of scope here.
- **`node_modules` at any depth** — refused, for the same reason as `.git` and
  scoped the same way. Root-only would be wrong here: this repo already has a
  real nested install at `web/app/node_modules`, and workspace/pnpm layouts
  make nested installs the norm rather than the exception — so a top-level rule
  would leave exactly the executed-by-every-gate-command files it exists to
  protect writable. No legitimate edit target lives under a `node_modules`
  segment, so the broad rule costs nothing.
- Both refusals return `409` with the `{ error }` shape, like every other
  target refusal in the status table.

The check runs on the resolver's `result.path` — already sanitized, already
containment-proven — so it cannot be bypassed by encoding tricks that
`readWorktreePath()` has by then normalized away. It is a *deny* list layered on
a proven-contained path, not a substitute for containment.

## Concurrency — what the guard does and does not promise

The agent writes the same worktree concurrently. Being precise about the
residual races is the point of this section; a vaguer promise would be worse
than none.

**What `baseHash` guarantees.** A save is refused if the file changed between
the read that seeded the editor and the write. It prevents the user from
overwriting an agent edit they never saw. That is a *stale-base* guard, not
mutual exclusion.

**Residual race 1 — TOCTOU.** Between the hash comparison and the `rename`
there is a window in which the agent can write; the `rename` then destroys that
write with no conflict raised. The window is milliseconds and there is no
portable file lock that an external agent process would honor. **Accepted and
documented** rather than papered over. Narrow it by hashing from an open
descriptor immediately before the rename, and re-check; do not claim it is
closed.

**Residual race 2 — the reverse direction, which the guard does not cover at
all.** The agent sends no `baseHash`. After the user saves, the agent's next
write silently destroys the user's edit. The guard is asymmetric by
construction, and this is the direction that loses user work.

**Residual race 3 — the path, not the content.** The two races above are about
bytes; this one is about the target. Between `readWorktreePath()`'s
`realpath` re-containment check and the write, a path component can be replaced
by a symlink pointing outside the worktree.

Be precise about which component, because the obvious version is *not* a
threat: **`rename(2)` does not resolve a symlink in the final component of
either operand** — renaming onto a symlink replaces the symlink itself. So
swapping the *target file* for a symlink cannot make this write escape. That is
the failure mode of a plain `writeFile(target)`, which §Proposed Solution
already rejects in favour of tmp+rename; the atomic write buys containment here
as a side effect.

The real variant is an **intermediate directory** swapped for a symlink after
resolution. Both the tmp `open()` and the `rename()` resolve the parent path by
name, so that one does escape. A re-`lstat` of the *target* would not help —
that guards the non-threat.

**This one is accepted, not mitigated, and the reason is worth stating because
the obvious fix does not exist in this runtime.** The correct control is to
open the parent directory once and perform the write and rename relative to
that descriptor — `openat`/`renameat` semantics. Node's `fs` exposes no
dirfd-relative operations: no `openat`, no `renameat`, no `AT_FDCWD`
equivalent; `FileHandle` has no path-relative methods. The `/proc/self/fd/`
emulation is Linux-only and cezar supports macOS. `O_NOFOLLOW` (which Node does
expose) constrains only the final component and does not bind the subsequent
`rename()`, which re-resolves the parent by name regardless. So a real fix
means a native addon — disproportionate here.

Severity is low in the threat model this feature lives in: the concurrent
writer is the run's own agent, in its own worktree, on a machine where the user
already has a shell (§Residual risk). It is named because it is a different
*kind* of failure from races 1 and 2 — an escape rather than a lost write — not
because it is likely or because this spec closes it. Race 1 and race 3 have the
same check-then-act shape and the same honest answer: documented, bounded, not
solved.

Mitigation for races 1 and 2 is §Audit & recovery, not a stronger lock — locking an external
agent process is not achievable, and pretending otherwise would be the actual
design error here. Additionally, while a file is open in the editor the client
**watches for divergence**: on the existing per-run SSE stream and on window
focus, it refetches the hash and warns when the file changed underneath —
including after a successful save. The user learns their edit was overwritten
instead of discovering it later in a diff.

## Audit & recovery

A human hand-edit into a live agent worktree today would leave no trace: no run
event, no log line. The agent's next turn sees code it did not write; a user
debugging the run has no way to know an edit happened. That is unacceptable in a
product whose premise is autonomous agents — and it is the same gap that makes
residual race 2 unrecoverable.

Both are closed, but **not by one record** — audit and recovery have opposite
requirements, and an earlier draft of this spec put them in the same field and
contradicted itself. Audit wants a small, redacted, streamable record. Recovery
wants the exact bytes. So:

**Audit — a `file-edited` run event, metadata only.** A successful `PUT`
appends to `runs/<id>.ndjson`:

```jsonc
{ "type": "file-edited", "path": "src/index.ts", "baseHash": "sha256:…",
  "hash": "sha256:…", "size": 4213 }
```

There is no separate `snapshot` pointer: the snapshot is **content-addressed**,
stored at `runs/<id>-edits/<hex>` where `<hex>` is the `hash` field's digest.
The event already carries its own pointer. This avoids naming snapshots by
`seq` — which is unknowable at write time, since `nextSeq()` is a private
`RunStore` method called from `appendEvent` (`src/runs/store.ts:450-460`,
`:620-624`) and the
snapshot must exist before the event that references it — and it makes repeated
saves of identical content deduplicate for free.

No `content`. Two independent reasons, either of which is sufficient:

- **Redaction would corrupt it.** `RunStore.appendEvent` redacts every event
  type, on by default (`store.ts:457`, opt-out `CEZ_REDACT_SECRETS=0` at
  `:555`), replacing any host env value ≥ 12 chars
  whose name matches `SECRET_NAME_RE` plus token-shaped literals
  (`src/core/secret-redaction.ts:55`; `TOKEN_PATTERNS` at `:57-70`). Editing a `.env.example`, a fixture, or
  any file containing a 12-character substring equal to a host secret would
  yield a "recovery" copy that silently differs from what the user saved.
  Restoring from it would write a redaction marker into a source file. A lossy
  record cannot be the unconditional recovery path.
- **Cost.** `appendEvent` is a *synchronous* `appendFileSync` plus a fan-out to
  every SSE subscriber, on the assumption that appends are "at agent-event
  rates … effectively free" (`store.ts:458-459`). Embedding up to
  `FILE_CONTENT_CAP` (512 000 bytes) per save breaks that assumption three
  ways: a 512 KB sync write inside a user-facing `PUT`, a full `redactDeep`
  walk of that string, and — because the server **replays the whole log** on
  every EventSource reconnect (`src/server/server.ts:1358-1361`; the client-side contract is documented at `web/app/src/api/run-events.ts:18`) — re-shipping every saved
  version of every edited file to the browser on each reconnect. The feature's
  premise is *iterative* editing, so this accumulates: twenty saves of a 300 KB
  file is 6 MB in a run whose events are otherwise kilobytes. `pruneOldRuns()`
  caps the *number* of runs (`MAX_RUNS_KEPT = 300`), never one event file's size.

**Recovery — a bounded snapshot beside the event.** The exact bytes go to
`.ai/cezar/runs/<id>-edits/<hex>`, written unredacted by the same atomic
tmp+rename. The `-edits` suffix follows the established per-run layout — every
existing artifact is a flat sibling (`runs/<id>.ndjson`,
`runs/<id>.handoff.md`, `runs/<id>-images/`, `store.ts:639-652`), documented at
`BACKWARD_COMPATIBILITY.md:42` — rather than introducing a nested `runs/<id>/`.

- Unredacted is correct here and is *usually* not a new exposure class: the
  snapshot is a copy of a file that already sits unredacted on the same disk,
  in the same worktree, readable by the same local user. Redaction (#427)
  exists because *agent tool output* is persisted and served back over the API;
  these bytes are user-authored and never reach the event stream.
- **The `#427` rationale is two conjuncts, and this design re-creates both.**
  `store.ts:454-456` states it as tool output being "persisted verbatim **and
  served back over the API**". An unredacted store plus `GET
  /api/runs/:id/edits/:hash` is exactly that pair. The "user-authored" half of
  the argument above answers *why the bytes are not redacted*; it does not
  answer *who may read them back*. Therefore **the snapshot read route is gated
  on the same `fileEdit` predicate as the write** — `409` under `CEZ_REMOTE=1`,
  a non-loopback bind, or the kill switch. Without this, flipping a cockpit to
  hosted mode leaves every snapshot written before the flip network-readable,
  and §Audit itself concedes snapshots can outlive the worktree they came from.
  Gating the read costs nothing: recovery is a local-machine act, the same as
  the edit that produced it.
- **One case where that argument does not hold, stated rather than glossed:**
  when the worktree is reclaimed under retention (#483, §Edge Cases), the
  snapshot **outlives its source** and becomes the only persistent unredacted
  copy — inside `.ai/cezar/`, which is what `CEZ_REDACT_SECRETS` exists to keep
  clean. Accepted, because a redacted snapshot is not a recovery record at all
  (that is the whole point of the split), and because reclamation already
  destroys the worktree the user would restore into. `CEZ_REDACT_SECRETS=0`
  semantics are unaffected either way. If this trade is judged wrong, the
  resolution is to evict snapshots on reclamation, not to redact them.
- **Retention:** keep at most the 20 most recent snapshots per run and 5 MB
  total per run, evicting oldest-first by mtime; snapshots are removed with the
  run. A re-save of content already stored reuses its snapshot, so the write
  **touches the file's mtime** — otherwise the run's newest edit would point at
  its oldest mtime and be evicted while still current. Bounded state, no
  sweeper, no knob.
- Recovery is therefore unconditional *within retention* — the honest
  qualifier. Twenty saves back is not recoverable, and the spec says so rather
  than implying an infinite undo.

**Reading a snapshot back.** Recovery needs a read path, so the snapshot gets
one route — `GET /api/runs/:id/edits/:hash` (§API Contracts). Without it the
bytes are recoverable only by hand-navigating `.ai/cezar/`, which is not a
feature. The route validates `:hash` as `^[0-9a-f]{64}$` and reads exactly
`runs/<id>-edits/<hash>`, so no caller-supplied path fragment reaches the
filesystem — the same shape as the existing images route (`server.ts:1039-1049`),
minus its permissiveness.

This does add state under `.ai/cezar/`, which an earlier draft ruled out. That
was the wrong call: zero config forbids *knobs the user must set*, not internal
bounded state (the same reasoning as Q5). See Q8.

Additive per `BACKWARD_COMPATIBILITY.md` §3 — `runs/<id>.ndjson` is documented
there (`:41`) as "one JSON object per line with `seq`, `ts`, `type`, free extra
keys", and `RunEvent.type` is an open `string` with an index signature
(`store.ts:151-157`), so a new type is additive by construction. (§3's "readers
skip bad lines" is about malformed lines; the unknown-key tolerance that
matters here is the `free extra keys` clause and the open `type`.) §7 is
untouched — `file-edited` is a run event, not an `AgentEvent`/`UiEvent`, so
backend parity does not apply.

**Interaction with autosave.** `autosaveCommit()` runs at turn end
(`run.ts:943`), at finish (`:1166`), at `run.ts:1653`, and pre-PR
(`forge/github.ts:534`), so during a running task a manual edit
usually reaches the branch as a commit within one turn — genuinely recoverable
via git. But it is *not* a guarantee: the periodic timer is opt-in, a finished
run has no further turn ends, and an agent write landing before the next
autosave leaves no git object of the user's version. The edit snapshot is what
makes recovery possible within its retention bound; autosave is a helpful
overlap, not the mechanism.

### Alternative considered: reuse `autosaveCommit()` instead of a snapshot store

This is the strongest argument against everything above, and an earlier draft
did not make it. Stating it properly, because it nearly wins.

`autosaveCommit()` (`src/workflows/run.ts` callers → `git-worktree.ts:234-254`)
is `status --porcelain` → `add -A` → `commit --no-verify -m "cezar autosave"`.
A single `await autosaveCommit(worktree)` after a successful `PUT` would give
recovery via a real git object and delete, in one line:

- the `runs/<id>-edits/` directory and its content-addressing,
- the 20-file / 5 MB eviction policy and the mtime-touch trick it needs,
- `GET /api/runs/:id/edits/:hash` and its client,
- the `deleteRun()` / `pruneOldRuns()` changes,
- the unredacted-store-under-`.ai/cezar/` exposure argued below,
- and the "snapshot expired" UI state.

That is roughly half of Phase 1. `add -A` also covers untracked and ignored
files, which is exactly the case §Risks calls out as having *no* git recovery
path — so it is strictly better there, not merely equivalent.

Q4's stated objection ("pollutes the branch") does **not** survive contact with
the code: on a running task — Q3's primary use case — the branch is already
being auto-committed wholesale at every turn end, so one more `cezar autosave`
commit changes nothing a user would notice.

**Why the snapshot store is kept anyway**, narrowed to the case that actually
justifies it:

1. **Finished runs.** After a run ends there are no further turn ends and no
   pre-PR hook. An explicit commit-on-save is the only thing that would record
   an edit — and on a finished run, a surprise commit on a branch the user may
   already have pushed or opened a PR from is a genuinely different act from
   the in-flight autosave they opted into by running an agent.
2. **`--no-verify` on a user action.** Autosave bypasses hooks by design for
   machine commits. Making a *user's* save silently bypass their own pre-commit
   hooks is a different contract.
3. **Non-git worktrees.** `readWorktreePath()` does not require a git repo;
   `autosaveCommit()` does.

**This trade is explicitly flagged for a human.** If the reviewer judges (1)–(3)
as not worth ~half of Phase 1 — a defensible read — the resolution is: drop
steps 6 and 8's recovery half, call `autosaveCommit()` after a successful
write, and keep only the metadata-only `file-edited` event for audit. The
audit/recovery split above stands either way; only the *mechanism* of the
recovery half changes. Note the coupling: dropping the snapshot store also
retires §Security 5's fourth scoping bullet and step 5's extra middleware test,
since `GET …/edits/:hash` would no longer exist. That is a further argument for
the descope, not against it.

## Security model

The first browser-reachable write into a checkout an agent subsequently
executes. That deserves stating plainly.

1. **Local-only by default.** The server binds `127.0.0.1` (AGENTS.md § HTTP
   server). Hosted deployments set `CEZ_REMOTE=1` or bind a non-loopback host.
2. **Hosted mode refuses every write**, from the same predicate as
   `localHandoff` (`CEZ_REMOTE !== '1' && isLoopbackHost(bindHost)`,
   `src/server/capabilities.ts:44`). Rationale, inherited from PR #418: a
   network-reachable write primitive into a checkout the agent then executes is
   an RCE, not a convenience. Reads stay open; writes do not.
3. **The containment boundary is `readWorktreePath()`** — reused, not
   reimplemented. But containment is *not* the whole boundary for a write:
   `readWorktreePath()` refuses only the worktree-root `.git`, so the write adds
   its own deny rule for `.git` and `node_modules` at any depth
   (§Write-path containment). That part **is** a new check, with its own tests.
4. **Text files only, within the content cap**, and **valid UTF-8 both ways**
   (§Encoding). Binary and over-cap targets are refused.
5. **CSRF and DNS rebinding — #467 is a hard blocker for this route.** #426 /
   PR #467 hardens the localhost API against exactly these. A content-type gate
   is *not* an acceptable fallback: it stops form POSTs and forces a preflight
   for cross-origin fetch, but **does nothing against DNS rebinding**, which
   makes the attacker's page same-origin so the preflight passes. Naming
   rebinding as the threat and then shipping a control that does not address it
   would be the worst outcome here. Therefore: this route ships **after** #467,
   or it ships with an explicit `Host`/`Origin` allowlist check implemented in
   this work and tested against a rebinding-shaped request. No third option.

   #467 is still open, so **the allowlist is the live path, not the fallback**.
   It ships as **server-wide Hono middleware**, not a check inside this route.
   A route-local guard would leave the other ~27 mutating routes (`POST
   /api/runs`, `/messages`, `/continue`, `PUT /api/config`, …) exposed to the
   identical attack while creating a second implementation for #467 to
   reconcile — the drift this spec avoids everywhere else. Shape it so #467 can
   absorb or replace it wholesale; if #467 lands first, delete this and assert
   the route is covered by it.

   **"Server-wide" needs four decisions spelled out, because taken literally
   it is a documented breaking change.** `BACKWARD_COMPATIBILITY.md:34` lists
   *"narrowing `/api/health` CORS"* explicitly under **Breaking**. So:

   - **`/api/health` is exempt.** `server.ts:431-440` sets
     `access-control-allow-origin: *` on it deliberately, so a saved bookmarklet
     on `github.com` can probe for a running cockpit — i.e. it is *supposed* to
     accept a foreign `Origin`. The middleware applies to **mutating methods
     only** (`POST`/`PUT`/`PATCH`/`DELETE`); `GET /api/health` is untouched.
     This also keeps the middleware off the entire read surface, so no existing
     consumer of any `GET` can regress.
   - **A missing `Origin` is allowed.** `BACKWARD_COMPATIBILITY.md:19` names
     "anyone scripting `localhost:4321`" as a supported consumer, and curl,
     `fetch` from Node, and every CLI send no `Origin` header at all. Browsers
     always send one on cross-origin requests, which is the threat being
     addressed; rejecting absent-`Origin` would break scripted clients while
     stopping no browser attack. **Reject only a present-and-foreign `Origin`.**
   - **`Host` is checked only when hosted mode is off.** A `Host` allowlist
     pinned to loopback is incoherent under `CEZ_REMOTE=1`, where a non-loopback
     `Host` is the entire point (`capabilities.ts:28-33`). Gate the `Host` half
     on the same `isLoopbackHost(bindHost)` predicate the capabilities already
     compute — no new configuration surface, so AGENTS.md § Zero config holds.
     Under hosted mode the `Origin` half still applies and this route is refused
     outright anyway.
   - **One `GET` is in scope anyway: `GET /api/runs/:id/edits/:hash`.** The
     "mutating methods only" scoping above is what keeps the middleware off the
     read surface — but the snapshot read is not an ordinary read. It serves a
     **deliberately unredacted** store (§Audit & recovery), so a rebinding
     attacker on a local cockpit — where `fileEdit` is `true` by definition —
     could `fetch()` it cross-origin and exfiltrate saved file contents. The
     `nosniff` + no-script CSP stops it becoming a document; it does not stop a
     `fetch`. The `fileEdit` capability gate does not help here either: the
     attack presumes a *local* machine, where that predicate passes.
     So the middleware's method scoping is "mutating methods **plus
     `GET …/edits/:hash`**". This is the one read whose exposure is created by
     this spec rather than inherited, so it is this spec's to close.

     **Which half does the work matters, so do not implement only the
     `Origin` check.** A rebound page is same-origin by construction, so its
     request carries **no `Origin` header at all** — and the second decision
     above deliberately allows absent-`Origin`. Rebinding is therefore stopped
     by the **`Host`** half, which is exactly why that half is gated on
     "hosted mode off" (the local case is the only one rebinding applies to).
     The `Origin` half covers ordinary cross-origin CSRF. An implementer who
     ships only the `Origin` check has built the control that §Security 5's
     opening paragraph explicitly rejects.

   **Scope warning, stated rather than buried:** this is an entire open PR's
   security work (#467) folded into one step of a file-editing feature. If the
   four decisions above are not accepted as sufficient design, the correct
   resolution is to make **#467 a hard sequencing blocker** — Phase 1 waits —
   rather than to ship a thinner control. Both paths are acceptable; shipping
   "server-wide middleware" with the above left unstated is not.
6. **Kill switch.** `CEZ_NO_FILE_EDIT=1` refuses all writes with `409`, so an
   operator can disable the primitive without a release (Q5). Update
   `.env.example` in the same commit — AGENTS.md makes an undocumented `CEZ_*`
   var a bug.

Background: #430 (agent tool access is not default-deny).

## Encoding

`readWorktreePath` sniffs binary by NUL byte in the first 8 KB. A latin-1 /
cp1252 file contains no NULs, so it passes as text, decodes with U+FFFD
replacement characters, and would be written back **as those replacements** —
silently corrupting a file the user only meant to glance at. That is precisely
the failure the CRLF rule below promises to avoid.

So: on read, a file is editable only if its bytes are **valid UTF-8** (decode
with `fatal: true`; on failure mark it `editable: false` with a reason, and the
UI shows it read-only). On write, the content is encoded UTF-8 and the bytes are
written verbatim — no line-ending normalization, no trailing-newline insertion.
Silent reformatting of someone's file is a bug.

## API Contracts

### `GET /api/runs/:id/files?path=…` — additive change

Unchanged behavior; the `type: 'file'` response gains:

```jsonc
{
  "type": "file", "path": "src/index.ts", "size": 4213,
  "binary": false, "tooLarge": false, "content": "…",
  "hash": "sha256:9f2b…",   // NEW — omitted when binary or tooLarge
  "editable": true,         // NEW — false for binary, tooLarge, or non-UTF-8
  "editableReason": null    // NEW — why not, when editable is false
}
```

`?meta=1` is also added: same `type: 'file'` envelope with `content` omitted,
for the Phase 2 divergence watch, which needs the `hash` many times per second
and must not pull up to 512 000 bytes with it (step 11). Additive — absent the
param, behavior is exactly as today. Document it in
`BACKWARD_COMPATIBILITY.md` §2 alongside the new fields.

The existing field is `tooLarge`, not `truncated` — server (`server.ts:1137`),
`FilesResult` (`git-changes.ts:428`), client type
(`web/app/src/api/types.ts:279`), and `previewKind()` (`worktree-files.ts:27`)
all agree. Only the three `NEW` fields are added; nothing existing is renamed.

### `PUT /api/runs/:id/files?path=…` — new

Request (`application/json`), zod-validated per the AGENTS.md rule that every
mutating route `safeParse`s its body. The **body is capped** before parsing
(reject over the content cap + a small envelope allowance with `413`) — an
unbounded JSON body would otherwise be parsed into memory ahead of every check.

```jsonc
{ "content": "…", "baseHash": "sha256:9f2b…" }
```

Both required. `baseHash` is required from day one deliberately: §2 flags
"making a previously optional body field required" as breaking, so a new route
must not ship it optional.

| Status | Body | When |
|---|---|---|
| `200` | `{ path, size, hash }` | Written. `hash` is the **new** token, so the client keeps editing without a refetch. |
| `400` | `{ error }` | Body fails `safeParse`. |
| `404` | `{ error: 'not found' }` | No such run. |
| `409` | `{ error: NO_WORKTREE }` | Run has no worktree — matches the `GET`. |
| `409` | `{ error: 'file editing is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)' }` | Hosted mode. Wording follows `server.ts:898`/`:928`. |
| `409` | `{ error: 'file editing is disabled (CEZ_NO_FILE_EDIT)' }` | Kill switch. |
| `409` | `{ error }` from `readWorktreePath`, or the directory / binary / non-UTF-8 / over-cap refusals | Target cannot be edited. |
| `409` | `{ error: 'file changed on disk since it was opened — reload to see the current content' }` | `baseHash` mismatch. |
| `413` | `{ error }` | Body over the cap. |

`409` (not `403`/`412`) keeps the route consistent with every other refusal in
this server, which uses `{ error }` + `400/404/409` uniformly.

### `GET /api/runs/:id/edits/:hash` — new

Reads back one edit snapshot (§Audit & recovery). `:hash` is the hex digest
from a `file-edited` event's `hash` field **with the `sha256:` prefix
stripped**, validated `^[0-9a-f]{64}$` before it touches the filesystem; the path is composed server-side as
`runs/<id>-edits/<hash>`, so no caller-supplied fragment is ever joined.

| Status | Body | When |
|---|---|---|
| `200` | the snapshot bytes, `content-type: text/plain; charset=utf-8`, `nosniff` | Found. Snapshots are UTF-8 by construction — the `PUT` refuses anything else. |
| `400` | `{ error }` | `:hash` is not 64 hex chars. |
| `404` | `{ error: 'not found' }` | No such run, or the snapshot was evicted by retention. |
| `409` | `{ error: 'file editing is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)' }` | Hosted mode, non-loopback bind, or kill switch. |

**This route is gated on the same `fileEdit` predicate as the `PUT`**, not left
open like the rest of the read surface. The store it serves is deliberately
unredacted (§Audit & recovery), and #427's rationale for redaction is precisely
"persisted verbatim *and served back over the API*" — so the read is the half
that turns an unredacted store into an exposure. Reads of *worktree* files stay
open; reads of the snapshot store do not.

The capability gate alone is **not sufficient** for this route, because the
attack that matters presumes a local machine, where `fileEdit` passes. This
route is therefore also the one `GET` covered by §Security 5's `Origin`/`Host`
middleware, which is otherwise scoped to mutating methods. Both controls, for
two different attackers: the capability gate stops a *hosted* deployment
serving the store to the network; the middleware stops a *rebinding* page
reading it off a local one.

Served with the same no-script CSP as the `raw=1` branch, so a snapshot can
never become a same-origin document. Unlike the images route
(`server.ts:1039-1049`), which serves any file in its directory, this route
admits exactly one filename shape.

### `/api/health` — additive capability

`Capabilities` gains `fileEdit: boolean`, derived from the same predicate as
`localHandoff` (and false under the kill switch). Single-sourced in
`resolveCapabilities()` so the two cannot disagree about what "local" means.

One consequence worth naming rather than leaving implicit: `/api/health` is the
**one** route serving `access-control-allow-origin: *` (`server.ts:427-440`), so
`fileEdit: true` advertises "this localhost port has a write-to-disk primitive
enabled" to any page that probes it — in a spec whose §Security 5 puts
cross-origin attackers in scope. The marginal disclosure over the existing
`localHandoff` flag is small (both mean "local cockpit"), and hiding the
capability would only break the UI's ability to hide the Edit button, so it
ships as-is. But it is a reason the §Security 5 control is a **prerequisite**,
not a nice-to-have: the capability tells an attacker the primitive is there.

## Architecture

`writeWorktreeFile(root, relPath, content, baseHash)` lives in a new
`src/server/worktree-write.ts`. It **calls** `readWorktreePath()` for resolution
so the boundary stays single-sourced, and is unit-testable against a temp
directory without booting Hono. `src/server/git-changes.ts` is about reading
diffs and worktree content; a write primitive does not belong under that name.

The `PUT` route in `server.ts` sits beside the `GET` at `:1107` and owns only
run lookup, the capability/kill-switch refusals, body validation, the snapshot
write, the run event, and status mapping. The `GET …/edits/:hash` read route
sits beside it and owns only hash validation and the file read.

Client: `putRunFile()` and `getRunEdit()` in `api/client.ts`,
`useSaveRunFile()` in `api/queries.ts` invalidating the file query;
`file-preview.tsx` owns the view⇄edit toggle and the snapshot-restore
affordance.

## Data Model

No `runs.json` field, no config key — the edit lands in the worktree and is
thereafter git's business. Two new records, both per-run and both bounded
(§Audit & recovery):

- the `file-edited` NDJSON event (metadata only — its `hash` field doubles as
  the snapshot's address), and
- `runs/<id>-edits/<hex>` — the exact saved bytes, content-addressed, capped at 20
  snapshots / 5 MB per run, evicted oldest-first, removed with the run.

The content hash is computed on demand over the **bytes**, never the decoded
string, so it cannot be fooled by an encoding round-trip — which is why
`readWorktreePath()` must surface the bytes (§Changes to `readWorktreePath()`).

## UI/UX

Only what is unique; the tree and preview chrome already exist.

Mockups live in `.ai/specs/assets/2026-07-20-worktree-file-editing/` — static HTML,
no JavaScript, openable straight from disk. They share a `tokens.css` copied
verbatim from `web/app/src/styles/index.css` (the one file allowed to carry raw
hex, enforced by `web/app/src/design-guardian.test.ts`), so the surfaces below
are drawn in the app's real tokens rather than an approximation of them. Each
has a `-dark.png` / `-light.png` beside it.

| Mockup | State |
|---|---|
| `files-view.html` | View mode, `editable: true` — the Edit button is the only new pixel |
| `files-edit.html` | Edit mode, dirty — overlay editor, Save/Cancel, uncommitted-honesty banner |
| `files-conflict.html` | `409` stale-base conflict — typed text preserved, Reload / Copy my version |
| `files-states.html` | Not-editable and gated states: non-UTF-8, hosted mode, no-grammar, `tooLarge`, and the Phase 2 overwrite banner |

`files-edit.html` and `files-conflict.html` render a **real** `<textarea>` over a
**real** token layer, so the caret sitting on its glyph is §Syntax highlighting
in edit mode's alignment invariant demonstrated rather than drawn. They are
fixed-density approximations: the real control must derive its padding from
`--spacing` rather than the literal pixels the mockups use, or it misaligns at
compact and ultra density (§Syntax highlighting, Overlay geometry). They are design targets for visual
approval; the implementation is React against the existing components, not these
files.

- **View by default** (mockup: `files-view.html`). `file-preview.tsx` gains an **Edit** button, shown only
  when the `GET` reports `editable: true` — the server decides editability, the
  UI does not re-derive it. When `editable` is false the existing preview states
  why (binary / too large / not valid UTF-8).
- **Edit mode** (mockup: `files-edit.html`) swaps the read-only `<pre>` for
  `CodeEditor` seeded with the content and
  `language={langForPath(path) ?? 'plaintext'}`. Header shows **Save** (disabled
  while clean or in-flight) and **Cancel**. Highlighting must survive the swap
  and survive typing — see §Syntax highlighting in edit mode, which is where the
  real work in this bullet is.
- **Dirty state** blocks navigation — tree selection, route change, tab switch —
  with a confirm. The Files tab is a place users click around in; losing an edit
  to a stray click is the obvious failure to design out.
- **Divergence warning** (§Concurrency): while the file is open, a banner
  appears when the on-disk hash stops matching — including after a save, which
  is how the user learns the agent overwrote their edit.
- **Uncommitted honesty.** While dirty and after saving, the header states the
  edit lives in the worktree and is not committed, linking the existing commit
  affordance.
- **Conflict** (mockup: `files-conflict.html`) is non-destructive: the user's
  text stays in the editor, with **Reload** (discard mine, refetch) and **Copy my
  version**. Never auto-resolve.
- **Hosted mode / kill switch** hide the Edit button via `fileEdit` (mockup:
  `files-states.html`). The server still refuses — the hidden button is UX, the
  `409` is the control.
- **Accessibility**: `CodeEditor` deliberately does not trap Tab, so keyboard
  navigation out keeps working. Preserve light/dark/system theming per AGENTS.md.

## Syntax highlighting in edit mode

The editor must highlight the file it has open, in the same colors as the
preview, without making typing feel slow. That sounds like it comes free from
reusing `file-preview.tsx`'s highlighting — it does not. Every property below is
a requirement on the new editor hook; none of them is inherited.

**H1 — One language resolution, shared.** Edit mode calls the same
`langForPath(path)` (`web/app/src/lib/highlighter.ts:150`) the preview calls,
resolves `null` to plaintext, and renders the same `data-lang`. The same bytes
must look identical either side of the Edit button.

`langForPath` returns `null` through **two** distinct routes, worth separating
because they mislead when merged: no usable extension (`dot <= 0` — `Dockerfile`
→ `-1`, `.gitignore` → `0`), and an extension we carry no grammar for
(`canonicalLang()` returns `null` — `.rb`, `.php`, `.java`). Both end in
plaintext; only the second is fixable by adding a grammar.

Note the preview already calls `langForPath` twice — memoized at
`file-preview.tsx:136` for the hook, and inline at `:161` for the `data-lang`
attribute. Same function, so no drift today; the editor should not add a third
spelling.

**H2 — The theme is genuinely free, and must stay that way.** Every
`foreground` in `SYN_THEME` (`highlighter.ts:45-86`) is a `var(--syn-*)` string,
`fg` is `var(--syn-var)` and `bg` is `'transparent'`; `highlightSync` hardcodes
the same and `plaintext()` matches. No hex reaches a token on any path.

So a light/dark flip costs **neither a re-tokenize nor a re-render**: it is a
class swap on `<html>` (`ThemeProvider`'s `useLayoutEffect`,
`web/app/src/components/theme-provider.tsx:44-46`) and the `--syn-*` variables
cascade to the existing token `<span>`s. `ThemeProvider` holds `theme` and
`prefersLight` in state, but its `children` element is constructed by `App`
(`web/app/src/app.tsx:38-50`) and is referentially stable across its own state
changes, so React bails out of the subtree — only `useTheme()` consumers
re-render. Edit mode inherits this unchanged.

The requirement is therefore preservative, not constructive: **do not break it.**
A future change resolving the CSS variables to hex at tokenize time would make
every theme flip a full re-tokenize of the open file, in a component where that
is now on the typing path — and nothing else in the suite would catch it. Assert
it: a theme flip mid-edit performs zero tokenizes.

**H3 — Re-tokenizing per keystroke is the jank, and the obvious reuse causes
it.** `useFileTokens` (`file-preview.tsx:134-154`) lists `text` in its effect
deps (`:149`) *and* calls `highlightSync(text, lang)` **during render** on a
cache-key miss (`:152-153`). That is correct for the preview, where `text` is
constant for the life of a file. In an editor it means, per keystroke:

1. a synchronous whole-file `codeToTokens` during render, before paint (`:153`);
2. a second whole-file tokenize in the effect (`:143` — `highlight()` is
   `highlightSync` once the grammar is resident); then
3. a second render, from `setLoaded`.

Plus a full `text.split('\n')` for the `plain` memo (`:135`) on every change,
used or not. And because the trigger is a **stale cache key**, not a keystroke,
step 1 also fires on any unrelated re-render while the key is stale — a parent
state change, an SSE tick. (Not a theme flip: per H2 that does not re-render
this subtree at all.)

H4's 1500-line cap bounds all of this, so the honest description is dropped
frames, not a freeze. But it bounds *lines*, not bytes: 1500 long lines is still
hundreds of KB tokenized two or three times per character, and even a 400-line
source file is enough to stutter visibly on a mid-range laptop. Degraded rather
than broken — and still not shippable.

The editor therefore needs its own hook that (a) keeps the last good token set on
screen while the user types, (b) re-tokenizes on a trailing debounce (~120 ms
idle) in an effect, **never during render**, and (c) never blocks a keystroke on
tokenization. Stale-by-one-debounce coloring is the correct trade; a stalled
caret is not.

**H4 — The same oversize cap, in both modes.** The preview stops highlighting
past `HIGHLIGHT_MAX_LINES = 1500` (`file-preview.tsx:129`, `:137`, `:151`) and
renders plaintext. Edit mode applies the same cap and the same fallback. Because
the content cap is a **byte** cap (`FILE_CONTENT_CAP = 512_000`,
`src/server/git-changes.ts:418`, applied at `:568`) and this one is a **line**
cap, a large-but-editable file that opens as plaintext in the preview must not
suddenly attempt highlighting when edited.

Two details this cap drags in:

- The constant is already duplicated — `file-preview.tsx:129` and
  `web/app/src/components/diff/diff-view.tsx:40`. A third copy in the editor is
  the wrong answer; export it once from `highlighter.ts` and have all three
  import it, as part of this step.
- **`data-lang` does not follow the fallback.** When `oversized`, the hook
  returns plaintext but `:161` still renders `data-lang="typescript"`. So
  `data-lang` cannot be used to assert "rendered as plaintext", and a test
  asserting only that view and edit agree on `data-lang` would pass on a file
  that is plaintext in both while claiming a language. Assert token *content*
  (a single uncolored token per line) instead — see step 7b.

**Overlay geometry.** The transparent-text `<textarea>` and the `<pre>` of tokens
must agree on `font-family`, `font-size`, `line-height`, `letter-spacing`,
`tab-size`, `white-space` (`pre` — the preview does not wrap, `:169`), wrapping
mode, and horizontal padding, and must scroll as one. Any disagreement drifts the
caret off the glyph it is meant to sit on.

The padding number is the trap, twice over.

*First, the arithmetic.* The preview's rows are `px-4` (`file-preview.tsx:165`)
but the **text column** does not start at 16px — the line-number gutter is a flex
sibling inside the same row, so the offset is `px-4 (16px) + w-10 (40px) = 56px`.
The gutter's `pr-3` (`:166`) is **inside** that 40px, not added to it, because
Tailwind's preflight sets `box-sizing: border-box`; it right-aligns the digits
within the gutter rather than widening it. A textarea given `px-4` lands 40px
off, and one given `16 + 40 + 12 = 68px` lands 12px off in the other direction —
an easy double-count, and one an earlier draft of this section made.

*Second, and worse: the number is not a constant.* Tailwind v4 derives its whole
numeric spacing scale from one token, and the app overrides it per density —
`:root[data-density='compact'] { --spacing: 0.21875rem }` and `ultra`
`0.1875rem` (`web/app/src/styles/index.css:197-210`). So `px-4` + `w-10` is
56px at comfortable, 49px at compact and 42px at ultra. **Any hardcoded pixel
padding on the textarea silently breaks caret alignment in two of the three
density modes** — a bug that would not appear in review, in the mockups, or in a
default-density test. The textarea's padding must be expressed in the same
`--spacing`-derived units as the token layer (share the utility classes, or
compute from the same custom property), never as a literal.

The editor must also decide explicitly whether the gutter stays inside the
horizontal scroll box — the preview's answer (`overflow-x-auto` at `:162`, so
line numbers scroll out of view on long lines), and an unusual one — or becomes
sticky. Whichever it picks, the textarea's left padding must equal the token
layer's text-column offset exactly, at every density.

**Grammar loading is asynchronous, and mostly already handled.** Grammars arrive
by dynamic `import()` (`highlighter.ts:89`), so the first render of a
newly-encountered language is plaintext and upgrades when the chunk lands;
`ensureLang` never rejects, and a failed grammar fetch deletes its cache entry
(`:184-202`) so a later render retries. Edit mode inherits that.

**The core chunk is the exception, and it is not handled.** `ensureCore`
(`:167-181`) memoizes with `corePromise ??=` and has **no** `.catch` eviction. If
`import('shiki/core')` or the engine import fails once — an offline reload, a
stale asset hash after a deploy — `corePromise` stays rejected for the life of
the page, `ensureLang` silently swallows it, and *every* language renders
plaintext forever with no retry. Pre-existing, and harmless in a read-only
preview. In an editor it is worth naming, because "highlighting is just gone"
reads as a broken editor. Either mirror `ensureLang`'s eviction in `ensureCore`
(a two-line fix, and the cheaper option) or surface the failed state rather than
degrading silently. Not a blocker for Phase 1; do not leave it undocumented.

The one genuinely new requirement here: an async upgrade landing mid-typing must
repaint tokens **without touching the textarea's value or selection**.

**Non-goal: widening grammar coverage.** The allowlist is 16 grammars
(`highlighter.ts:89`) plus 16 aliases (`:110`) and three extension fixups
(`mts`, `cts`, `htm`) inside `langForPath`, chosen for what agent transcripts
fence. A `.rb`, `.php`, `.java` or extension-less file renders untinted today and
will render untinted in the editor. That is a pre-existing limitation of the
preview, not a regression this feature introduces, and **editability never
depends on it** — a plaintext file is as editable as a TypeScript one, because
editability is a UTF-8 question (§Encoding). Adding grammars is a separate, cheap
change that benefits both surfaces at once, precisely because H1 keeps the
resolution shared.

## Edge Cases & Failure Scenarios

| Case | Behavior |
|---|---|
| Agent rewrites the file while the editor is open | `baseHash` mismatch → `409` → conflict banner; the user's text is preserved. |
| Agent rewrites the file **after** the user saves | Not preventable (§Concurrency race 2). Divergence banner warns; the edit snapshot holds the user's bytes. |
| Agent **deletes** the file while the editor is open | `readWorktreePath` → `missing` → `409`. Banner offers "Copy my version"; no accidental resurrection. |
| Symlink, symlinked parent, root `.git`, path escape | `readWorktreePath` → `invalid` → `409`. Inherited, already tested. |
| **Nested `.git`** (`sub/.git/config`, `sub/.git/hooks/pre-commit`) | `readWorktreePath` **allows** these — root-only rule. Refused by the write's own deny rule (§Write-path containment) → `409`. **New check, new tests.** |
| `node_modules/**` at any depth | Refused by the same deny rule → `409`. Executed by every gate command; never the "one variable" use case. Nested installs (`web/app/node_modules`, workspaces) are the common case, so the rule is not root-scoped. |
| Path that does not exist yet | `readWorktreePath` → `missing` → `409`. **File creation is out of scope** — see §Proposed Solution. |
| Non-UTF-8 bytes that pass the NUL sniff | `editable: false`; `PUT` refuses. §Encoding. |
| Worktree reclaimed mid-edit (retention, #483) | `worktreeOf(run)` empty → `409 NO_WORKTREE`. |
| Content grows past the cap in the editor | Refused (`409`); the editor warns as the cap is approached, not only on save. |
| Request body over the cap | `413` before parsing. |
| Disk full / EACCES during write | tmp write fails → tmp removed → `500` with the OS message; the original is untouched. |
| Process dies between tmp write and rename | Original intact; a stray `.<file>.cez-tmp-<rand>` remains. No sweeper — zero-config forbids *required* new state, and a recognizable tmp name is enough. |
| File with no resolvable grammar — no usable extension (`Dockerfile`, `.gitignore`) or an unsupported one (`.rb`, `.php`) | `langForPath` → `null` by either route → plaintext in **both** modes, and still fully editable. Highlighting coverage never gates editing (§Syntax highlighting H1, Non-goal). |
| File longer than `HIGHLIGHT_MAX_LINES` (1500) | Plaintext in edit mode too, matching the preview (§Syntax highlighting H4). Editable up to the byte cap regardless. Note `data-lang` still reports the real language in this state — it does not track the fallback. |
| **Grammar** chunk fails to fetch while the editor is open | Plaintext now, retried on a later render; `ensureLang` deletes the failed entry and never rejects. The textarea's value and selection are untouched (§Syntax highlighting). |
| **Core** Shiki chunk fails to fetch | Plaintext for the rest of the page's life, no retry — `ensureCore` memoizes a rejected promise with no eviction (`highlighter.ts:167-181`). Pre-existing; §Syntax highlighting says fix it or surface it rather than degrading silently. |
| Theme switched (light/dark/system) mid-edit | Repaints through the `--syn-*` custom properties — a class swap on `<html>`, with no re-tokenize and no subtree re-render (`ThemeProvider`'s `children` is referentially stable). Dirty state untouched. §Syntax highlighting H2 asserts it so a future hex-at-tokenize-time change cannot silently regress it. |
| CRLF / trailing newline | Bytes written verbatim. No normalization. |
| Empty content | Allowed — truncating a file is a legitimate edit. |
| Two cockpit tabs editing one file | Second save conflicts on `baseHash`. Same mechanism, no special case. |
| File is untracked or gitignored | Editable, but `git checkout --` will not restore it (§Risks). The edit snapshot is the only recovery path — which is why it is not optional, and why it is bytes rather than a redacted event field. |
| Snapshot retention exceeded (21st save, or > 5 MB in a run) | Oldest snapshot evicted; its `file-edited` event stays in the log, but `GET /api/runs/:id/edits/:hash` now 404s. The UI reports "snapshot expired", never a broken link. |

## Risks & Impact Review

**Blast radius.** Two new routes (`PUT …/files`, `GET …/edits/:hash`), one new
server module, three additive response fields, one additive capability, one new
NDJSON event type, one bounded per-run snapshot directory, a `src/runs/store.ts`
change so `deleteRun()` and `pruneOldRuns()` drop that directory with the run,
server-wide Origin/Host middleware for mutating methods plus `GET
…/edits/:hash` (§Security 5 — the
largest single piece of blast radius here, and the one most likely to be
descoped to #467), a write-path deny rule for `.git` / `node_modules`
at any depth (§Write-path containment), one client type change, one
changed component, and one new editor-side tokenizer hook — the preview's
`useFileTokens` cannot be reused unchanged without a per-keystroke whole-file
tokenize on the render path (§Syntax highlighting in edit mode H3). Lifting
`HIGHLIGHT_MAX_LINES` into `highlighter.ts` also touches `diff-view.tsx:40`,
which carries its own copy today — a pure de-duplication with no behavior
change, but it does put the diff view in this PR's blast radius.

`readWorktreePath()` gains a **third** caller — `server.ts:1112` (the `GET`) and
`server.ts:951` (the `open-in` default-app path, itself a security-relevant
consumer this spec's earlier drafts never mentioned) already exist — **and a
small additive change**: it returns the bytes' UTF-8 validity and the absolute
path, leaving `content` byte-identical for every existing caller (§Changes to
`readWorktreePath()`). That is the one security-relevant edit in this work and
it carries its own tests.

**Backward compatibility** (`BACKWARD_COMPATIBILITY.md`):

- §2 — new `PUT` method on an existing path: **additive**. No route removed or
  renamed, no response field removed, `GET` behavior unchanged. New `hash` /
  `editable` / `editableReason` fields and `fileEdit` on `/api/health`:
  additive. §2 flags `/api/health` as the most externally-depended-on JSON in
  the app — adding a field is safe; existing fields are untouched.
- §3 — the `file-edited` NDJSON event is a new `type` on an append-only log
  whose readers tolerate unknown types: additive. Verified across every reader,
  not assumed — `store.readEvents` (`store.ts:571-586`) skips only JSON-parse
  failures, `nextSeq`/`rehydrateSeq` touch only `seq`, the SSE writer routes by
  `isV2WireEventType` with non-dotted types riding `run-event`
  (`server.ts:1338-1341`), the thread reducer's `default: break`
  (`thread-state.ts:481-486`) renders unknown types as nothing deliberately,
  and the `cezar run` console switch (`src/index.ts:259-282`) has no default
  branch.
- **§Security 5's middleware is the one non-additive piece** and is scoped to
  avoid the documented break: mutating methods (plus the new `GET
  …/edits/:hash`, which breaks no existing consumer because it is new),
  `GET /api/health` exempt, absent `Origin` allowed. Those three exemptions are what keep it out of
  `BACKWARD_COMPATIBILITY.md:34`'s "narrowing `/api/health` CORS" and `:19`'s
  scripted-client guarantee. If the implementation cannot hold all three,
  it is a breaking change and #467 sequencing applies instead.
- §7 — untouched. `file-edited` is a run event, not an `AgentEvent`/`UiEvent`,
  so the backend-parity requirement does not apply.
- Document the route and the fields in `BACKWARD_COMPATIBILITY.md` §2, the
  event and the snapshot directory in §3, and `CEZ_NO_FILE_EDIT` in
  `.env.example` plus the README env table (`README.md:360-376`) — AGENTS.md
  `:18` makes an undocumented `CEZ_*` var a bug. The HTTP route listing lives
  in `BACKWARD_COMPATIBILITY.md:21-32`, not AGENTS.md.

**Rollback story.** Tracked files: `git checkout -- <path>`, and the run's diff
view already shows the change. Untracked/ignored files: git has nothing to
restore, so the edit snapshot is the recovery path, within its retention bound.
Stating both is the point — the earlier framing that rollback is "free via git"
is true only for tracked, committed state.

**Dependencies.** #467 (CSRF / DNS rebinding) is open, so the server-wide
`Origin`/`Host` allowlist ships in this work (§Security 5) — a dependency that
has *already* resolved to the fallback, not one still waiting. PR #418 is also
still open, so plan on the Q1 vendoring fallback for the editor.

**Residual risk.** A user with local cockpit access can write any existing,
non-symlinked, UTF-8 file in a worktree that is not under a `.git` or
`node_modules` directory at any depth (§Write-path containment). That
user already has a shell on the machine and an agent with unrestricted `Bash`
(#430), so the route widens no real boundary locally. Two places where that
"already has a shell" argument does **not** carry the weight it looks like it
does, stated rather than relied on: §Security 5 admits a *browser-reachable*
attacker whose mitigation is not yet in the tree — that attacker has no shell —
and the excluded paths above are excluded precisely because writing them is
code execution rather than editing. Hosted mode is where the boundary would
genuinely widen, and hosted mode refuses both the write and the snapshot read.

## Phasing

The split is **vertical**, not server-then-client. A server-only phase would put
the entire risk of a browser-reachable write primitive on `main` while
delivering zero user value — nobody curls a `PUT` to fix one variable — for
however long the UI takes. Phase 1 is therefore the smallest end-to-end slice
that a user can actually use.

**Phase 1 is nonetheless large, and two of its parts are separable** — worth
saying plainly rather than letting "smallest slice" imply "small". Step 5b (the
server-wide `Origin`/`Host` middleware) is #467's work; steps 6 and 8's recovery
half is the snapshot store, which §Alternative considered shows could collapse
into a single `autosaveCommit()` call. If Phase 1 needs to shrink, those are the
two cuts — in that order — and neither removes the "edit and save" user value
the vertical split exists to protect.

- **Phase 1 — edit and save, end to end.** Both routes + `worktree-write.ts` +
  hash/editable on the `GET` + `fileEdit` + kill switch + the `file-edited`
  event and its snapshot (with retention and run-deletion cleanup) + the editor
  UI with dirty state, conflict handling, and highlighting that survives typing
  (§Syntax highlighting in edit mode). Shippable and useful on its own.
- **Phase 2 — divergence awareness.** The open-file hash watch and the
  post-save "agent overwrote your edit" banner, plus surfacing `file-edited` in
  the Session timeline. Phase 1 is safe without it (the edit is already
  recorded); Phase 2 makes the loss *visible* rather than merely recoverable.

Both leave the app working. Neither changes existing behavior.

## Implementation Plan

Every step ends with the AGENTS.md gate: `npm run typecheck`, `npm test`, `npm
run test:unit`, `npm run build`, `npm run test:package`; `npm run test:e2e` at
phase completion.

### Phase 1 — edit and save

1. **`readWorktreePath()` bytes change, hash, and the `GET` fields.** Read the
   file as a `Buffer`; attempt a strict (`fatal: true`) UTF-8 decode; add
   `utf8: boolean` and `abs: string` to the `kind: 'file'` variant, leaving
   `content` byte-identical for valid-UTF-8 files. Then `fileHash(bytes)`
   (sha-256, `sha256:` prefix) and return `hash`, `editable`, `editableReason`
   from the `type: 'file'` branch (`server.ts:1132-1139`). *Tests:* every
   existing `readWorktreePath` and `GET /files` test still passes unchanged;
   `utf8: false` for a latin-1 file that passes the NUL sniff; `hash` stable
   across reads and absent when `binary` or `tooLarge`; `abs` resolves inside
   the worktree.
2. **`fileEdit` capability + kill switch.** Extend `Capabilities` and
   `resolveCapabilities()` (`src/server/capabilities.ts`); add
   `CEZ_NO_FILE_EDIT` and update `.env.example`. *Tests:* true by default; false
   under `CEZ_REMOTE=1`, a non-loopback bind, and the kill switch.
3. **`src/server/worktree-write.ts`.** `writeWorktreeFile()`: resolve via
   `readWorktreePath()`; reject directory / binary / non-UTF-8 / over-cap /
   missing; compare `baseHash`; re-hash from the open descriptor
   immediately before the rename (narrows race 1; race 3 is accepted — see
   §Concurrency); atomic tmp+rename with a randomized `.<file>.cez-tmp-<rand>` name and
   explicit mode preservation (neither is inherited from the `store.ts`
   precedent — see §Proposed Solution); return `{ path, size, hash }`. *Tests (temp dir, no server):* success; traversal; `.git`;
   symlink; symlinked parent; directory target; binary; non-UTF-8; over-cap;
   hash mismatch; empty content; mode preserved; original intact when the write
   throws. **Plus the write-path deny rule (§Write-path containment), which is
   new behavior and must fail loudly if dropped:** `sub/.git/config` and
   `sub/.git/hooks/pre-commit` are refused (they are *allowed* by
   `readWorktreePath` — assert that too, so the test documents why the rule
   exists); `node_modules/x/index.js` **and** the nested
   `web/app/node_modules/x/index.js` both refused; and a nonexistent path
   refused rather than created. Plus one test on the rename helper directly (not through
   `writeWorktreeFile`, which refuses symlinks at resolution): **renaming onto
   a symlink replaces it rather than following it** — the tmp+rename property
   race 3 relies on, asserted so a future switch to a plain `writeFile` fails
   loudly.
4. **The route.** `PUT /api/runs/:id/files` beside the `GET`: run lookup →
   404, `worktreeOf` → 409, hosted-mode and kill-switch → 409, body cap → 413,
   zod `safeParse` → 400, delegate, map to the status table. *Tests:* every row.
5. **Security guards, in the same commit as step 4.** (a) A `409` under
   `CEZ_REMOTE=1` for an *otherwise perfectly valid* request — written so it
   cannot pass for the wrong reason. (b) The `Origin`/`Host` allowlist as
   **server-wide middleware** (§Security 5), tested against a rebinding-shaped
   request (a valid `Origin` with a foreign `Host`) and asserted to cover a
   second mutating route besides this one, unless #467 has landed and supplies
   it — in which case assert this route is covered by it. The three scoping
   decisions from §Security 5 each need their own test, because each is a
   documented-contract boundary: **`GET /api/health` still answers a foreign
   `Origin` with `access-control-allow-origin: *`** (`BACKWARD_COMPATIBILITY.md:34`
   lists narrowing it as breaking); **a request with no `Origin` header is
   allowed** (scripted `localhost:4321` clients, `:19`); and **the `Host` half
   is skipped under `CEZ_REMOTE=1`**. If any of the three is judged wrong,
   §Security 5's fallback applies: make #467 a hard sequencing blocker instead
   of shipping a thinner control. One more test: **`GET …/edits/:hash` is
   covered by the middleware** despite being a `GET` (§Security 5) — assert a
   foreign-`Origin` `fetch` of a valid snapshot hash is refused, so a future
   refactor that "simplifies" the middleware to mutating-methods-only fails
   loudly instead of silently re-opening the store.
6. **The `file-edited` event and the snapshot.** Write the snapshot to
   `runs/<id>-edits/<hex>` (atomic, unredacted, `<hex>` = the content digest), enforce the 20-file
   / 5 MB oldest-first eviction, then append the metadata-only event with `{
   path, baseHash, hash, size }`. Add the `GET /api/runs/:id/edits/:hash` read
   route and extend `deleteRun()` (`src/runs/store.ts:590-605`) and
   `pruneOldRuns()` (`:659-675`) — each currently `rmSync`s exactly three paths
   (`eventsPath`, `handoffPath`, `imagesDir`) — to drop the edits directory too.
   **Gate the read route on the same `fileEdit` predicate as the `PUT`**
   (§Audit & recovery, §API Contracts) — the store is unredacted by design, and
   serving it back over the network is the half that makes that a problem.
   *Tests:* the read route `409`s under `CEZ_REMOTE=1` and the kill switch;
   event carries no `content`; snapshot bytes are byte-identical to
   the request body **including when the content contains a host-secret-shaped
   string**; identical re-saves reuse one snapshot; eviction drops the oldest
   past either bound; the read route serves the bytes and 404s after eviction;
   `:hash` rejects non-hex and any path fragment; snapshots removed by both
   `deleteRun` and `pruneOldRuns`; no event and no snapshot on any refusal.
7. **Client types + edit mode.** Extend the `type: 'file'` variant of
   `WorktreeEntry` (`web/app/src/api/types.ts:279`) with `hash`, `editable`,
   and `editableReason` — without this the gate's `npm run typecheck` fails the
   moment `file-preview.tsx` branches on `editable`. Then `putRunFile()`,
   `useSaveRunFile()`, and `file-preview.tsx`'s Edit/Save/Cancel with
   `CodeEditor` and `langForPath`.
   Per Q1, vendor `code-editor.tsx` if #418 has not merged, with a
   de-duplication follow-up. *Tests:* Edit button absent when `editable` is
   false and when `fileEdit` is false; present for editable text.
7b. **Highlighting in edit mode** (§Syntax highlighting in edit mode). A
   debounced editor-side tokenizer — **not** `useFileTokens`, which re-tokenizes
   synchronously on the render path per `text` change — keeping the last good
   tokens on screen while typing; the same `langForPath` resolution and the same
   oversize cap as the preview; and the overlay geometry pinned so the caret
   tracks its glyph. Export `HIGHLIGHT_MAX_LINES` once from `highlighter.ts` and
   have `file-preview.tsx:129` and `diff-view.tsx:40` import it rather than
   adding a third copy. Whichever way Q1 goes, this is where the vendored or
   imported `CodeEditor` is made to satisfy H1–H4 — #418 was not written against a
   512 KB file. *Tests:* view mode and edit mode produce the same `data-lang` and
   the same token colors for one file, including a `null`-language file
   (`Dockerfile`) rendering as plaintext in both — asserted on **token shape**
   (one uncolored token per line), not on `data-lang`, which keeps reporting the
   real language even when the oversize fallback is active; typing N characters
   triggers **one** tokenize, not N — counted by spying on the highlighter
   module's exports, since `resetHighlighterForTests()` (`highlighter.ts:262`)
   only clears the singleton and its caches and exposes no counter; reset
   through it between cases so each starts cold; **zero** tokenizes
   during render, asserted by re-rendering with an unchanged value while the
   debounce is pending; a file over 1500 lines renders plaintext in edit mode; a
   theme flip mid-edit repaints with zero re-tokenizes and leaves dirty state
   untouched; an async grammar upgrade that lands mid-typing leaves the
   textarea's value and selection unchanged; textarea and `<pre>` report
   identical computed `font`/`line-height`/`letter-spacing`/`tab-size`/
   `white-space` and identical left padding — the text-column offset
   (`px-4` + `w-10` = 56px at default density), **not** `px-4`, and **not** a
   hardcoded literal: assert the same equality again under
   `data-density="compact"`, where the correct answer is 49px. That second
   assertion is the one that catches a literal.
8. **Dirty-state guard, conflict UX, and snapshot recovery.** Confirm on
   navigation while dirty; `409` conflict leaves typed text in the editor with
   Reload / Copy my version. Add `getRunEdit()` in `api/client.ts` and the
   "restore this version" affordance that consumes `GET …/edits/:hash`,
   rendering "snapshot expired" on a `404` — without this the Phase 1 read
   route ships with no client and §Edge Cases' promise is unbacked. *Tests:*
   navigation blocked dirty and allowed clean; conflict preserves text;
   restore fetches the snapshot; an evicted snapshot renders the expired
   state.
9. **Docs.** `BACKWARD_COMPATIBILITY.md` §2 (both routes + the response
   fields + the `?meta=1` query param — §2 is where the route listing lives, `:21-32`) and §3 (the
   `file-edited` event and the `runs/<id>-edits/` snapshot directory);
   `.env.example` and the README env table (`README.md:360-376`) for
   `CEZ_NO_FILE_EDIT` (AGENTS.md `:18` makes an undocumented `CEZ_*` var a bug).
10. **E2E.** `web/app/e2e/`: browse → edit → save → the change appears in `GET
    /api/runs/:id/changes`, under `CEZ_DRY_RUN=1`.

### Phase 2 — divergence awareness

11. **Open-file hash watch.** Refetch the hash on the per-run SSE stream and on
    window focus while a file is open. **This needs a hash-only response
    shape** — the only route returning `hash` today returns it alongside up to
    `FILE_CONTENT_CAP` (512 000) bytes of `content`, and the SSE stream fires
    many events per second on a busy run. Add `?meta=1` to the `GET` (returns
    the `type: 'file'` envelope with `content` omitted) and debounce the
    stream-triggered refetch; polling the full-content route per event is not
    an acceptable implementation of this step. Note the Files tab does **not** subscribe
    today — `useRunFile` is a plain query with no stream invalidation
    (`queries.ts:155-163`), so this step wires `useRunEvents` into the tab
    rather than reusing an existing subscription. *Test:* banner appears when
    the on-disk hash diverges.
12. **Post-save overwrite warning.** Distinguish "changed before your save"
    (conflict) from "changed after your save" (overwritten), with the recovery
    pointer to the recorded edit. *Test:* the post-save case renders the
    overwrite wording, not the conflict wording.
13. **Session-timeline note.** Surface `file-edited` as a note in the thread so
    a human intervention is visible beside the agent's tool calls. *Test:* the
    event renders as a note.
