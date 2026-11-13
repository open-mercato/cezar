# Integration provider: Linear

> Slug: `integration-linear` · Issue: #1619 · Updated: 2026-10-22.
> Status: draft for review. Provider spec under the umbrella
> [integration-providers](2026-10-22-integration-providers.md), which is binding for the seam,
> contract, routes, persistence and phasing. This file only says how Linear fills it.
> Builds on [2026-09-18-jira-linear-tracker-browsing](2026-09-18-jira-linear-tracker-browsing.md)
> and [2026-09-19-project-tracker-connections](2026-09-19-project-tracker-connections.md). Their
> rules (scope anchoring, loss disclosure, history-verified events, write-only credentials) carry
> over unless this file says otherwise. Sibling: [Jira](2026-10-22-integration-jira.md). Linear
> deliberately mirrors its connection and link design.
> Every vendor claim cites a source under § Sources. **[V]** = verified on 2026-10-22 with `curl`
> against the vendor page, the npm registry, the GitHub API or Linear's published GraphQL schema
> (web search was unavailable to this session). **[A]** = assumption to confirm during
> implementation.

## TLDR

`linear` is a **scope-anchored work source**. It is not a code host, so it has no change
requests, merge, publish or clone. It implements four facets:

- `workItems`: list, search, detail and the comment thread.
- `automation`: `created` is kept. `status_changed` and `labeled` come back in phase 3, gated on
  *settled* `IssueHistory` entries.
- `link`: on by default, a title prefix and a magic-word footer written to the **code host's** PR.
  Opt-in, an attachment or comment written to Linear.
- `agentAccess`: today's per-run `LINEAR_API_KEY`.

Phase 2 moves `server/tracker/linear.ts` and `linear-events.ts` to `integrations/linear/` with **no
regression**. `tracker.json` and `tracker-connections/` are read in place, `/api/v1/tracker*`
becomes a frozen adapter, and every existing Linear test passes against it. The move adds
**several Linear teams per project, across several workspaces**, and **cross-provider linking** to
whichever code host (GitHub or GitLab) publishes the PR.

**Connection decision: `token` (personal API key, GraphQL) only. No CLI connection in phase 2,
and no OAuth.**

- **No official CLI.** Linear ships no maintained official CLI. The `@linear/cli` npm package is a
  two-command tool last published 2021-11-18 [V][npm-linear-cli].
- **The best community CLI was weighed and not adopted for phase 2.** `schpet/linear-cli` is
  active, keeps keys in the OS keyring, has `--json` and a `linear api` GraphQL passthrough
  [V][schpet-readme][schpet-auth][schpet-api]. It still costs a second transport for the same
  GraphQL documents, and it picks its credential from `LINEAR_API_KEY`, `.env` and a
  repository-controlled `.linear.toml` *before* the keyring [V][schpet-auth]. It also hides the
  rate-limit headers cezar's limiter reads.
- **OAuth needs infrastructure cezar does not run.** It needs a registered OAuth app plus 24-hour
  access tokens that rotate through a refresh token [V][oauth]. cezar would have to own an app and
  persist a rotating secret, for no read-path gain over a key the user can restrict to **Read +
  chosen teams** [V][api-keys].

## Problem

- **One Linear team per project.** `TrackerConnections` stores one record per project root and
  `tracker.json` holds one association (`tracker/connections.ts`, `tracker-association.ts`). A repo
  that serves two teams (`ENG` and `INFRA`), or a consultant with two client workspaces, sees one.
- **No path back.** A task launched from `ENG-123` opens a PR that Linear never links. Linear links
  a PR when the issue ID is in the **branch name or PR title**, or follows a **magic word** in the
  title or description (`Fixes ENG-123`) [V][li-github][li-gitlab]. Today the draft PR title is the
  run title and the branch is `cez/<id8>`, so nothing links.
- **Status and label automations are off.** `linearHistoryLimitation` says "Linear omits changes
  during the first three minutes and groups activity changes", so only `issue.opened` is
  advertised (`linear-events.ts`). The grouping half is documented: an `IssueHistory` entry
  "captures one or more property changes … within a short grouping window by the same actor"
  [V][schema]. The three-minute figure has no source this session could find [A]. It came in with
  #1045.
- **Two tabs, two composers** (umbrella § Problem).

## Non-goals

- Creating, editing, assigning or bulk-changing Linear issues from the cockpit, and syncing
  projects, cycles or documents. The only Linear writes are the opt-in `link` writes and the
  agent's own calls with forwarded env. Both exist under today's rules.
- Webhooks. Linear offers them [V][api-keys], but the umbrella rules out inbound HTTP.
- OAuth, `actor=app` and agent-session APIs (deferred: § Open questions).
- Linear Asks, Customers, Initiatives.

## Vendor research

### Official tooling

| Tool | Status | Verdict |
| --- | --- | --- |
| `@linear/cli` (`lin`), npm, maintained by Linear staff | Versions 0.0.1–0.0.5. Last publish **2021-11-18**. Two commands: `lin new` and `lin checkout` [V][npm-linear-cli]. Not in the `linear/linear` monorepo, whose packages are `sdk`, `import` and codegen [V][linear-repo] | Dead. Not a connection |
| `@linear/sdk` (TypeScript GraphQL client) | Maintained in `linear/linear`; ships the public `schema.graphql` [V][linear-repo] | Not adopted as a runtime dep: cezar already has a 60-line zod-validated GraphQL client. The schema file is used for codegen/check in tests (§ Tests) |
| Linear MCP server `https://mcp.linear.app/mcp` (`/mcp/readonly` for read-only) | Official. OAuth 2.1 with dynamic client registration, or a bearer API key [V][mcp] | An **agent** tool (agent-config's MCP section), not a cezar connection: cezar is not an MCP client of vendors |

### Community CLIs

| | `schpet/linear-cli` (`linear`) | `linearis` (`linearis-oss/linearis`) |
| --- | --- | --- |
| Maintenance | v3.0.0, 2026-10-06; last commit 2026-10-07; ~1 000 stars; ISC; Rust [V][schpet-gh] | v2026.8.0, 2026-08-14; `next` 2026.9.0-next.1; ~260 stars; MIT; Node [V][linearis-gh][npm-linearis] |
| Install | `brew install schpet/tap/linear`, npm `@schpet/linear-cli`, shell installer, `cargo`; prebuilt macOS/Linux (x64/arm64)/Windows x64 binaries [V][schpet-readme][schpet-release] | `npm install -g linearis` [V][linearis-readme] |
| Auth storage | Keys in the OS keyring (macOS Keychain via `/usr/bin/security`; Linux needs `secret-tool`/libsecret; Windows Credential Manager). The workspace list is in `~/.config/linear/credentials.toml`; `--plaintext` stores the key in that file [V][schpet-auth] | `~/.linearis/token`, AES with a **hard-coded key** ("obfuscation-level protection", per its source) [V][linearis-enc] |
| Key precedence | `LINEAR_API_KEY` (env **or `.env`**) > `api_key` in **`.linear.toml` of the repo** > `--workspace` > configured `workspace` > default [V][schpet-auth] | `--api-token` > `LINEAR_API_TOKEN` > file [V][linearis-readme] |
| Multi-workspace | Yes: `linear auth login` per workspace, `--workspace <slug>` per call [V][schpet-auth] | One token [V][linearis-readme] |
| JSON | `--json` on issue/team/user/project/cycle/document commands [V][schpet-readme] | JSON only [V][linearis-readme] |
| Raw passthrough | `linear api '<graphql>'` with variables and `--paginate`. Exit codes: 1 GraphQL error, 3 not found, 4 auth, 5 unavailable/rate-limited [V][schpet-api][schpet-usage] | None. "a raw API call" for anything unwired [V][linearis-readme] |
| Self-hosted | N/A: Linear is SaaS-only, `api.linear.app` [V][graphql] | N/A |

Other names checked: `evangodon/lincli` does not exist on GitHub [V]. No Linear package exists
in Homebrew core [V][brew].

### Command-by-facet mapping (if a `cli` strategy were enabled)

The GraphQL documents are the same ones the token transport sends. `linear api` is only a carrier.

| Facet | argv | JSON fields used |
| --- | --- | --- |
| availability | `linear --workspace <slug> auth whoami` | exit 0/4; slug match against the anchor's `urlKey` |
| scope picker | `linear --workspace <slug> api '<TrackerTeams query>' --variable first=50 …` | `data.teams.nodes[].{id,name,key}`, `pageInfo` |
| list/search | `linear … api '<TrackerIssues / searchIssues query>' --variable …` | as `itemSchema` in `linear.ts` |
| detail/thread | `linear … api '<issue(id) { … comments(first: 50) … }>'` | `issue.*`, `comments.nodes[]` |
| automation | `linear … api '<AutomationIssues>'`, `'<AutomationHistory>'` | as `linear-events.ts` |
| link | `linear … api 'mutation { attachmentLinkURL(…) }'` | `attachmentLinkURL.success`, `attachment.id` |

Argv flag spelling beyond `linear api '<doc>'` and `--paginate` is [A]. The README shows the
positional document and stdin forms only. `linear issue query --json` does not replace the
GraphQL list query: it has no cursor or `updatedAt` window, so it cannot back signed cursors or
automations.

### Linear API facts the design relies on

- **One endpoint**, `POST https://api.linear.app/graphql`. A personal key is sent as
  `Authorization: <key>` (today's code). OAuth uses `Authorization: Bearer <token>` [V][graphql].
- **Keys** can be restricted to Read / Write / Admin / Create issues / Create comments, and **to
  specific teams** [V][api-keys]. Admins may stop members from creating keys at all. A key is
  bound to one workspace (organization) [A, implied by `organization` resolving per key, which is
  today's `sourceQuery`].
- **Rate limits:** an API key gets 2 500 requests/hour **per user, shared by all of that user's
  keys**. OAuth apps get 5 000/user/hour. There are also complexity and per-endpoint windows, sent
  as `X-RateLimit-*` headers [V][rate]. Today's `graphql()` already reads the requests, endpoint
  and complexity headers.
- **Default page size is 50**, and Linear recommends ordering by `updatedAt` [V][rate].
- **`Issue.branchName: String!`** is "Suggested branch name for the issue" [V][schema]. The field
  is `branchName`. `gitBranchName` does not exist in the schema [V][schema].
- **`issueVcsBranchSearch(branchName)`** finds an issue from a branch [V][schema].
- **Attachments:** `attachmentCreate`, plus `attachmentLinkURL`, `attachmentLinkGitHubPR` and
  `attachmentLinkGitLabMR`. The last two take `issueId` as a UUID **or identifier** and create "a
  rich attachment using the workspace's GitHub/GitLab integration" [V][schema]. The URL is
  **idempotent per issue**: re-creating an attachment with the same URL on the same issue updates
  it [V][attachments]. `attachmentsForURL(url)` looks attachments up [V][schema].
- **`IssueHistory`** has `id`, `createdAt`, `updatedAt`, `fromStateId`/`toStateId`,
  `addedLabelIds`/`removedLabelIds`, `actor`, `botActor` and `autoClosed`. Entries group changes
  "within a short grouping window by the same actor" [V][schema]. The window length is not
  documented [A].
- **PR linking** [V][li-github][li-gitlab]:

  | Code host | ID in branch | ID in title | Magic word | Notes |
  | --- | --- | --- | --- | --- |
  | GitHub.com / GHEC (`*.ghe.com`) | ✓ | ✓ | title **or** description | |
  | GitHub Enterprise Server | ✓ | ✓ | **PR description only** | |
  | GitLab.com and self-managed (≥ 15.6, must be **publicly reachable**) | ✓ | ✓ | **MR description only**; no commit/comment linking | |
  | Azure Repos | — | — | — | No Linear integration documented [A] |

  - **Closing words** (`fixes`, `closes`, `resolves`, `completes`, `implements`, … and `linear
    issue`) apply the team's *On PR merge* status. **Non-closing words** (`ref`, `refs`, `part
    of`, `contributes to`, `towards`; GitLab adds `updates`) do not. **Relation words**
    (`relates to`, `related to`) only relate the PR to the issue.
  - `skip`/`ignore ENG-123` suppresses a link, and **`{TEAM}-NEW` in a PR description creates a
    new issue** [V][li-github].
  - **One Linear workspace per GitHub organization** ("GitHub Apps can only be installed once")
    [V][li-github].

### Recommendation: `token` only (phase 2); `cli` passthrough is a phase-3 option

**Preference order: `['token']`.** The reasons:

1. **Nothing to delegate to.** The official CLI is dead. The umbrella's CLI-first rule exists
   so cezar holds no credential. A personal Linear key is already a revocable, team- and
   permission-restrictable secret in the managed `0600` store, so a CLI would remove no more risk
   than restricting the key does.
2. **`schpet/linear-cli` is credible but leaks scope.** Its key precedence puts `.env` and the
   repository's `.linear.toml` (`api_key`) above the keyring. With cwd = project root, a cloned
   repository could silently point cezar at another workspace. cezar can neutralize that by
   spawning it with cwd set to an empty temp directory, a scrubbed env without `LINEAR_*`, and
   `--workspace <slug>` on every call. That is still a third-party binary on the read path of
   every list.
3. **The CLI is the same API.** The CLI path is a second transport for the *same* GraphQL
   documents, so it adds parity cost and no capability. It also loses the `X-RateLimit-*`
   headers: exit 5 merges rate limiting with outages [V][schpet-usage]. The availability would be
   `degraded`, and automations would back off blind.
4. **No new vendor setup on Linux.** Linux keyring support needs `libsecret-tools` [V][schpet-auth].
   The token path needs nothing.
5. **`linearis` is ruled out.** It has no passthrough and stores its token with a fixed-key
   cipher.

**Phase 3 option (needs owner sign-off, open question 2):** a `cli` strategy that carries
the same documents through `linear api`, with the three neutralizers above. It would be offered
only when `linear auth list` shows the anchor's workspace, and listed second, after `token`.
Both CLIs are listed under § agentAccess as tools an agent may use.

**OAuth vs API key.** The key wins for a local, single-user cockpit.

- **Infrastructure.** OAuth needs a cezar-owned OAuth application (client id and redirect URIs,
  PKCE supported [V][oauth]) and a loopback redirect listener.
- **Rotating secret.** Access tokens last 24 h with refresh tokens, mandatory for every app since
  2026-04-01 [V][oauth], so cezar would persist a rotating secret and own the refresh races
  across processes.
- **What OAuth would add.** The upside is 5 000/h instead of 2 500/h [V][rate], `actor=app`
  attribution, and no copy-paste. Revisit only if hosted cezar or `actor=app` link writes become
  goals.

## Mapping onto the umbrella seam

### Manifest

```ts
// packages/cezar/src/integrations/linear/manifest.ts
{
  id: 'linear', label: 'Linear', icon: 'linear',
  anchors: ['scope'], connections: ['token'],
  cliRejected: 'Linear has no maintained official CLI; community CLIs add a second transport for the same GraphQL API.',
  tokenForms: [{ deployment: 'cloud', fields: ['key (personal API key, secret)'] }],
  tokenHelp: { url: 'https://linear.app/settings/account/security', advice: 'Read permission; restrict to the teams you connect. Write or "Create comments" only if you enable Linear write-back.' },
  vocabulary: { workItem: 'issue', keyExample: 'ENG-123', scope: 'Team' },
  facets: ['workItems', 'automation', 'link', 'agentAccess'],
  automationEvents: ['work_item.created'],          // + status_changed, labeled behind the phase-3 gate
  referencePatterns: { key: '[A-Z][A-Z0-9_]*-[1-9]\\d*', url: 'https://linear.app/{urlKey}/issue/{key}' },
  footer: { titlePrefix: '{key}: ', body: '{magicWord} {key}' },
  secretPatterns: ['lin_api_[A-Za-z0-9]{20,}'],    // prefix from vendor examples [V][schpet-auth]; length [A]
  agentEnv: ['LINEAR_API_KEY'],
}
```

### Anchor, identity and several integrations

- **Anchor:** `{ kind: 'scope', source: { id: organization.id, webUrl: https://linear.app/<urlKey> },
  scope: { teamId (UUID, authoritative), teamKey (display + reference matching) } }`. Today's
  `checkScope`/`mapItem` team-id guard is unchanged. The team key can be edited in Linear [A], so
  it is refreshed on every successful association read, and stale keys are kept as aliases for
  reference matching for one release.
- **Connection = one API key = one workspace.** Several teams in one workspace share one
  connection. The connect flow offers "use the existing connection for *Acme* (`acme`)" before it
  asks for another key. A second workspace is a second connection.
- **Team-restricted keys:** the scope picker lists what `teams(…)` returns, so a key limited to
  `ENG` lists only `ENG`. Picking a team needs no extra permission.
- **Integration id:** `linear-<teamKey lowercased>`, suffixed `-2`… on collision across workspaces.
  It is assigned at connect time and never recomputed.
- **Storage and persistence** follow the Jira spec verbatim. The store is
  `integration-connections/<sha256(root)>/<connectionId>.env` (`LINEAR_API_KEY` record kind,
  same codec), with `tracker-connections/<sha256(root)>.env` read in place as connection `legacy`.
  Integrations are stored in `integrations.json`. A `tracker.json` with `kind: 'linear'` surfaces
  as the legacy integration, and a stored row matching `source.id + teamId` shadows it.
  `tracker.json` is never rewritten.
- **Cache and limiter:** cache keys are `project + integrationId + query` (umbrella). The rate
  limiter is keyed by **Linear user** (`viewer.id`, fetched once per connection with the
  organization), not by connection, because Linear meters all of one user's keys together
  [V][rate].

### Transport

`integrations/linear/client.ts` is today's `createLinearClient`, nearly verbatim: one GraphQL
endpoint, the envelope schema, error-code mapping (`RATELIMITED`, `AUTHENTICATION_ERROR`,
`FORBIDDEN`, `NOT_FOUND`), the `X-RateLimit-*` header logic and `source` generation guard. It runs
on `integrations/shared/http-transport.ts`. The host is fixed (`api.linear.app`), so the umbrella's
no-cross-origin-redirect rule reduces to "any redirect is `unavailable`".

### `workItems`

- **list/search:** today's `issues`/`searchIssues` queries with the team filter. "Active" means
  `state.type nin [completed, canceled]`, plus label `some` clauses and `orderBy: updatedAt`.
  Unchanged.
- **Normalization** to `workItemSchema`:
  - identity and kind: `id = key = identifier`, `kind: 'issue'`.
  - state: `state = state.type in (completed, canceled) ? 'closed' : 'open'`, and
    `stateLabel = state.name`.
  - people: `author = creator.name`, and `assignees = [assignee.name]` (the new field
    `assignee { name }`).
  - `labels` (incomplete label pages stay `invalid_response`, as today), `url`, and
    `commentCount` is omitted [A: no cheap count field].
- **detail:** the Markdown `description` passes through `descriptionBody` with the 60 000 cap.
  Linear bodies are already Markdown, so `bodyLoss` only reports truncation. Detail also returns
  `branchName`, carried as an optional `vcsBranchHint` (§ Contract).
- **thread (new):** `issue.comments(first: 50, orderBy: createdAt)` with `body`, `user { name }`,
  `createdAt` and `parent { id }`. Replies render flat with a "reply" marker, beyond 50 the thread
  shows "more on Linear", and the timeline is limited to status changes from `history`
  (allowlisted `status_changed`).

### `link`

**Defaults (no Linear write).** The work source contributes a title prefix and footer to the
code host's publish (§ Cross-provider linking). This writes only to the code host, which publish
already does.

**Opt-in Linear writes**, set in `settings.link = { attachment: false, comment: false }` and
toggled per integration in Settings → Integrations → Linear · ENG. The toggle copy names the
permission needed (`Write`, or `Create comments` for the comment alone [V][api-keys]).

| Trigger | Write | Idempotency |
| --- | --- | --- |
| Code host publishes a CR for a run whose `workItemRefs` include this integration, `attachment: true` | GitHub code host: `attachmentLinkGitHubPR(issueId: <identifier>, url: <PR url>)`. GitLab: `attachmentLinkGitLabMR(…)`. Any other host, or either call failing with a "no integration" error: `attachmentLinkURL(issueId, url, title: "<CR key> <title>")` [V][schema] | Linear's URL-per-issue idempotency [V][attachments]. A retry re-sends the same URL |
| Same, `comment: true` | `commentCreate(input: { issueId, body: "cezar opened [<CR key>](<url>)" })` | At most once per (run, CR), recorded in `workItemRefs[].linkedAt` |
| Agent-requested status change | Unchanged: the agent gets `LINEAR_API_KEY` (agentAccess) and calls Linear itself | Revision binding (`TrackerAgentBindingError`) |

A link failure never fails publish. The run log gets one human line, and the shared
`POST /integrations/:iid/items/:itemId/links` retry route (Jira spec) is reused. A read-only key
fails the write with `FORBIDDEN`, which maps to "the Linear key lacks write permission; widen it
or turn write-back off".

### `agentAccess`

Today's `resolveTrackerAgentEnv` Linear branch becomes `linear.agentAccess.env(run)`. It returns
`LINEAR_API_KEY` only for automation-launched runs bound to the exact connection revision, and
manual runs get nothing unless the user opts in per run (umbrella). That one variable is what
`schpet/linear-cli` (its top precedence) and the Linear MCP bearer mode accept
[V][schpet-auth][mcp]. An agent with either tool installed therefore works without cezar knowing
which one it has. With two Linear integrations bound to one run, only the triggering
integration's key is forwarded.

### Redaction

The `lin_api_…` pattern goes to `core/secret-redaction.ts`, which has no Linear pattern today.
The exact loaded key value is also registered (umbrella rule), because a key's format is not a
documented contract [A].

## Cross-provider linking (Linear as work source)

When a run's `workItemRefs` include a Linear item and the code host publishes:

1. **Title prefix: on by default, no Linear call.** The publish facet prepends `ENG-123: ` unless
   the title already contains the identifier (word-bounded). The ID in the title links on GitHub,
   GHES and GitLab alike [V][li-github][li-gitlab]. Up to 3 keys; the rest go to the footer.
   `settings.titlePrefix: false` turns it off.
2. **Body footer: magic word + identifier**, one line per ref.
   - **Default word.** The ref the run was *launched from* (hand-to-agent or automation) gets
     the closing word `Fixes`. Every other ref gets the non-closing `Refs`, so a task that merely
     mentions `ENG-9` never closes it on merge [V][li-github].
   - **Word override.** `settings.magicWord: 'closing' | 'non-closing' | 'relation'` overrides
     the launched-from word. Review/QA workflows default to `non-closing` [A: chosen by workflow
     id, final rule in implementation].
   - **Placement.** The footer goes in the **description**, the one place every code host reads
     (GHES and GitLab read magic words nowhere else [V]).
   - **Plus a link.** A Markdown link to the issue URL follows the word.
3. **Never emit vendor commands by accident.** The footer generator emits only
   `<word> <TEAM-N>` and never `{TEAM}-NEW`, `skip` or `ignore` [V][li-github]. The user's own
   title and body are passed through untouched, because cezar must not rewrite user text.
4. **Branch name.** Unchanged by default (`cez/<id8>`). The title already links, so changing the
   default branch would buy nothing and break the run-branch convention. When `branchNaming`
   ([2026-10-11-branch-naming-instructions](2026-10-11-branch-naming-instructions.md)) is set, the
   namer prompt gets Linear's `branchName` as a hint ("prefer `eng-123-fix-login` if the
   instructions allow"). The name is never rewritten after fork.
5. **Opt-in writes** come from § link. They are the only way the PR shows up in Linear when the
   code host has no Linear integration: Azure Repos, a private self-managed GitLab [V: must be
   public], or a second Linear workspace on a GitHub org already bound to another workspace
   [V][li-github].

The publish preview in the review gate shows the prefixed title and the footer before push, so
the closing word is never a surprise.

## Run bookkeeping and task references

- `referencePatterns.key` is compiled from **this project's connected team keys only**
  (`\b(ENG|INFRA)-[1-9]\d*\b`, plus alias keys). With two integrations the prefix picks the
  integration. Bare `#N` is never claimed (umbrella).
- URL patterns: `https://linear.app/<urlKey>/issue/<KEY>(/<slug>)?` for every connected workspace.
  The `urlKey` picks the workspace and the key picks the team.
- `workItemRefs`: `{ integrationId, providerId: 'linear', itemId: identifier, key, url, kind:
  'issue', launchedFrom?: true, linkedAt? }`. `launchedFrom` drives the closing-word choice. The
  existing `automationTracker` snapshot gains an optional `integrationId`, and old records resolve
  to the legacy integration.

## Automations

| Neutral event | Legacy spelling | Source of truth | Status |
| --- | --- | --- | --- |
| `work_item.created` | `issue.opened` | `Issue.createdAt` within the window, from today's `createdAt`-ordered scan | kept |
| `work_item.status_changed` | `issue.status_changed` | a **settled** `IssueHistory` entry with `toStateId` | **phase 3, gated** |
| `work_item.labeled` / `unlabeled` | `issue.labeled` / `unlabeled` | a **settled** entry's `addedLabelIds`/`removedLabelIds` | **phase 3, gated** |

**Reassessment.** `mapLinearHistory` already maps both kinds; only `pollEvents` refuses them. The
risk is not missing history but **mutable history**: an entry groups changes over a window
[V][schema]. A poll that reads it mid-window records a receipt for `<historyId>:status` and then
suppresses the corrected `toStateId` (an `A→B→C` burst read at `B`). The fix stays
webhooks-free, uses history only, and has no state diff:

- **Settle rule.** Consume an entry only when `updatedAt <= now − settleMs`. `settleMs` defaults
  to 10 min [A: the window and the reported 3-min lag must be measured]. Unsettled entries are
  left for the next poll, and the scan window's lower bound is extended by `settleMs` so no entry
  is skipped. `updatedAt` exists on `IssueHistory` [V][schema].
- **Semantics, disclosed in the editor:** "fires on the net change of each Linear activity
  group; a status passed through within a few minutes may not fire". It fires up to `settleMs`
  late. `autoClosed`/`botActor` entries are events like any other, and an optional filter
  `actor: 'any' | 'human'` is [A] for phase 3.
- **Options catalog** (today it returns empty lists): `team(id).states { id name type }` and the
  team plus workspace `issueLabels { id name }`, paged with the shared cursor.
- **Gate:** a recorded fixture from a live workspace showing that (a) an entry's `updatedAt`
  advances while grouping and stops, and (b) a create-then-move-within-3-min case still produces
  a `toStateId` entry. Until both exist, `automationEvents` stays `['work_item.created']` and the
  limitation text is unchanged.

The poll cycle, receipts, leases, baselines and 8 s scan deadline move verbatim from
`linear-events.ts`. Rate cost is one issues page plus one history page per changed issue. The
per-user limiter (§ Anchor) keeps two integrations of one user under the shared 2 500/h budget.

## Contract additions (Linear-specific, additive)

All in `packages/contract/src/integrations.ts`. `tracker.ts` stays frozen.

- `linearConnectionInputSchema = { key: <trackerSecretSchema> }`. This is the
  `trackerCredentialsSchema` Linear arm, reused by value.
- `linearScopeSchema = { teamId: z.uuid(), teamKey: /^[A-Z][A-Z0-9_]*$/, teamKeyAliases?: [] }`.
- `linearIntegrationSettingsSchema = { link: { attachment, comment }, titlePrefix, magicWord }`.
  Every field is optional, with `.catch` to the default.
- `workItemDetailSchema` gains an optional, provider-neutral `vcsBranchHint?: string`, which a
  GitLab or Jira provider may also fill.
- No Linear-only route. The links-retry route is shared with Jira.

## Frozen `/api/v1/tracker*` adapter

Same shape as the Jira spec's adapter, with the Linear specifics below. `WorkItem` →
`TrackerItem` maps `status = stateLabel`. `/tracker/candidates` and `/tracker/association` map to
the legacy integration's picker and `tracker.json` writes. `/tracker/automation-options` returns
today's `{ events: ['issue.opened'], limitations: [linearHistoryLimitation], … }` until the
phase-3 gate opens. Then it returns the widened list, which is additive on an existing enum.
`linear.test.ts`, `linear-events.test.ts`, `project-isolation.test.ts`, `tracker-api.test.ts` and
the contract-parity tests run unchanged against the adapter. That suite is the no-regression
proof.

## Cockpit

- Switcher entries read `Linear · ENG`, and `Linear · ENG (side-project)` when two workspaces are
  connected. Filter chips are Active / All (state type) plus labels, as today.
  `/p/:projectId/tracker` redirects to `/issues/<legacy id>`.
- The connect dialog has a key field with the restriction advice from `tokenHelp`, an
  existing-connection reuse choice, and then the team picker.
- Detail shows description, thread, "Open in Linear" and a "Copy Linear branch name" action from
  `vcsBranchHint`. Hand-to-agent goes through `work-item-task.ts`, headed `Linear issue ENG-123`.
- Settings → Integrations → Linear shows a "No CLI needed" chip, the `cliRejected` sentence, and
  the write-back toggles with their permission note.

## Dry-run fixtures

`integrations/linear/fixtures/`:

- `demo-eng`: today's `ENG` demo (`dry-run.ts` entry, moved), kept as the legacy integration.
- `side-ops`: a second workspace and team, to exercise multi-workspace routing.
- `automation-events/` (moved), plus `history-grouped.json` with an entry whose `updatedAt` moves
  between two polls.
- `link-writes`: recorded `attachmentLinkGitHubPR`, `attachmentLinkURL` and `commentCreate`
  bodies. Under `CEZ_DRY_RUN=1` they are recorded, never sent.

## Implementation steps

Umbrella phase 2, except step 8 (phase 3).

1. `integrations/linear/client.ts` ← `tracker/linear.ts`. `events.ts` ← `linear-events.ts`.
   `tracker/event-scan.ts`, `cursor.ts` and `adf.ts`'s `descriptionBody` move to
   `integrations/shared/`, coordinated with the Jira move. The old paths stay one-line re-exports
   until the adapter lands.
2. `integrations/linear/index.ts` holds the manifest, `discover() → []` and `create()`.
3. `integrations/shared/connections.ts` (shared with Jira) reads the `LINEAR_API_KEY` record kind
   and the legacy file in place.
4. The resolver reads `tracker.json` `kind: 'linear'` as the legacy integration.
5. Frozen adapter routes, and the thread facet (`comments`).
6. Publish hook: title prefix, footer and the `launchedFrom` word rule, then `link.afterPublish`
   for opted-in integrations.
7. `agent-credentials.ts` Linear branch → `linear.agentAccess`. The `lin_api_` pattern →
   `secret-redaction.ts`.
8. Phase 3: settle rule plus options catalog. Flip `automationEvents` once the gate fixtures are
   recorded.
9. Docs: `docs/issue-trackers.md` (several teams, write-back toggles, magic-word defaults) and
   `BACKWARD_COMPATIBILITY.md`.

## Tests

- **No regression:** every existing Linear and tracker test passes unchanged against the adapter,
  and moved tests keep their fixtures.
- Umbrella conformance suite over `demo-eng` and `side-ops`: a cursor from `linear-eng` is
  rejected on `linear-ops`, and no network runs on construct or discover.
- **Schema check:** every GraphQL document in `integrations/linear/` is validated against a
  vendored copy of Linear's `schema.graphql` [V][linear-repo] in a unit test (no network). A
  renamed field fails CI instead of production.
- Publish: prefix idempotence, the 3-key cap, `Fixes` only for `launchedFrom`, no `-NEW`, `skip`
  or `ignore` ever emitted, and the off switches. Write-back is never attempted when off (mock
  fetch). A failing attachment does not fail publish. A GitHub host whose call fails falls back
  to `attachmentLinkURL`.
- Two integrations of one Linear user share one limiter. A `RATELIMITED` response on one
  integration cools the other.
- Phase 3: a grouped entry read unsettled produces no receipt, and the same entry once settled
  fires exactly once with the final `toStateId`.
- Redaction of a loaded key in run logs. Prove-red for every regression test (AGENTS.md).

## Backward compatibility

- `/api/v1/tracker*` paths, shapes and codes are frozen. `issue.opened`, `tracker` automations and
  `tracker.*` tokens are kept, and `automationTracker` on old runs resolves to the legacy
  integration.
- `tracker.json` and `tracker-connections/<sha>.env` are read in place and never rewritten
  (DELETE semantics unchanged).
- `trackerCredentialsSchema` is unchanged. The `LINEAR_API_KEY` agent env is unchanged.
- PR titles of Linear-launched tasks gain an `ENG-123: ` prefix and a footer. This is a visible
  change to the code-host write (open question 1), and it applies only to runs with a Linear ref.
- Zero-config: with no Linear configured nothing changes, and `api.linear.app` is never contacted
  at boot, health or render.

## Acceptance criteria

- An upgraded project with a Linear connection shows the same items, search, detail and
  `issue.opened` automations with no action, and the old tests pass.
- A user adds a second team (reusing the connection) and a second workspace (a new key). All
  three appear in the switcher with separate caches and cursors, and references route by key
  prefix.
- A task launched from `ENG-123` on GitHub opens a draft PR titled `ENG-123: …` whose description
  ends `Fixes ENG-123`. With `attachment` on, the issue shows the PR as an attachment. With it
  off, no Linear mutation is sent (asserted).
- On a GitLab code host the footer is in the MR description and the attachment uses
  `attachmentLinkGitLabMR`.
- `CEZ_DRY_RUN=1` exercises both workspaces, the thread, automations and the link writes offline.

## Open questions

1. Should the title prefix and the `Fixes` footer be on by default? The proposal is yes: this is
   zero-config linking and no Linear write. The cost is that the PR's merge moves the issue to the
   team's *On PR merge* status, which is usually what was meant. The alternative is `Refs` by
   default.
2. Should a `cli` strategy through `schpet/linear-cli`'s `linear api` be offered in phase 3, given
   the parity cost and the repo-config precedence it must neutralize?
3. OAuth with `actor=app`: worth a cezar-owned Linear app so attachments read "via cezar", and
   for 5 000/h? It needs owner sign-off, because it is infrastructure and a rotating secret.
4. `settleMs`: is 10 min an acceptable latency for status automations, or should it be
   per-automation?

## Sources

- [npm-linear-cli] https://registry.npmjs.org/@linear/cli (versions/time; README)
- [linear-repo] https://github.com/linear/linear (packages/), schema: https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
- [schema] same `schema.graphql`: `Issue.branchName`, `IssueHistory`, `attachmentLink*`, `attachmentsForURL`, `issueVcsBranchSearch`
- [mcp] https://linear.app/docs/mcp
- [schpet-gh] https://github.com/schpet/linear-cli (GitHub API: repo, latest commit)
- [schpet-readme] https://raw.githubusercontent.com/schpet/linear-cli/main/README.md
- [schpet-auth] https://raw.githubusercontent.com/schpet/linear-cli/main/docs/authentication.md
- [schpet-usage] https://raw.githubusercontent.com/schpet/linear-cli/main/docs/usage.md
- [schpet-api] https://raw.githubusercontent.com/schpet/linear-cli/main/crates/linear-cli/src/commands/api.rs
- [schpet-release] https://github.com/schpet/linear-cli/releases/tag/v3.0.0 · https://raw.githubusercontent.com/schpet/homebrew-tap/main/Formula/linear.rb
- [linearis-gh] https://github.com/linearis-oss/linearis · [npm-linearis] https://registry.npmjs.org/linearis
- [linearis-readme] https://raw.githubusercontent.com/linearis-oss/linearis/main/README.md
- [linearis-enc] https://raw.githubusercontent.com/linearis-oss/linearis/main/src/common/encryption.ts
- [brew] https://formulae.brew.sh/api/formula/linear.json (404)
- [graphql] https://linear.app/developers/graphql
- [api-keys] https://linear.app/docs/api-and-webhooks
- [rate] https://linear.app/developers/rate-limiting
- [oauth] https://linear.app/developers/oauth-2-0-authentication
- [attachments] https://linear.app/developers/attachments
- [li-github] https://linear.app/docs/github
- [li-gitlab] https://linear.app/docs/gitlab
