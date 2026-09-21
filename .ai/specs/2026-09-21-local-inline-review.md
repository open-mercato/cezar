# Local inline code review in task Changes

- Date: 2026-09-21
- Status: ready for implementation planning; architectural and independent scope reviews completed.
- Mode: interactive; product decision owner: Jakub Tobiasz.
- Source brief: [Local inline review handoff](briefs/2026-09-21-local-inline-review.md).
- Delivery: documentation only; no application implementation, push, or PR is included in this authoring task.
- Priority: medium. Risk: high because new persistent data and delivery paths touch protected API and lifecycle surfaces.

## 📝 TLDR

Add comments directly beneath new-side lines or ranges in task Changes. Reviewers can save and edit local drafts, explicitly submit them together to the same task, inspect agent fixes, and repeat before pushing. Keep submitted comments as read-only history with their original code context; label uncertain current matches outdated. The existing optional general-feedback gate and textarea remain unchanged.

## Confirmed decisions

Jakub confirmed the handoff and these answers on 2026-09-21. This section is self-contained; no unpublished product brief is required.

| Decision | Confirmed behavior |
|---|---|
| Existing feedback | Preserve its behavior and default-off setting. Inline review works independently of that gate. |
| Scope and placement | Task Changes only; comments directly in the diff. No repository-wide or GitHub PR comment authoring. |
| First version | Line/range comments and editable/deletable drafts; defer replies, resolve/reopen, and suggested edits. |
| Delivery | Collect comments and explicitly submit the batch to the same task. Adding or saving a comment never starts agent work. |
| History | Submitted comments remain read-only; later batches send only new drafts. |
| Success | Review a completed task, submit precise feedback, inspect fixes, then push—all within Cezar. No numerical CI-savings target. |
| Q1: availability | Include done, review, failed, cancelled, and paused waiting tasks. Exclude queued/running tasks, including monitoring. Capabilities may refuse delivery when no usable session exists. |
| Q2: persistence | Drafts, submitted comments, and original snippets survive navigation, restart, and worktree reclamation. New authoring requires available code. |
| Q3: outdated drafts | Permit submission with preserved original context and an explicit outdated label; do not require recreating the comment. |
| Q4: diff side | New side only, including visible unchanged new-side context. Removed-only lines cannot receive comments. A range belongs to one file. |
| Q5: task retention | Review data follows existing task-history limits: currently 300 unarchived and 500 archived tasks. Explicit task deletion and automatic task-record trimming remove it; worktree reclamation alone does not. This qualifies Q2's original “until explicit deletion” wording. |
| Q6: interrupted delivery | Show “Delivery uncertain” and require an explicit retry after inspection. Never automatically resend an uncertain batch. Ordinary HTTP retries reuse a durable identity. |

There are no unresolved product questions. Engineering choices below implement these decisions and remain subject to the repository's normal implementation review.

## 📝 Problem Statement

The current optional review panel in packages/web/src/routes/task-thread/review-panel.tsx sends a general textarea through Continue, prefixed with “Review feedback:”. Task Changes in packages/web/src/routes/task-git/task-changes.tsx offers structured diffs and git actions but no line-comment authoring. Reviewers can already give local feedback without pushing, but must assemble file paths and code references manually.

Jakub wants precise feedback beside the code and a complete local fix/re-review cycle. Reduced preparation effort is an untested product hypothesis; avoiding premature CI is motivation, not measured evidence. Validate the interaction with a representative multi-file review and inspect the actual agent prompt.

## 📝 Proposed Solution

Use the existing task diff and its new-side line numbers. A line-gutter action opens an inline editor; selecting a new-side range opens the same editor beneath its final line. Saved drafts accumulate locally. A “Submit review · N comments” action opens a compact preview of this batch and its delivery destination; confirmation dispatches it to the existing task. This control is the specification's proposed UI, not a previously confirmed discovery requirement.

Keep Changes open after submission. Display delivery state and a Session link. Agent activity temporarily disables authoring; when the task waits or finishes, reviewers inspect updated code and add the next draft batch. Submitted history remains inspectable even when no diff or worktree is available.

### Alternatives and research

| Reference, checked 2026-09-21 | Pattern retained | Complexity omitted |
|---|---|---|
| [GitLab review documentation](https://docs.gitlab.com/user/project/merge_requests/reviews/) | Draft comments accumulate before an explicit review submission. | Immediate individual publication, approvals, thread resolution, notifications. |
| [Gerrit review UI](https://gerrit-review.googlesource.com/Documentation/user-review-ui.html) | Inline editors, line/block selection, and a preview of pending comments before publishing. | Patch-set voting, reviewer identities, labels, and file-level discussion. |
| [GitHub review documentation](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request) | Line/range feedback and pending review submission as the requested interaction reference. | Remote PR mutation and suggested-edit application. |

These are pattern comparisons, not evidence of demand or savings. A side panel would shorten the diff but separates feedback from code; Jakub selected inline placement. Building nothing preserves the existing textarea but retains manual code referencing.

## 📝 Architecture

### Components and boundaries

| Area | Responsibility |
|---|---|
| packages/contract/src/run-reviews.ts, new | Zod schemas for every review request, response, stored record, and revision invalidation payload; types inferred with z.infer. Re-export through the contract and api-client. |
| packages/cezar/src/runs/review-store.ts, new | Per-task review files, optimistic revisions, atomic writes, attempt receipts, retention/deletion, and restart reconciliation. |
| packages/cezar/src/runs/review-anchors.ts, new | Capture validated new-side context and conservatively derive current placement. No browser types, agent delivery, or GitHub integration. |
| packages/cezar/src/runs/review-submission.ts, new | Freeze a batch, format bounded feedback, coordinate durable attempt states and manager delivery callbacks. |
| packages/cezar/src/workflows/run.ts | Narrow review-input admission using existing sendMessage/continueRun machinery; report the actual dispatch boundary and known pre-dispatch failures. |
| Server route family and validators | Authenticate/scope through existing guards, validate all inputs as middleware, return exact contract shapes. |
| Task Changes and new task-review components/hooks | Editors, selection, saved-state indicators, review preview, history, and conflict handling. |
| Shared Diff facade/renderer | Optional review decorations and semantic new-line callbacks. Existing consumers without review props retain their behavior. |

Keep one ReviewStore associated with each RunStore through its constructor, rather than adding a partially initialized field to ProjectContext or ActiveRun. All boot, lazy-project, continuation, and recovery paths share that existing owner. Lazily create storage on first write; a missing file means no review data, not a setup requirement.

ReviewStore owns review state, RunManager owns task/agent lifecycle, and routes coordinate through those interfaces. Do not import browser modules into the service or api-client runtime values into the published service. The contract remains Node-free and continues through the existing inline-contract packaging step.

### Reuse and invariants

- Resolve the working directory exactly as task Changes does, including tasks intentionally running in the repository root. A reclaimed/missing isolated worktree must not silently change review delivery to the repository root.
- Use collectChanges and resolveTaskDiffBase with both task branch and startedAt. Preserve freshest-base and repointed-branch semantics; do not invent a HEAD-only review baseline.
- Read source using readWorktreePath containment, .git exclusion, symlink, binary, and 512,000-byte text limits. New comment context cannot authorize reading arbitrary paths.
- Existing run records and /changes, /messages, /continue responses keep their shapes. No new configuration, CEZ flag, database, account model, or required migration.
- Authoring remains independent of provider authentication. Submission uses authoritative provider/session checks; an unavailable provider disables sending with a reason while leaving saved feedback readable.
- Finished-task submission keeps the task's recorded runner/account; v1 does not add a backend/account picker or silently switch identity. Existing Session controls remain available if the user intentionally changes provider.

### Task capability matrix

| Task condition | Read saved review | Create/edit/delete drafts | Submit or retry |
|---|---|---|---|
| waiting with open session | yes | yes with available source | sendMessage after final live-state checks |
| done/review/failed/cancelled | yes | yes with available source | Continue if a resumable session and usable provider exist |
| queued/running, including monitoring | yes | no | no; never queue a review implicitly |
| eligible status but unavailable source | yes | existing draft body edit/delete only; no new anchors | no; show why. User may restore/continue normally, then review again |
| no resumable session/provider | yes | yes with available source | no; retain feedback |
| task no longer exists | 404 | 404 | 404 |

Archived tasks keep the same status/capability rules. There is no new review gate, task status, slot-holding session, or automatic wake timer.

Recheck capabilities on the server after asynchronous source/provider checks and immediately before dispatch. A state change returns 409 with drafts intact. Reserve continuation admission synchronously across its first await so a double click or competing normal Continue cannot open two sessions. This reservation is released on every preflight rejection, cancellation, dispatch outcome, and exception; it must be respected by normal continuation admission without changing non-contending behavior.

## 📝 Data Model

### Storage

Use .ai/cezar/reviews/<runId>.json, outside worktrees and outside runs.json. Its versioned envelope contains {version:1, revision, drafts, batches, attempts}. IDs are UUIDs except legacy run IDs, which use the existing safe run-id schema. No new required RunRecord field.

Writes reload the latest file, verify expectedRevision, apply one mutation, and persist through a same-directory unique temporary file, file sync, atomic rename, and directory sync where supported. Directories use 0700 and files 0600. A successful response means the review state was saved; do not reuse RunStore's debounced, error-swallowing index save as this guarantee.

Serialize mutations by canonical data directory/run ID and use an exclusive per-run file lease for competing server processes. Follow the existing local file-lease pattern, but never steal a live process's lease merely because it is old. Publish complete owner metadata atomically (prepared owner file plus exclusive hard-link acquisition), release only the matching token, and reclaim a confirmed dead owner's lease. Ambiguous ownership returns a retryable 409, not a boot failure. Read-modify-write revision checks run inside the lease; filesystem failures never dispatch an agent.

Old/future or corrupt review files are preserved. Unsupported schema versions make review writes unavailable; corruption is reported rather than silently replaced with an empty file. The rest of Cezar boots and works. Clean only known temporary/lease files and records belonging to confirmed deleted tasks; an unavailable/corrupt runs index is not evidence that every review is orphaned.

### Entities

| Entity | Fields and meaning |
|---|---|
| Comment | id, originalCreateHash, body, createdAt, updatedAt, anchor; editable copies live in drafts, frozen copies in their batch. Original create identity remains stable through edits for request replay. |
| Anchor | originalPath, side:'new', startLine/endLine inclusive, selectedLineCount, baseOid, headOid, fileHash, patchHash, selectionHash, before/after context hashes and line counts, original selected lines and up to three context lines each side, redacted flag. All original values are immutable. |
| Batch | id (client-generated submission identity), immutable comment snapshots in stable path/range/id order, exact frozen prompt, promptHash, createdAt. The first accepted request permanently binds the ID to this content. |
| Attempt | id, batchId, retryOf optional, state, timestamps, optional synthetic stepId, and one bounded human-readable error. States: preparing, dispatching, submitted, failed-before-delivery, uncertain, acknowledged. |
| Derived placement | current path/range or none; context is current or outdated; placement is inline or outside-diff; reason identifies missing source, ambiguous match, changed selection, branch change, or content absent from the current diff. Never overwrite the original anchor. |

A batch freeze atomically moves its drafts into immutable batch snapshots. A failed-before-delivery attempt restores editable copies to drafts, retaining immutable snapshots of what failed; later edits cannot rewrite that failed attempt's evidence. Submitted, uncertain, and acknowledged attempts retain frozen history. Create-ID replay checks both current drafts and frozen snapshots, returning the current view of the original creation instead of duplicating it. An explicit retry of an uncertain attempt creates a new attempt for the same frozen batch; it is not a new draft batch. Only one attempt per task may be preparing/dispatching, and an unresolved uncertain attempt must be retried or acknowledged before another batch is sent.

The “Keep as sent” action acknowledges an uncertain batch without claiming delivery was proven. It records the user's choice, leaves read-only history, releases the uncertainty hold, and performs no agent action. Inspecting Session alone does not resolve uncertainty.

### Bounds

Initial internal constants, not settings: 50 draft comments per task; 100 lines per range; 4,000 characters per comment; 20,000 characters of selected source per anchor; up to three bounded context lines on each side. Reject an oversized anchor rather than silently cut its selected source. The exact serialized batch prompt must fit the existing 100,000-character message limit, including all paths, labels, snippets, and framing. Show limits before submission; never silently drop comments.

Limit each review file to 16 MiB and refuse further growth without discarding saved history. Keep room within that limit for completion/recovery receipts for already admitted attempts, so reaching the cap cannot strand an in-flight submission. History is paged, newest first, 20 batches by default and at most 50. GET review returns bounded drafts and counts, not the entire history. These limits bound the new read/write and prompt costs without altering task-history limits.

### Source privacy and compatibility

Apply the existing secret-redaction utility to persisted and returned comment text, snippets, prompts, and errors, using the same configured secret values as RunStore. The server returns the saved canonical text and a redacted indicator; show “Sensitive text redacted” when it differs. Full raw source is read only through the existing bounded source path, not copied into review files. Matching hashes are calculated from the exact unredacted source in memory; stored text is never used to defeat redaction. No custom encryption or external synchronization.

Add reviews/ to ensureDataGitignore in the same implementation commit. Review data remains local to the Cezar server's project data directory (including hosted Cezar); “local” does not mean separate data per browser. Concurrent tabs share drafts and use revision conflicts, without introducing user accounts or authorship claims.

## 📝 API Contracts

All schemas below live in packages/contract. Register as one chained project-route family mounted at /api/v1/runs/... and /api/v1/p/:projectId/runs/... with existing alias parity. Validate path, body, and query using the existing middleware trio. Reuse the contract's run-id schema; validate UUID comment/batch/attempt IDs. Unknown task is 404; predictable refusal/conflict is 409 {error}; invalid input is 400 {error}. I/O failures use the repository's error mapping and never answer success.

Let R mean /runs/:id/review under those mounts.

| Route | Validated input | Success |
|---|---|---|
| GET R | none | 200 ReviewState: revision, capabilities with refusal reasons, draft comment views, pending/uncertain attempt summaries, historyCount |
| GET R/history | optional opaque cursor and limit 1–50 | 200 {revision, items: BatchView[], nextCursor?}; immutable originals plus current placement when available |
| GET R/context | path, expectedPatchHash | 200 ReviewContext: path, baseOid, headOid, fileHash, patchHash, bounded full new-side content; 409 if the displayed patch/source is stale or unavailable |
| POST R/comments | expectedRevision, commentId, context identity, startLine/endLine, body | 201 {revision, comment}; same ID and same original create content replays without duplication; reused ID with different content is 409 |
| PATCH R/comments/:commentId | expectedRevision, body | 200 {revision, comment}; anchor stays immutable |
| DELETE R/comments/:commentId | expectedRevision in query | 200 {revision, deleted:true}; only an editable draft |
| POST R/submissions | expectedRevision, batchId, ordered non-empty draft IDs | 202 {revision, batch, attempt}; freeze exactly those drafts. IDs must equal the complete current non-empty draft set shown in preview |
| GET R/submissions/:batchId | none | 200 {revision, batch, attempts, commentViews}; authoritative retry/recovery status |
| POST R/submissions/:batchId/retry | expectedRevision, attemptId, retryOf, acknowledgePossibleDuplicate:true | 202 {revision, batch, attempt}; only a latest uncertain attempt, after rechecking task/provider/source |
| POST R/submissions/:batchId/acknowledge | expectedRevision, attemptId | 200 {revision, batch, attempt}; uncertain → acknowledged, no dispatch |

A replayed submission/attempt ID is looked up before revision/capability rejection: return its current persisted receipt even if the task is now running. Compare its bound request identity; never dispatch twice or silently bind a key to changed feedback. This also holds after a browser reload/server restart. New requests with stale revision return 409 and leave the server state untouched.

No inline source, comment text, or prompt rides on a live notification. New view-scoped WebSocket topic run-review:<projectId>:<runId> carries only {revision}; publisher/listener ownership follows the existing 0→1 / 1→0 subscription contract. Subscribe once from the mounted Changes review controller and return the unsubscribe. Local clients invalidate only existing review queries on that signal.

Remote mode opens no WebSocket: add a revision-only run-review event {project, id, revision} to the existing authenticated workspace SSE channel and its contract schema. The same persisted-review change source feeds this metadata event; attach/detach its listener alongside the existing per-project store listeners. Remote clients invalidate mounted review queries on this event even when a preflight failure changes no task status; local clients use their view-scoped WebSocket topic and ignore the duplicate SSE review signal. HTTP mount/focus and SSE reconnect reconciliation remain the fallback. No polling loop or additional EventSource is introduced. Mutation responses update the initiating view immediately. Reuse project-scoped query keys and never populate another project's review cache.

### Context capture and anchoring

1. The client hashes the displayed file patch as UTF-8 SHA-256 and requests R/context when authoring begins. The service recollects that task's changes with the canonical diff base, verifies membership and patchHash, and reads its bounded new-side file.
2. Capture base/head IDs and source hashes consistently: bracket collection/read with identity checks, and refuse/reload on a detected change. No Git checkout, fetch, index mutation in the user's real checkout, or reconstruction of a missing worktree is permitted by this read.
3. The client compares the selected visible new-side lines with the returned content before opening an editor. Creation supplies its context identity; the server rereads/revalidates it, derives the snippet itself, and rejects stale content with 409. It never trusts a client-provided source snippet.
   Use one exact line convention across renderer and service: LF-delimited, 1-based lines, preserving CR characters and final-newline identity in source hashes. Do not normalize whitespace to force a match; include CRLF and no-final-newline fixtures.
4. A range can include expanded unchanged context, but all selected new-side lines must be materialized, consecutive, and from one file. A unified-view selection can visually span interleaved deletion rows; those rows contribute no lines to the new-side range. Endpoints cannot be removed-only rows, and a range cannot cross a collapsed gap. Truncated tails, metadata lines, binaries, and deleted-only files have no comment action.
5. Original path plus unchanged fileHash permits the original range. Otherwise search the same file for the exact selected-line hash and captured surrounding context hashes; attach only if precisely one match exists. A changed selected line or ambiguous/missing match is outdated. Line offsets, whitespace-insensitive matching, and “closest match” are insufficient.
6. Follow a renamed path only with an unambiguous rename association in current task-change evidence and matching content/context. No fuzzy repository-wide search. An unrelated branch checkout invalidates placement conservatively; unchanged content omitted from today's diff appears under “Comments outside the current diff” with its original snippet, not a fabricated inline row.
7. Derive placement fresh for read/preview/submission. Preserve frozen submission-time labels inside the prompt/history even if later placement changes. This is evidence of what was sent, not a claim about whether feedback was fixed.

## 📝 Submission and Recovery

### Durable admission and dispatch

The delivery receipt is authoritative; an NDJSON user-message is not proof of delivery. Today deliverMessage appends the user-message before session.sendMessage returns, and continueRun returns before asynchronous startup reaches the backend. Do not infer submitted from either of those facts.

1. Under the per-run mutation lease, look up the idempotency key, check revision and exact draft set, then validate task/provider/source and aggregate prompt limits.
2. Freeze the chosen comments, their source labels, and prompt into a batch. Atomically persist preparing before scheduling any agent work. Return 202 with the saved receipt; the mounted view reads its evolving state.
3. ReviewSubmission coordinates a narrow manager input-admission guard. A waiting task uses its live sendMessage path; a finished task uses Continue with the same runner/account. Both retain existing permissions, tool grants, skills expansion, resource/slot accounting, and lifecycle behavior.
4. Before the actual live sendMessage or runner.startSession call, atomically persist dispatching. If this write fails, do not call the backend. The waiting boundary is synchronous; continuation reports this boundary after asynchronous preflight through an internal callback/context, not through a backend-specific API.
5. A known refusal before crossing that boundary records failed-before-delivery and unlocks drafts. After dispatch begins, exceptions without definite refusal are uncertain. A live send accepted by the existing session contract or a successfully handed-off startSession records submitted; that means handed to the runner, not that the agent finished or fixed the comments.
6. Preserve task failure normally if provider work later fails; submitted feedback stays in history and is never auto-sent again. For a continuation failure demonstrably before startSession, mark failed-before-delivery, even though Continue originally accepted the request.
7. A crash before the final receipt leaves dispatching, which becomes uncertain at recovery. A preparing attempt is safely failed-before-delivery only because dispatch cannot begin without the durable transition. An outcome-persistence failure after dispatch is uncertain; do not fabricate a successful final receipt.

Carry the review attempt identity through the synthetic continuation step/admission metadata using optional, additive schema fields. Enumerate all RunManager construction/recovery/continuation sites and ensure that both streaming and non-streaming lifecycle paths report the necessary outcome. Existing non-review operations omit the fields and keep their behavior.

For an already admitted continuation, source identity is checked again immediately before backend dispatch. A reclaimed/missing worktree, changed HEAD/branch, or conflicting resume is a known pre-dispatch failure. Review delivery never uses runContinuation's ordinary repo-root fallback for a missing task worktree; existing non-review Continue keeps that fallback.

### State transitions and exits

| Attempt state | Exit and trigger |
|---|---|
| preparing | Coordinator completes preflight → dispatching; known rejection/cancel/restart before dispatch → failed-before-delivery. It never holds a run slot indefinitely. |
| dispatching | Runner handoff → submitted; definite refusal → failed-before-delivery; crash or ambiguous exception/persistence failure → uncertain. |
| failed-before-delivery | Terminal receipt. Comments return to drafts; the user may edit and submit a new batch ID. Replaying the old ID returns failure, not a new attempt. |
| uncertain | User inspects then acknowledges → acknowledged, or explicitly retries → a linked new preparing attempt. No timer or restart may retry it. |
| submitted / acknowledged | Terminal read-only history until its task is deleted/trimmed. New feedback starts a new batch. |

Use a bounded pre-dispatch timeout (30 seconds) around review-only asynchronous preflight; expiration before dispatch is a known failure. Cancellation of preparation must fence the callback so a late completion cannot still dispatch. A live receipt owner is not mistaken for a crashed owner by a second process or an HTTP reader.

On startup, reconcile review attempts before ordinary RunManager recovery in both boot and lazy project contexts. For unresolved dispatching attempts, stop that task's automatic restart continuation and usage-limit auto-resume: leave it in the existing failed status with “Review delivery uncertain; inspect the session”, with no active session/slot/timer owned by the new process. Do not reset the batch or resend it. Other tasks—and tasks with durably submitted receipts—keep ordinary recovery unchanged.

An explicit uncertain retry snapshots a new attempt ID, retains the original batch/prompt, records duplicate-risk acknowledgment, and uses the same capability checks. Permit only the latest uncertain attempt to retry. The UI offers “Keep as sent” to finish inspection without resending; neither action implies resolution of the code concern.

### Agent prompt

Render deterministic plain text starting “Local code review feedback” so an individual comment cannot become a top-level slash command. Include the batch ID and creation time, task-relative path, original new-side range, original revision identifiers, source snippet, body, and context status at batch creation for each comment. State that all source/context labels describe the original submission snapshot, including on an explicit retry, and ask the agent to inspect current code before changing it. Attempt identities live in receipts/step metadata so retrying can send the exact frozen prompt without embedding a stale attempt ID. Treat quoted source as data; comments are the reviewer's instructions. Escape delimiters or use length-delimited sections so source backticks cannot corrupt framing.

Do not reinterpret comments as approvals, shell commands, structured suggestions, or task-control markers. No push/PR action occurs as a side effect of review submission. Include only new drafts or the exact frozen batch explicitly retried after uncertainty.

## 📝 UI/UX

### Authoring and saved state

- On eligible text rows, show an accessible “Add comment on line N” gutter button on hover and keyboard focus. Unified mode uses newLine; split mode places the action on the right. Selection never hijacks ordinary code copying.
- A click selects one line; Shift+click extends within that file's materialized new-side lines. Provide keyboard-operable start/end controls so range authoring does not depend on dragging or holding Shift.
- Insert the editor beneath the range's last line. Keep input state in the task-review controller, not a virtualized row. Focus must not disappear when another file unmounts; pin the active editor or retain and restore its focus through the facade.
- Autosave a newly created draft and body edits, with visible Saving/Saved/Save failed states. Debounce edits by 500 ms and flush on blur/internal navigation; do not leave the page with an unsaved buffer without warning. Only server-acknowledged content is promised durable after forced browser termination.
- A failed save retains the typed buffer and retry action; never render it as Saved. Revision conflict refetches the server value and lets the user keep their text or accept the newer copy rather than silently overwriting either.
- The non-empty draft count drives submission. Empty editor drafts are saved but excluded from the batch; the preview says so. New drafts after a frozen batch are independent.
- If work starts while typing, preserve the buffer, freeze editing, and explain “Review resumes when the task pauses or finishes.” Recheck eligibility before any resumed save.

### Submission and history

The preview lists file/range, body, preserved source, outdated badges, and destination task. Primary action is “Send N comments to agent”. Source/payload limit failures keep the preview open with an actionable reason. No general-summary field is added; the existing general textarea remains separate.

Preparing/dispatching show “Sending review…”; failed-before-delivery returns comments to drafts with an error; submitted shows a sent timestamp. Uncertain shows “Delivery uncertain” with Inspect session, Retry sending (duplicate-risk confirmation), and Keep as sent. Retry buttons generate their operation identity before the request and reuse it on network retry.

Render history inline where placement is safe, collapsed by default after submission, with a Review history list for navigation. Comments whose code is outside the current diff or unavailable remain in a section within Changes using saved snippets and original paths; a missing/empty diff must not replace the entire page with an empty state that hides review history.

While the agent works, keep saved comments readable and show a Session link. Retain history when changes are no longer visible after a commit/base update. Outdated is a context label only—there is no resolved/fixed checkbox.

Retain responsive unified/wrap behavior on phones and existing split/unified toggles on desktop. Keyboard focus, accessible names, error announcements, contrast, and wrapping apply to comments as to code. The plain-text diff fallback must either support safe new-line controls through the shared parser or clearly disable new authoring while keeping drafts/history accessible; it must not offer buttons with guessed line numbers.

## 📝 Edge Cases & Failure Scenarios

| Situation | Required behavior |
|---|---|
| External edit after context fetch | Creation returns 409; retain typed text, refresh source, ask user to select current lines. Existing outdated drafts remain sendable. |
| Repeated code or changed adjacent context | Conservative outdated label; never attach merely by matching line number. |
| Rename, deletion, base refresh, repointed HEAD | Preserve original evidence; attach only under the anchor rules, otherwise show outside-diff/outdated. |
| Binary, large file, truncated tail, removed-only row | No new-line comment action; existing saved feedback remains accessible. |
| Reclaimed worktree | Read drafts/history; no new anchors or implicit restoration. Sending waits for available source; normal Continue may restore the worktree through its existing flow. |
| Browser reload, lost POST response | Read state/receipt and reuse IDs; no duplicate comment or agent delivery. |
| Agent unavailable or preflight fails | Keep/restore drafts; no claimed delivery, no hidden backend switch. |
| Crash around dispatch | Durable boundary distinguishes safe failure from uncertainty; never auto-resend the latter. |
| Disk full/read-only directory/corrupt file | Review writes unavailable with a reason; code and saved readable data remain; never dispatch without durable admission. |
| Two tabs edit or submit together | Expected revision and exclusive mutation lease choose one winner; loser preserves its buffer and refetches. |
| Task deleted or trimmed during preparation | Fence/cancel pending dispatch, remove review data with task cleanup; late callbacks may not recreate it. An already dispatched task follows existing cancellation/deletion rules. |
| Multiple Cezar processes | Disk receipt lookup/revision under lease prevents same-key replay dispatch; fail busy rather than overwrite another live writer. Do not claim this fixes unrelated cross-process run scheduling. |
| Late provider error after handoff | Existing task error stays visible; review remains submitted history, not silently restored and resent. |
| Remote browser / offline UI | No browser WebSocket in remote mode; revision-only workspace SSE updates every attempt transition, retained input + honest save failure, then HTTP/SSE reconciliation and revision checks. |

## 📝 Risks & Impact Review

### Load-bearing behavior and retention

The current task-history caps bound in-memory/index/history growth; leave them intact. Worktree retention bounds disk usage; comments do not pin worktrees. Review data follows actual task-record lifetime, not whether its code directory exists.

Integrate review cleanup at both RunStore.deleteRun and pruneOldRuns. Do not rely solely on the deleted event: pruneOldRuns currently removes records/artifacts directly. Cleanup is idempotent and limited to the exact run ID, including known lease/temp files, with pending-dispatch fencing. On subsequent boot, confirmed orphan review data left by an older version can be cleaned without affecting extant tasks.

Current restart recovery is load-bearing for unrelated interrupted tasks. Only uncertain review dispatch suppresses automatic continuation; it yields a visible failed task and user action rather than an unbounded monitoring/active state. All other recovery remains unchanged.

### Migration and rollback

No required data migration and no rewrite of old runs. Missing review files produce empty state. Optional continuation/step metadata must parse with old records and be populated in every relevant construction path; no endpoint changes its existing response contract.

Older Cezar versions ignore the new review files, so an ordinary downgrade hides this UI while preserving files that the older version does not know to delete. Re-upgrade reads version 1 data and reconciles receipts before allowing dispatch. Never silently downgrade an unknown review schema or infer an uncertain batch was sent.

An old binary cannot honor the new uncertain-delivery recovery guard. Therefore rollback with preparing/dispatching/uncertain receipts requires stopping the server and settling or explicitly acknowledging those attempts in the newer version first; document this operational limit, do not promise safe automatic recovery across that downgrade. Reverting the feature must retain readable review files until an explicit cleanup decision.

### Security, exposure, and validation

Keep loopback/same-origin guards and existing remote authentication behavior. Add no CORS expansion, outbound network dependency, remote comment synchronization, or telemetry. Scope every read/write and notification by project and task; validate filenames before filesystem access. Source and comment content is inert display text with existing safe Markdown conventions, no raw HTML execution.

Spec validation needs real-browser evidence because inline layout and virtualization can pass unit tests while losing focus or hiding comments. Repository validation remains typecheck, npm test, test:unit, build, and test:package; UI integration/QA is an additional gate. Regression tests for existing mechanisms must be shown failing without the implementation fix, with source-only reversal in an isolated checkout rather than disturbing unrelated work.

### Architectural review

No unresolved Critical or High findings. The fresh-context scope reviewer received only this spec path and found one independently deployable local review capability; storage, anchoring, delivery, recovery, and reconciliation support the same end-to-end job. No split is warranted.

Author review corrected two design gaps: batches now retain immutable comment snapshots when failed feedback returns to drafts, and revision-only workspace SSE covers remote submission outcomes even when no task-status event fires. Evidence for the review is architectural, not a claim that unimplemented code or tests already pass.

| Criterion | Verdict and rationale |
|---|---|
| Architectural diff | Pass: focuses on anchors, durable delivery, lifetime, and inline UI; existing framework boilerplate is referenced. |
| Scope cohesion | Pass: independent reviewer found one capability; exclusions stay explicit. |
| Canonical mechanisms | Pass: existing diff/base resolver, source reader, lifecycle/provider guards, contract middleware, WS bus and SSE are reused. |
| Contracts and compatibility | Pass at design level: additive review resources/state; old endpoints unchanged; downgrade limitation and retention covered. |
| Reversibility | Pass: drafts edit/delete; known failures restore drafts; uncertain retry is explicit; acknowledge and downgrade paths are defined. |
| Boundaries and coupling | Pass: storage, anchor derivation, orchestration, lifecycle, and UI have named responsibilities; no backend-specific protocol leaks. |
| Sensitive data | Pass: existing redaction, protected local files, project scoping, and content-free live notifications. |
| Failure scenarios | Pass: state exits, bounded preflight, crash windows, provider/source/storage failures, and cross-tab races are specified. |
| Testability | Pass: each implementation step names observable fixtures or checks; actual implementation validation remains future work. |

## 📋 Phasing

This is one independently deployable capability. Internal phases are implementation checkpoints, not separate user-facing products.

1. Contract, storage, and anchored drafts behind additive endpoints; the existing cockpit continues working.
2. Durable batch delivery and recovery using existing task lifecycle, still without replacing any current review flow.
3. Task Changes authoring, preview, history, and live reconciliation, with accessibility and regression coverage.
4. End-to-end verification, compatibility documentation, and release readiness.

No configuration flag is introduced to make a partial replacement ship off by default. The existing mechanism stays intact through every phase.

## 📋 Implementation Plan

### Phase 1 — Durable review data

**Step 1.1 — Contract and fixtures.** Define all wire/store schemas and inferred types in the contract, including new-side-only anchors, attempt states, and bounds. Re-export through api-client. Verify invalid ranges/paths/IDs and node-free compilation; no existing contract widens to fit implementation drift.

**Step 1.2 — Atomic store and lifetime.** Implement revisioned per-run files, durable failure-aware writes, lease ownership, and capacity accounting. Wire constructor ownership, both deletion paths, and ignore maintenance. Verify create/restart/load, cross-tab/process CAS, disk failures, corrupt/future schemas, task trimming versus worktree reclamation, and no silent eviction at the size cap.

**Step 1.3 — Source context and placement.** Implement bounded context capture and conservative matching over the canonical task diff. Fixtures cover new/context lines, ranges across visually interleaved deletion rows, expanded gaps, repeated snippets, edits, renames, missing files, branch/base changes, and truncated content. Cross-check source changes between read and save; preserve original redacted evidence.

**Step 1.4 — Draft/history APIs.** Chain routes with body/path/query middleware and exact contract responses. Add typed-bodies, bidirectional contract parity, scoped/unscoped/default-alias parity, versioned-surface, and backward-compatibility route inventory coverage. Exercise project isolation and idempotent comment creation.

### Phase 2 — Safe agent delivery

**Step 2.1 — Batch freeze and preview formatting.** Freeze the complete current non-empty draft set, deterministic source labels, bounded canonical prompt, and request identity. Verify stale revisions, oversized prompts, delimiter-containing code, empty drafts, and immutable history.

**Step 2.2 — Manager admission and dispatch boundaries.** Route paused versus finished tasks through their existing delivery mechanisms, with synchronous continuation reservation and review-only before-dispatch/outcome hooks. Verify one invocation under double-submit/normal-Continue races, source disappearance, provider failure, same runner/account, skills/tool grants, and release on every exit. Cover all continuation construction sites and both event-handler variants.

**Step 2.3 — Receipts, recovery, and manual retry.** Implement preparing/dispatching/submitted/failure/uncertain/acknowledged transitions. Inject a crash or write failure at every boundary; prove same-key retry never dispatches again, uncertain restart does not invoke auto-resume, and a new explicitly acknowledged retry invokes exactly one additional attempt. Run equivalent tests in boot and lazy project recovery; ordinary interrupted tasks still resume.

### Phase 3 — Task Changes integration

**Step 3.1 — Optional Diff review seam.** Add new-side selection/decorations to the existing facade and renderer without changing non-review callers. Verify unified/split, wrap, keyboard ranges, mobile, virtualization/focus, and fallback. Removed rows and invalid ranges expose no authoring control.

**Step 3.2 — Persistent draft controller.** Add scoped queries, autosave, revision-conflict recovery, retained buffers, and saved/error states. Verify navigation/reload, task-state races, multi-tab editing, and source refresh without silently moving an editor.

**Step 3.3 — Submit preview and history.** Add batch preview, send status, read-only inline/history displays, outdated original-context feedback, uncertain inspection/retry/acknowledgment, and capability reasons. Verify only new drafts are submitted and empty/missing diffs do not hide saved review data.

**Step 3.4 — Demand-scoped updates.** Add revision-only local WebSocket subscription with proper unsubscribe and no background publisher after view unmount. Wire the metadata-only workspace SSE event for remote review transitions and HTTP/reconnect reconciliation without opening a browser WebSocket. Assert project/cache isolation, no polling, listener disposal, and receipt updates after a preflight refusal with no accompanying task event.

### Phase 4 — Verify and document

**Step 4.1 — End-to-end acceptance.** In a real browser and dry-run fixture, review a multi-file task with the general-feedback gate off, add a single-line and new-side range comment, edit/delete a draft, navigate/restart, submit once, inspect the exact received batch, modify code, inspect outdated history, and send only the next batch. Repeat for waiting and finished tasks; demonstrate removed-side authoring is unavailable. Capture desktop unified/split and narrow-screen evidence. No remote push is needed to validate review itself.

**Step 4.2 — Failure and compatibility gate.** Exercise reclaimed worktrees, task-history trimming, missing providers, two tabs, lost HTTP responses, interrupted dispatch, manual uncertain retry, disk failure, and existing general-feedback behavior. Confirm no auto-merge/push, no slot/timer leaks, no fallback delivery in the wrong directory, and unchanged default behavior on tasks without review data.

**Step 4.3 — Packaging and release readiness.** Update BACKWARD_COMPATIBILITY route/state inventory and README workflow documentation; document retention and the unsettled-receipt downgrade limitation. Verify the new contract values are included by existing inlining. Run the configured validation commands in order and the browser QA gate; carry this spec and its source brief together into the eventual documentation/implementation change. No CEZ variable changes are planned.
