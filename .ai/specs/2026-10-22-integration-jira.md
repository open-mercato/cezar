# Integration provider: Jira (Cloud, Data Center/Server)

> Slug: `integration-jira` · Issue: #1618 · Updated: 2026-10-22.
> Status: draft for review. Provider spec under the umbrella
> [integration-providers](2026-10-22-integration-providers.md), which is binding for the seam,
> contract, routes, persistence and phasing. This file only says how Jira fills it.
> Builds on [2026-09-18-jira-linear-tracker-browsing](2026-09-18-jira-linear-tracker-browsing.md)
> (scope anchoring, loss disclosure, history-verified events). Those rules carry over unchanged
> unless this file says otherwise.
> Every vendor claim cites a doc. **[V]** = verified against the vendor's docs page with `curl` on
> 2026-10-22 (web search was unavailable to this session). **[A]** = assumption to confirm during
> implementation.

## TLDR

`jira` is a **scope-anchored work source**. It is not a code host: it has no change requests,
merge, publish or clone. It implements `workItems` (list, search, detail, comment thread),
`automation` (created and status-changed, both history-verified), `link` (opt-in remote link or
comment back to the work item, plus the existing agent-requested transitions) and `agentAccess`
(the existing per-run `JIRA_*` env).

Phase 2 of the umbrella moves today's `server/tracker/jira*.ts` onto `integrations/jira/` with
**no regression**. `tracker.json` and `tracker-connections/` are read in place,
`/api/v1/tracker*` becomes a frozen adapter, and every existing test keeps passing against the
adapter. The move then adds three things:

- **Several Jira integrations per project**, across sites and projects.
- **Cross-provider linking** to whichever code host publishes the PR. The Jira key goes into the
  PR **title**, because Jira's development panel reads titles and branch names, not bodies. An
  opt-in remote link back to the PR is also available.
- **Jira Data Center/Server** through a personal access token (PAT, bearer auth) against a
  validated custom origin.

**Connection decision: `token` only. No CLI connection is offered.** Atlassian's official `acli`
is Cloud-only. Its signed-in account is process-global (`acli jira auth switch`), it has no raw
API passthrough and no changelog, and its search pages with `--limit`/`--paginate` rather than a
cursor. It cannot back history-verified automations, and it cannot back two Jira integrations at
once without mutating the user's CLI state. The community `jira-cli` reads the same secret from
`JIRA_API_TOKEN`/`.netrc`/keychain that cezar would otherwise hold, so it removes no credential
from cezar. Both are listed under § Host tooling as tools an agent may use; neither is a
connection.

## Problem

- **One Jira per project.** `TrackerConnections` stores exactly one record per project root
  (`sha256(root).env`), and `tracker.json` holds one association. A team whose repo serves two
  Jira projects, or two sites, cannot see both.
- **Cloud only.** The credential schema accepts only `https://<x>.atlassian.net`
  (`contract/src/tracker.ts`). Data Center ends support on 2029-03-28 [V][dc-eol], but it is still
  where regulated teams keep their backlog.
- **No path back.** A task launched from `PROJ-42` opens a GitHub/GitLab PR that Jira never
  learns about. Jira's development panel needs the key in the PR **title** or the **branch
  name** [V][devpanel]. Today's draft PR title is the run title and the branch is `cez/<id8>`, so
  nothing links.
- **Two tabs, two composers** (umbrella § Problem). Jira lives in the Tracker tab, and its
  hand-to-agent prompt is `tracker-task.ts`.

## Non-goals

- Creating, editing, assigning or bulk-changing Jira issues from the cockpit. The only writes are
  the opt-in `link` writes and the agent-requested transitions that exist today.
- Jira webhooks, Forge or Connect apps, and OAuth 2.0 (3LO). OAuth would need a registered app
  and a redirect URI, which is configuration cezar does not ship.
- Jira Service Management queues, boards and sprints, and Jira Work Management specifics. A
  service-desk *project* is still an ordinary JQL scope and works.
- Atlassian Government Cloud (`acli` does not support it [V][acli-intro]; the REST path is
  untested there [A]).
- Server versions older than 8.14, which have no PAT [V][dc-pat]. Basic auth with a password
  against Server/DC is deliberately not offered.

## Vendor research

### `acli` — Atlassian CLI (official)

| Question | Finding |
| --- | --- |
| Status | Official, Atlassian-maintained, documented under `developer.atlassian.com/cloud/acli` [V][acli-intro]. |
| Install | macOS: `brew tap atlassian/homebrew-acli && brew install acli` [V][acli-mac] (not in homebrew-core: `formulae.brew.sh/api/formula/acli.json` → 404 [V]). Linux: an APT repo at `acli.atlassian.com/linux/deb` with a signed keyring, plus a curl binary [V][acli-linux]. Windows: `Invoke-WebRequest` of `acli.exe` (amd64/arm64) [V][acli-win]. No winget or npm package found [A]. |
| Deployments | The Jira command group is titled "Jira Cloud commands", and every login example uses `*.atlassian.net` [V][acli-login]. **No Data Center/Server.** No Government Cloud [V][acli-intro]. |
| Auth | `acli jira auth login --web` (browser OAuth), or `--site --email --token` with the API token on stdin [V][acli-login]. `auth status`, `auth logout`, and `auth switch --site --email` switch the **active** account [V][acli-switch]. Commands take no per-invocation `--site`/account flag [V] (none of the reference pages lists one). The credential store location is not documented [A]. |
| JSON output | `--json` on `workitem search` [V][acli-search], `workitem view` [V][acli-view], `project list`/`project view` [V][acli-project], `workitem comment list` [V][acli-comment-list], `transition`/`comment create` [V][acli-transition]. The `auth status` output format is undocumented [A], so readiness would have to scrape text. |
| Pagination | `--limit N` or `--paginate` (fetch everything) [V][acli-search]. **No continuation token** is exposed, so cursor-stable paging is impossible. |
| Raw API passthrough | **None.** No `acli api`-style command exists in the command index (39 reference pages, 2026-10-22) [V][acli-index]. |
| History / changelog | No command [V][acli-index]. Automations need `/issue/{key}/changelog`. |
| Remote links | `workitem link` is issue↔issue only (`create/delete/list/type`) [V][acli-link]. There is no remote (web) link command. |

### `jira-cli` — `ankitpokhrel/jira-cli` (community)

| Question | Finding |
| --- | --- |
| Status | MIT, about 6.0k stars, last push 2026-10-17, **latest release v1.7.0 on 2025-08-31** (over a year old) [V][jc-repo]. In homebrew-core as `jira-cli` 1.7.0 [V][jc-brew]. |
| Deployments | Cloud and on-premises (Server/DC) [V][jc-readme]. |
| Auth | `basic` (default), `bearer` (PAT, via `JIRA_AUTH_TYPE=bearer`) and `mtls` [V][jc-readme]. **The secret comes from `JIRA_API_TOKEN`, `.netrc` or keychain**, and `jira init` writes a config file [V][jc-readme]. |
| JSON output | `jira issue list --raw` is documented [V][jc-readme]. The README documents no `--raw` for view, comments or history [A]. |
| Raw API passthrough | None documented [A]. |
| Remote links | `jira issue link remote ISSUE-1 <url> "<text>"` [V][jc-readme]. |

Driving `jira-cli` would mean cezar either sets `JIRA_API_TOKEN` itself (so it holds the secret
anyway) or depends on the user's shell env, which a repository `.env` rule and the cockpit's
non-login process do not provide. It also has no changelog command. It brings release lag and a
second auth model for no benefit over REST.

### Jira REST facts the design relies on

- Cloud search is `POST /rest/api/3/search/jql`, which pages by `nextPageToken`
  [V][cloud-search]. Changelog: `GET /rest/api/3/issue/{key}/changelog` and
  `POST …/changelog/list` [V][cloud-issues]. These are what `jira.ts`/`jira-events.ts` already
  call.
- **Scoped API tokens must call `https://api.atlassian.com/ex/jira/{cloudId}`** [V][tokens]. The
  existing gateway-then-site fallback in `jira.ts` stays.
- API tokens created after 2024-12-15 **expire within one year** [V][tokens]. A 401 on a
  previously working connection maps to "Token expired or revoked — reconnect".
- Rate limits: API-token traffic is governed by **burst** limits only. The points-based hourly
  quota (enforced since 2026-03-02) applies to Forge, Connect and OAuth apps, not to token
  traffic. 429 responses carry `Retry-After` [V][rate]. The existing `transport.ts` cooldown
  honours that header.
- Remote issue links: `POST /rest/api/3/issue/{key}/remotelink` is "Create or update", keyed by
  `globalId` [V][cloud-remotelink], so it is idempotent. Data Center has the same resource at
  `/rest/api/2/issue/{key}/remotelink` [V][dc-remotelink].
- Data Center: a PAT is sent as `Authorization: Bearer <token>`, is available from Jira 8.14,
  and can be set to expire [V][dc-pat]. REST v2 provides `/rest/api/2/search` with
  `startAt`/`maxResults` [V][dc-search] and `/rest/api/2/serverInfo` [V][dc-serverinfo].
  `serverInfo.deploymentType` is `"Server"` on DC and `"Cloud"` on Cloud [A]. In v2 the
  description and comment bodies are **wiki-markup strings**, not ADF [A], and changelog is
  available through `GET /rest/api/2/issue/{key}?expand=changelog` [A].
- Development panel: put the work item key **in the branch name**, **in the commit message**, or
  **in the PR title** (or have the source branch contain it) [V][devpanel]. Keys must be
  uppercase [V][devpanel]. GitLab feeds the panel through the "GitLab for Jira Cloud" app on
  Cloud and the DVCS connector on DC/Server, and mentioning a Jira ID in an MR links it
  [V][gitlab-jira]. GitHub is supported through the "GitHub for Jira" app [V][devpanel].

### Recommendation: `token`, with a deployment split under it

| Need | acli | jira-cli | REST + token |
| --- | --- | --- | --- |
| Cloud | ✓ | ✓ | ✓ (today) |
| Data Center/Server | ✗ | ✓ (bearer) | ✓ (bearer PAT) |
| Holds no credential in cezar | ✓ | ✗ (`JIRA_API_TOKEN`) | ✗ |
| Several sites or accounts at once | ✗ (global active account) | ✗ (one config) | ✓ (one connection per record) |
| Cursor-stable paging | ✗ | ✗ | ✓ |
| Changelog (automations) | ✗ | ✗ | ✓ |
| Remote link (`link`) | ✗ | ✓ | ✓ |
| Raw passthrough for gaps | ✗ | ✗ | n/a |

`connections: ['token']`. The reasons are already written in the manifest's `cliRejected` note
(rendered in Settings → Integrations): Cloud-only, global account, no changelog, no
passthrough. **Revisit when** `acli` ships an `api` passthrough **and** a per-invocation site
flag. Then a `cli` connection for Cloud becomes the preferred strategy, using the same client as
`gitlab`'s `glab api` pattern, and the token path stays for DC.

#### Facet → command mapping (evidence for the decision)

| Facet | acli argv | JSON fields used | REST used instead |
| --- | --- | --- | --- |
| availability | `acli jira auth status` | none (text) [A] | `GET /_edge/tenant_info` (Cloud, unauthenticated cloudId) · `GET /rest/api/2/serverInfo` (DC) + `GET …/myself` |
| scope candidates | `acli jira project list --limit 50 --json` | `id,key,name` [A shape] | `GET /rest/api/3/project/search?startAt&maxResults&query` (Cloud) · `GET /rest/api/2/project` (DC, unpaged [A]) |
| list/search | `acli jira workitem search --jql "<jql>" --limit N --json` | `key,fields.summary,…` [A] (**no next token**) | `POST /rest/api/3/search/jql` · `POST /rest/api/2/search` |
| detail | `acli jira workitem view KEY --fields '*navigable' --json` | `fields.description` (ADF) [A] | `GET /rest/api/{3,2}/issue/{key}?fields=…` |
| thread | `acli jira workitem comment list --key KEY --json --paginate` | `body,author,created` [A] | `GET /rest/api/{3,2}/issue/{key}/comment?startAt&maxResults` |
| automation history | none | — | `GET /rest/api/3/issue/{key}/changelog` · v2 `?expand=changelog` |
| link: remote link | none | — | `POST /rest/api/{3,2}/issue/{key}/remotelink` |
| link: comment | `acli jira workitem comment create --key KEY --body … --json` | id [A] | `POST /rest/api/{3,2}/issue/{key}/comment` |
| link: transition | `acli jira workitem transition --key KEY --status S --yes --json` | — | agent-side today (§ link) |

## Mapping onto the umbrella seam

### Manifest

```ts
// packages/cezar/src/integrations/jira/manifest.ts
{
  id: 'jira', label: 'Jira', icon: 'jira',
  anchors: ['scope'], connections: ['token'],
  cliRejected: 'acli is Cloud-only, has one global signed-in account and no changelog or API passthrough.',
  tokenForms: [
    { deployment: 'cloud', fields: ['origin (https://<site>.atlassian.net)', 'email', 'token (API token, secret)'] },
    { deployment: 'data-center', fields: ['origin (https://host[:port][/context])', 'token (PAT, secret)', 'caFile? (PEM path)'] },
  ],
  vocabulary: { workItem: 'work item', keyExample: 'PROJ-42', scope: 'Project' },
  facets: ['workItems', 'automation', 'link', 'agentAccess'],
  automationEvents: ['work_item.created', 'work_item.status_changed'], // § Automations
  referencePatterns: { key: '[A-Z][A-Z0-9_]+-[1-9]\\d*', url: '{origin}/browse/{key}' },
  footer: { titlePrefix: '{key}: ', body: 'Jira: [{key}]({url})' },
  secretPatterns: ['ATATT[A-Za-z0-9_\\-=]{20,}'],             // Cloud API token prefix [A]
  agentEnv: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
}
```

Facets absent: `changeRequests`, `merge`, `publish`, `clone`. The resolver therefore never makes
Jira the code host.

### Anchor, identity and several integrations

- **Anchor:** `{ kind: 'scope', source: { id: cloudId | serverId, webUrl: origin }, scope: {
  projectId (numeric, authoritative), projectKey (display + reference matching) } }`. The numeric
  id stays authoritative, as today (`mapIssue` rejects an issue from another project). The key
  is refreshed on every successful association read, because project keys can be renamed.
  `serverId` comes from `serverInfo.serverTitle`/`baseUrl` [A]. Without a stable id, DC uses the
  normalized origin as `source.id`.
- **Integration id:** `jira-<projectKey lowercased>`, suffixed `-2`, `-3` on collision across
  sites. It is assigned at connect time and never recomputed, so a later key rename does not
  change URLs or ui-state.
- **Connection ≠ integration.** One connection (site + account + secret) can back several
  integrations (several projects on the same site). The connect flow offers "use the existing
  connection for `acme.atlassian.net`" before asking for a token again.
- **Storage** (umbrella § Connection strategies): new connections go to
  `cezarHomeDir()/integration-connections/<sha256(root)>/<connectionId>.env`, using the same
  dotenv codec, `0600`/`0700`, O_NOFOLLOW reads, mkdir lock and atomic rename as
  `TrackerConnections` today, generalized. The legacy `tracker-connections/<sha256(root)>.env` is
  read in place as connection `legacy` and is never moved or rewritten. Disconnecting the last
  integration that uses `legacy` deletes that file, which is today's `DELETE /tracker/connection`
  behaviour.
- **Persistence:** stored Jira integrations live in `.ai/cezar/integrations.json` as
  `{ id, providerId: 'jira', anchor, connectionId, settings? }`. An existing `tracker.json` with
  `kind: 'jira'` surfaces as one integration with `legacy: true`. Its id is
  `jira-<key>` like any other, and it is not written to `integrations.json` until the user
  changes a setting on it. At that point a stored row **shadows** `tracker.json` by matching
  `source.id + projectId`, and `tracker.json` itself is still never rewritten.

### Transports

One `JiraClient` with two deployment adapters. Both use `integrations/shared/http-transport.ts`
(today's `tracker/transport.ts`: deadline, size caps, 429 cooldown, **no cross-origin
redirects**).

| | Cloud | Data Center/Server |
| --- | --- | --- |
| Auth header | `Basic base64(email:token)` | `Bearer <PAT>` [V][dc-pat] |
| Base | gateway `api.atlassian.com/ex/jira/{cloudId}` then site (today) | `origin` (with context path) |
| API | v3 (ADF bodies) | v2 (wiki-markup bodies) [A] |
| Source identity | `/_edge/tenant_info` → `cloudId` | `/rest/api/2/serverInfo` |
| Search paging | `nextPageToken` | `startAt` + `total`/`isLast` [A], wrapped in the same signed cursor |
| Body → Markdown | `adf.ts` (moves to `shared/markdown.ts`) | new `jira/wiki-markup.ts`: headings, lists, code/noformat, links, mentions. Every other macro becomes a `bodyLoss` disclosure |
| TLS | system CAs | system CAs + optional per-connection `caFile` (umbrella), never TLS-off |

**DC origin validation** (the `data-center` credential variant):

- Accept `https:` only. `http:` is accepted only for a loopback host, so a bearer token never
  crosses a network in clear text.
- Parse with `new URL`, then reject userinfo, query, fragment and non-default ports outside
  1–65535. Keep a path prefix (a `/jira` context path) normalized without a trailing slash, and
  allow at most 512 characters.
- Reject `*.atlassian.net` in the DC form (it belongs to Cloud) and the Cloud gateway host.
  Private and intranet addresses are allowed: DC normally lives there, and cezar is local.
- **Origin binding:** every request URL is built as `origin + path` and asserted to start with
  the stored origin. Redirects are followed only when same-origin. A cross-origin redirect is
  `unavailable` ("Jira redirected to another host; check the base URL"). This is the
  header-leak rule from the umbrella.
- A connect-time probe runs `GET /rest/api/2/serverInfo` + `GET /rest/api/2/myself`. If
  `deploymentType` is `Cloud`, the user gets "this is a Jira Cloud site; use the Cloud form", so
  no PAT is ever sent to Cloud.

### `workItems`

- **list/search:** today's JQL builder, unchanged: `project = <id>`, `statusCategory != Done` for
  open, label clauses, `key = … OR text ~ …`, `ORDER BY updated DESC`. On DC the same JQL goes
  to v2 search.
- **Normalization** to `workItemSchema`: `id = key` (as `TrackerItem.id` today; `getItem`
  resolves moved keys and returns the canonical key), `key = key`, `kind: 'issue'`,
  `state = statusCategory.key === 'done' ? 'closed' : 'open'` (adds `status.statusCategory` to
  `issueFields`), `stateLabel = status.name`, `author = creator.displayName`,
  `assignees = [assignee]` (adds `assignee`), and `labels`. `url = <origin>/browse/<key>`, as
  today.
- **detail:** body through ADF or wiki markup → Markdown, with the existing 60 000-character cap
  and `bodyLoss`.
- **thread (new):** comments only, paged by `startAt`, with a bounded first page (50) and
  "more on Jira" beyond it. The timeline is limited to status changes from the changelog (the
  allowlisted `status_changed` kind). Other changelog fields are not rendered.

### `automation` — see § Automations.

### `link` (writes, all opt-in per integration, default off)

`settings.link = { remoteLink: false, comment: false }` in `integrations.json`. It is toggled in
Settings → Integrations → Jira · PROJ. The toggle copy names the vendor write and the token
permission needed (`write:jira-work` for scoped tokens [A]).

| Trigger | Write | Idempotency |
| --- | --- | --- |
| Code host publishes a CR for a run whose `workItemRefs` include this integration | `POST …/issue/{key}/remotelink` `{ globalId: "cezar:<projectId>:<runId>", object: { url: <CR url>, title: "<CR key> <title>", icon: { url16x16: <provider icon> } } }` | "create or update" by `globalId` [V][cloud-remotelink] |
| Same, with `comment: true` | `POST …/issue/{key}/comment`, with an ADF (Cloud) or wiki (DC) body "cezar opened <CR link>" | at most once per (run, CR), recorded in `RunRecord.workItemRefs[].linkedAt` |
| Agent-requested transition | Unchanged: the agent receives `JIRA_*` env through `resolveTrackerAgentEnv` and calls Jira itself, only for runs whose snapshot binds this integration's connection revision | revision binding (`TrackerAgentBindingError`) |

A link failure never fails the publish. It is written to the run log as one human line, and the
run shows "Jira link failed — retry" (a `POST /integrations/:iid/items/:key/links` retry endpoint,
capability-gated).

### `agentAccess`

Today's behaviour, now per integration. `resolveTrackerAgentEnv` becomes
`jira.agentAccess.env(run)`. It returns `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` (Cloud) or
`JIRA_BASE_URL`/`JIRA_API_TOKEN`/`JIRA_AUTH_TYPE=bearer` (DC, the variable names `jira-cli`
reads [V][jc-readme]) for **automation-launched runs bound to the exact connection revision**.
Manual runs get nothing unless the user opts in per run (umbrella rule). With two Jira
integrations bound to one run, only the triggering integration's env is forwarded, because one
set of `JIRA_*` names cannot carry two sites.

### Redaction

The manifest pattern catches Cloud `ATATT…` tokens [A]. DC PATs have no documented prefix, so the
**exact value** of every loaded connection is registered with `core/secret-redaction.ts` (the
umbrella rule). A test loads a DC connection and asserts its PAT is masked in run logs.

## Cross-provider linking (Jira as work source)

When a run's `workItemRefs` include a Jira item and the code host publishes the change request:

1. **Title prefix: on by default, deterministic, no Jira call.** The publish facet prepends
   `PROJ-42: ` to the CR title unless the title already contains that key (case-sensitive, word
   bounded). This is the documented trigger for the GitHub-for-Jira app, the GitLab-for-Jira-Cloud
   app and the DVCS connector [V][devpanel][gitlab-jira]. It writes to the **code host** only,
   which publish already does, so it adds no new exposure. Several keys produce
   `PROJ-42 PROJ-43: `, capped at 3 keys, with the rest moved to the body.
   `settings.devPanelTitlePrefix: false` turns it off per integration.
2. **Body footer:** `Jira: [PROJ-42](https://acme.atlassian.net/browse/PROJ-42)` (the manifest
   `footer.body`). It is a human link only; Jira does not read bodies.
3. **Branch name:** unchanged by default (`cez/<id8>`). When `branchNaming`
   ([2026-10-11-branch-naming-instructions](2026-10-11-branch-naming-instructions.md)) is set, the
   namer prompt gets the key as a hint ("include `PROJ-42` if the instructions allow"). The branch
   name is never rewritten after fork.
4. **Remote link / comment:** the opt-in writes from § link.

Code hosts the panel cannot see (Azure Repos has no documented Jira development-panel
integration [A]) still get the title and footer. Only the opt-in remote link makes the PR visible
in Jira for them.

## Run bookkeeping and task references

- `referencePatterns.key` is matched **only against the project keys of this project's Jira
  integrations**: `\b(PROJ|OPS)-[1-9]\d*\b`, built from the anchors. A bare `UTF-8` or
  `ISO-9001` therefore never becomes a work-item ref. With two integrations, the key's prefix
  picks the integration. An unknown prefix is ignored.
- URL patterns match `<origin>/browse/<KEY>` for every connected Jira origin, including a DC
  context path.
- `workItemRefs` entries carry `{ integrationId, providerId: 'jira', itemId: key, key, url,
  kind: 'issue', linkedAt? }`. The existing `automationTracker` snapshot (`runs/store.ts`) stays
  as is and gains an optional `integrationId`. Old records without it resolve to the legacy
  integration.

## Automations

| Neutral event | Legacy spelling | Source of truth | Status |
| --- | --- | --- | --- |
| `work_item.created` | `issue.opened` | `fields.created` within the poll window | kept |
| `work_item.status_changed` | `issue.status_changed` | changelog item `fieldId === 'status'` with `from`/`to` ids | kept |
| `work_item.labeled` | — | changelog item `field === 'labels'`: the labels added are `toString` tokens minus `fromString` tokens **within one history entry** | **phase 3, gated** |

- **Label events: reconsidered and kept off for now.** Today's limitation text ("label history
  encoding has not been verified") still holds: no doc found on 2026-10-22 specifies the
  `labels` changelog encoding. A set difference computed inside **one** history entry is still
  history-verified, not a state diff, so it satisfies the umbrella rule *once the encoding is
  proven*. Gate: a recorded Cloud fixture **and** a DC fixture showing `fromString`/`toString` as
  space-separated label lists, with a label containing a hyphen and one added together with a
  removal. Until both exist, `automationEvents` omits `work_item.labeled` and the editor shows
  the limitation.
- Polling, receipts, leases, baselines, the timezone-correct `updated >= "<local time>"` JQL and
  the 8 s scan deadline are moved verbatim from `jira-events.ts`. DC reads `timeZone` from
  `/rest/api/2/myself` [A].
- A `tracker`-kind automation keeps running against the legacy integration. A new automation may
  use `kind: 'integration'` with `integrationTrigger.integrationId`. Template tokens: `item.*`,
  with `tracker.*` kept as aliases.
- Rate budget: a per-connection limiter shared by every integration on that connection (several
  projects on one site share one burst budget).

## Contract additions (Jira-specific, all additive)

In `packages/contract/src/integrations.ts` (umbrella file), never in `tracker.ts`:

- `jiraConnectionInputSchema = z.discriminatedUnion('deployment', [
  { deployment: 'cloud', origin: <existing atlassian.net regex>, email, token },
  { deployment: 'data-center', origin: jiraDcOriginSchema, token, caFile?: absolute path ≤ 1024 }])`.
  `trackerCredentialsSchema` stays frozen, and `PUT /tracker/connection` keeps accepting only
  the Cloud shape.
- `jiraIntegrationSettingsSchema = { link: { remoteLink: boolean, comment: boolean },
  devPanelTitlePrefix: boolean }`. Every field is optional, with `.catch` to the default.
- `jiraScopeSchema = { projectId: /^\d+$/, projectKey }`, used in the scope anchor.
- `POST /integrations/:iid/items/:itemId/links` (retry a failed link write). It answers 409
  when `settings.link` is all false.

## Frozen `/api/v1/tracker*` adapter

`server.ts`'s tracker family stays chained and byte-identical in shape. Each route resolves **the
legacy integration**: the one from `tracker.json`, else the first stored scope-anchored
integration in `integrations.json` order. It then calls that integration's facets and maps
`WorkItem` → `TrackerItem` (`id`, `title`, `author`, `labels`, `status = stateLabel`, `body`,
`url`).

- `/tracker/connection` GET/PUT/DELETE map to the legacy connection.
- `/tracker/association` PUT writes `tracker.json` as today. It never writes `integrations.json`,
  so an old cockpit and a new one converge.
- `/tracker/automation-options` and `/tracker/watch*` map to the legacy integration's
  `automation` facet.
- `tracker-api.test.ts`, `tracker-read-scope-api.test.ts`, `project-isolation.test.ts` and the
  contract-parity tests run unchanged against the adapter. That suite **is** the no-regression
  proof.

## Cockpit

- The Issues switcher shows `Jira · PROJ` (and `Jira · OPS (acme-dc)` when two sites are
  connected). Filter chips are Open / Done (status category) plus labels, as the Tracker tab has
  today. `/p/:projectId/tracker` redirects to `/issues/<legacy integration id>`.
- The connect dialog first asks "Jira Cloud or Data Center/Server?" and then shows the
  matching form. The DC form has "Custom CA (optional)". The existing paginated project picker
  follows.
- Item detail shows `bodyLoss`, the thread and "Open in Jira". Hand-to-agent goes through
  `work-item-task.ts`, headed `Jira work item PROJ-42`.
- Settings → Integrations → Jira shows a "No CLI needed" readiness chip and the `cliRejected`
  sentence, so the absence of `acli` is explained rather than looking like an omission.

## Dry-run fixtures

`integrations/jira/fixtures/`:

- `cloud-demo`: today's `DEMO` project, moved from `tracker/dry-run.ts` and kept as the legacy
  integration.
- `dc-ops`: a second Jira integration on `https://jira.example.test/jira`, with wiki-markup
  bodies including one unsupported macro.
- `automation-events/` (moved): created and status histories.
- `link-writes`: the recorded request bodies for the remote link and comment, asserted
  byte-for-byte. Under `CEZ_DRY_RUN=1` link writes are recorded, never sent.

## Implementation steps (umbrella phase 2)

1. `integrations/jira/client.ts` ← `tracker/jira.ts` with the transport split behind a
   `JiraDeployment` interface (`cloud.ts`, `data-center.ts`). Also `events.ts` ←
   `jira-events.ts`, `shared/markdown.ts` ← `adf.ts`, and new `wiki-markup.ts`. The old paths
   stay as one-line re-exports until the adapter lands, then go.
2. `integrations/jira/index.ts`: `IntegrationProviderDef` (manifest, `discover` returns `[]`
   because scope providers never auto-discover, and `create`).
3. `integrations/shared/connections.ts` ← `tracker/connections.ts` + `connection-env.ts`. This
   adds the per-connection directory layout, the legacy read-in-place, and the `data-center`
   record kind (`JIRA_AUTH_TYPE=bearer`, `JIRA_CA_FILE`).
4. The `IntegrationResolver` reads `tracker.json` as the legacy Jira or Linear integration, with
   the shadowing rule from § Anchor.
5. The frozen tracker adapter in `server.ts`, plus the `integrationsRoutes` link-retry route.
6. Publish hook in the code-host `publish` facet: the title prefix and footer from work-source
   manifests, then `link.afterPublish(run, cr)` for each opted-in work source.
7. `tracker/agent-credentials.ts` → `jira.agentAccess`, keyed by integration.
8. Cockpit: Jira entries in the provider metadata, the connect dialog with deployment choice,
   `work-item-task.ts` vocabulary, and the `/tracker` redirect.
9. Docs: `docs/issue-trackers.md` (DC, several projects, linking toggles) and
   `BACKWARD_COMPATIBILITY.md` (tracker routes deprecated, not removed).

## Tests

- **No regression:** every existing `tracker/*.test.ts` and `server/tracker-*.test.ts` passes
  unchanged against the adapter. Moved unit tests keep their golden fixtures.
- Conformance suite (umbrella) over `cloud-demo` and `dc-ops`: pagination, cursor binding to
  integration + query, empty vs unavailable vs not-found, no network on construct.
- DC origin validator: table tests for `http://` non-loopback, userinfo, `*.atlassian.net`,
  context path and trailing slash. A cross-origin redirect yields `unavailable` and the bearer
  token is never sent to the second host (mock fetch asserts this).
- Two integrations on one project: separate caches, separate cursors (a cursor from
  `jira-proj` is rejected on `jira-ops`), and key prefix → integration routing in
  `extractTaskRefs`. `UTF-8` is not a ref.
- Publish: title prefix idempotence (no double prefix on update), the 3-key cap, and the off
  switch. A link write is never attempted when the setting is off, and **a failing remote link
  does not fail publish**.
- Redaction of a DC PAT value. Wiki markup → Markdown with loss disclosure.
- Prove-red: run each regression test with the source change stashed (AGENTS.md).

## Backward compatibility

- `/api/v1/tracker*`: paths, shapes and status codes are frozen and served by the adapter.
- `tracker.json` and `tracker-connections/<sha>.env` are read in place, never migrated, never
  rewritten (except the existing DELETE semantics).
- `tracker` automations, `issue.opened`/`issue.status_changed` and `tracker.*` tokens stay
  valid. `automationTracker` on old runs resolves to the legacy integration.
- `trackerCredentialsSchema` is unchanged. DC exists only on the new routes.
- Zero-config: with no Jira configured nothing changes, and no Atlassian host is contacted at
  boot, health or render.

## Acceptance criteria

- A project upgraded with an existing Jira Cloud connection shows the same items, search, detail
  and automations with no user action, and the old tracker tests pass.
- A user connects a second Jira project (same site, reusing the connection) and a DC project
  (PAT). All three appear in the switcher, each with its own scope and cache.
- A task launched from `PROJ-42` on a GitHub code host opens a draft PR titled `PROJ-42: …` with
  a Jira footer. With `remoteLink` on, the Jira issue shows a remote link to the PR. With it
  off, no Jira write is made (asserted with mock fetch).
- A DC origin that redirects to another host never receives the PAT.
- `CEZ_DRY_RUN=1` exercises Cloud, DC, automations and link writes offline.

## Open questions

1. Should the title prefix be on by default? It changes the PR titles of teams who never asked
   for the Jira panel. The proposal is yes, since it is the only zero-config route into the
   panel and writes nothing to Jira. The alternative is opt-in with the other link toggles.
2. Should DC's "basic auth with password" be supported for pre-8.14 servers? The proposal is no.
3. Should `work_item.labeled` ship in phase 2 if a live Cloud fixture proves the encoding before
   a DC one exists, with the event advertised per deployment?
4. Should there be a `cli` connection on Cloud once `acli` gains `api` passthrough and a per-call
   site? It needs owner sign-off, because cezar would then have two Cloud code paths to keep in
   parity.

## Sources

- [acli-intro] https://developer.atlassian.com/cloud/acli/guides/introduction/
- [acli-mac] https://developer.atlassian.com/cloud/acli/guides/install-macos/
- [acli-linux] https://developer.atlassian.com/cloud/acli/guides/install-linux/
- [acli-win] https://developer.atlassian.com/cloud/acli/guides/install-windows/
- [acli-login] https://developer.atlassian.com/cloud/acli/reference/commands/jira-auth-login/
- [acli-switch] https://developer.atlassian.com/cloud/acli/reference/commands/jira-auth-switch/
- [acli-search] https://developer.atlassian.com/cloud/acli/reference/commands/jira-workitem-search/
- [acli-view] https://developer.atlassian.com/cloud/acli/reference/commands/jira-workitem-view/
- [acli-project] https://developer.atlassian.com/cloud/acli/reference/commands/jira-project-list/ · …/jira-project-view/
- [acli-comment-list] https://developer.atlassian.com/cloud/acli/reference/commands/jira-workitem-comment-list/
- [acli-transition] https://developer.atlassian.com/cloud/acli/reference/commands/jira-workitem-transition/ · …/jira-workitem-comment-create/
- [acli-link] https://developer.atlassian.com/cloud/acli/reference/commands/jira-workitem-link/
- [acli-index] the command sidebar of the pages above (39 entries, 2026-10-22)
- [jc-repo] https://github.com/ankitpokhrel/jira-cli (GitHub API: repo + latest release)
- [jc-readme] https://raw.githubusercontent.com/ankitpokhrel/jira-cli/main/README.md
- [jc-brew] https://formulae.brew.sh/api/formula/jira-cli.json
- [cloud-search] https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- [cloud-issues] https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
- [cloud-remotelink] https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/
- [tokens] https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
- [rate] https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- [dc-pat] https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html
- [dc-eol] same page, banner: "Data Center support ends on March 28, 2029"
- [dc-search] https://developer.atlassian.com/server/jira/platform/rest/v11001/api-group-search/
- [dc-serverinfo] https://developer.atlassian.com/server/jira/platform/rest/v11001/api-group-serverinfo/
- [dc-remotelink] https://developer.atlassian.com/server/jira/platform/rest/v11001/api-group-issue-remote-links/
- [devpanel] https://support.atlassian.com/jira-software-cloud/docs/reference-issues-in-your-development-work/
- [gitlab-jira] https://docs.gitlab.com/integration/jira/
