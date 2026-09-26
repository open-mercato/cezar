# Tracker list automatic refresh

Goal: Check the visible Jira/Linear list every 60 seconds, automatically update page one,
and preserve loaded later pages until the user accepts an update banner. No commits or PR changes.

Design: One bounded in-memory watch per canonical project/connection revision/association/normalized
filters. No vendor work at boot or watch registration; subscribers start the publisher, the last
subscriber stops it. Local clients subscribe via the existing trusted WS bus to an opaque version
signal, then fetch the snapshot through the project API. Remote clients use abortable authenticated
HTTP long reads (25s timeout), never a new browser WebSocket. Both share the same scheduler.
Idle watches expire after 120s; stale project configuration terminates watches and drops old results.
Only successful fresh first-page provider requests advance checkedAt. Errors retain the previous
stamp and visible data; exponential retry and provider Retry-After apply. Only50 first-page issues
are checked; deeper pages are not claimed fresh. Visibility, navigation, filters and project changes
release demand. In-flight bounded provider requests may finish but cannot restart an idle publisher.

## Implementation plan
- [x] Add contract schemas and a tested demand-driven watch service; removable WS registrations.
- [x] Chain scoped watch registration/read/refresh routes, API client and exact contract/route checks.
- [x] Add visibility-bound UI controller, first-page update/pagination banner, refresh button and
      successful-check timestamp using existing motion-safe styles. Preserve detail/composer.
- [x] Test timer bounds, shared demand, cooldown, disconnect/revision races and stale UI responses.
- [x] Update local docs; run focused/full tests, typechecks, production build and browser verification.

Validation commands use TMPDIR=/tmp. No new dependency or mandatory configuration.
