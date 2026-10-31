# Discovery: Jira/Linear-triggered automations (todo → agent → PR → status)

Status: draft, local only, not published (no commit/push/PR). Follows up on the read-only
browsing feature already implemented on `feat/jira-linear-tracker-browsing`
(`.ai/specs/2026-09-18-jira-linear-tracker-browsing.md`), which explicitly deferred "writes to
vendors" and "automatic completion status sent back to the vendor" as non-goals (spec §Proposed
Solution and Scope). This is discovery for that deferred work: watch Jira/Linear for a matching
issue (e.g. status = "To Do"), launch an agent task, and optionally report back when a PR exists.

## 1. What already exists and is reusable

- **Read-only tracker access** (`packages/cezar/src/server/tracker/{jira,linear,index}.ts`):
  `createTrackerService` builds a per-project `TrackerProvider` from credentials stored privately
  per project (`connection-env.ts`, plaintext, 0600, never in `process.env`, never sent to an
  agent). `TrackerDriver.listIssues`/`searchItems`/`getItem` are full read paths — including
  Jira's `status` field and both vendors' `labels`/`updatedAt`.
- **Automations engine with an extensible `kind` discriminator**
  (`packages/cezar/src/automations/types.ts`): today `'github'` (event polling: `issue.opened`,
  `issue.labeled`, `issue.unlabeled`, `pull_request.opened`, driven by `GithubPoller`, which shells
  out to `gh` CLI) and `'schedule'` (cron-like, ≥60s, no external dedup). The 2026-09-14
  automations-redesign spec explicitly designed `kind` as the axis for adding trigger types
  without touching the other kind's lifecycle.
- **Generic receipt/dedup/backoff/log machinery** (`AutomationStore`): keyed by
  `automationId:eventId`, kind-agnostic already — a new kind reuses it unchanged.
- **`WorkspaceAutomationScheduler`**: one process-wide timer over the earliest due item across
  both kinds; adding a third branch (`isTrackerAutomation`) is a small, well-precedented change.
- **A structured post-launch signal**: `RunRecord.pullRequestUrl`
  (`packages/cezar/src/runs/store.ts:253`) is set once the run's git state shows a created PR
  (`updateRun(runId, { pullRequestUrl: created })`, `store.ts:1131`). This is a real hook a
  server-side write-back could watch, without ever handing Jira/Linear credentials to the agent.
- **Least-privilege agent env** (`packages/cezar/src/core/agent-env.ts`): only `GITHUB_TOKEN` /
  `GH_TOKEN` (host env) are forwarded into agent child processes today, specifically so the agent
  can use `gh` for the PR handoff. Jira/Linear credentials are NOT on this path — by design, per
  `connection-env.ts`'s own comment ("do not source this file").

## 2. Gaps to close

### 2.1 A tracker poller (candidate discovery)
Needs a `TrackerPoller`-equivalent to `GithubPoller`, built on the existing fetch-based
`TrackerProvider`/`TrackerDriver` (not a CLI shell-out — Jira/Linear have no `gh`-equivalent
locally installed binary). Requires:
- A `TrackerCandidate` shape mirroring `GithubCandidate` (`eventId`, `timestamp`, `tieBreaker`,
  issue key/id, title, url, status, labels, assignee).
- A stable cursor: Jira JQL `updated >= X ORDER BY updated ASC` with a secondary tiebreaker
  (issue key, since JQL timestamp resolution is coarser than GitHub's); Linear GraphQL
  `updatedAt`-ordered query with its own cursor. Needs confirming both vendor query languages
  support this ordering + filter combination cleanly — Jira JQL does natively; Linear's issue
  filter/orderBy needs a quick spike against the real GraphQL schema already used in `linear.ts`.
- A filter vocabulary distinct from GitHub's label-centric one: the natural Jira/Linear trigger
  is a **status/workflow-state match** (e.g. "issue entered To Do"), not a label event — though
  both vendors also support labels, which can stay as a secondary filter.

### 2.2 New `kind` value(s) and schema wiring
- `automationDefinitionObjectSchema` (`types.ts`) needs a third `kind` — either two
  (`'jira' | 'linear'`) or one unified `'tracker'` with a `provider: 'jira' | 'linear'` field.
  Given the existing `TrackerProvider` interface is already provider-agnostic on the read side,
  a unified `tracker` kind is the smaller surface and matches how `createTrackerService` already
  abstracts over both vendors — but it's a naming/versioning decision that affects storage
  migration and the CLI (`cez automation schema`), so it belongs in the actual spec's gate
  questions, not assumed here.
- `isGithubAutomation`/`isScheduleAutomation`-style guard + a `TrackerAutomationDefinition` type.
- `ProjectAutomationHandle` (`scheduler.ts`) needs a `tracker?: { kind, provider }` sibling to
  `github?: { owner, repo, poller }`, built server-side from the project's already-resolved
  tracker connection — no new credential surface, reuses `createTrackerService`.
- `WorkspaceAutomationScheduler.schedule()` needs a third `due.push(...)` branch.
- `ProjectAutomationScheduler`-equivalent: either a parallel class or (cleaner, since the launch/
  receipt/backoff logic is identical) generalize the existing one to take an injected poller
  interface instead of a hardcoded `GithubPoller`.

### 2.3 Prompt template vocabulary
`automations/prompts.ts` + `task-template.ts` need new placeholders
(`{{jira.key}}`, `{{jira.title}}`, `{{jira.url}}`, `{{jira.status}}` /
`{{linear.identifier}}`, …) documented in `cez automation schema`, mirroring `{{github.number}}`.

### 2.4 UI
Automations list/editor (`.ai/specs/assets/github-automations/*`,
`.ai/specs/assets/automations-redesign/*`) has GitHub vs Schedule trigger cards today. Needs a
third card sourced from the project's tracker connection (if none configured, the card is absent
or disabled — same pattern as the existing GitHub-remote-optional handle). Status filter should
be a picker populated from the vendor's real workflow statuses (the browsing feature already
fetches real Jira/Linear metadata for its own UI — reuse that, don't hand-author a status enum).

### 2.5 Write-back (status / PR link on completion) — the harder, explicitly-deferred half
Two independent mechanisms, not mutually exclusive:
- **Server-side, using `RunRecord.pullRequestUrl`**: once a tracker-triggered run's
  `pullRequestUrl` is set, a server-side hook calls the *existing* private per-project
  Jira/Linear credentials (already resolvable via `createTrackerService`) to comment/transition
  the issue. No new credential exposure — the server already holds and uses these credentials for
  reads; this only adds a write call using the same client. Needs: (a) a write method added to
  `TrackerDriver`/`jira.ts`/`linear.ts` (currently 100% read-only), (b) a hook point where a
  finished run with a known triggering automation+candidate can be correlated back to its issue,
  (c) an explicit per-connection "allow writes" opt-in — the current credential form and its
  copy ("write-only form", "no write scope is required by cezar") would need to change, which is
  a user-facing trust/scope decision, not just code.
- **Agent-side** (mirrors how GitHub handoff works: the agent itself runs `gh` inside its own
  task): would require exposing Jira/Linear write credentials into the agent's child env
  (`agent-env.ts`), which the codebase currently treats as a hard boundary
  (`connection-env.ts`: "do not source this file"). Would also need a CLI helper, since there is
  no locally-guaranteed `jira`/`linear` CLI equivalent to `gh` the agent could invoke — the agent
  would have to hand-write authenticated HTTP calls, which is fragile and harder to keep scoped.
  **Server-side is the safer default**; agent-side should only be considered if the user wants
  richer write-back than "transition + comment with PR link" (e.g. sub-task creation).

## 3. Recommendation

Server-side write-back triggered off `RunRecord.pullRequestUrl`, using the same per-project
credentials the browsing feature already stores and reads — no new credential-exposure surface,
just a write method added to the existing adapters plus an explicit opt-in toggle per connection.
Trigger on status/workflow-state match (not labels) as the primary filter, matching how Jira/Linear
teams actually organize "todo" work, with labels as a secondary filter for parity with GitHub.
Unify `jira`/`linear` under one `kind: 'tracker'` rather than two kinds, since the read path is
already provider-agnostic and a unified kind halves the schema/UI/CLI surface to maintain.

## 4. Open questions (belong at the spec's gate, not decided here)

1. Read-only trigger only (todo → agent → PR, no write-back) vs full loop with status/comment
   write-back?
2. If write-back: server-side (recommended above) or agent-side, and exactly what should be
   written (status transition, comment with PR link, both)?
3. Trigger condition: status/workflow-state only, or also label- and assignee-based like GitHub?
4. One `kind` per provider vs a unified `kind: 'tracker'` with a `provider` field?
5. Does write-back need an explicit new "allow writes" opt-in per connection (changing the
   current "write-only credential form, no write scope required" posture), or is it acceptable to
   assume any configured token already has write scope?
6. Minimum poll interval: reuse GitHub's 60s–86 400s bound as-is, or something coarser given
   Jira/Linear's own rate limits differ from GitHub's?

## 5. Rough implementation phasing (mirrors the existing spec's phase structure)

1. **Contract + tracker poller**: candidate/cursor types, Jira JQL + Linear GraphQL query for
   status-ordered polling, unit tests against fixtures (dry-run mode already exists via
   `dry-run.ts` and can be extended with candidate fixtures).
2. **Automation engine wiring**: new `kind`, `ProjectAutomationHandle.tracker`, scheduler branch,
   prompt placeholders, CLI schema output.
3. **UI**: trigger-type card, status/label filter pickers sourced from real vendor metadata.
4. **End-to-end acceptance**: dry-run and (if a live credential is available) real-vendor poll →
   launch → verify receipt/log, mirroring the existing `tracker-live` verification pattern.
5. **Write-back** (separate phase, gated on open question #1/#2/#5 being resolved): adapter write
   methods, opt-in toggle, completion hook off `pullRequestUrl`, acceptance tests against a real
   sandbox issue.

This document is discovery + a rough plan only. Before implementing, the actual spec needs the
open questions above answered at a gate (same pattern as the original tracker-browsing spec).

## 6. 2026-09-19 update: implemented, fast/simple path (local only, not published)

The user answered the open questions live, choosing speed over the safer design in every case:

1. Full loop, not read-only-trigger: todo → agent → write-back.
2. Write-back mechanism: **agent-side**, not the recommended server-side-only path — "zróbmy to
   dzisiaj, jak najprościej, nawet kosztem tego, że agent dostanie token" (do it today, as simply
   as possible, even at the cost of the agent getting the token). The write-back ACTION itself is
   not hardcoded by cezar at all: the automation's own prompt template tells the agent what to do
   on completion (e.g. "transition this to Done"), mirroring exactly how the GitHub kind already
   works (the agent uses `gh` itself; the engine has no built-in "close the issue" step).
3. Trigger condition: status/workflow-state only (`filters.status`), no label/assignee parity —
   the smaller, sufficient vocabulary discussed.
4. Kind naming: unified `kind: 'tracker'` (provider resolved at poll time from the project's own
   connection), as recommended in §3.
6. Poll interval: reused the GitHub 60s–86 400s bound as-is.

Implemented and green (full typecheck + 2198 cezar tests + 3880 web tests):

- `packages/cezar/src/automations/types.ts` — `kind: 'tracker'`, `filters.status`,
  `TrackerAutomationDefinition`, `isTrackerAutomation`.
- `packages/cezar/src/automations/tracker-poller.ts` (new) — `TrackerPoller`: one page of the
  project's active items via the EXISTING read-only `TrackerDriver.listIssues`, filtered
  client-side on `status`. Deliberately no persisted poll cursor (unlike GitHub's): eventId is
  `provider:key:status:updatedAt`, so the automation store's own receipt dedup is the only guard —
  documented as a simplification, not a bug (an item edited again while still in the target status
  can refire).
- `packages/cezar/src/automations/scheduler.ts` — `ProjectTrackerAutomationScheduler` (new,
  parallel to the GitHub one, not a generalization of it — lower regression risk), third
  `WorkspaceAutomationScheduler.schedule()` branch, `ProjectAutomationHandle.tracker`.
- `packages/cezar/src/automations/task-template.ts` — `{{tracker.*}}` placeholders,
  `renderTrackerTask` (names the available credential env vars in the untrusted-context block,
  never their values), `launchTrackerAutomationRun`.
- `packages/cezar/src/runs/store.ts` — `automationTracker` provenance (own key, same pattern as
  `automationTrigger`): `provider`/`key`/`url` only, never a secret.
- **Credential forwarding** (the actual "agent gets the token" mechanism):
  `packages/cezar/src/server/tracker/agent-credentials.ts` (new) reads the project's EXISTING
  private tracker connection (same store/format the browsing feature already uses) and maps it to
  `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` or `LINEAR_API_KEY`. Wired into
  `RunManager.agentEnvForStep` (`workflows/run.ts`) via a new optional constructor dependency,
  applied ONLY when the run's (non-secret) `automationTracker` provenance is present, re-derived
  live on every step rather than ever persisted. This is the one deliberate exception to
  `connection-env.ts`'s "never sourced into agent env" rule, called out at every one of these
  sites as known debt to revisit (the server-side-only / privileged-CLI design discussed earlier
  in this file remains the safer alternative if tightened later).
- Server wiring: `packages/cezar/src/server/server.ts` (scheduler's `tracker` handle +
  `launchTracker`), `project-context.ts` + `index.ts` (both `RunManager` construction sites get
  `resolveTrackerEnv`).
- Contract (`packages/contract/src/automations.ts`): `automationKindSchema` widened to include
  `tracker` (so `GET /automations` doesn't throw on a hand-authored one) — but
  `createAutomationInputSchema`/`updateAutomationInputSchema` and `automationTemplateSchema`
  deliberately KEPT NARROW (`'github' | 'schedule'` only): no create/edit route or CLI exists for
  tracker automations yet.

**Explicitly out of scope for this pass** (by design, for speed — not forgotten):
- No settings/automations-editor UI to CREATE or EDIT a tracker automation. Today it is
  hand-authored directly into `.ai/cezar/automations.json`. Opening one in the existing editor
  (`packages/web/src/routes/automations/editor.tsx`) shows a short read-only notice instead of the
  github/schedule form; "run now", "duplicate" and "copy as CLI" refuse it with an explanatory
  toast (`use-automations.ts`) rather than mis-behaving.
- No `cez automation` CLI support for creating one (`AUTOMATION_SCHEMA_REFERENCE` in `prompts.ts`
  only mentions that the kind exists and must be hand-authored).
- No status/comment write-back is performed by cezar itself — the prompt author decides what "on
  completion" means, and the agent must call the vendor API itself (e.g. via curl) using the
  env vars now available to it. There is no `cez tracker` CLI helper.
- `filters.status` is not yet in the WIRE `automationFiltersSchema` (contract) used by
  `GET /automations`'s response type — a tracker automation's status filter is invisible to any
  future UI reading that response until that schema is extended too (internal polling is
  unaffected; it reads the storage schema directly).

Given the credential-exposure trade-off was made explicitly and knowingly for speed, revisiting it
(server-side write-back, or a privileged CLI that never hands the agent the raw secret) remains the
natural next step if this graduates past a same-day experiment.
