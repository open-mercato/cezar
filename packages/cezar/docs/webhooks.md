# Outbound task webhooks

Webhooks send task notifications from a running cezar server to your own receiver, Slack or Discord.
Your receiver can process these events in an automation workflow. They do not start tasks or accept answers.
Choose **Custom receiver** for signed cezar JSON, **Slack channel** for an Incoming Webhook, or **Discord channel** for a channel Webhook URL.

## Supported server platforms

Delivery requires an **OS-verified process identity** to fence a single owner: **Linux** (`/proc`
process start + boot id + PID namespace), **macOS** (`ps` start time + `sysctl kern.bootsessionuuid`) and
**Windows** (PowerShell PID + `Get-Process` start time). All three are supported;
delivery stays off until explicitly enabled. Ownership is fenced by an OS-verified process start
token and, where stable, a boot-session identity, so a lock left by a crashed or rebooted process is recovered,
while a process the OS still reports as live keeps it. If the OS cannot verify an identity (an
unopenable process on Windows, a changed hostname, an unreadable owner file), cezar keeps webhooks
unavailable instead of stealing the lock; after confirming no cezar process is running, an operator
may remove the stale `.ai/cezar/webhooks/owner.lock`. Windows boot timestamps are diagnostic only:
a changed timestamp never proves a live owner has died. Linux owners from another PID namespace
or locks without namespace evidence remain unverifiable. On macOS, safe ownership recovery
requires the boot-session identifier to stay constant across sleep/wake.

A platform without such an identity (for example FreeBSD) reports
`capabilities.webhooks: false` with `capabilities.webhooksUnavailableReason: "unsupported_platform"`,
regardless of the flag. Webhook API routes return 409 with the platform explanation before opening
storage. Settings shows this explanation instead of instructions to enable delivery. This refers
to the server OS, not the browser's OS.

On a supported platform the reason field is absent and delivery remains off unless explicitly
enabled. An ownership or storage failure reports the existing storage/coordinator error.

## Enable and connect

1. Start cezar with `CEZ_WEBHOOKS=1` in its server environment. Restart after changing the flag.
   Without the flag, the Webhooks settings page explains how to enable delivery; it creates no
   webhook storage, capture observers, timers or requests.
2. Open your project's **Settings → Webhooks**, then **Add receiver**. Use an HTTPS receiver URL.
   Paths and query strings may contain credentials: cezar masks them in lists and delivery history.
3. Keep **Minimal** initially. For a custom receiver, save and copy the signing key into its secret storage.
   The cockpit shows that key once. If you lose it, use **Rotate key** in the receiver's **⋯** menu. Slack and Discord use their secret URL instead.
4. Send a test. It contains only a synthetic connection event, never a project name, task or question.
   A passing test means the receiver accepted it; it does not prove a chat or phone displayed it.
5. Activate after reviewing the destination and data profile. Only events captured **after** activation
   are eligible. Existing tasks are not backfilled. Pause and Resume also establish a new capture fence.

A local server can send to a private receiver after explicit local-network consent, including for
Test. Hosted mode requires public HTTPS. Local HTTP is unencrypted even with a signed body.
Loopback cezar ports, metadata services and unsafe DNS/address forms are always denied. Redirects
and corporate environment proxies are unsupported; use a directly reachable receiver with a valid
TLS certificate. DNS is revalidated and pinned for every attempt.

## What is sent

| Event | Meaning |
| --- | --- |
| `task.attention_required` | Task entered waiting, or an explicit question was replaced. |
| `task.review_ready` | Task entered the review gate. |
| `task.finished` | Task finished; `resolution` explains PR opened, accepted, no changes, completed or unknown. |
| `task.failed` | Task is still failed after at least 30 seconds and is no longer active or continuing. |
| `task.cancelled` | Task was cancelled. |
| `webhook.test` | Synthetic receiver setup check. |

The default preset selects attention, review, finished and **manual** failure. **All results** adds
cancelled and scheduled failures. **Custom** lets you select types and scheduled failure delivery.
The default scope covers main tasks and explicit questions from children; **Every task** includes
children's other selected events. The default waiting/review grace is three minutes, with 0, 1, 3
and 10 minute choices. An answered question, continued task or archived task can make a queued
attention/review/failure notification obsolete before it is sent.

Minimal sends IDs, states, timestamps and structural fields. It includes a title only when the
user authored it. Standard can additionally send generated titles, questions and bounded error
text. Neither profile includes prompts, transcripts, file contents or local paths, and known
secrets — this project's receiver URLs and keys, credential-named host environment values and
recognized token shapes — are redacted by design. A credential embedded in free text that matches
none of those, for example inside a URL path, can survive redaction. Outbound secret redaction
always runs, even when transcript redaction is disabled. Choose Standard deliberately.
Recognizable filesystem paths in free text are redacted before capture and rendering. A path
without quotes may contain spaces, so redaction conservatively omits the rest of that text line;
quoted paths and HTTP(S) links preserve surrounding context. This is a syntax-based safeguard,
not general data-loss prevention: encoded or otherwise disguised sensitive text can escape it.
Already frozen delivery bodies are not rewritten, preserving retry and Replay byte identity.
Known secrets are redacted before title/error length limits. When an oversized title or error
contains an HTTP(S) URL, its retained excerpt ends before the first such URL. This can omit
additional context, but avoids retaining a partial destination that later secret redaction
cannot recognize. Short text retains complete links. Delayed failure rendering also checks
the current set of receiver URLs and signing keys.

Bodies are capped at 64 KiB and may include `truncated: true`.

Completion events include measured token counts and cost when available. Their usage coverage
is marked partial because some steps or providers may not report every measurement; absent
measurements are omitted. GitHub links are rebuilt for the configured project repository only.
For a PR, the created-PR reference takes precedence over the task's referenced PR and then the
GitHub automation source. For an issue, a tracker automation reference matching the current Jira/Linear connection and
association takes precedence, followed by the task's GitHub reference and GitHub automation
source. Each candidate must validate before it can win; invalid candidates do not mask a valid
fallback. Query strings and fragments are discarded. Tracker title slugs are discarded too.
Hosted events may include `links.cockpit` only when one installed local server record matches
both the running service identity and actual port and supplies a public HTTPS origin. Local
mode, missing identity and ambiguous records omit it; request headers never supply that URL.

See [JSON Schema](webhooks.schema.json), generated from the shared Zod contract. Unknown optional
fields should be tolerated by consumers; handle unknown event types without side effects. The
transport headers below are separate from the JSON envelope.

## Verify before processing (custom receivers)

Read the exact raw request body before JSON parsing. Verify:

- `webhook-id`: stable event ID; it must equal JSON `id`.
- `webhook-timestamp`: integer Unix seconds for **this attempt**; reject more than five minutes of skew.
- `webhook-signature`: space-separated `v1,<base64 HMAC-SHA256>` signatures.

Decode the Base64 part of the signing key after its `whsec_` prefix. Sign the exact bytes
`webhook-id + "." + webhook-timestamp + "." + raw-body`. Compare signatures in constant time.
Do not reserialize JSON, verify only the JSON timestamp, or use the textual Base64 key as HMAC key.
During graceful rotation accept either configured key. Remove the old key after its 24-hour overlap.
A second graceful rotation is refused during an active overlap. **Revoke old keys** (in the
receiver's **⋯** menu, beside **Rotate key** and **Delete**) invalidates both previous keys immediately; update the receiver promptly. A request already in flight cannot be recalled.

Signatures authenticate possession of the shared key. Processes running as the same OS user can
read keys or configure receivers through the local API. They can forge a valid event. The change
banner is best-effort detection, not proof of human approval or a boundary against such processes.
Do not use these notifications alone to approve payments, deployments or privileged actions.

## Delivery and acknowledgement

Return 2xx only after the desired work is completed durably, or after it is in your own durable queue.
The total request budget is ten seconds. cezar retries connection errors, 408, 429 and 5xx, using
backoff and Retry-After, within a 72-hour delivery lifetime. Other 4xx stop that delivery; 410 disables
the receiver. No redirect is followed. Ordering across events is not guaranteed.
Queued attention/review notifications are also subject to freshness suppression, including the
permanent owner-restart limit described under [Operation and boundaries](#operation-and-boundaries);
the durable queue and 72-hour retry window do not guarantee their recovery after restart.

History keeps HTTP status and safe failure reasons. Response bodies are omitted for private
destinations and URLs containing a path or query: a receiver or proxy can echo destination
credentials in forms that cannot be reliably redacted. For public origin-only URLs, response
diagnostics are retained only when the complete response is smaller than 4 KiB. Incomplete
responses and responses reaching that limit are omitted, without waiting for more bytes;
HTTP status and safe headers remain available. Optional diagnostics are also omitted if their
JSON representation exceeds the space reserved for a delivery result. If receiver configuration
changes during a request, response and header text are omitted because secret coverage may
have changed; HTTP status and valid Retry-After timing remain available.
A Retry-After beyond the delivery lifetime
expires the delivery rather than causing an earlier retry.

Deduplicate using the event ID, scoped to a trusted receiver/installation. Serialize concurrent
requests for the same ID. Under that serialization: look up completed IDs without mutating them;
post the notification; durably record completion; then acknowledge. Keep completed IDs at least
72 hours. Recording the ID before the post can permanently lose a message after a downstream failure.
A crash after a successful post but before completion is saved can duplicate its effect. Delivery is
not exactly once, and storage failure, expiry, policy blocks or capacity can prevent delivery altogether.

Retry now keeps the same event and delivery. Replay creates another delivery cycle with the same
event ID and immutable body, so your receiver may deliberately deduplicate it. Replay is available
only for retained eligible deliveries and the current receiver configuration; it never recreates a
payload that has expired. Scheduled failure bytes are never rewritten as manual failure on retry.

## Receiver states and history

- **Inactive:** saved but not activated. Test does not activate it.
- **Active:** accepts new selected events.
- **Paused:** entered only from Active or Suspended; stops admission and cancels unsent work. Resume starts with future events.
- **Suspended:** ten consecutive transient failures caused automatic backoff. Eligible work is probed
  after fifteen minutes. A successful Test also recovers the receiver and can release queued work;
  the cockpit discloses that before sending the test.
- **Disabled:** a 410 response disabled delivery. Repair the destination and pass a test before activation.

A permanent Test failure, including a destination-policy rejection, blocks activation of that configuration until a successful test or a
relevant configuration edit. Changing delivery settings returns the receiver to Inactive and
cancels pending work; renaming preserves activation. Confirmations show pending/in-flight counts.
Pause, Edit and Delete cannot undo a request already received by the destination.

Receiver definitions and deleted-receiver identities share a 1 MiB budget. Additional bounded
space (4 KiB per live receiver plus 8 KiB) is reserved for operational state, so reaching the
configuration limit does not prevent result recovery, key rotation or receiver deletion.

One event's serialized payloads and envelope share an 8 MiB admission budget across its
receivers. Delivery metadata has separately reserved space within the total retained-state
limit, so a full payload budget does not prevent recording results. Oversized fanout is
dropped with `retained_capacity` and degraded health, even when the project-wide queue
has room. Reducing the selected receivers or using Minimal can reduce future payloads;
already dropped deliveries are not automatically recovered.

Delivery payloads and Replay eligibility are retained for seven days after terminal completion.
Masked delivery/activity history is retained up to thirty days within finite storage limits. If a
delivery or activity log cannot be read, cezar preserves it beside the original
(`*.corrupt-<id>`) and starts a fresh log; the receiver list reports degraded health, and neither
capture nor delivery is disabled.
An unreadable admission is also quarantined, but its lost delivery evidence requires a safe reset:
queued deliveries are cancelled, receivers become Inactive and health reports degraded until
reactivation. Unrelated files in `events/`, such as `.DS_Store`, are ignored.
A corrupt rate-limit file is preserved before replacement. Budgets restart empty and manual Tests
wait one minute, so recovering does not grant extra requests; health records that recovery.
Policy-blocked lifecycle deliveries report degraded health with an address/consent/server-mode
explanation. Repairing the policy lets eligible retries proceed and clears that warning.
Delivery pages show the latest 100 entries and offer older retained pages; status filtering applies
to loaded entries, while the task-ID filter is applied on the server. Deleted receivers remain as
read-only historical identities while retained history exists, without keys or usable destinations.
Removing a project pauses receivers when this server owns them and records that the removal paused
them; heed any warning if that write fails or another server owns the project.

## External automation receivers

Configure the webhook URL of your own backend or automation workflow (for example Make or n8n)
as the receiver. cezar sends signed JSON; your workflow decides how to format it and whether to
send a Slack/Discord message or perform another action. No cezar relay process is required or supplied.

Follow the signature verification and duplicate-handling requirements above. A successful HTTP
response acknowledges receipt by your workflow, not delivery to a downstream chat. If the workflow
acknowledges before processing finishes, it must handle downstream failures and retries itself.
Select the Minimal or Standard profile deliberately: the automation service receives those fields.

## Send to Slack

Create or use a Slack app, enable Incoming Webhooks, and install a webhook into the desired channel
([Slack setup guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)).
In Settings → Webhooks choose **Slack channel (Incoming Webhook)**, paste its URL, Save, Test, then
Activate. This requires no bot process, relay or OAuth flow in cezar. Only `hooks.slack.com/services/…`
URLs are supported; GovSlack is outside this scope.

Messages contain an event label, project/task identifiers and status. Standard also includes the
available task title, questions/options and failure text; Minimal uses only the fields present in
the Minimal event. The test message includes the receiver name. Slack links and user-supplied text
are escaped and automatic mentions/link previews are disabled. An archived channel (HTTP 410)
disables an active receiver. Fixed Slack error codes appear in delivery diagnostics.

## Send to Discord

In Discord Server Settings → Integrations → Webhooks, create a channel webhook and copy its URL
([Discord setup guide](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)).
Choose **Discord channel (Webhook URL)**, paste the URL, Save, Test, then Activate. No bot is needed.
Cezar asks Discord to confirm that the message was saved before marking a delivery successful.
The returned message content is discarded.
The `discordapp.com`, `ptb.discord.com` and `canary.discord.com` hosts and `/api/v10/webhooks/…`
paths are accepted and saved as `discord.com/api/webhooks/…`. Queries, forum/thread parameters and
Slack/GitHub compatibility endpoints are not supported.

Messages use a coloured embed, bounded to Discord's limits. Minimal/Standard follow the same
privacy rules as Slack. Mentions are disabled, including `@everyone` and role/user mentions in
task text. A deleted webhook (404/code 10015) or invalid token (401/code 50027) disables an active
receiver; only a fixed vocabulary of Discord diagnostics is retained.

Both services use the shared queue, Retry-After/backoff, 72-hour delivery expiry and history.
Retained delivery storage keeps the canonical cezar event; history exposes metadata only.
The provider-specific message is rendered when sending. Changing destination type resets the receiver to Inactive. To switch back to a custom
receiver, rotate its signing key and copy it before testing/activating.
Treat each chat webhook URL as a password: anyone who has it can post. It is masked in the cockpit
and redacted from diagnostics. Chat deliveries carry no cezar signature headers and chat receivers
have no key reveal/rotation. Standard sends potentially sensitive content into the external workspace.
These are one-way notifications: no answers, approvals, message updates or task threads.

## Operation and boundaries

Private state lives below each project's `.ai/cezar/webhooks/`, with owner-only permissions on POSIX
(Windows does not apply filesystem modes) and verified git exclusion. One verified owner process sends for each project; another instance reports
unavailability instead of competing. Unsupported owner-identity platforms fail this optional service
closed. The owner verifies process start and boot identity through `/proc`
(Linux), `ps`/`sysctl` (macOS) or PowerShell (Windows). A probe that fails, times out or cannot read
an owner's own identity is unverified: cezar reports webhooks unavailable rather than claiming the
owner is dead and stealing the lock. On Linux a `/proc/<pid>` ENOENT read is itself proof of
absence only within the verified same PID namespace, and a PID above the platform's ceiling is provably absent on every platform; otherwise only
a complete, normally exited listing may show that an owner's PID is absent.

Ready deliveries drain after each completed attempt, within the project, host and global
limits. Maintenance skips unchanged state, and runs.json for unopened projects is parsed again only
when its file identity, size or timestamps change. Empty-recipient decisions retire once their source
is durably compacted, rather than consuming seven days of control capacity. Pause, edits and deletion
batch history and registry updates while preserving per-admission durable cancellation.

Capture is synchronous and non-throwing so webhook persistence cannot fail a task. It is not an
fsync transaction with the task index: a crash or disk error can lose capture. Standard source text
is a second redacted plaintext copy on disk. Copying state to another root resets receivers, keys,
identity and queue instead of sending another installation's notifications. Dry-run uses separate
state and does not send receiver traffic.

If an established project's failure identity index is missing or corrupt, retained sources and
attempts can restore only the episodes they prove. Health remains **degraded** across restarts
when completeness cannot be established; some later failure alerts may be unavailable. The
service does not invent historical alerts from current task metadata. New captures continue.

Only a server observing its project sees live transitions. A separate headless `cezar run` or
non-owner process can change a task without producing a lifecycle webhook. Lightweight discovery
of enrolled projects does not start task managers. A server that never opened a task context treats
persisted resume metadata as manual; a live scheduled notification requires a real manager timer.

After the owner restarts, queued attention/review notifications for a project whose task context
has not opened in the new process are permanently superseded as `owner_restarted` when checked
for delivery. This applies even if the question is still unanswered or the task still awaits
review. cezar does not start a task manager merely to validate a webhook. Opening the project
later does not resend these suppressed notifications; they are not a recoverable backlog.

`CEZ_WORKFLOW_WEBHOOKS` is independent: it enables an HTTP node **inside a workflow graph**, whose
result can affect graph execution. `CEZ_WEBHOOKS` observes task lifecycle outside the workflow.
They do not share receivers, signing keys, delivery IDs, retries or rate budgets. Pausing lifecycle
receivers does not stop workflow-node HTTP, and a lifecycle delivery failure cannot fail the task.

Use the receiver guide and JSON Schema from the same cezar release/tag you run. These are
repository documentation assets, not runtime imports or components of the npm service.

## Manual browser regression suites

Two additional fixture-based suites are **manual-only** and are not included in the
standard Vitest or CI gate. From the repository root, after installing dependencies
and building the application, run:

```sh
npx --no-install e2e run --config packages/web/e2e/chat-webhooks.config.ts
npx --no-install e2e run --config packages/web/e2e/webhooks-review.config.ts
```

The chat suite covers native receiver setup; the review suite covers delayed UI
actions and delivery controls. Both use fictional credentials and a server forced
to `CEZ_DRY_RUN=1`. They require the e2e browser runtime and do not verify live
Slack or Discord delivery.
