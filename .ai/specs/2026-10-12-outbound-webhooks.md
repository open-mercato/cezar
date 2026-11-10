# Outbound webhooks — task notifications beyond the cockpit

Technical specification for project-scoped outbound task notifications. Provider-specific
contracts: [Slack](2026-10-19-slack-webhook-receivers.md) and
[Discord](2026-10-19-discord-webhook-receivers.md).
Setup and operating limits: [receiver guide](../../packages/cezar/docs/webhooks.md).

## Overview

Per-project, opt-in outbound notifications for attention, review, success, failure and cancellation:
signed JSON to custom receivers, or native Slack/Discord channel messages. User-owned automation
workflows can handle further downstream actions. Minimal is the default profile. Delivery controls include Replay, Retry now, Suspended with automatic recovery, Custom event selection,
task scopes, configurable grace, delivery filters, the project summary card and project SSE.
A project-local outbox captures observations without putting webhook records in agent transcripts.
One process owns each project's webhook service; task execution never depends on webhook health.

## Problem statement and business value

Send a signed JSON event or Slack/Discord message when a task needs attention, is ready for review, finishes, fails, or
is cancelled. The strongest use case is a developer running several long tasks who leaves the
cockpit and wants to know when to return. Existing browser notifications
(Settings → Notifications) fire only while a cockpit tab is open in the background; they do not
reach a closed tab, a phone or a team’s backend. Notifications are one-way; on a local installation they
do not let the developer answer or resume a task from a phone. The computer and cezar server must
be running to send anything.

Users can connect a Slack Incoming Webhook or Discord channel Webhook
URL directly, or send signed JSON to their own endpoint/automation workflow such as Make or n8n.
The [receiver guide](../../packages/cezar/docs/webhooks.md) documents setup and the receiver contract.
Native destinations need no cezar bot, OAuth flow or relay; Slack setup still requires the user
to install an Incoming Webhook app. Notifications remain one-way, with no replies or approvals
from chat and no guarantee that a phone displays them.

| Audience / scenario | Shipped benefit | Limit / validation |
|---|---|---|
| Developer away from the cockpit | Direct Slack/Discord notification about a question, review, completion or failure, or forwarding through an automation workflow | Requires a channel webhook or custom receiver; no local cockpit link; push delivery depends on the target app |
| Reviewer tracking several projects | Independently configured review notifications in each project | No shared receiver or cross-project routing; each project chooses its own channel |
| Team with n8n/Make/backend | Structured events with optional issue/PR correlation | External integration owns tracker permissions and status mapping; `finished` does not authorize closing a ticket |
| Operations / audit consumer | Bounded retry and inspectable delivery results | Neither a lossless audit ledger nor a deployment/merge signal |

Notifications do not provide an external job portal, assignee routing, dispatch-tree completion,
or automatic ticket closure. They contain no tracking pixels or read receipts.

The graph-workflow `notify.webhook` node is separately enabled by `CEZ_WORKFLOW_WEBHOOKS=1`.
It sends when a workflow reaches that node. Lifecycle subscriptions use `CEZ_WEBHOOKS` and
send independently of workflow structure, with signing, durable delivery and receiver history.
The two mechanisms share no receiver configuration, delivery IDs, retries or deduplication.
A workflow using both can produce two independent notifications.

## Non-goals

No inbound webhooks, challenge–response, dispatch-tree question correlation, chat replies, bots, cezar-managed OAuth or relay, global receivers, tenant RBAC,
automatic merge/deploy/ticket closure, or lossless audit ledger. No lifecycle scheduling rewrite.
No CLI command or agent skill for managing webhooks. The HTTP API remains callable by same-user
processes; omitting a CLI is not an access-control mechanism.

## Project ownership and isolation

Each receiver belongs to exactly one project. Project Settings → Webhooks owns configuration,
activation, signing keys, queue, delivery history, activity and health. There is no project
selector, wildcard subscription, global receiver registry or global webhook overview in feature.
Creating a project never enrolls it into another project's integration. Using the same receiver
URL in two projects requires two independent receiver records and activations. Signing keys are
independently generated per receiver, never shared or inherited.

All lookups resolve the current project context before endpoint, task, event or delivery IDs.
Filters, retries, replay, counts, logs and SSE must remain in that context. Copies, forks, task
worktrees and exports do not copy webhook state or credentials. A project cannot select another
project through a body field, query parameter, stored path, tree parent or backend fallback.
Cross-project task relationships confer no webhook visibility or sending rights; foreign task
IDs, questions, counts and titles are omitted from this project's payload.

This is application data separation, not a claim of regulatory compliance or process isolation.
Agents and services running as the same OS user with unrestricted shell can still read accessible
files. Stronger boundaries require separately permissioned users/containers/volumes and controlled
network egress. Existing workspace-wide APIs and authentication are not turned into tenant RBAC
by this feature. Project-qualified URLs alone are not authorization; deployment access controls
must cover canonical routes, boot aliases and event streams alike. No new authorization scheme
is implied or introduced by this specification.

Agents receive `CEZ_API_URL` through dispatch and can call the local API without an Origin header.
They can create, activate, edit and rotate receivers and read accessible project secrets. Existing
Bash already permits outbound traffic; the added risk is persistence across later tasks under a
cezar signing key. Activation and banner acknowledgement are consent UX, not proof of a human.
A signature proves key possession, not that cezar observed the claimed event. In hosted mode,
a local process can also reach loopback and bypass reverse-proxy authentication.
Host-local authentication is outside the webhook access boundary.

Every create, activation, edit, rotation, deletion and test writes masked Activity and updates a
persistent project-level “Webhook configuration changed” notice. Show receiver name, masked host,
change/time and reported source, with Pause, Delete and View activity (where applicable). Keep it
until acknowledged; a later change reopens it. Source labels and acknowledgements are spoofable
by the same user, so never describe this as prevention or a human-only security gate.

The implementation shares code, not receiver data: formatter/signing/transport helpers accept
an explicitly scoped project service. Optional process-wide protection stores only transient
host concurrency/cooldown counters, never project payloads, receiver URLs, secrets or history.
A slow/full/broken project queue cannot take another project's quota or suspend its receivers.
No webhook payload or secret is persisted under `~/.cezar`.

## Architecture and integration

Webhooks use the four-workspace architecture; no database, daemon, relay or public ingress is needed.
The service owns filesystem/network code; `packages/contract` owns Node-free Zod definitions.
The service never imports `api-client` at runtime. The pure attention predicate lives in
the contract; UI labels, colors, pulses and `deriveAttention` rendering live in the web package.

| Integration point | Responsibility |
|---|---|
| `packages/cezar/src/runs/store.ts`: `updateRun`, `setArchived`, `archiveFinished`, `reconcileLoadedRun`, `deleteRun`, `pruneOldRuns`, `touch` | One before/after observer covers all these paths. `appendFileSync` is not an fsync/transaction guarantee. |
| `packages/web/src/lib/read-state.ts`, `routes/task-thread/task-thread.tsx` | Unread receipts cover done/failed, not waiting/review. Do not repurpose `seenAt`. |
| `packages/cezar/src/workflows/run.ts`: `dropActive`, `scheduleAutoResumeIfLimited`, `armAutoResume`, `settleSuccess` | Resume scheduling happens after failed; autonomous runs can finish with changes and no review. |
| `packages/cezar/src/server/project-context.ts` | Projects are lazy. Lightweight webhook startup must not instantiate managers or resume tasks in unopened projects. |
| `packages/cezar/src/automations/store.ts`, `server-install/state.ts` | Local file-lock patterns exist; webhook ownership requires PID-reuse-safe identity and a single writer. |
| `packages/cezar/src/server-install/state.ts`, `paths.ts` | Multiple installer records exist; never assume the default record describes the running server. |
| `packages/web/src/routes/settings/registry.tsx`, `packages/cezar/src/server/server.ts` | Project settings and project-scoped SSE keep receiver state out of global broadcasts. |

Headless `cezar run` neither captures webhook source events nor sends them. Its normal lifecycle
logging is unaffected. Webhook source capture is enabled explicitly by server-owned store
construction, including boot, lazy project and recovery construction paths. A later server must
not backfill headless lifecycle records into webhook notifications.

## Event semantics

`sequence` is an increasing counter within one project installation's outbox (gaps allowed),
not a run-log `seq` or a global order. Persist its high-water mark; after a crash recover the
maximum from outbox/admissions before allocating another number. Consumers scope ordering to
`source.instanceId`; stable event `id` remains the deduplication key. Out-of-order delivery does
not authorize dropping distinct audit events.

| Event | Trigger / snapshot | Default preset |
|---|---|---|
| `task.attention_required` | New waiting episode; `reason: question` if there is a current structured ask, else `turn_end` | Yes, with grace |
| `task.review_ready` | New review episode; optional verified diff/check summaries | Yes, with grace |
| `task.finished` | Entry into done with explicit completion reason | Yes for root tasks |
| `task.failed` | Entry into failed, sent after a short grace with the auto-resume state read at send time (`manual` or `scheduled`); or `autoResumeAt` cleared while still failed (`manual`) | Only manual |
| `task.cancelled` | Entry into cancelled; author/reason optional | No |
| `webhook.test` | Explicit test; synthetic fixture with no task contents | Only on request |

Presets: **Attention, review and results** (attention, review, manual failure and root success); **All results** (all five task types, including
scheduled failures); **Custom** (explicit types and `includeScheduledFailures`, default false).
Default task scope is **Main tasks + subtask questions**: all selected root events plus selected
`attention_required` events from children only when `reason=question`. **Every task** includes
selected events at every level. An explicit question may be forwarded by a parent; feature does not
promise cross-task deduplication without shared, trustworthy request identity.

### Episodes, grace and freshness

An episode is identified by task ID plus the project outbox sequence that began waiting/review/
failure. A new structured question while waiting replaces the episode; the same `requestId` does
not. Record `attentionRequest` (requestId, askedAt, bounded questions) in the same patch as
`status: waiting`; cover both turn-end handlers and native asks. It is the canonical notification
snapshot; `dispatch.pendingAsk` remains the dispatch answer-routing state, updated by the same
helper rather than independently interpreted by webhooks.

Central normalization follows `askParked`: clear `attentionRequest` whenever the resulting status
is not waiting, and `completionReason` whenever it is not done, including load reconciliation.
An unrelated wait with no question explicitly clears the old request even if status stays waiting;
this replaces the episode and supersedes its queued notification. Inspect every `RunStore` and
`ActiveRun` construction site; no handler-specific cleanup or missing continuation initialization.

The transition helper receives before/after snapshots for update, archive, archive-all, reconcile,
delete and prune. Record relevant changes and allocate sequence before `touch` emits to listeners,
so a reentrant update cannot overtake the outer transition. Recovery does not manufacture events
from historical tasks; archive/delete invalidate existing deliveries. Capture errors are isolated.

`notBefore = occurredAt + grace`. Immediately before each attempt (including replay), compare
with the current episode. An answer, continuation, cancellation, archival, newer question or
exit from review invalidates the old notification. Mark it `superseded`, with a specific reason.
Do not invent a separate cancellation meaning for the same freshness rule during grace.
Opening the thread does not acknowledge or suppress anything. UI: **“Skipped if you reply or
the task no longer needs attention.”** Viewing a question is not an acknowledgement.

If a task is deleted, waiting/review/failure deliveries are superseded; other terminal snapshots
can still be sent. Project removal cancels all unsent work. Use the owning in-memory store for
freshness, never a lagging `runs.json` while that store exists. Temporary read/recovery uncertainty
defers until a bounded recheck or expiry. After restart, an unopened project's waiting/review
work is superseded as `owner_restarted`; do not start its RunManager merely to validate a webhook.
Failure handling for unopened projects is specified below. Recheck immediately before HTTP;
state can still change while a request is in flight, which receiver docs must acknowledge.

### Failure disposition

The scheduling algorithm stays unchanged. `failed` precedes `dropActive` and scheduling; on a
continuation failure, `autosaveCommit` can delay `dropActive` without a time bound. A 30 s timer
alone cannot prove that no auto-resume will be scheduled.

1. Entry into failed captures the failure episode, time and newest continuation step ID. Wait at
   least 30 s. Before sending, require the same failed episode, no archival, no newer `continue-N`
   step and `!manager.isActive(runId)` (this includes active, starting and queued sets). Defer
   while active; a newer continuation supersedes the alert even before its status becomes running.
2. Once eligible, read `autoResumeAt`: scheduled failures go only to receivers explicitly selecting
   them; default receivers record `superseded: auto_resume_scheduled`. Otherwise send manual.
   Freeze disposition and body at the first claimed attempt; subsequent retries retain those bytes
   but still check freshness. Before every automatic retry, suspension probe, Retry now and Replay,
   recompute disposition and deadline using the same owner/disk policy. A manual body is stale if a
   live resume has appeared; a scheduled body is stale if the schedule disappeared, changed deadline,
   or is no longer live after restart. Supersede with `failure_schedule_changed`; never rewrite frozen
   bytes. The metadata-clear candidate in rule 3 can still produce the eligible manual notification.
3. Clearing `autoResumeAt` while still failed captures a candidate manual event, not an immediate
   alert. Apply the SAME 30 s grace, episode/continuation/active checks and current scheduling
   check. Both human Continue and successful automatic resume clear this field before progressing:
   neither may send a false alarm. Archive-induced clears create no candidate. A genuine cancelled
   schedule still alerts after the checks. Do not remove this existing notification capability.
4. Deduplicate candidates by `(failure episode, disposition)` per receiver: a manual entry and
   metadata-only candidate do not alert twice. All-results may still get scheduled then manual.
   Bulk scheduling clears during boot/settings changes retain ordinary limits and 30 s grace;
   cap manual-failure sends at 10 per project per minute (also for retries/replay). Others remain
   queued with original expiry; record the delay in history, never drop silently.
5. For an unopened context after restart, use a read-only validated disk snapshot, without
   constructing a RunManager. Disk-only `autoResumeAt` is not a live timer: classify manual and
   supersede if newer continuation evidence exists. Once the context is built, switch to its
   in-memory store and wait for recovery before sending. Read-only reconciliation must not write
   run state or invent new source events.

Readiness is rechecked on store changes and a bounded 5 s timer, until the delivery expires at
72 h. A forever-active task therefore cannot leave a delivery pending forever. After a restart
no old question is authorized merely because a debounced record still says waiting.

### Completion and links

| Resolution | Evidence required |
|---|---|
| `pr_opened` | The cezar PR-creation operation succeeded and the same operation changes this task to done |
| `accepted` | Explicit acceptance of review without cezar creating a PR |
| `no_changes` | Successful task-relative diff check found no changes; never inferred from skipping review or a failed diff command |
| `completed` | Normal successful completion, including autonomous/review-disabled runs with changes |
| `unknown` | Completion without sufficient recorded evidence |

The optional `completionReason` field records known completion provenance: the PR-creation route
(`pr_opened`), review acceptance (`accepted`) and a successful task-relative diff check (`no_changes`).
Normal successful completion writes `completed` explicitly; a done record without provenance
reports `unknown`. Deployment and no changes are never inferred from missing evidence.
The field follows the central lifetime rules above.
When capture is active, compute task-relative diff evidence in the existing completion operation
before its done patch; bound it with a 5 s timeout, and use `completed` on timeout/failure. With
capture off, do not add a git invocation or delay the default path. The existing whole-branch
diff cannot establish task-relative `no_changes` unless its anchor is proven equivalent.
Task-relative diff determination uses `resolveTaskDiffBase` with branch and startedAt;
the review-gate helper retains its whole-branch meaning.
Creating/linking a PR after done does not rewrite the historical finished event and does not
emit a second finished event. There is no separate PR-linked notification. An existing PR URL can be included
with `completed`; its existence does not prove that cezar just opened it.

`finished` is one task's outcome, not deployment, merge or tree settlement. Children can later
resume a parent. Include root/parent task IDs where known; descendant counts are optional,
point-in-time values, never inferred as zero from missing information.

`links.issue` / `links.pullRequest` are optional. Resolve them from existing structured tracker,
automation and repository-reference fields, with documented precedence and tests per source.
An unresolvable reference is omitted. Agent-derived URLs remain untrusted even after storage:
extract a structured provider identity, then rebuild a canonical URL. GitHub owner/repo must
match the project's configured remote and the issue/PR number must be valid. Tracker links must
match the connected tracker origin and association. Drop query/fragment; reject credentials and
foreign repositories/origins. Host allowlisting alone is insufficient. Never treat “from the run
record” as a security proof. `origin.automationId` is optional; no invented external correlation.

For hosted cockpit links, use `listServerInstances()` and an installed record matching the
running service's actual port and known local service context. Require one unambiguous match
and a valid public HTTPS `publicUrl`; absence, ambiguity or a remote installer record means
omit the link. Never derive it from arbitrary Host/X-Forwarded-Host headers, invent a localhost
fallback, or add another required setting. Build the task route through the project's routing
helper. Local mode always omits it (D13).

## Durable capture, admission and recovery

### Current failure identity lifetime

Persist minimal current-failure metadata under `webhooks/failure-episodes.json`: task/episode ID,
original sequence, continuation baseline and per-receiver disposition decisions. Its lifetime is
independent of seven-day payloads and thirty-day history: keep it while that captured failure is
current, then retire on exit/deletion (and receiver decisions on receiver deletion). Bound it by
existing tasks/receivers; do not retain Standard text, keys or historical episode lists here.
Admission/reconciliation commits the metadata before advancing past or compacting its last source
record. Synchronous capture can refer to the in-memory baseline; it must not wait for this fsync.
Recover the index from retained sources/admissions before enabling capture or lazy-manager recovery;
pruning must preserve the last identity evidence until the index is durable. Never recreate an old
failure episode merely because its body expired. A never-captured failure has no historical event;
missing/corrupt evidence for a captured episode produces an explicit gap/unavailable diagnostic,
not a fabricated ID. After a long offline interval, read-only reconciliation retains identity for
still-failed tasks before normal recovery can clear their old schedule.

### Contract and failure boundary

Delivery is attempted with bounded retries after durable admission. Duplicates are possible;
expiry, user edits, staleness, capacity limits or storage failure may prevent delivery. A receiver
that does not deduplicate by `webhook-id` (for example a relay posting to chat) can show a
duplicate when an earlier successful response was lost. This is notification
infrastructure, not a transaction participant in task execution.

Keep run-state transitions independent of webhook availability. No network, global lock wait or
project queue fsync belongs inside any run transition observer. A source-record write error is caught and reported
as a capture gap (one warning per failure episode of storage, health reason/counter when
possible); it must not throw into the agent lifecycle. The exact missed historical snapshot
cannot be reconstructed after such an error. Do not silently promise recovery for events that
never reached durable storage. Existing task persistence and webhook capture are not an atomic
transaction, so process/power loss before capture can also leave a gap.

### Project-local source outbox

Only the owning process captures, and only while at least one receiver is Active or Suspended.
A synchronous non-throwing append writes one bounded, versioned, unconditionally redacted Standard
snapshot to `webhooks/outbox.ndjson`, with stable event/episode IDs, installation ID, sequence,
mode, occurrence time and task identity. Token/title/seenAt-only changes do not create records.
No source snapshots enter run NDJSON, transcript SSE, continuation prompts or auth context readers.
An outbox append is not a power-loss fsync guarantee; acknowledge that capture gap explicitly.

The owner reads complete lines and uses one byte cursor. Admission writes an atomic event file
before advancing the cursor; an existing file always wins, including an empty-recipient decision.
Do not materialize a default failure disposition at capture/admission: persist its bounded snapshot
and render/freeze each target's final bytes with the first durable attempt claim after eligibility.
All other event bodies freeze at admission. Recipient selection is always frozen at admission.

At startup validate cursor bounds and recover sequence high water before capture. A missing cursor
rescans the retained outbox and matches stable IDs against event files, never generating new IDs.
A truncated tail after a crashed writer is quarantined before appending again; malformed interior
records make capture/admission unavailable with a gap diagnostic. Never silently skip corruption.

Compact under the owner mutation queue, with an explicit linearization point shared with synchronous
append. Snapshot the segment, cursor, append-generation and file length; prepare and fsync a replacement
containing the unconsumed suffix asynchronously. Immediately before rename, in one non-yielding section,
compare the generation/length again. If an append occurred, discard the candidate; never replace the
live file with that stale snapshot. Limit immediate preparation attempts to three, then defer to a
30-second timer; sustained traffic may defer compaction and eventually hit the ordinary capacity limit,
but must never block task transitions. No lock/fsync wait or unbounded tail copy enters the observer.

When unchanged, atomically rename and switch the append target/descriptor without yielding; subsequent
appends must open/use the new file, never the retired inode. A descriptor-switch failure makes capture
unavailable with a gap diagnostic. Sync the replacement directory where supported before durably
resetting the byte cursor; persist sequence high water and current failure identity before destroying
their last source evidence. Give the outbox a segment-ID header (new only on compaction) and
store that ID in the cursor. A crash between writes is detected by a mismatch: rescan from the
first record, where existing admissions win. Keep admission
files until their source records have been durably removed; afterwards empty/expired decisions with
no recipients or operations retire immediately, while ordinary delivery retention still applies.
If control space fills, attempt compaction and reclaim these decisions before stopping admission.
Skip no-op compaction and history pruning: idle maintenance must not rewrite unchanged state.
Cap the outbox at 50 MiB; on capacity or append failure record capture-gap health and one warning,
without blocking task execution. The append-generation above is an in-memory change counter,
not a persistent generation/receipt protocol;
no per-task cursors or historical tombstones are needed.

Deleting `webhooks/` removes sources too; a new installation ID and fresh activations start from
new observations, never from historical run logs. Lost identity/sequence integrity stops capture
until safe automatic reset; preserve receiver definitions but mark them Inactive, cancel pending
payloads and require normal activation. No user-authored JSON repair. Source capture while every
receiver is Inactive/Paused/Disabled is intentionally absent; activation never backfills history.

### Recipient selection and immutable admission

The coordinator consumes the project outbox and selects recipients at **first admission**, under the
project mutation lock. Eligible receivers are Active or Suspended, with matching event/task filters in the same project,
current activated revision and matching installation ID, with `source.sequence > activationFence`.
Wall-clock `activatedAt` is display metadata, never subscription ordering evidence; equal timestamps
or clock rollback cannot admit a preactivation source. Paused/Inactive/Disabled do not receive admissions.
Edits/pause that happen before admission affect selection; there is deliberately no claim to
reconstruct historical subscriptions. Records already older than 72 hours get an expired admission decision.

Activation, Resume and reactivation after delivery-affecting edits persist an installation-scoped
`activationFence` with the receiver revision. Rename, rotation and automatic Suspended recovery
preserve the fence and existing backlog. Recover sequence high water from committed fences as well
as sources before capture; never reuse a fence across an installation reset.

Define publication against synchronous capture: under the owner mutation queue, snapshot the capture
high water and prepare/fsync the new receiver state and fence asynchronously. In one non-yielding
section, recheck high water, atomically rename the prepared state and publish Active with that fence.
If capture advanced, discard/reprepare; after three unsuccessful preparations return a retryable 503
without activating or changing the previous state. The observer never waits. With the first receiver,
capture remains off until this publication; with another Active/Suspended receiver, its earlier
captures are excluded by the fence. Captures after publication have higher sequence numbers, even
in the same millisecond. Sync the directory where supported before returning success or allowing
admission/claims to use the newly published activation. A sync failure makes webhook processing
unavailable until recovery validates committed state; do not continue sending with uncertain state.
Restart uses the committed state/fence, or makes the receiver Inactive if integrity cannot be proven.
A lost response can reveal a committed activation on refetch; no timestamp reconstruction or backfill.

Construct one admission object for the event containing all selected `(endpointId, deliveryRevision)`
entries, profile-filtered bodies (deferred failure bodies as above), `notBefore`, expiry and initial state.
Write a unique temporary file, fsync, atomically rename to `events/<eventId>.json`, and sync the
parent directory where supported. All targets are in this one atomic object: a crash cannot
persist just half the recipients. Empty selection also gets an admission file so it is not re-evaluated
against a later configuration. Failures before rename leave no committed admission.

Only then advance the outbox cursor atomically. Restart reuses the admission's event ID,
recipients and any already frozen body. `recovered` is local delivery metadata, never signed data.
Outbox compaction and admission retention share the mutation queue; neither may delete the last
durable admission decision while its source could still be reprocessed.

### Attempts and delivery history

Each selected target has a stable delivery ID. Under the mutation lock, record a durable attempt
claim before HTTP, checking endpoint revision/state, source-mode security policy, freshness,
limits and expiry. Perform network I/O outside the mutation lock. Persist result and bounded
history atomically afterwards. On a crash with an unfinished claim, mark outcome unknown and
retry after its timeout; it may duplicate a successful remote side effect. A takeover waits out
any previous claimed request timeout before starting a competing attempt.

Automatic expiry is `occurredAt + 72h`; being offline does not extend it. Payloads are retained
through delivery termination plus seven days; compact results/activity for 30 days, bounded by
10 MiB per log. Pending capacity remains 10,000 delivery entries or 50 MiB of pending bodies,
whichever first. In addition, enforce a fixed zero-config **total retained-state budget** across pending
and terminal admissions, bodies, delivery cycles, operation receipts, failure identities and deleted
receiver history identities. Both bytes and object count have fixed finite limits; no user configuration is required. The outbox and compact logs retain
their separate caps. Account for temporary replacement files with bounded peak disk overhead.

An admission has an 8 MiB serialized payload/envelope budget, excluding delivery metadata.
Reserve deferred failure bodies before admission and at least 8 KiB of metadata per delivery
inside the aggregate retained-state budget. Results may use this reservation without consuming
the payload budget. Frozen payloads remain unchanged. A per-admission capacity rejection records `retained_capacity`
and durable saturation evidence so health is degraded even below project-wide limits.

Reserve total capacity before committing an admission or manual operation; release it only when
retention/source-recovery rules permit pruning, never on successful delivery or supersession alone.
Shared immutable body bytes count once, but every Replay cycle consumes metadata and holds its body
reservation through its own retention obligation. Rebuild/validate accounting before accepting work
after restart. Do not evict already-admitted payloads early to make space for new work.

At either limit, record a compact dropped decision/counter instead of full payloads, using bounded
reserved control capacity. Empty/dropped decisions and diagnostics cannot form an unlimited log.
If even that capacity is exhausted, stop admission and cursor advancement until pruning/compaction
frees space; never delete the last decision while its source can be reprocessed. The bounded outbox
may then fill and report capture gaps without blocking tasks. Report retained-storage saturation
separately from pending-queue congestion. Pruning, reservations, source compaction and cursor
advancement share the owner mutation queue; no network or observer wait enters this accounting.

History points to archived payloads only while retained; replay is then available. Beyond payload
retention show “Payload expired — replay unavailable”. Never reconstruct old bodies from current
run. Deleted tasks have no live link. Retained replay candidates remain discoverable even if the
10 MiB compact history cap evicts their result rows: retain minimal display/order metadata in their
admissions until body expiry. Merge those records with compact history by delivery ID when listing;
never extend payload retention merely to serve a history page.

Removing a project keeps the `removeProject` contract — unregistration only, nothing in
the repository is deleted — and stops its webhooks. Before unregistering, under the project
lock, Active/Suspended receivers become Paused and their unsent deliveries are cancelled;
in-flight requests are aborted best-effort (acceptance may already have happened). Receivers,
secrets and history stay in `webhooks/`. If that write fails, unregistration still proceeds with
a warning: this instance stops serving the project anyway. After a successful pause write, re-adding finds receivers Paused; Resume requires confirmation
and starts without backlog. A persisted pause is respected by the next owner. If this process
does not own the service, apply the non-owner removal warning below; never claim another live
owner has stopped. Users who want the secrets gone delete the receivers before removing the
project. The removal confirmation names the number of receivers it pauses.
Loss of the project root makes its webhook service unavailable; never search another root/home
for a fallback queue. Renaming a registered slug does not copy or retarget persisted state.

### Delivery states and wake sources

`pending` waits for grace/limiter; `in_flight` has a durable attempt claim; `retrying` waits for
`nextAttemptAt`; `blocked_policy` waits for an eligible sender/policy repair. Terminal states are
`delivered`, `failed`, `superseded`, `cancelled` and `dropped`, each with a structured reason.
The coordinator schedules the earliest grace/retry/expiry/probe deadline; startup scans rebuild
these timers. Policy blocks are rechecked on ownership/configuration changes and at most once
per 15 min; their original expiry still terminates them. Never leave a nonterminal delivery
whose only wake source is a browser action. A manual Retry now does not bypass these predicates.
A `test` uses the same transport/limiter machinery with a 10 s attempt, but no automatic retries:
the user gets one definite result or outcome-unknown, not repeated synthetic messages.

### Single owner and lazy projects

One process owns a project's entire webhook service: capture, configuration, admission, sending
and history. Acquire an exclusive filesystem lock at canonical `dataDir/webhooks/`; record a
random owner token, PID, process start identity and host boot identity. PID alone or heartbeat
age never proves death. Use verified OS process identity (for example Linux boot ID + process
start ticks, macOS `ps` start time + `kern.bootsessionuuid`, or Windows process start + last boot
time); inability to verify safely makes webhooks unavailable rather than stealing a lock. A probe
that is killed, times out or exits abnormally yields no trustworthy listing, and an owner identity
whose own PID cannot be read is unknown rather than absent: on macOS and Windows only a complete,
normally exited listing may show that a PID is gone, while a Linux `/proc/<pid>` ENOENT read and any
PID above the platform's ceiling are themselves proof of absence. The boot identity is the second half
of the fence on Linux and macOS: a mismatch between stable random boot IDs authorizes takeover
without a start-token probe, because the previous boot's processes cannot still be running.
Windows last-boot timestamps are not stable IDs: always probe PID plus start time there, regardless
of timestamp differences. On a matching Linux boot, require the same recorded PID namespace before
probing absence or PID reuse; a different or missing namespace is unknown, never proof of death. On macOS, ownership relies on `kern.bootsessionuuid` remaining constant across sleep/wake
and changing only on reboot. A boot identity that changes while its owner is alive could let a contender take over a live fence.
A same-boot PID reused with an identical one-second start token stays fail-closed. Unsupported/network filesystems fail closed
for this service, never for project boot.

A second live process shows “Another process owns this project’s webhooks” and exposes only
masked owner diagnostics; webhook mutations return 503. It must not capture or mutate the outbox.
Recheck ownership every 15 s; acquire a free lock or remove a verified dead owner's lock using
token-checked exclusive recovery. Wait out persisted HTTP claim deadlines before resending.
No live handoff or concurrent webhook writers. Serialize owner mutations in-process; no network
operation holds that queue. This lock does not make `runs.json` or RunManager multi-process-safe;
changes made by a non-owner process may not produce webhook events. State this limitation.

Pin the served boot project's service by canonical dataDir independently of registry membership.
`initWorkspace` can leave a boot root unregistered and its context ID can be `default`; registry-only
discovery must not omit or dispose it. Pass the public slug resolved by `resolveBootProject` into
capture separately from storage identity. Refresh the mapping if slug allocation changes; do not
rewrite frozen bodies. Later registration/alias resolution attaches to the same service, not a second
owner or installation. Do not auto-register a project to solve webhook enrollment. Registry removal
uses the explicit pause policy; routine discovery alone never evicts the pinned boot service.

Boot/registration discovers enrolled project outboxes and starts lightweight services, even
without an open browser, without constructing lazy RunManagers. Attach capture when the owning
process creates a real context. Old waiting/review work is superseded for unopened contexts;
failures use the explicit disk-only rule above. Terminal deliveries, retries, expiry and suspension
probes continue on timers. Readiness rechecks never auto-start tasks. Disposal releases only the
owner's token/timers. Project removal on a non-owner cannot stop another live owner by assumption:
request pause through the owning cockpit first; if unavailable, warn that unregistration is local.
Re-adding after a successful persisted pause finds receivers Paused; failed pause writes must not
be described as a guaranteed global stop.

Retained work uses the stricter producer, activation and current sender mode: any remote mode
requires public HTTPS. A private target becomes `blocked_policy` under a remote owner and expires
unless a policy/configuration change permits it. Preserve these checks across verified restart;
there is no cross-process policy negotiation or access to another project's data.

## Endpoint revisions and state machine

Every delivery refers to the endpoint's delivery-configuration revision. URL, format, profile,
event/task filters, grace or local-network permission edits cancel every unsent old
revision delivery, increment `deliveryRevision`, clear activation/test state, and return to Inactive.
Show the count in the Save confirmation. Require activation again even when narrowing scope;
this simple uniform rule avoids silently rerouting an old Standard payload to a new destination.
Rename and signing-key rotation do not change the delivery revision; they have separate audit
revisions. Keep historical targets masked, never retarget old deliveries. Replay across changed
configuration is rejected; a new test is the way to validate the new destination.

| State | Admissions / sending | Exit and queue policy |
|---|---|---|
| Inactive | Neither; manual tests allowed | Confirm Activate → Active; edits stay Inactive |
| Active | Admit and send | Pause → Paused; 10 consecutive transport/5xx failures → Suspended; permanent endpoint failure → Disabled |
| Paused | Neither | Pause cancels unsent work; confirm Resume commits a new activation fence → Active, no backlog |
| Suspended | Admit, hold ordinary sends | After 15 min try one oldest eligible real delivery; success → Active; failure → next 15-min attempt; Pause/Edit/Delete/Disabled remain possible |
| Disabled | Neither | Cancel unsent work; resolve cause and pass a manual test, then explicitly Activate → Active |

While Suspended, choose a still-fresh delivery; if none exists, send no synthetic probe.
Remain Suspended until new eligible work reaches the next probe time or a successful manual test
returns it to Active. Discard expired work normally. `429`, invalid payloads and policy blocks do
not increment the transport-failure streak; a successful ordinary or probe delivery resets it.
A single delivery exhausting 72 hours does not disable the receiver.

Pause, Disable, Edit and Delete stop all future unclaimed sends and cancel unsent claims where
possible. An already started HTTP request is aborted best-effort but may have been accepted;
state this in confirmations (“A message already in flight may still arrive”). Results of old
claims cannot reactivate or change a newer endpoint revision after a state, configuration or
key change. A name-only edit preserves result authority: a late HTTP 410 still disables the
same destination. This exception cannot bypass an intervening Pause/Resume, edit or rotation.
Delete retains masked history for
retention, cancels retries and removes secrets once in-flight requests release their references.
Retain a minimal project-local historical identity (ID, bounded masked display name and deletion time)
only while associated retained history exists; no secret or usable destination is kept for navigation.
Commit live-definition removal and the historical identity in the same atomic endpoint-state write;
reserve its bounded display metadata while the receiver is live, so deletion does not need new
unreserved capacity. Its lifetime ends with that history, without restarting retention. This is not a sixth receiver state
and does not count as active/failing. Later results of already-started attempts may update retained
history under its existing rules, but cannot restore configuration or credentials.

Activation is allowed without a test, or after a transient test failure with a warning. A known
permanent/configuration test error (destination-policy rejection, 410, or any other 4xx except 408/429) blocks activation until
a successful test of the current revision. Fixing the receiver side, for example its authorization
rule, can pass that test **without changing the URL**. A previous
permanent block remains until success, even if a later test times out. Testing a Disabled endpoint
does not silently activate it. For initial tests Inactive stays Inactive, with a blocked activation result on permanent failure;
Paused stays Paused. The “Disable receiver” transport rule applies to Active/Suspended, or keeps
an already Disabled receiver Disabled. Successful tests do not resume a Paused receiver. Server
validation enforces these rules, not just the button. Pause is allowed only from Active/Suspended;
Inactive or Disabled cannot use Pause → Resume to bypass activation requirements.

## Payload contract and data minimization

One Zod discriminated union in `packages/contract/src/webhooks.ts`; inferred TypeScript types and
JSON Schema generated with `z.toJSONSchema` into `packages/cezar/docs/webhooks.schema.json`; verify regeneration in contract tests. `schemaVersion: 1` is fixed for feature. Optional fields are omitted, never
invented as zero or emitted as always-present `undefined`. Event ID is a random stable
`evt_<uuid>` assigned during source capture; test events use their own IDs. Source instance ID
is a persisted random project-installation ID; a full reset generates a new one. Real project slugs only,
never the reserved `default` alias.

```json
{
  "id": "evt_9f664930-5157-4938-bf64-8cf9105e7990",
  "type": "task.finished",
  "schemaVersion": 1,
  "occurredAt": "2026-10-08T13:20:00.000Z",
  "sequence": 412,
  "source": { "instanceId": "inst_76a31bca", "projectId": "customer-api", "mode": "local" },
  "task": { "id": "598afadb-5324-4c0c-a3ef-2081410d4ac4", "status": "done", "previousStatus": "running" },
  "tree": { "rootTaskId": "598afadb-5324-4c0c-a3ef-2081410d4ac4" },
  "data": { "resolution": "completed", "finishedAt": "2026-10-08T13:20:00.000Z" }
}
```

| Event | Required `data` | Optional data |
|---|---|---|
| attention_required | `episodeId`, `since`, `reason` | requestId, Standard questions/options, links |
| review_ready | `episodeId`, `since` | task-relative diff counts, check outcomes, links |
| finished | `resolution`, `finishedAt` | startedAt, measured usage/cost and coverage, links |
| failed | `episodeId`, `failedAt`, `disposition` | stepId, category, Standard message; autoResumeAt required when scheduled |
| cancelled | `at` | structured reason |
| webhook.test | `test: true`, fixed format | fixed synthetic fixture; omit caller-chosen name/text and project/task/source sequence |

Profile **Minimal** (the schema default: a create request without `profile` gets Minimal) includes identifiers, statuses, counts, timestamps and validated links.
It includes a bounded redacted title only when `titleOrigin === 'user'`; absent/auto/marker origins
omit it. Provenance is application metadata, not authenticated human identity: same-user API
access can forge it. Receivers may fall back to the task ID and project.
**Standard** adds bounded title, question/options and error text. The failure `message` is never
required in Minimal. Neither profile serializes prompts, transcript, diffs, tool logs or local
filesystem paths. Apply redaction to free-text fields, URLs and errors before durable source
capture and again before admission; preserve schema validity. Known webhook URLs/secrets,
including retired rotation keys, are passed through `collectSecretValues`/`redactSecrets` in
`core/secret-redaction.ts`, including the pattern `whsec_[A-Za-z0-9+/=]{32,}`. Never log one-time
secrets in Activity, toasts, NDJSON, request logs or console diagnostics. Mask generic receiver URL paths and
queries too: they can contain credentials.

Redaction removes known values and recognized token patterns; it cannot reliably recognize all
business-confidential text or arbitrary secrets. Standard consent explicitly says this. Text
fields are data, never markup: receiver docs state that a title, question or
error must be escaped for the target (for example `&`, `<`, `>` in Slack mrkdwn, `@everyone` in
Discord) before display. Only `links.*` are validated by cezar; agent-provided text is untrusted.

Bound every optional string/array in the schema. After JSON serialization measure UTF-8 bytes:
maximum 64 KiB. Trim optional questions/title/error/other lists deterministically, set
`truncated: true`, and validate again. Never remove required `data`/resolution/disposition fields.
If even the minimal envelope cannot validate or fit, record `failed: payload_invalid`, warn once
and send nothing. Exact rendered bytes are frozen per delivery; later redactor/formatter changes
do not mutate retry bodies. A newly discovered secret leak cancels affected unsent payloads rather
than “fixing” an existing ID's body silently.

Transport and external receiver boundaries are specified in [Appendix A](#appendix-a-signing-network-safety-and-retry)
and [Appendix B](#appendix-b-external-automation-and-native-chat-integrations). The Slack/Discord contracts define native formatting, URL validation, transport and provider diagnostics.

## Storage, privacy and degradation

All paths below are relative to the owning project context's canonical `dataDir`, normally
`<project-root>/.ai/cezar`. Resolve it from the server context, not a client-supplied path or an
agent task's current worktree. Construct one private webhook service per canonical dataDir; contexts and boot aliases attach to it.

| Path | Contents |
|---|---|
| `webhooks/endpoints.json` | This project's live definitions/keys/revisions and installation-scoped activation fences; separate masked historical identities without keys |
| `webhooks/identity.json` | Project-installation ID, sequence high water and canonical root binding |
| `webhooks/outbox.ndjson`, `webhooks/cursor.json` | Private redacted source snapshots and segment-bound byte cursor |
| `webhooks/failure-episodes.json` | Minimal current failure identity and per-receiver disposition decisions, independent of payload/history TTL |
| `webhooks/events/<eventId>.json` | This project's admissions, body bytes, target revisions, cycles and claims |
| `webhooks/deliveries.ndjson`, `webhooks/activity.ndjson` | Project-local bounded redacted history |
| `webhooks/limits.json`, `webhooks/owner.lock` | Project budgets and verified single-owner identity |
| `webhooks/dry-run/` | Fully separate definitions, identity, outbox, queue, history and lock for dry-run |

Create directories/files with private permissions (0700/0600 where supported). Persist the
canonical project-root binding in identity; a copied directory at a different root must not send
with inherited activation. Treat it as untrusted copied state: discard copied credentials and
pending payloads from active use, start a new identity with no active receivers, and show a reason.
Intentional moves require reconfiguration in feature. Reject webhook storage symlinks and client path
traversal rather than following them into another project. This prevents accidental sharing, not
a malicious same-user process with filesystem access.

`DATA_GITIGNORE_ENTRIES` includes `webhooks/`. Every project context build calls
`ensureDataGitignore`; lightweight services repeat this protection and verification before
their first write. The storage path is `join(dataDir, 'webhooks')`.
`ensureDataGitignore` returns void and swallows errors: separately verify `git check-ignore`
succeeds for `webhooks/endpoints.json` and that no webhook path is already tracked (`git ls-files`).
Failure makes only webhooks unavailable; never silently write secrets or automatically untrack
user files. Test boot, added projects, pre-existing contexts and failed ignore writes.
Explicit export/worktree/copy helpers also exclude the subtree; gitignore is not a secret boundary.
Use sandboxed project dataDirs and CEZ_HOME in tests; no global webhook secret cache.
One-time create/rotate responses send `Cache-Control: no-store`. URLs are write-only, masked on
reads; no payload/secret enters global SSE, prompts or copied task state. The outbox is a second
plaintext copy of Standard data: private permissions, bounded size and post-admission compaction
are mandatory, and outbound redaction ignores `CEZ_REDACT_SECRETS=0`.

A read-only project dataDir, malformed state or unsupported lock disables only this project's
webhooks with a reason and one warning. Other projects, boot and tasks continue. A bounded health
recheck detects ordinary disk/permission repairs. Never overwrite corrupt receiver definitions
with empty defaults. Lost outbox/identity/admission integrity follows the safe reset above and
makes its receivers Inactive pending normal reactivation. Bounded delivery/activity history is
display data, not evidence: an unreadable log is quarantined beside the original
(`<file>.corrupt-<uuid>`), reported as degraded and replaced with an empty log instead of
disabling delivery. Ignore unrelated files in `events/`. Quarantine malformed admission files only
after durably marking the integrity reset, so a crash cannot erase the obligation to cancel queued
deliveries and require reactivation. Corrupt limiter counters are lower-value state: preserve their
bytes before atomically replacing them with an empty token bucket, full manual-failure window and
a one-minute global Test cooldown. A failed replacement leaves the corrupt original in place, never
a missing-file path that would grant fresh budgets. Report the recovery as degraded health.
Policy-blocked pending lifecycle deliveries also report degraded health with an actionable reason;
clear that warning when no blocked deliveries remain. Users do not repair JSON manually.

Drain ready deliveries after each completion, within the existing concurrency and rate caps; the
five-second poll remains a wake source, not a per-delivery throughput limit. Cache unopened-project
run-index parses by file identity/size/timestamps; never reuse an index whose metadata cannot be
read. Cancellation batches history and registry writes while retaining per-admission durable state
and recoverable history-pending markers.

Only exact `CEZ_WEBHOOKS=1` enables services in this process; unset/0/other values are off.
This gate does not activate or subscribe any project. Disabled processes neither capture nor
send; another enabled owning process serving the same project can still send. Pause that project's
receivers to stop its delivery. Re-enabling may resume its own retained pending work under normal
expiry/freshness/consent checks, but does not synthesize events for the disabled interval.
There is no inheritance from another project.

`CEZ_DRY_RUN=1`: no DNS or HTTP, synthetic test/delivery success visibly marked `dry-run`.
A dry-run process uses an isolated dry-run queue namespace and does not consume real pending work
or activate real definitions. A dry-run test cannot qualify a live endpoint for activation.

## HTTP API and live updates

All body/params/query schemas and responses belong to `packages/contract`; types use `z.infer`.
Register one chained family through validators middleware; do not use loose `app.get` statements
or handler-only parsing. Response shapes must exactly match serialized output. Include routes
in BACKWARD_COMPATIBILITY.md §2, contract parity, route-parity and typed-body checks. Build the
family once and mount it canonically and at the boot alias; both resolve the same scoped service.

Canonical base: `/api/v1/p/:projectId/webhooks`. Boot-project alias: `/api/v1/webhooks`.
The reserved project alias `default` resolves to the boot project; payloads always use its real
slug. Do not introduce `/api/v1/workspace/webhooks` or duplicate handler definitions.

| Method | Relative path | Behavior |
|---|---|---|
| GET | `/` | This project’s masked live receiver list, health and bounded deleted-history summary/count |
| GET | `/history` | Newest-first pages of at most 100 read-only deleted receiver identities; hasMore/nextCursor, scoped opaque cursor |
| GET | `/events` | Project-only SSE invalidations and reconnect resynchronization |
| POST | `/` | Create Inactive; return the signing secret once |
| PATCH | `/:id` | Rename or revision-changing edit; expectedRevision required; 409 on stale revision |
| DELETE | `/:id` | Cancel unsent work and remove definition; expectedRevision required |
| POST | `/:id/test` | Enqueue visible synthetic test; return test delivery ID |
| POST | `/:id/activate` | Confirm current revision/data/destination and activate; expectedRevision required |
| POST | `/:id/pause` | Pause and cancel unsent work; expectedRevision required |
| POST | `/:id/resume` | Confirm current revision and commit a fresh activation fence; expectedRevision required |
| POST | `/:id/rotate-secret` | `mode: graceful` (24 h overlap) or `revoke_now`; secret once; expectedRevision required |
| POST | `/notice/acknowledge` | Acknowledge `expectedChangeSequence`; 409 if a newer change exists |
| GET | `/:id/deliveries` | Newest-first pages of at most 100; total/hasMore/nextCursor and server timezone; optional taskId and opaque cursor |
| GET | `/:id/activity` | Latest 100 masked changes, total/hasMore and server timezone |
| POST | `/deliveries/:deliveryId/retry` | Retry now without changing expiry or bypassing cooldown |
| POST | `/deliveries/:deliveryId/replay` | Confirm duplicate warning, create new delivery cycle with same event ID |

Register the fixed `/history` route before any dynamic `/:id` lookup. Its cursor binds project and
stable `(deletedAt, id)` ordering with a first-page upper bound. Delivery/activity GETs resolve either
a live receiver or its retained historical identity in this project; unknown, foreign or fully expired
identities return 404. Configuration and every mutation, including delivery-ID Retry/Replay, require
a live receiver and reject a historical identity. Contract responses discriminate live configuration
from read-only history; historical entries contain no fabricated states or secrets.
The compatibility inventory and route/contract parity cover the family and its boot aliases.

Delivery cursors bind the project, receiver and optional task filter to a stable `(createdAt, deliveryId)`
ordering boundary and first-page upper bound. They never authorize access by themselves. Validate
bounded cursor input, reapply scope on every page and deduplicate rows by delivery ID. Concurrent
new deliveries appear on refresh, not twice across an older-page walk; expired records can disappear.
`total` counts currently discoverable retained records, not all-time events. `nextCursor` is omitted
when no older record remains. Listing retained snapshots does not require a live task, including
when `taskId` identifies a deleted task; it must not fall back to another project's store.

Every receiver record carries a `revision` bumped by every mutation (rename, edit, activate, pause,
resume, rotation, delete); mutations send it as `expectedRevision` and get 409 when it is stale, so
a stale tab cannot resume a receiver paused later. The `deliveryRevision` stays a separate
number that only delivery-affecting edits change. List responses also include the masked pending
change notice and `changeSequence`; acknowledge only the observed sequence so concurrent changes
cannot be dismissed accidentally. Keep a deletion notice without its former secret/URL. An
acknowledgement is logged but does not itself reopen the notice. Test/retry/replay mutations also carry the
expected receiver `revision`, `deliveryRevision` and an operation ID; dedupe
repeated operation IDs so a double click/retried POST cannot create multiple tests/replay cycles.
Validate all limits, paths and state preconditions on the server. Return 400 for invalid input,
404 for unknown resources, 409 for stale/state conflicts, 429 plus retry metadata for local
rate limits, and 503 with a safe reason for unavailable storage/coordinator. No real URL in errors.

Resolve and authorize the project before every lookup, including test/retry/replay and SSE.
Endpoint, delivery and operation IDs from another project return 404, never a global fallback;
bodies cannot change the owner or supply project filters. TaskId history filters also resolve
within the selected project. Identical IDs in fixtures across A/B must not collide. Apply the same
access policy to the boot aliases; aliases are not an escape from deployment restrictions.

`capabilities.webhooks` is a required boolean in `packages/contract/src/health.ts`, populated at
every health construction site. It is only the process feature gate. An unsupported platform also
sets `capabilities.webhooksUnavailableReason: 'unsupported_platform'`. Routes are always registered;
with the flag off, reads, mutations and SSE return 409 `{error}` naming `CEZ_WEBHOOKS=1` (an
unsupported platform names the platform first), before creating the service or reading its secrets. Project existence/access validation still applies. Project-specific
`webhookHealth` (`disabled | ready | degraded | unavailable`, with safe reason) belongs to the
project receiver-list response. Global health carries no endpoint counts, errors or project
storage paths. An enabled but unavailable project keeps its section visible with the reason.

Use a project-specific SSE route `/events` in this chained family, reusing the existing SSE
transport, origin/access checks and anti-buffering behavior. It emits only `{changeSequence}`
invalidation notices for this project plus an initial/reconnect resync notice. Subscribe while
that project's view demands it and unsubscribe on unmount/project switch; invalidate query keys
including projectId. Authenticated remote SSE follows the existing client's transport pattern.
The server publisher/watchers are demand-driven and bounded; the separate delivery service keeps
working with no open UI. Reconnection refetches snapshots; it need not replay historical notices.
Do not add webhook notices to the all-project `/workspace/events` stream or global WebSocket bus.
The dedicated event schema/client decoder validates project invalidations. No browser polling timer
is needed. The scoped SSE connection supports authenticated remote deployments and exists only
while the project view is subscribed; teardown and reconnect follow the run-stream lifecycle.
Receiver diagnostics stay out of workspace-wide events and WebSocket topics.

## User interface

Project Settings → Webhooks, with registry `scope: 'project'`, route
`/p/:projectId/settings/webhooks` and `?endpoint=<id>&tab=settings|deliveries|activity`.
Show the owning project prominently; no editable project selector and no “All projects”.
The project Settings index/General view supplies the Webhooks card with this
project's active, paused, inactive and attention counts and a scoped Manage link. Global Notifications remains browser
preferences only: no webhook counts, details or cross-project edit links. A global webhook
overview is outside scope. `SettingsSectionId` and `visibleSettingsSections` include `webhooks`
even with the feature off (no capability-based removal).
Enabled/unavailable shows the selected project's reason. Reuse existing UI primitives and native
checkboxes; no new navigation badges. Cache keys, optimistic changes and toasts carry projectId;
clear/unsubscribe old view state on project switch, including in-flight response handling.

| Screen | Required behavior / copy |
|---|---|
| List | Mask all URL paths; state Pill + named `endpointHealthTone` map; Suspended shows next retry of a real delivery, not a synthetic check |
| Empty | “Get notified outside this browser”; Add webhook and link to repository-hosted `packages/cezar/docs/webhooks.md` (sample payloads, signature verification and external automation guidance) |
| Add receiver | Form creates nothing before Save; Destination selects Custom receiver, Slack or Discord; local preview for the selected format; “Main tasks + subtask questions”; “Skipped if you reply or the task no longer needs attention”; link to receiver guide |
| JSON/local variants | Explicit local consent; HTTP warning; hosted rejects private addresses; metadata/link-local always denied |
| After Save | Inactive; one-time JSON secret; Send test can transmit before activation, so do not say “Nothing is sent until activated” |
| Permanent test failure | Reason-specific repair hint; “Resolve the cause, then send a successful test”; activation blocked until success; same URL can recover |
| Activation / edited revision | Destination host (masked secret path), explicit events, task scope, grace, read-only owning project, data and local-network permission; public/Minimal and Standard/private HTTP activation/reactivation variants; confidentiality/HTTP/transient-failure warnings |
| Deliveries | Human event/result labels; bounded detail; “Showing 1–100 — filters apply to loaded entries”; Load older for retained records; distinct Retry now and Replay rules |
| Activity | Latest 100 administrative/system actions, changed field names, revision, time and source; no secrets; `cockpit/api` is informational, never authenticated identity |
| Project General/index | Current project’s active, paused, inactive and attention counts and scoped Manage link; no global aggregation |
| Unavailable / validation | Visible reason and repair action when enabled; no boot failure |

Menu actions depend on state/format. Delete/Pause and delivery-affecting edits explain queued
cancellation and in-flight caveat. Updating profile/event/task scope requires the same new activation
consent as a URL change. Save confirmation names the number of unsent deliveries cancelled.
Successful manual retest of Suspended may recover it automatically; Disabled still needs Activate.
For Suspended only, label the action **Test and recover** and disclose: “A successful test resumes
eligible queued deliveries.” Only Disabled uses **Test after repair**; every other state
uses **Send test**. Any queued count is an as-of snapshot, not a delivery promise. Show
“Test succeeded; receiver recovered” only when that transition commits; if Pause/Edit/Delete won,
show test success with the current state and no recovery claim. Refresh through the existing scoped
SSE. This adds disclosure, not another consent gate or a change to automatic recovery.

Use existing toast components, scoped to the owning project for activation, disabled state, test result and queue drops.
With `CEZ_WEBHOOKS=1`, the project-scoped toast observer holds one extra EventSource for as long as a project is on
screen. It counts toward the browser's six-connections-per-origin limit alongside the global stream, which is
acceptable for an opt-in feature. Do not add a second one per panel.
Activity records a bounded, redacted reason and source. UI filters apply only to the loaded range;
show the loaded range and Load older while `hasMore`; do not suggest a complete search. Activity
remains latest-100 with an honest more-results hint; it does not inherit delivery pagination. Deleted tasks show
“Task deleted” without a broken link. Switching projects closes the old receiver sheet and clears its data; never show another project’s cached results.
The list includes **Deleted receivers’ history** with a count and bounded Load older discovery.
The deletion notice’s View history action opens the same read-only history; acknowledgement does not
remove the list entry. Its sheet shows deletion time, Deliveries/Activity and expiry information, but
no Settings, Test, Retry, Replay, activation or rotation controls. Unknown/expired IDs show an honest
unavailable state; a reused name does not reconnect history to a new destination.
History times explicitly label server timezone. Narrow layouts stack rows and dialogs; keyboard,
focus and light/dark/system support are acceptance requirements.

### Flag-off copy and confirmations

Always show the section. When disabled, the heading is **“Webhooks are off”** and the
explanation describes Slack, Discord and custom endpoint notifications. Show how to start the
server with `CEZ_WEBHOOKS=1`, reload the page and open the receiver guide. An unsupported
platform shows its process-identity limitation. There is no nonfunctional one-click toggle.

The receiver form keeps event selection, task scope and grace, with less-used choices in Advanced. Private URL
consent lives beside the URL and also gates Test. Recognizing a Slack/Discord webhook shows a
masked hint offering the matching destination, never echoes its secret URL. For custom receivers,
the create and key-rotation flows display the complete one-time secret with Copy and recovery instructions
(“Rotate if you lose it”). Chat receivers have no signing-key reveal or rotation.
Activation explains “Only events after activation are sent; tasks already waiting will not alert.”
The preview compares Minimal (user title or task-ID fallback, no question/error) and Standard
payloads, using the selected destination’s JSON or message presentation.

Confirmations cover Pause, Delete, delivery-affecting Save, Resume, Replay and both rotation choices. Show
cancelled-delivery counts, reactivation/no-backlog rules and the in-flight caveat where relevant.
Receiver pills use the actual five states; retry detail is secondary text, never a sixth state.
After removal/re-add show Paused with the project-removal reason and a Resume action.

## Backward compatibility

The compatibility inventory covers:

- BC §1: `CEZ_WEBHOOKS` default off, documented in `.env.example` and README; no new required config.
- BC §2: every route and alias above, invalidation payload, required `capabilities.webhooks`,
  project `webhookHealth` and all Zod request/response schemas, with two-way parity/typed bodies.
- BC §3: private `webhooks/*` formats, identity/outbox/cursor/lock recovery; optional
  `attentionRequest` and `completionReason` with central field lifetimes. No new run-NDJSON type.
  Records without completion provenance report `unknown`; missed events are never synthesized.
- BC §6: receiver guide and JSON Schema remain repository-hosted. The cockpit guide link targets `main`;
  users comparing a specific release can select its repository tag. These assets are not bundled
  in the npm package. No relay or relay-dependent workflow
  template is supplied.

## Risks and acceptance limits

Same-user agents can configure receivers, forge provenance, dismiss notices and read signing
keys. Minimal still exports metadata (and eligible titles); Standard may export confidential or
prompt-injected text despite redaction. Receivers escape text and never execute its instructions.
Local consent permits fixed-body POSTs to user-chosen LAN paths; own-server ports remain denied.
Plain HTTP lacks confidentiality. Proxy authentication does not protect host-loopback callers.
Persistent notices provide best-effort detection only. No signature is proof of lifecycle truth.

Capture and run persistence are not one transaction; crashes/disk-full can lose observations.
Lost HTTP responses can duplicate effects. Non-owner task changes may not be captured; unopened
project questions after restart are suppressed rather than guessed fresh. The receiver guide and health messages describe these delivery limits.

Ownership is deliberately fail-closed. On Windows, a dead owner whose PID was reused by a process
this user cannot open reports an unreadable start time, so acquisition keeps waiting until the
stale `owner.lock` is removed; a changed hostname (recreated container on a bind mount) or any
unreadable identity behaves the same way. Windows boot-time changes do not authorize takeover;
PID and process-start evidence are required. Linux locks from a different PID namespace, or
locks with no namespace evidence, remain fail-closed on the same boot. The macOS
boot-session stability dependency is described above. Two cockpits on one project are unsupported for task execution; if a non-owner
RunManager advances a run while the owner reads the disk-only snapshot, an unopened-project
notification can be stale by one save-debounce interval.

### Recovery and deleted-history acceptance

Exercise Test in all five receiver states, success racing Pause/Edit/Delete or an automatic probe,
and queued-count changes. State and success copy must reflect the committed outcome. Exercise
Delete → notice View history → acknowledge → reload → Deleted receivers’ history → normal expiry,
including project-ID collisions, late in-flight results and denied mutations/Replay. Retained-storage
health must explain why new events were dropped while already-admitted payloads remain available.

## Validation requirements

Tests live beside their owning modules. Required coverage:

1. Both turn-end handlers, normal/recovered/queued failures, PR route, review acceptance,
   autonomous success, failed diff and every server store construction path.
2. Waiting → running → waiting; replacement question without status change; viewing does not
   suppress; responding/archive does; empty/absent source registry degrades explicitly.
3. Failed with `autoResumeAt` written within the grace emits no default alert; `autoResumeAt`
   cleared while failed emits one eligible manual event after the same checks; human/automatic Continue
   creates no false alert, including delayed worktree acquisition and autosave beyond 30 s; a crash within
   the grace still reads the current state; task remains operational if source capture throws.
   Scheduled body retries/probes/Retry now/Replay are superseded after cancellation, changed deadline
   or restart without a live timer; immutable bytes never change. Prune payload/history, restart after
   40 offline days, then clear a missed schedule: current episode identity and dedupe survive.
   Guard tests with `CEZ_WEBHOOKS` unset pin default auto-resume, review gate and status
   transitions unchanged.
4. Crash before admission rename, after rename/before cursor, before first outbox cursor and after
   send/before result; all recipients retain IDs/body bytes; no partial target list.
5. Missing/mismatched byte cursor, crash during compaction, truncated tail, corrupt identity,
   sequence recovery, outbox capacity, payload expiry and full reset; no historical flood.
   Prove the activation fence excludes earlier same-tick/rollback sources and includes later same-tick
   sources; cover first/second receiver, Resume, edited revisions, contention bounds and crashes before/
   after publication/directory sync. Rotation, rename and Suspended recovery preserve the fence.
   Fast success/supersession, empty-decision churn and repeated Replay must respect total retained
   byte/count limits with low pending occupancy; test restart accounting and saturated control space
   without premature retention eviction or forgotten decisions.
   Inject append after compaction snapshot/during fsync/before rename and immediately after switch;
   every accepted source remains admissible once by stable ID. Repeated contention defers on a timer;
   test descriptor failure and crashes between replacement, directory sync and cursor reset.
6. Two processes open the same project (even from different CEZ_HOME registries), contend,
   PID reuse, verified owner exit or a live stalled owner, unsupported identity and retained mode policy;
   no stale claim can overwrite a new state/configuration/key revision; a name-only revision
   preserves result authority without bypassing an earlier fence. Lock/queue failure never breaks boot.
   Serve unregistered boot B while registry contains A: no-browser startup/restart, public slug
   collision, boot/default aliases and later registration share one service without auto-registration.
7. Rename vs URL/profile/filter edits, pause/disable/delete during a request; no old payload is
   rerouted; new receiver never sees pre-activation data; idempotent mutation retry.
8. Every endpoint-state exit, Suspended with no fresh queued deliveries, manual retest of an admin
   restriction without URL change, no transport suspension on 429/invalid payload.
9. Replay has new retry window but same body/event ID; Retry now obeys cooldown/expiry; superseded
   question, deleted-task attention/failure and changed revision cannot be replayed around consent;
   retained finished/cancelled snapshots may be replayed after task deletion. With 101+ results,
   including one task with 101 results, Load older reaches retained replayable entries; repeat after
   compact-history eviction/deletion. Expired bodies stay unavailable; cursors cannot cross projects.
10. SSRF table: IPv4/IPv6/mapped/embedded and unusual numeric forms, metadata/link-local/reserved,
    DNS changes, mixed DNS answers, redirects, certificate mismatch and implicit proxy bypass.
11. Standard Webhooks vectors, raw-byte verification and dual-signature rotation; immediate revocation and receiver key removal;
    A→B→attempted graceful C during overlap returns conflict with unchanged deadline; revoke-now C,
    lost B response, restart and exact expiry boundary preserve the two-key policy;
    secret-value/pattern and URL masking; Minimal permits only user-origin bounded titles; Standard redaction even when ordinary redaction is off;
    UTF-8 size clipping preserves required schema fields.
12. Receiver guide describes signature verification, duplicate handling and the boundary between
    HTTP acceptance and downstream action completion. No chat relay is shipped.
13. Route/schema parity in both directions, project/boot/default alias parity, typed bodies,
    BC inventory, project health and project-only SSE contracts;
    outbox records never reach transcript SSE, continuation or auth context readers.
14. Dry-run has no DNS/network/real-queue effect; read-only project dataDir shows one warning and recoverable
    unavailable state; settings flow e2e (add → test → activate → delivery) in sandboxed project dataDir (and CEZ_HOME for existing registry fixtures).

15. Isolation: A/B deliberately reuse endpoint/delivery/task/operation IDs; list, edit, test,
    replay, rotation, deletion, counts and SSE in A never read/mutate/emit B. Boot/default aliases
    resolve only the boot project; no body/query can override it. A's corrupt/full queue and
    credential rotation leave B unchanged; no global SSE/health leaks webhook state.
16. New project gets no receivers; copied/worktree/exported state cannot inherit credentials or
    activation; storage symlink/path traversal rejected. Project removal pauses receivers, keeps
    their files and still unregisters when the pause cannot be written; re-adding finds them Paused after a successful pause; failed/non-owner pause warns honestly.
    Gitignore establishment and exclusion from worktree/export paths are tested before secrets
    are persisted. Project switch drops stale HTTP results and unsubscribes old SSE.

Repository validation follows `AGENTS.md`, `SDLC.md` and `.ai/agentic.config.json`:

```sh
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

User-facing changes also follow the repository E2E and QA process. The packaged service inlines
contract values and has no private api-client runtime import. `.env.example`, README and
`BACKWARD_COMPATIBILITY.md` document the flag and public surfaces. Breaking event-contract
changes require a new `schemaVersion`. Validation results are recorded separately from this contract.

## Appendix A: Signing, network safety and retry

Cezar JSON uses Standard Webhooks: per-endpoint 32-byte random secret encoded as `whsec_<base64>`.
Decode the key before HMAC-SHA256; sign the exact UTF-8 `id.timestamp.body` bytes. Send
`webhook-id`, `webhook-timestamp` (attempt time in Unix seconds), and `webhook-signature` with
`v1,<base64 signature>`. Body `occurredAt` stays unchanged. Rotation accepts two keys for 24 h;
the signature header carries space-separated signatures. Receiver examples verify raw bytes,
constant-time equality, a ±5 min timestamp tolerance and `webhook-id` deduplication. “Revoke old key now” removes all previous keys
from future signatures immediately. With an unexpired overlap, another graceful rotation returns
409 with `rotation_overlap_active` and the existing retirement time; it cannot silently retire the
oldest key early, extend its deadline, or retain a third key. The UI offers waiting until that time
or explicit revoke-now, including recovery when the current one-time secret was lost. Revoke-now
generates a replacement and retires every predecessor; warn that deliveries may fail until the
receiver is updated. Persist the original deadline across restart and expire it before evaluating
a boundary-time request. Revision validation still applies. A receiver must also stop accepting compromised keys; cezar
cannot revoke a key in somebody else's verifier. Already in-flight requests cannot be recalled.
A 72 h dedupe store may accept a later explicit Replay: document this intended behavior. See [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).

The URL is user-authored configuration, never derived from task text. Allow absolute HTTP(S)
URLs only, no userinfo, fragments, non-HTTP schemes or redirects. Hosted mode requires public
HTTPS. Local mode permits loopback, RFC1918 and IPv6 ULA only with explicit local-receiver
consent; plain HTTP gets a visible transport warning. Link-local, metadata services, multicast,
unspecified, reserved/special-use ranges and known metadata hostnames are always denied, including
in local mode. Revalidate after WHATWG URL parsing (including numeric forms such as `2130706433` and `0x7f.1`),
then classify every DNS answer; any denied answer rejects the whole set. Test requires the same
local-network consent BEFORE transmission, never only at activation. Deny this server's listen
ports and every port reported by `listServerInstances()` as destination ports, even with local
consent; conservative false positives are preferable to a POST into cezar's API.

Pin the actual connection to the validated IP while retaining TLS hostname validation/SNI for
the original hostname; no second uncontrolled DNS lookup, implicit proxy or certificate bypass.
Use a dedicated undici `Agent`, never the global dispatcher, with `rejectUnauthorized: true`,
no environment proxy support and `autoSelectFamily: false`; connection lookup returns only the
validated pinned address. Test with `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY=1`
and `NODE_TLS_REJECT_UNAUTHORIZED=0`. Corporate proxies are unsupported in feature.

| Address class | Policy after normalization |
|---|---|
| Public unicast | HTTPS in hosted; local HTTP(S) subject to explicit HTTP warning |
| Loopback, RFC1918, IPv6 ULA | Local consent only; server ports always denied |
| `0.0.0.0`, `::`, link-local, multicast, reserved/special-use | Always deny |
| Cloud metadata, including `169.254.169.254`, `fd00:ec2::254`, metadata names | Always deny, overriding local consent |
| IPv4-mapped `::ffff:`, IPv4-compatible `::a.b.c.d` | Classify embedded IPv4; never evade IPv4 policy |
| NAT64 `64:ff9b::/96`, `64:ff9b:1::/48`, 6to4 `2002::/16`, Teredo `2001::/32` | Deny transition ranges in feature; no embedded-address bypass |
| Mixed public/private or denied DNS answers | Reject the entire set |

Use an explicit service dependency for the client. [OWASP guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

| Result | JSON policy |
|---|---|
| 2xx | Delivered: remote acceptance, not proof of processing |
| Connection/timeout/transient DNS/408/5xx | Exponential retry: base 5 s, doubling to 1 h, bounded jitter, within expiry |
| 429 | Respect Retry-After; no early manual retry; fallback backoff when absent/invalid |
| 3xx | No redirect; delivery failed |
| 410 | Disable receiver, cancel unsent work |
| Other 4xx (not 408/429) | Fail this delivery without automatic retry; show safe reason; user may replay after correction |
| Policy or permanent DNS validation rejection | No network request; blocked_policy until corrected/eligible, otherwise expires |

Retry-After supports seconds or HTTP date for generic HTTP; do not retry before it, even beyond
72 h (expire instead). Timeout covers DNS/connect/headers/body and is 10 s total; read at most
4 KiB response bytes. For public origin-only destinations retain a redacted diagnostic only
after a complete response below that limit; omit partial or limit-reaching bodies without
draining. Also omit optional diagnostics whose serialized size exceeds the reserved result
metadata, so HTTP status and endpoint effects can still be committed at capacity. For
private destinations retain status/content type only, never a response body. Mask path/query
in every API error, UI result, server warning and Node/undici error; do not log raw error objects. Response bodies are untrusted.
Each project has its own bucket of 120/min with burst 10; one concurrent request per destination host and
at most four in the process with fair scheduling and at most one in-flight request per project. Tests 3/min/host/project, persisted independently of endpoint deletion. All test,
probe, replay and automatic work share that project’s budgets. Per-project limits persist across
ownership takeover; no durable global limiter file is introduced.

**Retry now** applies only to nonterminal retryable deliveries, preserves ID/body/expiry, and
cannot bypass grace, suspension, freshness or Retry-After. **Replay** creates a new delivery
cycle/ID with the same event ID/body and `replayedAt + 72h` expiry; requires retained payload,
same endpoint revision, Active state, user confirmation and valid freshness. Restrict to failed
or delivered terminal deliveries; superseded/cancelled/dropped/policy-blocked entries cannot be
replayed around consent rules. Replaying a successful event may be ignored by JSON receiver
deduplication and may duplicate a downstream chat message; explain this in the confirmation.

## Appendix B: External automation and native chat integrations

Custom receivers use signed JSON. A user supplies a receiver URL from their backend or an
automation workflow such as Make or n8n, then configures downstream actions there. cezar does
not ship a relay or a workflow template that depends on one.

Custom receivers should verify signatures and handle duplicate event IDs. A 2xx acknowledges acceptance
by that receiver; it does not prove downstream Slack/Discord delivery. A workflow that acknowledges
before completing its actions owns their retries and failure reporting.

Native cezar-to-Slack/Discord notifications follow the
[Slack](2026-10-19-slack-webhook-receivers.md) and
[Discord](2026-10-19-discord-webhook-receivers.md) contracts. Those specs define provider formatting, response classification, rate handling, URL
validation and setup UX. They share the queue and privacy profiles, and require no
cezar bot, OAuth flow or relay. They do not accept replies or approvals, and HTTP acceptance
is not a phone display/read receipt. Dry-run checks send no receiver traffic and cannot
verify that a provider displayed a message.
