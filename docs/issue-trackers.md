# Jira Cloud and Linear

Cezar can browse a Jira Cloud project or a Linear team and hand a selected issue to an
agent. Each local project has one saved tracker connection. GitHub remains independent.
Browsing performs no vendor writes. Enabled event automations can launch agent workflows as described below. The visible issue list checks its first page every 60 seconds; it stops when hidden or closed.

## Connect

Open the project's **Settings → Issue tracker**, then **Configure Jira credentials** or
**Configure Linear credentials**. Jira needs the site URL, account email and API token;
Linear needs an API key. Use a token with read access restricted to the intended data.
Save it, choose **Browse**, search for the project/team, then **Connect**. Discovery is
paginated; **Load more** reaches later results. No server restart or environment editing
is needed. Saving credentials is local; Browse/Connect verifies vendor access.

Each cezar project has one credential connection and one selected tracker scope. Configuring
project A does not configure project B. Replacement creates a new connection identity and
requires selecting a scope again, even if the vendor IDs happen to match. Failed credential
storage preserves the previous credentials. Failed scope selection preserves the previous
association, but an association tied to replaced credentials remains disabled until reconnected.

**Disconnect** removes the selected scope while retaining the project's credentials for reuse.
**Remove project credentials** deletes the local credential record and disables reads; it does
not revoke the token at the vendor. The old scope metadata may remain stored, but Settings shows no connected tracker without matching credentials.
Both actions work offline. Remove credentials before unregistering or moving a repository;
otherwise its private credential file remains until explicitly removed. Use `cez tracker-connections list`
to inventory retained records and `cez tracker-connections remove <id>` to delete a selected
64-hex record ID, including a record whose repository is gone. These local commands require no
running server or vendor access and never print secrets. Credentials are not
copied when a repository is copied or moved to a new path.

### Storage and isolation

Secrets are write-only through the API: read responses expose only connection ID/provider.
They are stored as encrypted managed records in
`~/.cezar/tracker-connections/<sha256(canonical-project-path)>.vault` (or the selected
`CEZ_HOME`), with directory mode `0700` and file mode `0600` on POSIX. The whole credential
record is encrypted with the vault's AES-256-GCM data key, held in the OS keychain or the
private `secrets/.key` fallback. Possession of both the fallback key and ciphertext allows
decryption; this is not isolation from another process running as the same OS user.
Tracker credentials are not editable as generic Secrets and cannot be assigned to checks.

Credential replacement through Settings still rotates the connection identity. Missing storage
never prevents boot; invalid storage reports a recoverable error. The form clears its secret
fields after saving; read APIs expose only connection metadata. No repository `.env` is loaded.
A managed `.gitignore` excludes connection files from ordinary staging, including with a local
`CEZ_HOME`; already committed files and forced staging are not protected.

Mutations for the same record are serialized across processes. Unsupported future formats are not
automatically overwritten. Explicitly replacing credentials in Settings or removing a listed
record is a user-requested mutation; inspect the local inventory before doing so.
Local deletion does not revoke the vendor token.

Tracker credentials are encrypted at rest. Task history and fetched issue-context files are not.
OS permissions protect against other OS users, not agents or processes with the same user's filesystem privileges. Project scoping is an application
boundary, not a tenant sandbox or a compliance certification. Hosted access must use the
existing authenticated HTTPS deployment. Ticket descriptions enter local run history and
the selected AI backend when you launch; follow your organization's data/retention policies.

Candidate discovery, adapter/cache instances and signed cursors are project/connection-bound.
Replacing/removing credentials rejects late results from the old connection. A token's vendor
permissions remain an upper bound: a broad token can discover many vendor scopes within the
project where it was explicitly configured. Separate narrowly scoped tokens are recommended.

### Existing environment-based connections

`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` and `LINEAR_API_KEY` in the server
environment or a repository `.env` are not read by this integration. They appear only in
legacy per-project `.env` connection files, which migrate to encrypted `.vault` records. Existing saved scopes stay visible, but reads fail closed until you configure
credentials and reconnect in that project's Settings. There is no silent migration or fallback
to a global key. `CEZ_DRY_RUN=1` remains an explicitly selected credential-free demo; it cannot
save real credentials and never contacts vendors.

## Credentials and read permissions

Jira supports Cloud sites at `https://<site>.atlassian.net`, using account email plus
a scoped or unscoped API token. Data Center/custom hosts and OAuth are outside this
integration. Use the site URL, not the API gateway. Cezar discovers the cloud ID and
tries the scoped-token gateway first, with one site-origin fallback on authorization
failure. [Create, expire and revoke Atlassian tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/).

The account needs **Browse projects** and any applicable issue-security access.
The reads below use the recommended classic **`read:jira-work`** scope. When
choosing granular scopes instead, the endpoint requirements are:

| Read | Granular scopes |
| --- | --- |
| Project search and direct project lookup | `read:issue-type:jira`, `read:project:jira`, `read:project.property:jira`, `read:user:jira`, `read:application-role:jira`, `read:avatar:jira`, `read:group:jira`, `read:issue-type-hierarchy:jira`, `read:project-category:jira`, `read:project-version:jira`, `read:project.component:jira` |
| Enhanced issue search | `read:issue-details:jira`, `read:field.default-value:jira`, `read:field.option:jira`, `read:field:jira`, `read:group:jira` |
| Direct issue lookup | `read:issue-meta:jira`, `read:issue-security-level:jira`, `read:issue.vote:jira`, `read:issue.changelog:jira`, `read:avatar:jira`, `read:issue:jira`, `read:status:jira`, `read:user:jira`, `read:field-configuration:jira` |
| Issue comments (required for task context) | `read:comment:jira`, `read:comment.property:jira`, `read:group:jira`, `read:project:jira`, `read:project-role:jira`, `read:user:jira`, `read:avatar:jira` |
| Available transitions (required for task context) | `read:issue.transition:jira`, `read:status:jira`, `read:field-configuration:jira` |

These are the declared endpoint scopes in Atlassian's [OpenAPI contract](https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json);
see [project reads](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/),
[enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/),
and [issue lookup](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).
Browsing does not call `/myself`. Enabled Jira automations read the account timezone through
`GET /rest/api/3/myself`, which additionally requires classic **`read:jira-user`**. Its granular
scopes are `read:application-role:jira`, `read:group:jira`, `read:user:jira`, and `read:avatar:jira`
(already included in the aggregate table above). See [current-user permissions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/#api-rest-api-3-myself-get).
These reads require no write scope. Task context always reads comments and available
transitions, even for a read-only automation; granular tokens need those scopes too.
For explicitly authorized writes, retain the read scopes and additionally grant classic
`write:jira-work`, or the relevant granular write scopes:

| Authorized action | Additional granular scopes |
| --- | --- |
| Post comment | `write:comment:jira` (the comment read scopes above are also required) |
| Change status | `write:issue:jira`, `write:issue.property:jira` |

See [comment endpoint permissions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
and [transition endpoint permissions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).
Provider project permissions and workflow restrictions still apply. Granting token scopes
does not enable automation writes: select those separately in the cockpit editor.

For Linear, create a personal API key with **Read** permission and access to the desired
team. It reads organization identity, team discovery/direct lookup, issue search/list/detail
and the issue's state, creator, labels, comments and team workflow states. Reading needs no
create/update/admin permission. If an automation is allowed to post comments or change status,
the key also needs write access to that team's issues and comments (a **Read**-only key makes
such an operation fail; cezar reports it and does not retry).
[Create, restrict and revoke Linear keys](https://linear.app/docs/api-and-webhooks).
The [GraphQL API](https://linear.app/developers/graphql) describes key authentication and
[rate limits](https://linear.app/developers/rate-limiting).

Rotate or renew an expired token using Replace credentials in project Settings, then reconnect the scope.
Changing the Jira site or Linear organization requires explicitly reconnecting the project;
saved IDs are never silently retargeted.

## Agent context

Handing off a ticket fetches its detail description, including text beyond the list preview.
The prompt includes the identifier, title, source URL, description snapshot, selected skills,
supplemental context and your instruction. The snapshot persists in normal run history. If no agent backend is ready or its authentication
cannot be checked, the handoff explains the problem and links to **Configure providers**;
your draft stays in place while you restore access.

Descriptions become eligible for refetch after one minute; this does not periodically refresh an
open detail view. Ordinary background refetches preserve the composer. A failed detail read blocks
launch until a successful **Retry**, while preserving your instruction and selections. The displayed
content is a snapshot, not a guarantee of the vendor’s current state. While connection or scope metadata is being refreshed,
launching and dragging tickets are temporarily disabled. Reads carry the captured source and
connection identity, so changing a connection cannot mix another source’s ticket into the current
draft. An unchanged scope preserves the draft; a changed scope clears it. Submitting the same search
again refreshes its results from page one. Detail refetches revalidate with the provider.

Comments, attachments and custom fields are not fetched. Previews are capped at 8,000
characters and detail descriptions at 60,000. If conversion drops unsupported content or
the description reaches its cap, the composer discloses the limitation and requires
acknowledgment; you can add supplemental context. Final prompts over 100,000 characters
must be edited before launch. Tracker credentials are never forwarded to agents:
a source link does not grant the agent access to omitted context.

### Credential migration

On first connection read, managed `.env` records migrate to encrypted `.vault` records,
preserving connection IDs and project associations. Plaintext is deleted only after
successful encrypted readback. If the home is read-only or the key is unavailable,
a valid legacy record can remain readable without migration. Authoritative ciphertext
never falls back to stale plaintext.

A non-secret `.migrated` marker survives removal, including an interrupted migration,
so this version will not accept stale plaintext written by an older process. Settings
can replace malformed legacy data but refuses unreadable authoritative ciphertext.
Stop old cezar processes before upgrading. Older versions cannot read migrated records;
use a separate home and reconfigure credentials when downgrading. See
[secret recovery](reference.md#secret-storage-and-recovery) for key compatibility.

Both record formats have a 32 KiB limit. Encryption overhead can push an unusually
large legacy credential past that limit; migration then reports unavailable and keeps
the plaintext unchanged. Disconnect retains credentials; explicit removal deletes them
locally without revoking the vendor token.

## Recovery

| Symptom | Action |
| --- | --- |
| Connect disabled | Save credentials for this project. Jira URL must be a Cloud site origin without a path, embedded credentials, query or fragment. |
| Access denied | Check token expiry, read scopes, account permissions and selected team/project. Replace credentials in this project and reconnect. |
| Source discovery unavailable | Check connectivity and the Jira site URL; retry. Saved credentials remain local; no new scope association is saved when discovery or validation fails. |
| Source changed | Reconnect deliberately to the new site/workspace in Settings. |
| Rate limited | Wait for the indicated cooldown before Retry. Refresh does not bypass vendor cooldown. |
| Saved connection but no credentials | Configure project credentials and reconnect, or disconnect locally. |
| Expired result page | Restart the search; cursors are bound to the source, scope, query and server process. |
| Cannot save/disconnect scope | Restore write access to the project's `.ai/cezar` directory and retry. |
| Cannot save/remove credentials | Restore owner-only write access to `CEZ_HOME/tracker-connections` (default `~/.cezar/tracker-connections`) and retry. |
| Secrets data key unavailable | Unlock the keychain or follow [secret recovery](reference.md#secret-storage-and-recovery); do not delete values merely because the keychain is locked. |

Deleting `.ai/cezar/tracker.json` removes only the non-secret connection. Ticket content
is not mirrored there, and already-created run snapshots remain in run history.

## Adding another provider

Developers and coding agents should follow [Adding an issue tracker](adding-issue-tracker.md)
for the extension points, invariants, implementation checklist and verification gate.

## Automatic list checks

Opening a configured Jira/Linear list starts a shared server-side check of the first 50 matching
issues every 60 seconds (from completion of the previous request). Hidden browser tabs, mobile detail views and
closed lists hold no observation demand. Desktop detail keeps the adjacent list visible and observed. Multiple tabs with the same project, connection and
filters share the check. Returning to a stale view checks once; it does not replay missed ticks.

The first page updates automatically. After **Load more**, detected first-page changes produce
**Show changes**; accepting returns to the fresh first page while retaining filters. **Refresh**
explicitly checks and returns to page one. This is not a full-backlog synchronization: changes
confined to later pages may not be detected until those pages are loaded again.

**Last checked** is the time of the last successful fresh provider response, even when its data
is unchanged. It describes the first-page check, not necessarily the displayed paginated snapshot.
Errors keep the displayed rows and last successful timestamp. Retries back off up to five minutes
and respect longer provider cooldowns. Timestamp/spinner animations respect reduced motion.

Local mode uses Cezar's shared WebSocket for opaque version signals and project-scoped HTTP for
snapshots. Remote mode uses authenticated HTTP long reads, with existing SSE configuration
reconciliation; it opens no browser WebSocket. No new configuration or credential access is needed.

## Issue browser layout

Jira and Linear reuse GitHub's split-pane shell: compact issues on the left, full detail on the
right. Mobile shows one pane at a time with a Back to the list link. Workflow and skills pickers
are shared with GitHub. Workflow/engine/skills choices persist between rows; per-issue instruction
drafts stay in memory until leaving the browser or changing project/association. Automatic list
updates preserve the open issue. Explicit filters reset only the implicit first-row selection;
an issue selected through its URL remains open. Snapshot limitations still require acknowledgment.

## Event automations

After connecting a project tracker, open **Automations → New automation → When Jira / Linear
changes**. Select an advertised event and, for Jira status changes, one or more destination
statuses. The default check interval is 30 minutes. Use the same workflow, backend and instruction
controls as other automations. Save paused, preview matches, then enable. Preview results appear
in the execution log and do not launch tasks. Enabling starts from the current time, not the backlog.

Optional **Required labels** filters candidates before starting an agent. Click a label to
select it; click again to deselect. Every selected name must be present (case-sensitive).
No selection means no label filter. The picker has no text input. Labels come from tasks
in the connected project/team, including closed tasks; **Load labels from more tasks**
fetches another page of 50 tasks. This is not a complete vendor catalog and excludes
inaccessible tasks. Previously saved selections remain visible and removable even when
missing from loaded tasks or when loading fails. Changing project/source/connection isolates
the suggestion cache. This works for Jira and Linear without label-history support.
API/JSON uses `trackerTrigger.requiredLabels`; CLI uses repeatable `--require-label bug`.
The filter uses labels in the polled issue snapshot, not their historical state at creation.
Adding a label is not a trigger and does not scan old skipped tasks; a recent creation can
still be reconsidered during the existing two-minute overlap. Preview uses the same filter.

Jira currently supports issue creation and status changes. Linear currently supports issue
creation. Jira label changes and Linear status/label changes are not advertised: their complete
history semantics have not been verified. The UI explains these limitations rather than treating
a currently matching status as a transition.

Changing the event or connection/scope of an enabled tracker automation establishes a new
current-time baseline; it does not replay the new source’s backlog. Editing its prompt or
status/label eligibility filters preserves the existing checkpoint and pending progress.
Changing the event or connection/scope while paused clears incompatible preview progress without
enabling the rule. Preview uses its bounded lookback; enabling still starts from the current time.

If local execution state is lost, the next check records a new baseline and a visible continuity
gap rather than replaying the old backlog. If an individual queued Jira issue disappears during
history pagination, its history is skipped with a visible gap entry; other issues keep progressing.
Authentication failures and provider outages still stop the scan and retry under backoff.
Jira automation discovery reads the authenticated account’s timezone through `GET /rest/api/3/myself`
(once per scan, within the existing request limit); the token must allow this profile read. If the
timezone cannot be read, the scan retries without advancing its checkpoint. Around daylight
saving changes, discovery includes a wider window; exact event timestamps still control matches.

At agent launch and continuation, cezar fetches current issue details and accessible comments
through the vendor API and saves the context for the agent. Missing or incomplete context is
reported explicitly; if it is required for the task, the agent is instructed to stop and report
the blocker. The agent can refresh its bound issue with `cez tracker read`. Event metadata
alone is not the complete issue description.

Long history scans can span multiple polling intervals. Completed pages are checkpointed when
the scan yields near its time budget, so a slow sequence of successful reads does not restart
from page one each time; a request that cannot complete within the hard deadline still fails.

The CLI supports the same flow, for example:

```sh
cez automation add --kind tracker --name 'Jira work' --on issue.status_changed --to-status '<status-id>' --every 30m --prompt 'Implement {{tracker.key}} and prepare a pull request.'
cez automation check '<automation-id>'
cez automation enable '<automation-id>'
```

Use IDs from the project options picker/API, not display names. Copy as CLI preserves the association and event filters as JSON. Tracker exports with write
grants or unreviewed legacy access are created paused and read-only; review the prompt and grant
required writes in the cockpit editor before enabling. The existing automation is unchanged. Credentials remain project-bound; rotation or a changed source
requires updating the automation with the new connection. A legacy status-only definition stays
visible but must be configured with an explicit event before it runs.

An automation launches an ordinary agent workflow. The agent can follow instructions to prepare
a PR or update a vendor status; the scheduler itself does not guarantee these outcomes or merge
PRs. Tracker automation agents receive issue context and limited operation capabilities, never
the vendor token. Connection changes invalidate the captured binding. Cezar redacts known secrets
from run output, but does not sandbox a trusted agent against reading local files or sending network requests.

Delivery receipts for tracker events are retained while the automation definition exists, including
when paused. This protects resuming an unfinished historical scan from launching old events twice,
but disk usage and receipt lookup cost grow with the number of distinct events. Deleting the
automation lets receipts older than 90 days expire through normal compaction. This is a conservative
interim retention policy; GitHub and schedule receipt retention is unchanged.

## Tracker automation access

Tracker automation agents no longer receive Jira/Linear tokens. New automations explicitly
record `trackerTrigger.access: { "version": 1, "writes": [] }` for read-only access. In the
editor, comments and status transitions can be authorized individually. Those checkboxes permit
the agent to execute that operation on the bound issue without another approval. Vendor token
permissions must also allow the operation; prefer the smallest scopes and team/project access.

Automations created before this change show **Needs review** in the automations list and log
one error; they stop polling (keeping their checkpoint) until you open the editor, check the
prompt for unsupported operations, confirm read-only access, tick any writes you want and save.
Polling then resumes where it stopped; when its last successful poll is older than the
automation's lookback (`lookbackDays`, 7 by default) it starts from a current-time baseline
instead, so the backlog is not launched. Tasks started before the change still start and continue,
with a note that tracker commands are unavailable to them. Labels, assignees and arbitrary vendor
API writes are not supported by this interface. No keyword matching infers old prompt permissions.
Write grants are given only in the cockpit editor: `cez automation create|update` (the agent's
CLI) keeps or narrows them and refuses to add one.

At actual agent launch and continuation cezar fetches the description, status, labels and
accessible comment pages, writes them to `.ai/cezar/runs/<run>.tracker-context.json` and points
the agent at that file. Content it cannot render exactly (Jira mentions, media, panels, smart
links), a description over 200,000 characters, comments past 100 pages or over the 500,000
character budget (the oldest are dropped) are listed in the context's `limitations` instead of
blocking the run. If the tracker cannot be read at all, the agent still starts and is told the
context is unavailable. Attachments, linked issues and Jira custom fields are not included. The
agent must stop and report when missing data matters. Jira comments are posted as plain text.
The browser's existing issue preview remains a separate, smaller read described above.

A tracker task can use `node "$CEZ_BIN" tracker read` to refresh its issue. Authorized writes:

```sh
node "$CEZ_BIN" tracker comment --id <stable-UUID> --body-file comment.md
node "$CEZ_BIN" tracker transition --id <stable-UUID> --transition <id-from-context> --expected-status <current-status-id>
```

The session capability binds these commands to one run/project/issue. It is issued for an active execution, replaced on continuation/restart,
rejected for terminal runs and not delegated to children; only the first parallel variant has
write access. Connection rotation/removal invalidates subsequent operations. Local management
API and same-user filesystem access remain trusted; this is not a hostile-process sandbox.
The commands require the local cockpit and never fall back to exposing a vendor token.

Persist the operation UUID before calling. Retry with the same UUID and identical payload:
completed receipts replay without resending, different payloads are rejected, and uncertain
outcomes stay `unknown`. A failure before the request was sent (status changed, expired task,
connection changed) is `rejected` and frees the UUID for a retry. Writes to one issue queue for
up to 20 seconds. A recorded result replays even after the connection was rotated. Receipts live
beside run state and are deleted with the run. Inspect the issue after an unknown result; do not
invent a new UUID to retry blindly. A dead process's lock can be reclaimed, but its unknown
receipt is retained. Status preconditions detect intervening changes observed
before sending; there is no claim of atomic compare-and-set at the vendor. Transitions requiring
additional Jira fields are unavailable. Neither comments nor transitions promise exactly-once
remote effects.

Pausing or editing an automation governs future launches. Already started runs retain their captured operation permissions; cancel a run to stop new operations from it, or disconnect/rotate the connection to revoke all old bindings. An already submitted vendor request may still finish.
