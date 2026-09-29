# Adding an issue tracker

Use this guide when asking an agent to add a compiled-in, read-only issue tracker.
The Jira and Linear integration provides the reusable path; a new provider should
not need its own HTTP route family, React screen, persistence file, or task composer.
For connecting an existing provider, see [issue-trackers.md](issue-trackers.md).

## Scope and invariants

A tracker exposes this journey: discover a scope → connect it to a local repository
→ browse/search tickets → read the full description → launch an existing workflow
with a description snapshot and the user's instruction.

One repository has one saved tracker association. Each project has its own
credential connection, stored outside the repository. Multi-account selection, OAuth, multiple associations,
vendor writes, comments/attachments/custom fields, and background synchronization
are separate design changes. Do not quietly pretend the current connection model
supports them. A provider unable to support search/filter semantics needs an explicit
design decision, not silent local filtering of the first page.

GitHub remains a forge integration, with issues plus PRs, checks, comments and merge
features. Do not put an issue-only provider into `ForgeDriver`, change GitHub's
numeric API shapes, or make GitHub users manually configure what git remote/gh
already discovers. Sharing GitHub issue behavior later is a separate migration.

Follow the root AGENTS.md, especially zero-config, the HTTP contract and workspace
boundaries. No mandatory user-authored configuration file; `.env` is not auto-loaded.
No vendor requests during construction, boot, health, or project classification.
Reads begin only on user demand. Credentials stay on the server.

## Files to read first

| Purpose | Repository path |
| --- | --- |
| Boundary schemas and provider identity | `packages/contract/src/tracker.ts` |
| Complete provider behavior | `packages/cezar/src/server/tracker/types.ts` (`TrackerProvider`) |
| Configuration and registration | `packages/cezar/src/server/tracker/connections.ts`, `index.ts` |
| REST and GraphQL examples | `packages/cezar/src/server/tracker/jira.ts`, `linear.ts` |
| Timeout, failures, limits, cache, cursors | `packages/cezar/src/server/tracker/transport.ts`, `cursor.ts` |
| Local association | `packages/cezar/src/tracker-association.ts` |
| Generic API | `trackerCandidatesRoutes` / `trackerRoutes` in `packages/cezar/src/server/server.ts` |
| Display metadata and readiness mapping | `packages/web/src/lib/tracker-providers.ts` |
| Shared UI and task composition | `packages/web/src/routes/tracker/`, `packages/web/src/lib/tracker-task.ts` |

## Implementation checklist

1. **Define vendor semantics first.** Consult the vendor's official API documentation.
   Specify minimal read permissions, stable account/source and scope IDs, ticket ID,
   canonical web URLs, active/done mapping, label semantics, ordering, search, pagination,
   limits and description format. Verify with a real test account when available; clearly
   distinguish live evidence from mocked tests. Never mutate that account without authorization.
2. **Extend `trackerKindSchema`.** Keep the finite Zod enum. Do not change it to an
   arbitrary string to bypass validation. Data shapes belong in the contract with inferred
   types; contract and API client remain Node-free. Extend shapes only for a demonstrated
   need. Ticket detail IDs must fit one URL segment; reserved route names are rejected by
   `trackerItemParamsSchema`. Item and source links must use HTTPS.
3. **Implement `TrackerProvider`.** Add `server/tracker/<provider>.ts` with discovery,
   association resolution, driver construction, cache invalidation, and driver operations
   `listIssues`, `searchItems`, `getItem`. Validate vendor JSON with Zod. Resolve canonical
   names/URLs server-side; never trust a client-authored URL or scope name. Verify source
   identity and scope membership for every read, including direct ticket lookup.
4. **Reuse the transport discipline.** Use bounded requests with a deadline spanning the
   whole operation, response caps, controlled errors, cooldown on throttling and no unsafe
   redirects. Preserve error distinctions: unavailable is not an empty list, and missing
   ticket is not an outage. Cache identities must include source, scope and query; cursor
   reuse across sources/scopes/queries must fail. Detail requests must revalidate the vendor:
   browser caching already limits normal reads; a second server cache must not renew an old
   snapshot after explicit Refresh. Keep in-flight deduplication and cooldown. Never log raw credentials, headers or
   upstream error bodies. Map vendor-specific errors inside the adapter.
5. **Wire project credentials and registration.** Extend the managed dotenv codec in
   `tracker/connection-env.ts` (strict key inventory, literal round-trip, private digest and revision).
   Never load project credentials into `process.env`; use the existing private per-project store.
   Manual edits must not keep an old provider cached. Preserve canonical-root/filename validation,
   per-record mutation serialization and the local inventory/remove CLI. Do not introduce
   prototype-format migrations or removal tombstones.
   Extend the discriminated write-only
   `trackerCredentialsSchema` and the factory map in `createTrackerService`. Missing credentials
   disable only that project connection. Never use host-wide environment keys as fallback.
   Use `TrackerConnections` for atomic owner-only storage outside checkouts; never persist
   credentials in `tracker.json` or return them through GET. Replacement creates a fresh
   connection ID; association selection must carry that ID and stale selections must fail.
   Custom/self-hosted origins require explicit origin validation and credential routing.
6. **Use project readiness.** `/tracker/connection` exposes ID/kind, demo mode and controlled local-storage
   diagnostics, never secrets. Settings reads this project-scoped endpoint. Do not add global
   health flags for provider readiness. Discovery, result caches and signed cursors must
   be namespaced by project and connection revision; old in-flight results cannot be released
   after credential removal/replacement or scope reassociation/disconnection. Add fixtures to `project-isolation.test.ts` as necessary.
7. **Add UI metadata and credential fields.** Extend `TRACKER_PROVIDERS` with display
   label and scope terminology. Add the provider's write-only credential fields in Settings,
   clearing them on save/error/cancel/project change and never using browser persistence.
   Provider names and scope labels in navigation/browsing remain metadata-driven. Metadata,
   provider factories and dry-run fixtures must be exhaustive over `TrackerKind`.
8. **Add offline fixtures.** Extend the exhaustive `FIXTURES` table in `dry-run.ts` and
   the service's dry-run registration. Use enough rows to cross page boundaries, long and
   lossy descriptions, and deterministic source/scope IDs. Fixtures must never contact
   real services or inherit their credentials. Extend the explicit provider list in
   `dry-run.test.ts`; its current assertions include Jira/Linear-specific ticket IDs.
9. **Check the task handoff.** Preserve identity, source URL, description, loss disclosure
   and the final user instruction. Exercise the actual `extractTaskRefs` parser: numeric
   tracker IDs must not become GitHub issue numbers. The composer uses `tracker ticket [ID]`
   to avoid that heading collision. This is not a complete provider-aware reference model:
   explicit references in titles/descriptions/instructions still use existing parsing.
   Do not claim native tracker chips or synchronization from a prompt snapshot alone.
10. **Update documentation.** Document credential fields and setup in `docs/issue-trackers.md` and the README.
    Do not introduce global token environment variables for a project-scoped connection. New or
    changed `CEZ_*` variables must follow the root env-contract rule. No secrets in examples,
    screenshots, plans or test recordings.

## Verification gate

Use realistic, schema-validated vendor fixtures and the existing adapter tests as examples.
There is no automatic universal adapter conformance suite yet: adding an adapter does not
make all these behaviors tested by itself.

- Discovery beyond page one; canonical source/scope validation; account changes; disconnect
  while offline; foreign ticket lookup rejected; malformed and cross-scope cursors rejected.
- Listing and search beyond the first page; active/all and AND-label semantics; empty vs
  unavailable vs not-found; auth failure; throttling/cooldown; timeout and malformed payload.
- Full detail differs correctly from list excerpts; truncation and unsupported content are
  disclosed and acknowledged before launch; custom instructions remain last.
- No network on boot/health/project list; missing credentials leave other providers working;
  default child environments do not receive the new credentials; errors expose no secrets.
- Correct provider name, scope terminology and readiness in Settings, navigation and detail;
  connect, reload, search, select, launch and disconnect through the actual generic routes.
- Numeric and prefixed IDs through composer **and downstream task-reference extraction**;
  preserve legitimate GitHub references. A regression test must fail without its fix.
- Contract parity in both directions, typed request bodies, scoped/unscoped route parity;
  all-workspace typecheck, appropriate tests, production build/package validation and browser
  evidence for changed flows. No new endpoint is normally needed; if one is necessary, use
  chained route builders and validation middleware and update the API inventory.

Useful starting commands (from the repository root):

```sh
TMPDIR=/tmp npx vitest run packages/cezar/src/server/tracker packages/cezar/src/server/tracker-api.test.ts packages/web/src/lib/tracker-task.test.ts packages/web/src/routes/settings/tracker-section.test.tsx
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm test
TMPDIR=/tmp npm run build
```

Use isolated `CEZ_HOME`, repositories and disposable ports for browser/live verification.
The main developer checkout and real user state are not test fixtures. Record commands,
results and limitations. Respect the task's publication policy; verification is not
permission to push, open a PR, upload evidence, or write to a vendor.

## Brief to give an agent

> Add read-only support for <provider> following `docs/adding-issue-tracker.md` and
> root `AGENTS.md`. Implement the existing TrackerProvider seam and reuse generic
> routes, persistence and UI. Preserve Jira, Linear and GitHub behavior. First document
> any mismatch with the current single-account/single-scope model. Validate pagination,
> source isolation, full-detail handoff and numeric-ID provenance with meaningful tests.
> Report live vs mocked verification separately. Publication policy: <local-only or
> explicitly authorized publication>.

## Visible-list refresh contract

`server/tracker/watch.ts` owns the 60-second demand-driven scheduler, independent of providers.
Adapters must honor `refresh: '1'`, bound request duration, coalesce concurrent reads and return
controlled failures/Retry-After. Never add a provider timer or start a request during construction.
Watches revalidate the saved association and credential revision before and after reads; keep that
boundary when adding another adapter. List, search and detail requests from the cockpit also carry
`expectedScope`, produced by the shared `trackerReadScope` helper. Preserve that binding for
all reads, including prefetch and label suggestions; a cache key alone does not bind an HTTP
response to the source the caller expects. `checkedAt` advances only on a successful fresh first page.
Exercise shared demand, hidden/unmounted views, pagination protection, remote HTTP cancellation,
credential replacement and error cooldowns; do not report deeper pages as automatically refreshed.

## Automation events

Browsing does not imply that a provider supports automation events. The optional driver
`pollEvents` and `automationOptions` methods expose verified history capabilities to the existing
automation engine. Reuse the common event cycle, durable receipts, mutation/poll leases, retry
reconciliation and project connection binding; do not build another scheduler or poll current
status snapshots as if they were transitions.

Each candidate carries a stable vendor history identity, event timestamp, immutable issue ID,
association snapshot and historical changed values. Created events use the immutable issue ID.
Never derive event identity from `updatedAt`: editing a description must not fire a status event.
Checkpoint discovery and history independently, keep partial scans resumable, bound requests and
preserve a completed watermark with an indexing overlap. Request-count caps alone are not a
time budget: a slow sequence must yield completed-page progress before the hard operation
deadline. Never turn user cancellation, auth failure or a source change into a partial success.
Test eventual delivery across timed continuations, including a slow first page. Reject source/connection changes and
stop new starts after pause or edit. Preview does not reserve receipts or advance execution state.

Only advertise verified events. Current Jira capabilities are creation and status changes;
Jira label events are withheld pending a verified changelog encoding. Linear creation is supported;
status and label events are withheld because early changes can be absent and activity can be
grouped. A mapper passing synthetic tests does not establish provider history completeness.

Add contract schemas first, then the existing options API, editor and CLI. Status and label filters
use vendor IDs. Keep GitHub configuration and schedules working unchanged. Verify multiple real
transitions within one interval, delayed indexing, pagination, retry after lost responses,
cross-process disable/re-enable, token rotation, redaction, and source isolation. Use synthetic
secrets and isolated homes; live writes are not required for regression tests.
