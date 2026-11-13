# Mattermost extension

A reference fixture, not a supported integration: a standalone fourth chat provider
using only the public SDK and the [Mattermost v4 API](https://docs.mattermost.com/api). Build with `npm install`
and `npm run build`, then select this folder in Settings → Extensions,
preview/install, and approve it for a project. This code runs as your local user.

Open Integrations → Mattermost and enter your HTTPS server URL and a dedicated
bot access token. Open the returned direct-message link and send the displayed
`cezar start <code>` message. Approve through the normal Cezar pairing flow.
Use `cezar tasks`, `cezar reply`, and `cezar task <prompt>`; replies to bot posts
also use the core task-control flow. Group setup requires private verification
and membership checks. No native slash-command registration, public inbound
listener or additional setting is needed.

Confirmation and question choices appear as labelled, copyable commands, for
example `Confirm: cezar choose <opaque-data>`. Send the complete command shown
under the choice in the same chat. These are text equivalents of core buttons:
the adapter sends the original preview receipt, the actual chat and the actual
sender back to core. Core checks the user, chat, permissions, task state and
one-use capability before doing anything. Cancel consumes the same pending
action as Confirm. Confirmation normally expires after two minutes; question
choices may last up to fifteen minutes. Restart invalidates outstanding choices;
send the original command again. Old choice text can remain visible, but cannot
authorize an expired or used action. Do not edit or share choice commands.

The bot reads at most 20 joined channels; use a dedicated, low-volume bot with
fewer channels. It declares `receiveModel: "ordered"`: its `receiveSession` reads the
host's checkpoint, fetches at most one page of 100 posts and accepts its rows in
order, then polls again (after half a second when the page was empty). Pages
are read newest first using page numbers: neither timestamps nor post IDs are
treated as unique time cursors. The adapter durably stages the whole channel
catch-up before delivering any of it; incomplete scans return no events and
resume on the next poll, including after a worker restart. Once the lower
time boundary is reached, all staged posts are sorted oldest first (post ID
breaks equal-timestamp ties deterministically across pages), assigned increasing
numeric sequences, and delivered in batches of at most 100. The adapter stores
staged posts, pending/ready batches, page position, overlapping time boundary and
seen post IDs through SDK storage before accepting anything. The host
checkpoints each sequence only after core acceptance. Unacknowledged rows replay
after a restart, including a partially acknowledged page. A full page of equal
timestamps advances to the next page rather than starving its tail.

This is bounded catch-up, not an exactly-once or snapshot guarantee. Mattermost
offset pages can shift during concurrent deletions; backdated imports below a
completed scan's time boundary are not recovered. New posts during a scan are
covered by the next overlapping scan. At 10,000 retained post IDs per channel,
or the host's storage limit, polling fails rather than silently evicting IDs.
Core can reject commands older than its freshness window. Check task state in
the cockpit before resending after a delivery failure; this example is not a
bulk-history importer. Removing extension data resets its local polling state.

Disable stops the worker and releases bot ownership without deleting pairings.
Re-enable uses the same IDs, encrypted credentials and grants. Disposal aborts
the adapter's HTTP requests, and each poll shares a 20-second HTTP deadline.
When the host supplies an operation context, every HTTP request rechecks that the
operation is active after asynchronous preparation and forwards cancellation to
its own request controller. Concurrent operations keep separate cancellation
signals.
Cancellation cannot undo a request already sent to Mattermost; its result may
be uncertain.

Run `npm test` for compiled-adapter tests with mocked Mattermost HTTP, including
confirmation transport, 101/1,001 equal-time posts, partial acknowledgment,
restart, later arrivals and failed storage writes. It does not exercise a live
Mattermost server.

A chat provider has no placement: `location` applies to panels and commands only,
and this extension declares neither. It appears under Settings → Integrations,
never in the sidebar, command palette or a task's Extensions view.
See `../project-summary` for placements.
