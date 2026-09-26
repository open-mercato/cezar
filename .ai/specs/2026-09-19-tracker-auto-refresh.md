# Visible issue-list automatic refresh

Local extension to Jira/Linear browsing. User selected automatic first-page updates with
pagination protection. Implementation and documentation remain local; no commits/PR updates.

## Behavior

- Opening a configured list starts demand; check its first 50 matching issues every 60s after
  the preceding completion. Multiple tabs observing the same scope share the check.
- Auto-apply when only the first page is loaded. After Load more, preserve rows and offer Show
  changes; acceptance replaces pages with the latest first page and keeps filters.
- Refresh explicitly requests a new first page and resets pagination only after success.
- Last checked is a server timestamp for a successful fresh vendor response, including an
  unchanged result. Display local date/time, checking spinner and 200ms motion-safe fade.
- Errors retain displayed rows and successful timestamp; retries back off 60/120/240/300s and
  respect longer Retry-After. This does not claim to detect changes confined to later pages.

## Architecture and lifecycle

`TrackerWatches` owns bounded ephemeral watches keyed by canonical project context, saved
association/connection revision and normalized query/state/labels. Registration performs no
vendor I/O. Subscribe 0→1 arms the timer;1→0 clears it. Hidden views, navigation and filter/project
changes unsubscribe. Desktop split-pane detail retains demand while its adjacent list is visible;
mobile detail hides the list and releases its demand. A completed request cannot rearm an unobserved, expired or invalidated
watch. Return from hidden state checks once if stale, without catch-up. Idle watches expire120s
later and remove their dynamic topic. At most100 watches exist per server.

Project-scoped chained routes and Zod contracts expose registration, snapshot/long-read and
manual refresh. Local mode reuses the shared trusted WS bus for `{version}` signals only;
actual ticket data uses guarded project HTTP. Topic errors trigger handle re-registration after
server restart/expiry. Remote mode uses authenticated HTTP long reads (change/abort/25s timeout),
not a browser WebSocket. Both transports own demand on the same publisher. Existing workspace
SSE still reconciles configuration; visibility/SSE reconciliation does not refetch every loaded
page of an observed list.

Before and after vendor reads, revalidate connection and association. Configuration replacement,
removal or project removal invalidates watches; old in-flight results cannot be published.
Watch IDs cannot read another project's data. Cursor checks and vendor request bounds remain
inside existing adapters. Browser effects capture project scope and abort/drop late responses;
version checks include manual refresh, including after awaited query cancellation.

## Validation

Server tests cover cadence, shared normalized demand, idle expiry, no overlap/catch-up,
project boundaries, configuration races, cooldown, remote cancellation and removable topic
lifecycle. Contract tests pin exact route response/input inference. UI tests cover auto-apply,
pagination acceptance, hidden-view cleanup, remote transport, error timestamps, filter changes
and delayed manual refresh. Production browser evidence uses a deterministic local vendor
boundary and actual 60s intervals. No live Jira/Linear credential is required for this feature.
