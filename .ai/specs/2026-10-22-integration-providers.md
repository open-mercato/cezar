# Integration providers — one pluggable seam for issues and pull requests

> Slug: `integration-providers` · Issue: #1614 · Updated: 2026-10-22.
> Status: draft for review. Umbrella spec; provider specs build on it:
> [GitHub](2026-10-22-integration-github.md) ·
> [GitLab](2026-10-22-integration-gitlab.md) ·
> [Azure DevOps](2026-10-22-integration-azure-devops.md) ·
> [Jira](2026-10-22-integration-jira.md) ·
> [Linear](2026-10-22-integration-linear.md).
> Supersedes the "separate migration" deferral in
> [2026-09-18-jira-linear-tracker-browsing](2026-09-18-jira-linear-tracker-browsing.md) and the
> seam half of #847 (and its unmerged spec PR #848; implementation PR #1226 is prior art on the
> old seam). Related: #1085, #1484.
> API names below are proposed contracts, not existing capabilities.

## TLDR

cezar has two unrelated seams today: `ForgeDriver` (GitHub only, repo-anchored, `gh`-backed,
issues + PRs + checks + merge + draft PR) and `TrackerProvider` (Jira/Linear, scope-anchored,
token-backed, read-only issues + automation events). The cockpit shows them as two tabs —
**GitHub** and **Tracker** — and a project can have at most one of each.

This spec replaces both with **one integration seam**: a provider is a self-contained plugin
module that declares a manifest (identity, capabilities, how it connects) and implements only
the capability facets it supports. A project can have **any number of connected integrations at
once** — e.g. GitHub for code review plus Jira for work items, or GitLab plus Linear, or Azure
DevOps alone. The two nav tabs collapse into one **Issues** view with a provider switcher; the
review gate's "Create PR" goes to whichever integration owns the push remote.

Connection strategy is **CLI-first**: where the vendor ships a maintained CLI with its own auth
store and JSON output (`gh`, `glab`, `az devops`, `acli`), cezar delegates to it and holds no
credential — the property GitHub already relies on. Where no such CLI exists or the user prefers
a token, the provider falls back to the existing managed per-project credential store. Zero-config
survives: a GitHub repo with `gh` signed in shows exactly what it shows today, with no setup.

## Problem statement

- **One tab per seam, one integration per seam.** A team on GitLab + Jira, or Azure DevOps
  end-to-end, has no path. A team on GitHub + Jira sees two disconnected tabs with two composers.
- **Adding a provider means touching ~40 files.** #847 inventories eight subsystems that bypass
  `ForgeDriver` and talk to `gh`/`github.com` directly (routes, automations, clone, backend
  detection, agent env, secret redaction, run bookkeeping regexes, the whole web tier).
  `docs/adding-issue-tracker.md` is better, but still requires editing a closed enum, a factory
  map, a fixtures table and a UI metadata table in four packages.
- **The two seams already overlap.** Both list, search and fetch issues; both hand an issue to an
  agent; both feed automations (`github-poller.ts` vs `tracker-poller.ts`, with two trigger
  schemas and two template-token namespaces). Every improvement lands twice or once.
- **Demand is concrete:** #847 (GitLab incl. self-managed), #1085 and #1484 (Azure DevOps),
  and the Jira/Linear trackers that today cannot link to the PR their task produced.

Business outcome: a team picks cezar regardless of where its code and backlog live, and a new
provider is one directory plus a registry line — not a cross-package change.

## Non-goals

- Bitbucket, Gitea/Forgejo, YouTrack, Shortcut, ClickUp, GitHub Projects — the seam must not
  preclude them; none ships here.
- Loading third-party provider code from npm in phase 1 (see § Packaging — designed, deferred).
- Webhooks / inbound HTTP. All vendor reads stay demand-driven or automation-poll-driven.
- Two-way sync, bulk edits, creating vendor issues from cezar. Writes stay limited to what exists
  today (draft PR, merge, agent-requested status update) plus "link the PR back to the work item"
  (§ Cross-provider linking), each capability-gated.
- Changing any frozen `/api/v1/github*` or `/api/v1/tracker*` shape (BACKWARD_COMPATIBILITY.md §2).

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Provider** | A plugin module: `github`, `gitlab`, `azure-devops`, `jira`, `linear`. Static code. |
| **Integration** | One connected instance of a provider inside one project: provider + anchor + connection. A project has 0..n. |
| **Anchor** | What an integration is bound to. `remote` = discovered from a git remote (GitHub/GitLab repo, ADO repo). `scope` = user-selected vendor container (Jira project, Linear team, ADO project's Boards). |
| **Connection** | How cezar authenticates — site/host + account + secret: `cli` (vendor CLI owns the credential) or `token` (managed per-project credential record). Separate from the integration: several integrations (two Jira projects on one site) share one connection. |
| **Work item** | Normalized issue / ticket / work item. |
| **Change request** | Normalized pull request (GitHub, ADO) / merge request (GitLab). |
| **Facet** | A capability group a provider may implement (below). Absent facet = truthful "not supported", never a 5xx. |

## Architecture

```mermaid
flowchart LR
  subgraph registry[Provider registry — static, no I/O]
    gh[github] --- gl[gitlab] --- ado[azure-devops] --- jira[jira] --- lin[linear]
  end
  remote[git remotes] --> discover[discover() per provider]
  cli[vendor CLI on PATH + auth status] --> discover
  stored[.ai/cezar/integrations.json] --> resolve
  discover --> resolve[IntegrationResolver per project]
  creds[managed credential store] --> resolve
  resolve --> i1[Integration A: github remote]
  resolve --> i2[Integration B: jira scope]
  i1 & i2 --> api["/api/v1/integrations/*"]
  i1 --> legacyG["/api/v1/github* (frozen, thin adapter)"]
  i2 --> legacyT["/api/v1/tracker* (frozen, thin adapter)"]
  api --> ui[Issues view + provider switcher]
  i1 & i2 --> auto[Automations event sources]
  i1 --> gate[Review gate: create/view change request]
```

### Provider manifest

Every provider lives in `packages/cezar/src/integrations/<id>/` and default-exports one
definition. The registry (`integrations/registry.ts`) is a static list of imports — adding a
provider is one directory plus one line.

```ts
// packages/cezar/src/integrations/types.ts — behavioral interfaces only; data shapes are zod in the contract
export interface IntegrationProviderDef {
  readonly id: IntegrationProviderId;          // contract enum, see § Contract
  readonly manifest: IntegrationManifest;       // pure data, also served to the cockpit
  /** Zero-network: classify remotes + read CLI presence. Never contacts the vendor. */
  discover(ctx: DiscoverContext): Promise<IntegrationCandidate[]>;
  /** Build a live integration for one project. Construction performs no network I/O. */
  create(ctx: IntegrationContext): Integration;
}

export interface Integration {
  readonly ref: IntegrationRef;                 // { id, providerId, anchor, connectionId? }
  availability(opts?: { refresh?: boolean }): Promise<IntegrationAvailability>;
  workItems?: WorkItemsFacet;                   // list/search/get, thread, labels
  changeRequests?: ChangeRequestsFacet;         // list/search/get, status-by-branch, diff, checks
  merge?: MergeFacet;                           // merge-state + merge
  publish?: PublishFacet;                       // create draft CR from a run branch
  automation?: AutomationFacet;                 // eventOptions + AutomationEventSource
  link?: LinkFacet;                             // write a backlink / transition a work item
  clone?: CloneFacet;                           // clone a repo by ref
  agentAccess?: AgentAccessFacet;               // env/CLI the agent may use, opt-in per run
  dispose(): void;                              // replaces clearCache/evict*ProjectCaches
}
```

`IntegrationManifest` (served at `GET /integrations/providers`) carries: `label`, `icon` key,
`anchor` kinds, `connections` it supports in preference order (e.g. `['cli','token']`), the CLI
descriptor (`bin`, minimum version, install hints per platform with an install-weight note (e.g. `az` is a large Python install), `authStatus`/`login` argv,
docs URL), the token form fields (schema-driven: name, label, secret?, validation regex), the
**vocabulary** (`workItem: 'issue' | 'ticket' | 'work item'`, `changeRequest: 'pull request' |
'merge request'`, key format example `#123` / `PROJ-42` / `!17` / `AB#1234`), the facets it
implements, the automation events it can verify, and its **reference patterns** (§ Run bookkeeping).

Facets are capability flags, not booleans in the UI: the cockpit renders a panel only when the
integration's resolved capabilities include it (`merge` absent → no Merge button; `publish`
absent → review gate offers "Push branch" only).

### Anchors and discovery (zero-config)

- **Remote-anchored providers** (`github`, `gitlab`, `azure-devops` Repos) classify every git
  remote of the project, not just `origin`, using `resolveTaskRemotes` (`git-remotes.ts`) for
  base/push selection. A provider recognises well-known hosts (`github.com`, `gitlab.com`,
  `dev.azure.com`, `*.visualstudio.com`, `ssh.dev.azure.com`) and any host its CLI is signed in
  to (`gh auth status --hostname`, `glab auth status`, `az devops configure --list`), which is how
  self-managed GitLab / GitHub Enterprise / Azure DevOps Server are found **without a host table
  the user must write**. An explicit host override is optional (`integrations.json`), never
  required. "Signed in to" is read **synchronously from the CLI's own host config file with a
  short TTL** (the `github-hosts.ts` pattern), never by spawning `auth status` per request. Those
  files can hold plaintext tokens, so parsers are a zod *pick* of host keys only; a token value is
  never kept, logged or cached.
- A remote anchor carries the **full project path** (GitLab subgroups `group/sub/repo`, ADO
  `org/project/_git/repo`) and an **instance base** (scheme, web port, relative URL root such as
  `https://intranet.acme/gitlab/`) supplied by the connection, not guessed from the remote URL.
  `parseRemote` in `git-remotes.ts` drops both today and is fixed in phase 1.
- **Host classification precedence** when two providers could claim a host, stated once here:
  user override in `integrations.json` > a CLI signed in to that host > well-known host. A host
  name that merely *looks* like a vendor (`gitlab.acme.com`) is at most a "sign in?" suggestion in
  Settings, never an active integration.
- **Scope-anchored providers** (`jira`, `linear`, ADO Boards) need a user choice — Settings →
  Integrations → Connect → pick project/team (the existing paginated picker). No scope is ever
  guessed.
- Discovery is **local only**: git config, `PATH` lookup, the CLI's local auth status. No vendor
  request at boot, health, project classification or sidebar render — inherited from both
  existing specs. Health reports cached availability with stale-while-revalidate, as
  `detectGithubCached` does today.

### Several integrations at once

`IntegrationResolver` (one per project context, beside `store`/`manager` in
`server/project-context.ts`) yields the ordered list of integrations:

1. remote-discovered integrations (auto, not persisted unless the user overrides or hides one);
2. stored integrations from `.ai/cezar/integrations.json` (scope-anchored or overridden).

Roles are explicit, not inferred from order:

- **Code host** — at most one per project: the integration owning the PR-target remote from
  `resolveTaskRemotes`. It receives the review gate's publish, merge, branch→CR status and PR
  chips. A user may override it (e.g. ADO repo mirrored to GitHub) in Settings.
- **Work sources** — any number. Every integration with a `workItems` facet appears in the
  Issues switcher; the user can hide one per project.

### Packaging and installation ("easily installed")

Phase 1 providers are **first-party, compiled in**, each a self-contained directory (server
module + cockpit metadata + fixtures + tests). "Installing" an integration is a user flow, not a
package install:

1. **Settings → Integrations** lists every provider from the registry with live readiness:
   `CLI missing` → `CLI found, signed out` → `Signed in` → `Connected (n)`.
2. **Install CLI** shows the per-platform command from the manifest and, on a local cockpit,
   offers a one-click run through the existing server-install step runner (`server-install/steps.ts`,
   brew/apt/winget). Never auto-installs.
3. **Sign in** opens the CLI's own interactive login in the user's terminal via the existing
   Open-in-terminal handoff (`server/open-in-terminal.ts`) — cezar never sees the secret — or, for
   `token` connections, the write-only form backed by the managed credential store.
4. **Connect** — remote-anchored integrations connect themselves once signed in; scope-anchored
   ones open the scope picker.

The same flow is available headless: `cez integrations list | doctor | connect <provider> [--scope …] | disconnect <id>`.

**Phase 3 (designed, not built here): external provider packages.** A provider package
`cezar-integration-<name>` exports the same `IntegrationProviderDef` and declares
`cezarIntegrationApi: 1`. It is installed only by an explicit user command
(`cez integrations add <npm-spec>`) into `~/.cezar/integrations/` and loaded at boot from there.
It runs in-process with full trust — the install command is the consent, and the Settings page
labels it "third-party". Provider ids for external packages live in an `x-<name>` namespace that
the contract validates as a pattern **in addition to** the first-party enum, so the finite-enum
rule in `docs/adding-issue-tracker.md` still holds for everything shipped. This needs owner
ratification before it is built (it widens the trust boundary); everything in phases 1–2 is
designed so that it can be added without reshaping the seam.

### Connection strategies

| Strategy | Who holds the credential | Used by | Notes |
| --- | --- | --- | --- |
| `cli` | The vendor CLI's own store (keychain / config file) | `gh`, `glab`, `az` + `azure-devops` extension | cezar shells out with a fixed argv, `--json`/`-F json`/`--output json`, cwd = project root, bounded timeout, zod at the boundary. ENOENT → `{ available:false, reason:'Install <cli>' }`. |
| `token` | Managed per-project dotenv in `cezarHomeDir()/integration-connections/<sha256(root)>/<connectionId>.env` (legacy `tracker-connections/<sha256(root)>.env` is read in place as connection `legacy`) | Linear, Jira (Cloud API token / Data Center PAT), any provider when the CLI is absent | The existing `tracker-connections` store generalized and renamed; the old directory is read in place (no migration of secrets, no fallback to `process.env`). |
| `cli` (brokered) | The vendor CLI; cezar holds a **short-lived** token it minted, in memory only | Azure DevOps Services (`az account get-access-token`) | For vendors whose CLI has no usable API passthrough. The token never touches disk, logs, run records or agent env, and is re-minted on expiry. |

A provider declares its strategies in preference order and the resolver picks the first that is
ready. Each provider spec documents the vendor CLI research, including why a CLI was rejected
where it was (e.g. no official Linear CLI).

Shared plumbing extracted from `forge/github.ts` into `integrations/shared/`:
`cli-exec.ts` (cwd-scoped execFile, timeout, output cap, ENOENT/auth mapping, env scrubbing),
`http-transport.ts` (today's `tracker/transport.ts`: deadline, size caps, cooldown; a
per-connection CA file option for private CAs, never a TLS-off switch; **no cross-origin
redirects** on token transports, which would leak the auth header), `cursor.ts` (signed cursors bound to integration + query), `cache.ts` (keyed by
`project + integrationId + query`, never module-global — the `detectCache` singleton bug #847
names), and `markdown.ts` (ADF/HTML → Markdown converters, with loss disclosure).

## Contract

New file `packages/contract/src/integrations.ts`; types inferred, api-client re-exports.

- `integrationProviderIdSchema = z.enum(['github','gitlab','azure-devops','jira','linear'])`.
- `integrationRefSchema = { id, providerId, anchor: { kind:'remote', remote, host, path } | { kind:'scope', source, scope }, connectionId? }`. `id` is a stable slug (`github`, `jira-PROJ`, `gitlab-2`), URL-segment safe.
- `workItemSchema`: `{ integrationId, providerId, id (string, URL-segment safe), key (display: '#12', 'PROJ-42', '!17', 'AB#1234'), kind: 'issue'|'change_request', title, state: 'open'|'closed'|'merged'|'draft', stateLabel, author, assignees[], labels[{name,color?}], createdAt, updatedAt, url (https), commentCount?, checks?, diffStat?, excerpt? }`.
  GitHub's numeric `number` maps to `id: '12'`, `key: '#12'`; `GithubItem` is unchanged.
- `workItemDetailSchema`: item + `body` (Markdown), `bodyLoss?` (truncated/unsupported content
  disclosure, from the tracker spec), `thread?` (comments + timeline events with an allowlisted
  kind union that is a superset of `ForgeTimelineEventKind`).
- `integrationAvailabilitySchema`: `{ available, reason?, connection: 'cli'|'token'|null, degraded?: string, cli?: { bin, found, version?, signedIn? } }` — `reason` is human copy, never a vendor error body; `degraded` flags a working but slower/limited transport (e.g. no rate-limit headers) so health and automations can slow down truthfully.
- Change-request status/merge/diff/checks reuse the existing `github.ts` contract shapes,
  re-exported under neutral names (`ChangeRequestMergeState = GithubPrMergeState` structurally);
  GitHub-specific fields become optional where another vendor cannot supply them.
- **Auto-merge** (GitHub auto-merge, GitLab merge-when-pipeline-succeeds, ADO auto-complete) is
  decided once here: merge-state gains `autoMerge?: { available: boolean; enabled: boolean }`, the
  neutral merge body gains `autoMerge?: boolean`, and the neutral merge response adds a non-merged
  success branch `{ merged: false, autoMergeEnabled: true, … }` with status 200, and a `{ merged: false, queued: true, … }`
  branch for vendors whose completion is asynchronous (ADO PR completion).
  `githubMergeResponseSchema` (`merged: z.literal(true)`) is frozen and untouched — the frozen
  GitHub route never sends that branch.

### Routes

One chained family `integrationsRoutes`, mounted under `/api/v1` and `/api/v1/p/:projectId`,
validated with the middleware trio:

| Route | Purpose |
| --- | --- |
| `GET /integrations/providers` | manifests (static) |
| `GET /integrations` | this project's integrations + roles + cached availability |
| `POST /integrations` / `DELETE /integrations/:iid` | connect a scope-anchored integration / disconnect or hide |
| `GET /integrations/:iid/candidates` | scope picker (paginated) |
| `GET /integrations/:iid/items?kind&state&q&labels&cursor&refresh` | list + server-side search |
| `GET /integrations/:iid/items/:itemId` | detail (body + loss disclosure) |
| `GET /integrations/:iid/items/:itemId/thread` | comments + timeline |
| `GET /integrations/:iid/change-requests/:itemId/{changes,merge-state,checks}`, `POST …/merge` | capability-gated |
| `POST /runs/:id/change-request` | publish through the code host (today's `POST /runs/:id/pr` stays, delegating) |

`/api/v1/github*` and `/api/v1/tracker*` keep their paths and shapes and become thin adapters over
the GitHub integration and the **legacy** scope-anchored integration respectively — the one derived
from `tracker.json`, else the first scope-anchored entry in `integrations.json` order; a stored entry
matching `tracker.json`'s association shadows it rather than duplicating it. The GitHub adapter
is selected by **provider id**, not by the code-host role, and serves the frozen shapes **directly**
(no `WorkItem → GithubItem` round-trip). Both adapters are proven by **wire goldens captured from
the current handlers before any code moves**. They are
deprecated in BACKWARD_COMPATIBILITY.md but not removed. `forgeInfoSchema.kind` in `health.ts`
widens from `z.literal('github')` to the remote-anchored subset of the provider enum (a type change
for `git-actions.ts`, shipped in the same commit).

### Persistence

`.ai/cezar/integrations.json` — optional, written only when the user connects a scope, overrides a
host/role or hides an integration. Zod with `.catch` per field, per-entry salvage, `.passthrough()`.
Absent file = remote-discovered integrations only. An existing `.ai/cezar/tracker.json` is read as
one stored scope-anchored integration (read-in-place, never rewritten), so no migration step.
Add `integrations.json` to `ensureDataGitignore`.

## Cockpit UX

The whole interface may change; these are the constraints, mockups belong to the GitHub spec's
UI phase.

- **One integration = no visible change:** `GitHub` label, `/github/*` URLs, no switcher.
- **Nav:** with two or more integrations (or one that is not GitHub), `GitHub` and `Tracker` merge
  into one **Issues** item. Routes `/p/:projectId/issues/:iid`, `/issues/:iid/i/:itemId` (work item)
  and `/issues/:iid/cr/:itemId` (change request — keeps GitLab `#12` and `!12` apart); `/github/*`
  and `/tracker/*` deep links redirect only then. `projects[].integrations?` lets the sidebar gate
  the item without network. Design and wireframes: [GitHub spec](2026-10-22-integration-github.md).
- **Provider switcher:** a segmented control / tab strip of connected integrations with provider
  icon + scope (`GitHub · open-mercato/cezar`, `Jira · PROJ`), plus `+ Connect` leading to
  Settings → Integrations. Selection persists in ui-state (`issuesView.integrationId`, replacing
  `githubView` additively).
- **Lists:** one list component over `WorkItem`. Filter chips come from the manifest
  (Issues / Pull requests for code hosts; status categories for trackers). Server-side search
  always; no local filtering pretending to be search. Search depth is a per-facet capability
  (`search: 'full' | 'id-only'`) — Azure Repos has no PR title search — and the UI says so instead
  of faking it.
- **Detail + hand-to-agent:** one composer (`lib/work-item-task.ts`) generalizing
  `github-task.ts` and `tracker-task.ts`; the prompt heading uses the manifest vocabulary and the
  item `key`. The existing tier-2 worded patterns in `task-refs.ts` stay intact for GitHub.
- **"All" view (phase 4, optional):** merged feed across integrations sorted by `updatedAt`,
  only once each provider's list is cursor-stable.
- **Settings → Integrations** (the existing `integrations` section, today holding the e2e "Test
  frameworks" card) gains an **Issues & code** first tab — catalog + readiness + connect — and
  absorbs Settings → Issue tracker.

## Run bookkeeping and task references

`runs/store.ts` (`PR_URL_RE`, `ISSUE_URL_RE`) and `runs/task-refs.ts` only know GitHub's URL shapes
(those regexes are already host-agnostic and stay exactly as they are — narrowing them to known
hosts would drop chips). Each new provider's manifest contributes `referencePatterns`: URL patterns
(host-parametrized for self-managed),
worded patterns, and a `key` pattern (Jira: the contract's `^[A-Z][A-Z0-9_]*-[1-9]\d*$`, matched **only for project
keys of connected integrations** so `UTF-8` and `ISO-9001` never become refs; `AB#\d+` for ADO, `!\d+` for
GitLab MRs). `extractTaskRefs` runs every pattern of the project's integrations; bare `#N`
takes the **code host's native meaning** (GitHub/GitLab issue, Azure DevOps work item) and is never
claimed by a scope-anchored work source. `RunRecord` gains optional
`workItemRefs?: { integrationId, providerId, itemId, key, url, kind, launchedFrom? }[]`; existing `prNumber`-style
fields remain and are populated for the code host. Old records parse unchanged.

## Cross-provider linking

The reason to run GitHub + Jira together: a task launched from `PROJ-42` produces a PR on GitHub.

- The publish facet accepts `linkedWorkItems` from the run's refs. Each work-source manifest
  supplies two templates:
  - a **title prefix** — the bare key (`PROJ-42`, `ENG-12`, `AB#1234`). Jira's development panel
    reads only the PR title and branch name, so the key goes in the title by default;
  - a **description footer** — magic words go in the body, because GitHub Enterprise and GitLab read
    them only in the description (`Fixes #12`, Linear `Fixes ENG-12`, ADO `AB#1234`).
- Closing words (`Fixes`, `Closes`) apply **only to the item the run was launched from**
  (`workItemRefs[].launchedFrom`); every other ref gets a non-closing word (`Refs`).
- `workItemDetail.vcsBranchHint?` (e.g. Linear `Issue.branchName`) feeds the existing branch-naming
  hints, so the vendor recognises the branch too.
- Optional `link` facet: on publish, add a remote link / attachment / comment on the work item
  ("cezar opened PR …"). Opt-in per integration, off by default (it is a vendor write). One shared
  settings shape and one retry route for every provider:
  `POST /integrations/:iid/items/:itemId/links`.
- Agent-requested status transitions (existing Jira capability via `agent-credentials.ts`) move
  under `link` with the same opt-in rules.

## Automations

`automations/event-source.ts` already defines `AutomationEventSource<C>`. Generalize:

- `AutomationFacet = { eventOptions(): Promise<…>; source(trigger): AutomationEventSource<WorkItemEventCandidate> }`.
- `automationKindSchema` gains `integration` with `integrationTrigger = { integrationId, providerId, events, filters }`;
  `github` and `tracker` kinds keep parsing and running unchanged (they are the frozen spellings)
  and new automations created on GitHub/Jira/Linear may use either.
- Event vocabulary is provider-neutral where semantics match (`work_item.created`,
  `work_item.status_changed`, `work_item.labeled`, `change_request.opened`,
  `change_request.review_requested`, `change_request.review_submitted`), each provider advertising
  only events it can **verify from history** (tracker spec rule). No state-diff fallback: an
  event the vendor keeps no history for (e.g. GitLab reviewer-requested) is simply not offered
  by that provider, and the editor says so.
- Template tokens: new `item.*` namespace (`item.key`, `item.title`, `item.url`, `item.labels`,
  `item.provider`, `item.event`); `github.*` and `tracker.*` keep working as aliases.
- The poll cycle, receipts, leases and baselining (`event-poll-cycle.ts`, `scheduler.ts`) are
  reused as is. Per-provider rate budgets replace `GithubRequestArbiter`'s GitHub-only budget, keyed by **vendor
  account** rather than connection (Linear meters all of a user's keys together).

## Host tooling, agent env, redaction

- `backendCheckSchema.name` widens to include each provider CLI (`glab`, `az`, `acli`); probes
  come from manifests, never a hand-written union.
- `core/agent-env.ts`: each manifest declares the env names its CLI reads (`GH_TOKEN`,
  `GITLAB_TOKEN`/`GITLAB_HOST`, `AZURE_DEVOPS_EXT_PAT`, …). Forwarding keeps today's GitHub
  behavior and is opt-in for every new provider.
- `core/secret-redaction.ts`: manifests contribute token patterns (`glpat-…`, `lin_api_…`,
  `ATATT…`); a test asserts every manifest's pattern is registered. Patterns are not enough
  (a self-managed GitLab PAT prefix is configurable), so the **exact values** held in the managed
  credential store are also registered with the redactor when a connection loads.
- `workflows/run.ts` PR nodes (`createDraftPr`, `commentOnPr`, `updatePr`, `commentOnIssue`,
  wait-for-CI) call `forge/github.ts` directly today; they route through the code-host
  integration's `publish`/`changeRequests`/`link` facets, and a node whose facet is absent fails
  with a clear "not supported by <provider>" step error.
- `checkout.ts`: clone goes through the `clone` facet; `parseRepoRef` accepts any host a provider
  recognises; the ownership-proof and target-path rules are unchanged.

## Phasing

| Phase | Ships | Issue |
| --- | --- | --- |
| 1 | Seam, registry, contract, resolver, `integrations.json`, Settings → Integrations, `cez integrations`, shared plumbing; GitHub migrated with **no user-visible change** | umbrella + GitHub |
| 2 | Jira and Linear moved from `server/tracker/` onto the seam; multiple integrations per project; Issues view + switcher; cross-provider linking | Jira, Linear |
| 3 | GitLab (SaaS + self-managed); Azure DevOps (Services + Server); automations per provider | GitLab, Azure DevOps |
| 4 | Optional "All" feed; external provider packages (after owner ratification) | follow-ups |

Each phase is shippable alone and keeps every frozen route green.

## Backward compatibility

- `/api/v1/github*`, `/api/v1/tracker*`, `POST /runs/:id/pr` — paths and shapes frozen; adapters.
- `health.forge.kind` widening, `backendCheckSchema.name` widening, `projects[].forge` — additive
  values on existing keys; consumers widened in the same commit.
- Automations `github`/`tracker` kinds, `github.*` / `tracker.*` tokens, log fields
  `githubNumber`/`trackerKey` — kept; new fields additive.
- `tracker.json`, `tracker-connections/` — read in place; never required, never rewritten.
- Zero-config: GitHub + `gh` behaves exactly as today; unknown host → no code-host integration,
  plain-git features only, never an error.

## Acceptance criteria

- A new provider is added by creating `integrations/<id>/` and one registry line; a conformance
  suite (`integrations/conformance.test.ts`) runs every registered provider's fixtures through
  the same assertions (pagination, empty vs unavailable vs not-found, cursor binding, no network
  on construct/discover, redaction, loss disclosure).
- A project with GitHub + Jira shows both in the switcher, launches a task from a Jira ticket,
  and the draft PR on GitHub carries the Jira key.
- `route-parity`, `bc-route-inventory`, `contract-parity*`, `typed-bodies` cover every new route.
- `CEZ_DRY_RUN=1` exercises every provider offline through fixtures.
- With no config file and no new env var, a GitHub repo's cockpit is byte-identical in behavior.

## Open questions

1. Nav label: "Issues", "Work" or provider-named when there is one integration? (proposal above)
2. Should the "All" merged feed be phase 2 instead of 4?
3. External provider packages: ratify the trust model, or keep providers first-party only?
4. Do we deprecate (and later remove) `/api/v1/tracker*` once the cockpit no longer calls it?
