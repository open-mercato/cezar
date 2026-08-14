# GitHub Automations

## TLDR

Add a project-scoped **Automations** page directly below GitHub in the sidebar. Users define bounded, polling-based GitHub triggers and pair them with the same prompt, workflow, skill, model, runner, worktree, and autonomy controls used by New task; matching issues or pull requests enqueue ordinary cezar tasks, while a durable execution log makes every decision debuggable.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why | Confirm? |
|---|----------|-----------------|-----|----------|
| Q1 | Should the first release execute matches that predate automation creation, or establish a cursor and only process later events? | Enabling establishes a baseline and processes only later events; a separate “Test filter” preview never launches tasks. | Prevents a newly enabled rule from unexpectedly creating hundreds of runs. | ok |
| Q2 | Should editing an enabled automation reconsider records already seen under the old filter? | No. Event receipts are immutable and edits only affect future polling observations. | Exactly-once intent is safer than retroactive reinterpretation; duplication can be explicit later. | ok |
| Q3 | Should “new flag on issue” mean GitHub label added, label removed, or both? | Model two selectable event types, **issue label added** and **issue label removed**, with added selected by default. | This matches GitHub’s `labeled`/`unlabeled` action vocabulary and keeps intent explicit. | ok |
| Q4 | Should the polling scheduler operate only while cezar is running, or require an external daemon? | Poll only while the existing cezar server is running. | A daemon would violate zero config and add a process users must manage. | ok |
| Q5 | Is this one cohesive feature or should trigger detection, task templates, and execution history ship as separate specs? | Keep one spec and phase delivery behind a disabled-by-default per-automation switch. | Detection, launch configuration, and audit history are one safe execution contract; none is useful or supportable alone. | ok |

## Problem Statement

GitHub work currently reaches cezar only through manual hand-off. Teams need a local, zero-configuration way to turn new pull requests, new issues, and issue-label changes into normal cezar tasks without exposing a webhook receiver, scanning unbounded repositories, or hiding why an automation did or did not run.

## Proposed Solution

Persist project-local automation definitions and execution records under `.ai/cezar/`. A demand-independent server scheduler polls GitHub at user-selected intervals, applies server-enforced author, assignee, label, relative-date, and result-limit filters, deduplicates event identities, and submits each accepted event through the existing run creation and scheduler path.

The cockpit gains a first-class `/p/:projectId/automations` surface immediately below GitHub. The GitHub tab shows a quiet “Set up automations” link when GitHub is available. An automation’s task template reuses the New task form and its validation rather than inventing a second workflow builder.

Webhooks are deliberately excluded: cezar binds to loopback, has no account or hosted callback, and must not require router, tunnel, GitHub App, or repository configuration. GitHub recommends webhooks over polling for hosted integrations, so this local-only exception must compensate with serialized conditional requests, conservative intervals, strict result bounds, cursors, and rate-limit backoff. Authenticated conditional REST requests that return `304 Not Modified` do not consume the primary limit, while search has its own tighter bucket ([GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2026-03-10), [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).

## Goals

- Let one project define multiple named GitHub automations with multiple trigger event types.
- Poll only while cezar is running, without webhooks, another daemon, required config, or new credentials.
- Bound every scan by time window, GitHub filters, pagination, and a hard per-poll result limit.
- Configure the launched task with the same prompt, planned/free workflow, skills, runner, model, variants, worktree, follow-up, and autonomous controls as New task.
- Enqueue matches through `RunManager.startRun`/`startGroup`, so normal scheduling, workspace concurrency, worktree isolation, persistence, and review behavior remain authoritative.
- Make evaluation and execution debuggable through a durable log, including non-match and error summaries without storing whole GitHub payloads.
- Degrade to a readable disabled/unavailable state when `gh`, authentication, a remote, home/disk writes, or the network is unavailable.

## Non-goals

- GitHub webhooks, GitHub Apps, a public listener, tunnels, or cloud scheduling.
- Running automations while the cezar server is stopped.
- Generic cron/time triggers or non-GitHub forge automation.
- Arbitrary shell commands in trigger filters or prompt interpolation.
- Guaranteed distributed exactly-once execution across multiple cezar processes for the same project. A cross-process lease prevents normal duplication; receipts make recovery idempotent.
- Backfilling pre-existing matches on first enable.
- Closing, labeling, commenting on, or otherwise mutating GitHub records as part of trigger evaluation.

## User Experience

### Navigation and discovery

- Add `Automations` directly below `GitHub` in the project sidebar, using a workflow/bolt icon. It is visible under the same forge-availability gate as GitHub.
- Add `/automations`, `/automations/new`, `/automations/:automationId`, and `/automations/:automationId/log` to project-scoped routes and page-title mapping.
- The GitHub tab header includes `Set up automations`, linking to `/automations/new`.
- Settings may include a contextual link, but the sidebar page is the canonical management surface.
- If no GitHub remote or usable `gh` authentication exists, retain the existing “GitHub tab is hidden” convention: Automations is hidden and the Tools/environment note explains why.

![Current GitHub surface](assets/github-automations/current-01-github.png)
![Current New task form](assets/github-automations/current-02-new-task.png)
![Current Settings surface](assets/github-automations/current-03-settings.png)

### Automations list

The list page shows:

- Name, enabled/paused state, trigger summary, interval, next check, and last result.
- Counts for matches, launched tasks, skipped duplicates, and errors over the retained log.
- `New automation`, `Run check now`, `Pause`, `Edit`, and `View log`.
- An empty state explaining local polling: “Checks run while cezar is open. No webhook or public URL required.”
- A top-level status strip for GitHub availability, the scheduler lease, current rate-limit/backoff state, and the most recent successful project poll.

Proposed list:

![Proposed Automations list](assets/github-automations/mockup-01-automations-list.png)

### Create/edit automation

The editor has three clearly separated sections:

1. **When GitHub changes**
   - Name and optional description.
   - Multi-select events: `New pull request`, `New issue`, `Issue label added`, `Issue label removed`.
   - Poll interval presets (`1 min`, `5 min`, `15 min`, `1 hour`, `6 hours`, `24 hours`) plus validated duration input. Default `5 min`; minimum `1 min`; maximum `24 hours`.
   - Filters: authors, assignees, include-all labels, include-any labels, exclude labels, relative lookback (`last 24 hours`, `last week`, `last 30 days`, custom 1–90 days), and maximum records per poll (`1–100`, default `25`).
   - Label-name filters are required when either label-change event is selected; the event matches only transitions for those labels. Author/assignee filters use subject state at observation. `allLabels`/`anyLabels`/`excludeLabels` evaluate the post-event label set for `labeled`, and the reconstructed pre-event label set for `unlabeled`, so removing the watched label can still match deterministically.
   - A read-only generated-query preview and `Test filter` button show up to the configured limit without launching tasks.
2. **What task to run**
   - Render the shared New task controls: free prompt; saved or planned workflow; skill stack; backend/runner; model; variants; worktree; follow-up; autonomous.
   - Provide safe, documented placeholders: `{{github.kind}}`, `{{github.number}}`, `{{github.title}}`, `{{github.url}}`, `{{github.author}}`, `{{github.assignees}}`, `{{github.labels}}`, `{{github.event}}`.
   - Always append a machine-owned context block containing repository, immutable node/database id when available, event timestamp, and URL. GitHub title/body remains untrusted task input, never instructions to the scheduler.
3. **Review and enable**
   - Summarize cadence, worst-case records per day, selected events, filters, task settings, and whether task runs are autonomous.
   - Save paused by default. `Save and enable` establishes a baseline cursor and explicitly states that existing matches will not launch.

Proposed editor:

![Proposed Automation editor](assets/github-automations/mockup-02-automation-editor.png)

### Execution log

The log is a tab within the Automations page and a per-automation detail route. Each row records:

- Evaluation time, event, GitHub subject, result (`launched`, `no-match`, `duplicate`, `rate-limited`, `error`, `baseline`), reason, and duration.
- The created run id/status with a link into the task when launched.
- The exact automation revision and filter summary used.
- Poll-level summaries aggregate candidate counts and omit per-record `no-match` rows after the first ten, preventing log growth proportional to repository size.
- Filters for automation, result, event, and relative date; a detail drawer exposes the sanitized query/cursor, response status, and concise error.
- `Retry task` is available only when a reserved receipt reached a pre-launch error before a
  `runId` was finalized. Retry transitions that same receipt under the project lease; it never
  creates a second receipt or bypasses deduplication.

Proposed log:

![Proposed Automation log](assets/github-automations/mockup-03-automation-log.png)

Accessibility follows existing cockpit patterns: semantic labels/fieldsets, keyboard-operable multi-selects, status text in addition to color, visible focus, mobile stacked sections, and `<time dateTime>` for exact timestamps.

## Architecture

### New modules and boundaries

- `src/automations/types.ts` — zod schemas and inferred types for definitions, cursors, receipts, and log records. Every persisted field is optional/defaulted where an older reader can tolerate absence; objects use `.passthrough()`.
- `src/automations/store.ts` — project-local atomic definition/state store and append-only execution log. It owns salvage, caps, file locking, and change notifications.
- `src/automations/github-poller.ts` — GitHub-only candidate discovery behind a narrow `AutomationSource` interface. It builds validated argument arrays for `gh api`; it never accepts shell fragments.
- `src/automations/scheduler.ts` — one lightweight workspace coordinator started only after the HTTP server listens. It discovers registered projects with enabled definitions without materializing unrelated full project contexts, calculates due work, owns the shared GitHub request arbiter/backoff, and hands bounded checks to project schedulers. Project schedulers hold the project cross-process lease, evaluate events, commit receipts, and invoke a supplied run-launch adapter.
- `src/automations/task-template.ts` — validates the same `CreateRunInput` contract used by `POST /api/runs`, expands the fixed placeholder vocabulary, and returns a `StartRunInput`/planned workflow.
- `src/server/automations.ts` — project-scoped API route module registered once and mounted through the existing route-parity mechanism.
- `web/app/src/routes/automations/` — list, editor, log, loading/error states, and focused components.
- Extract shareable New task form state/schema from `web/app/src/routes/new-task-form.ts` and `new-task-plan.ts`; both New task and Automation editor serialize through one pure `CreateRunInput` builder.

The poller depends on the forge/GitHub seam for identity and availability but is intentionally not added to the WebSocket subscription bus: this work is required when no browser is viewing it. UI freshness uses the existing global workspace SSE signal with a new additive `automation-change` event carrying only project id, automation id, and revision; clients invalidate/refetch bounded automation queries.

### Lifecycle

1. Server listens.
2. A workspace automation coordinator scans registered project roots for the optional automation definitions file only. Missing/gone/read-only roots degrade per registry rules; it never constructs a full `ProjectContext` merely to discover due work. Registry add/remove events refresh this bounded index.
3. Lazily materialized `ProjectContext`s reuse the coordinator-owned store/scheduler handle; removing or disposing a context does not stop enabled background checks. If no enabled definition exists anywhere, the coordinator owns no timer and performs no GitHub call.
4. The first enabled definition schedules the earliest due time; edits recompute one timer for the project.
5. At due time, acquire `.ai/cezar/automation-poll.lock` using create-exclusive semantics with PID/start-time metadata and stale recovery.
6. Re-read definitions under the lease, group due automations by compatible event family/query, and acquire the workspace GitHub request arbiter. The arbiter permits one active GitHub polling request chain per cezar process and applies token/user-scoped backoff shared by every project. A user-home cross-process quota lease serializes polling across cezar processes using the same `CEZ_HOME`/`gh` identity; when unavailable, conservative backoff prevents concurrent retries.
7. Apply event reconstruction, filters, cursors, receipt deduplication, and caps.
8. For each accepted event, durably reserve the receipt, launch the ordinary run, then finalize the receipt with `runId`. A startup repair reconciles `reserved` receipts: if their run exists, finalize; otherwise mark launch error and permit explicit retry.
9. Persist cursor/ETag/backoff/log, publish one change event, release the lease, and schedule the next due time.
10. On context disposal/server shutdown, clear timers and await only the currently bounded request; never orphan another daemon.

### GitHub event reconstruction

GitHub search syntax supports author, assignee, label, and date qualifiers and boolean composition ([GitHub filter documentation](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)). Push selective, indexed filters into GitHub; repeat all predicates locally against normalized candidates so provider quirks cannot widen execution.

- **New pull request:** query PRs sorted by creation/update descending with `created:>=lookbackStart`; match `createdAt > baseline/cursor`.
- **New issue:** query issues, excluding pull requests, with `created:>=lookbackStart`; match `createdAt > baseline/cursor`.
- **Issue label added/removed:** issue search alone cannot reconstruct transitions. Fetch issue timeline events for bounded recently updated candidates and select `labeled`/`unlabeled` events after the cursor. GitHub uses those action names for label transitions ([GitHub webhook event vocabulary](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).
- Each provider event identity is
  `${repoNodeId}:${subjectNodeId}:${eventKind}:${eventNodeId || eventTimestamp + normalizedLabel}`.
  Receipt uniqueness is scoped to `${automationId}:${eventId}` so two automations may
  independently launch from the same GitHub event while an overlap or retry cannot launch the
  same automation twice. Receipts persist this composite key before task launch.
- Use a two-minute overlap before the last successful cursor to tolerate timestamp ties and GitHub indexing delay. Receipts eliminate duplicates within the overlap.
- At poll start, freeze a high-watermark `(eventTimestamp, stableNodeId)` from the newest visible candidate. Drain candidates in ascending stable `(eventTimestamp, stableNodeId)` order from the prior success watermark through that frozen boundary. Newer arrivals belong to the next poll.
- Stop when the configured record cap is reached; never fetch past ten pages or 100 candidates, whichever comes first. Persist a backlog continuation tuple and keep the prior success watermark unchanged until every candidate through the frozen boundary is drained. Restart resumes the same frozen boundary. If the relative lookback would overtake an undrained boundary, continue that bounded backlog from the durable tuple and log the age rather than skipping it.
- A relative lookback bounds discovery, not dedup retention. Receipts are retained at least 90 days and never less than the maximum selectable lookback.

### Rate limiting and backoff

- Use authenticated `gh api` only after the existing GitHub capability check succeeds.
- Prefer list/timeline endpoints with `If-None-Match`; persist ETags per normalized request key. Do not use conditional caching where pagination/cursor semantics could skip a page.
- Serialize requests per project and enforce one active polling project at a time per cezar process.
- Honor `Retry-After` and `X-RateLimit-Reset`; otherwise exponential backoff from one minute to six hours with jitter.
- Search and core limits are recorded separately. Do not call `/rate_limit` every tick; use response headers.
- A rate-limited automation does not advance its cursor and does not retry in a tight loop. The UI shows the exact next allowed check.
- Manual `Run check now` obeys the same lease, rate limits, cap, and deduplication.

## Data Model and Persistence

New state remains deletable/rebuildable and lives under `.ai/cezar/`; add every filename to `ensureDataGitignore`.

### `automations.json`

```ts
type AutomationDefinition = {
  id: string
  revision: number
  name: string
  description?: string
  enabled: boolean
  events: Array<'pull_request.opened' | 'issue.opened' | 'issue.labeled' | 'issue.unlabeled'>
  intervalSeconds: number
  filters: {
    authors?: string[]
    assignees?: string[]
    allLabels?: string[]
    anyLabels?: string[]
    excludeLabels?: string[]
    changedLabels?: string[]
    lookbackDays: number
    maxRecords: number
  }
  task: {
    prompt: string
    workflow?: string
    steps?: WorkflowStepDef[]
    runner?: 'claude' | 'codex' | 'opencode'
    model?: string
    variants?: 1 | 2 | 3
    worktree?: boolean
    generateFollowups?: boolean
    autonomous?: boolean
    systemPrompt?: string
  }
  createdAt: string
  updatedAt: string
}
```

The file is `{version: 1, automations: []}` with whole-file zod validation plus per-entry salvage, `.passthrough()` at every object layer, atomic temporary write/rename, and mode `0600` where supported. Unknown fields survive read-modify-write. Corruption disables affected entries, logs one warning, and never blocks boot.

### `automation-state.json`

Runtime-only state keyed by automation id, with the revision that last wrote it recorded alongside
the state:

```ts
type AutomationRuntimeState = {
  revision?: number
  baselineAt?: string
  cursor?: { timestamp: string; tieBreaker?: string }
  frozenHighWatermark?: { timestamp: string; tieBreaker: string }
  backlogAfter?: { timestamp: string; tieBreaker: string }
  nextCheckAt?: string
  lastSuccessAt?: string
  etags?: Record<string, string>
  backoffUntil?: string
  consecutiveFailures?: number
}
```

Editing increments `revision` but preserves receipts and atomically carries the current runtime
state forward to the new revision. Cursors continue unless event selection or repository identity
changes, in which case enabling establishes a new baseline. Pausing preserves cursor. Deleting a
definition tombstones its id for 90 days so delayed writes cannot resurrect it.

### `automation-receipts.ndjson` and `automation-log.ndjson`

- Receipts are append-only
  `{receiptId, receiptKey, eventId, automationId, revision, status, runId?, observedAt, updatedAt}`
  records, where `receiptKey` is `${automationId}:${eventId}`. They are compacted under the lease
  when over 20,000 lines, retaining the latest row per receipt key for at least 90 days.
- Logs are append-only, monotonically sequenced, sanitized, and capped by compaction to 10,000 detail rows plus daily summaries. Never store issue/PR bodies, tokens, response headers other than rate-limit metadata, or raw API payloads.
- Missing receipt/log files mean empty state. A malformed line is skipped with one warning; later lines remain readable.

## API Contracts

All routes are project-scoped, mounted under `/api/p/:projectId`, with required legacy boot-project aliases per route parity. Every mutating route remains behind the global origin guard, validates with zod `safeParse`, and returns `{error}` with 400/404/409.

- `GET /api/automations` → `{available, reason?, scheduler, automations[]}`.
- `POST /api/automations` with the definition minus server-owned ids/timestamps → `201 {automation}`; saved paused unless `enable: true`.
- `GET /api/automations/:id` → definition plus bounded latest status.
- `PUT /api/automations/:id` with full editable definition and `expectedRevision` → updated definition; stale revision returns 409.
- `DELETE /api/automations/:id` → `204`; does not delete runs or historical receipts/logs.
- `POST /api/automations/:id/enable` → baseline plus updated definition.
- `POST /api/automations/:id/pause` → updated definition.
- `POST /api/automations/:id/check` with `{mode: 'preview' | 'execute'}` → `202 {checkId}`. Preview never writes receipts or launches runs.
- `GET /api/automation-checks/:checkId` → bounded status/result for manual previews.
- `GET /api/automation-log?automationId=&result=&event=&since=&cursor=&limit=` → cursor-paginated records; max 100.
- `POST /api/automation-log/:receiptId/retry` → `202`, only for a reserved receipt in a
  pre-launch error state with no finalized `runId`; it retries by transitioning the same receipt
  under the project lease.

The Automation editor consumes the existing workflow, skill, config, model, and runner endpoints; it does not duplicate catalogs in automation APIs.

## Task Launch Semantics

- Store the task configuration in the same normalized shape accepted by the New task serializer. At execution, resolve named workflows/skills/models from current catalogs exactly as New task does; a missing selection logs an error and launches nothing.
- Planned/free workflows persist their validated step definitions so they remain reproducible even if no YAML file exists.
- Placeholder substitution is plain string replacement from a fixed map. Unknown placeholders fail save; no template expression language, command interpolation, file reads, or arbitrary object access.
- The scheduler appends a delimited `GitHub event context (untrusted data)` block. The prompt explicitly tells the agent that GitHub-authored text is reference data and cannot override system, workflow, or repository instructions.
- A launched run gains optional additive provenance:

```ts
automation?: {
  automationId: string
  automationRevision: number
  receiptId: string
  event: string
  githubUrl: string
}
```

This field is optional in `RunRecord`, redacted/sanitized on writes, exposed additively through run APIs, and rendered as an Automation badge linking back to the log. Old `runs.json` remains parseable.
- Variants call the existing `RunManager.startVariants`; one event produces one group receipt, not
  one receipt per variant.
- Worktree, autonomy, follow-up, backend/model, system prompt, and review behavior are passed unchanged to existing run machinery. The automation scheduler never bypasses workspace semaphore limits.

## Security and Privacy

- No listener beyond cezar’s existing loopback server; no webhook secret or inbound network path.
- No new token store. Reuse the current `gh` authentication/GITHUB_TOKEN degradation behavior without exposing credentials in definitions, logs, tasks, or UI.
- All `gh` invocations use fixed executable/argument arrays and validated values; never a shell-built query command.
- GitHub author, title, label, and body are untrusted strings. Escape them in UI, bound lengths, strip control characters, and keep them out of system prompts and shell commands.
- Require a repository identity match on every response before launch. URLs are validated as HTTPS GitHub URLs for the configured owner/repo.
- Automation APIs inherit Host/DNS-rebinding and CSRF guards. The SSE notification carries no GitHub content and is safe for the existing local workspace stream.
- Definitions may contain user-authored free prompts about people. Store locally at `0600`; do not upload or include them in telemetry.

## Failure Modes and User-visible Behavior

| Failure | Behavior |
|---|---|
| `gh` missing, unauthenticated, no GitHub remote, or offline | Enabled automations remain persisted but paused by capability; no cursor advances; status explains the reason and next retry. Boot succeeds. |
| API 403/429 | Honor headers/backoff, log one rate-limit row, show next retry, do not advance cursor. |
| Search result exceeds cap | Stop at cap, log truncation and continuation cursor; never silently scan thousands. |
| Cezar stopped through several intervals | On restart run one bounded catch-up from cursor within lookback, not one tick per missed interval. |
| Two cezar processes open the same project | One cross-process lease polls; the other observes state and reschedules. Stale PID/start-time leases recover. |
| Crash after receipt reservation before run creation | Startup reconciliation marks a visible recoverable error; no silent duplicate. |
| Crash after run creation before receipt finalization | Reconcile by persisted automation receipt provenance on the run, then finalize without relaunch. |
| Automation definition corrupt | Salvage other definitions, disable the bad entry, retain source file, show validation reason. |
| Missing workflow/skill/model after save | Log configuration error and launch nothing until edited. |
| Read-only project state | List definitions if readable; disable create/edit/enable/execution with an explicit local-write error; boot and GitHub tab still work. |
| GitHub indexing delay or tied timestamps | Two-minute overlap plus receipt identity prevents loss/duplication. |
| Log compaction fails | Keep append-only data, warn once, pause further automation launches before disk growth becomes unbounded. |

## Compatibility and Rollback

- The protected `/api/github` response and existing GitHub routes remain unchanged.
- `RunRecord.automation` is additive/optional; existing `runs.json` and clients parse unchanged.
- New `.ai/cezar/` files follow existing optional, salvageable, atomic persistence rules and are added to `.ai/cezar/.gitignore` maintenance.
- Existing workflow YAML and `POST /api/runs` contracts are reused, not narrowed.
- Removing/rolling back the feature means stopping schedulers and ignoring the new optional files/fields. Existing launched runs remain ordinary runs; deleting automation state is safe and rebuilds empty.
- ~~No new `CEZ_*` variable is proposed. Enabling is stored per automation and user initiated; the zero-config default performs no GitHub polling until the first automation is explicitly enabled.~~ **Amended by #801 (2026-08-07):** per-automation `enabled` plus a zero-config default turned out not to be gating enough — the whole surface, including the sidebar entry, had to be hideable, and every project with a GitHub remote saw the tab. The feature is now opt-in behind `CEZ_AUTOMATIONS=1` (strict activation, off by default, surfaced as `capabilities.automations` on `/api/v1/health`): off, the nav item is absent everywhere, the `/automations*` routes answer `409`, and the workspace scheduler never starts. The per-automation `enabled` toggle and the no-backfill baseline described in this spec are unchanged and still apply once the flag is on. See `BACKWARD_COMPATIBILITY.md` §"GitHub automations — opt-in gating".

## Observability

- Structured internal events: scheduler started/stopped, check due, lease acquired/contended, request completed/304/rate-limited, candidates bounded, receipt reserved/finalized, run launched, compaction.
- Never include tokens, prompt text, issue body, or raw response payload.
- Health automation summary is additive and aggregate only: enabled count, scheduler state, next due, backoff-until, last success/error.
- The Automation log is the user-facing source of truth and survives restarts.

## Testing Strategy

- Unit tests for schemas, per-entry salvage, unknown-field preservation, atomic writes, cursor overlap/ties, event identities, all/any/exclude filters, label transitions, caps, ETag rules, backoff, compaction, prompt placeholders, provenance, and crash reconciliation.
- Poller contract tests use deterministic `gh` fixtures for pagination, `304`, search/core rate limits, malformed responses, foreign repository payloads, and issue-vs-PR discrimination.
- Scheduler tests use fake clocks and multiple stores/processes to prove no timer with zero enabled automations, restart discovery without UI access, registry changes, cadence, catch-up, shared request arbitration, lease exclusion/stale recovery, manual-check serialization, cursor non-advancement on failure, arrivals during truncation, timestamp ties, restart during backlog drain, and lookback expiry before drain.
- Server tests cover every route’s zod failures, 404/409 shapes, origin guard inheritance, preview non-mutation, optimistic concurrency, project disposal, and route parity.
- Run-manager integration tests prove one event → one run/group, queued capacity behavior, worktree/autonomy propagation, and receipt reconciliation.
- React unit tests cover sidebar ordering, forge gating, empty/error/backoff states, shared New task serialization parity, generated query preview, enable-baseline confirmation, and accessible log filters.
- Real browser E2E: navigate from GitHub setup link; create paused automation; preview bounded matches; enable baseline; inject deterministic dry-run GitHub fixtures; observe one task; verify duplicate tick creates none; follow run link from log; pause and confirm no later poll.

## Phasing

### Phase 1 — Safe persistence and read-only preview

Ship schemas/store, API CRUD, sidebar page/editor, shared New task form extraction, filter/query preview, current capability status, and preview-result history. All definitions remain paused and no background scheduler launches tasks; the product labels this as preview, not automation execution.

### Phase 2 — Bounded polling and receipts

Ship workspace lifecycle/bootstrap integration, shared GitHub request arbitration, `gh` poller, frozen high-watermarks/backlog continuation, filters, caps, ETags, rate backoff, cross-process leases, label timeline reconstruction, and preview/check logs. A hard execution gate keeps every definition non-executable: preview never advances execution cursors or creates receipts.

### Phase 3 — Ordinary task launch and provenance

Connect accepted receipts to the existing run/group path, add optional run provenance, crash reconciliation, Automation badges/links, and execution/retry log controls. Only this phase exposes enablement and initializes the execution baseline; no earlier phase can consume an event.

### Phase 4 — Full browser verification and hardening

Add the real-browser journey, large-repository fixtures, disk/read-only degradation, compaction, restart/multi-process tests, documentation, and packaging verification.

## Implementation Plan

1. Add `src/automations/types.ts` schemas and fixtures; pin defaults, bounds, unknown-field behavior, and compatibility tests.
2. Add `src/automations/store.ts` for atomic definitions/state, append-only receipts/logs, salvage, compaction, and cross-process lease primitives; update `ensureDataGitignore`.
3. Add the lightweight workspace automation coordinator, registered-project discovery, registry add/remove/gone-root handling, and project-context handle reuse; test missing/corrupt/read-only state without broadly materializing contexts.
4. Register project-scoped automation CRUD, preview, check-status, log, and retry route manifests with zod/origin/route-parity tests.
5. Extract the pure New task configuration model/serializer and render it in the Automation editor without changing `POST /api/runs`.
6. Add Automations routes, sidebar ordering below GitHub, GitHub setup link, list/editor/log states, API types/client/query hooks, and React/accessibility tests.
7. Implement `github-poller.ts` using fixed `gh api` arguments, normalized candidates, server-side and local filters, result/page caps, ETags, and rate metadata; cover with fixtures.
8. Implement `scheduler.ts` with one workspace due timer, project scheduling handles, post-listen start, registry/context disposal behavior, process-wide and user-home GitHub request arbitration, token-scoped backoff, frozen high-watermarks/backlog continuation, lease, baselines/cursors, and overlap; cover with fake clocks and multi-instance tests.
9. Add issue timeline reconstruction for label-added/removed events and stable event identity/receipt deduplication.
10. Add `task-template.ts`, fixed placeholders, untrusted-context delimiter, ordinary run/group launch adapter, optional `RunRecord.automation` provenance, and crash reconciliation.
11. Publish additive workspace SSE invalidations and Automation/run cross-links; verify one root connection and no UI polling.
12. Add log compaction, aggregate health/status, structured redacted diagnostics, and explicit error/retry controls.
13. Run `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`, and `npm run test:e2e`; capture the final browser evidence for create → preview → baseline → launch → dedupe → inspect log.

## Risks & Impact Review

- **High scheduler safety risk:** a cursor/dedup bug can create duplicate autonomous work. Mitigate with baseline-first enablement, durable pre-launch receipts, overlap tests, and ordinary scheduler capacity.
- **Medium GitHub quota risk:** polling is contrary to GitHub’s hosted-integration preference. Mitigate with explicit enablement, five-minute default, one-minute floor, conditional requests, serialized access, strict bounds, and header-driven backoff.
- **Medium prompt-injection risk:** GitHub content becomes agent input. Mitigate by treating it as delimited untrusted data, fixed placeholders, bounded strings, and no system/shell interpolation.
- **Medium persistence risk:** new local files participate in concurrent process access. Mitigate with atomic writes, append-only receipts/logs, a cross-process lease, salvage, caps, and optional additive schemas.
- **Low rollback risk:** schedulers can be disabled and optional files ignored without touching existing runs or public contracts.

## Alternatives Considered

- **GitHub webhooks:** lower latency and GitHub’s preferred hosted pattern, but requires a reachable listener, repository configuration, secrets, and ongoing delivery management; incompatible with cezar’s local zero-config contract.
- **GitHub Actions workflow dispatching cezar:** requires committed workflow/config and a remotely reachable or self-hosted runner; cezar would no longer be local-only.
- **External cron/launchd/systemd job:** could poll while cezar is closed but adds platform-specific process/config management and competing state ownership.
- **Pure GitHub Search polling:** simpler for created issues/PRs but cannot reliably reconstruct label transitions and has a tighter independent rate limit.
- **One workflow file per automation:** portable, but cannot express trigger cursor/receipt/log state and would overload the protected workflow YAML contract. Automation task settings should reference/reuse workflow semantics without changing that format.
