# Integration provider: GitHub (github.com, ghe.com, Enterprise Server) — the reference migration

> Slug: `integration-github` · Issue: #1615 · Updated: 2026-10-22 · Status: draft for review.
> Builds on the binding umbrella spec [integration-providers](2026-10-22-integration-providers.md).
> Siblings: [GitLab](2026-10-22-integration-gitlab.md) · [Azure DevOps](2026-10-22-integration-azure-devops.md) ·
> Jira · Linear. **Owns** the umbrella's phase-1 GitHub migration, the **Issues view + provider
> switcher** UI and the **Settings → Integrations** page. Supersedes the GitHub half of #847 / #848.

## Evidence legend

- **[V-local]** — verified on the writing machine on 2026-10-22: `gh --version` → **2.103.0
  (2026-10-21)**, Homebrew stable 2.103.0, `gh <cmd> --help` flag lists.
- **[V-live]** — verified against github.com on 2026-10-22 with the writer's own `gh` (read-only:
  GraphQL introspection, `gh api rate_limit`, `gh auth status --json hosts`).
- **[V-docs]** — read today from the cited page (`curl` against docs.github.com / cli.github.com).
- **[code]** — read from this repo at the fork point (`cez/1ba0d513`).
- **[A]** — assumption / design inference; must be pinned by a test before it ships.

## TLDR

- GitHub becomes `packages/cezar/src/integrations/github/`, **remote-anchored**, roles **code host**
  + **work source**, implementing every umbrella facet: `workItems`, `changeRequests`, `merge`,
  `publish`, `clone`, `automation`, `link`, `agentAccess`.
- It is a **move, not a rewrite**: `server/forge/github.ts` (3 523 lines) and
  `automations/github-poller.ts` are split into the provider directory behind the facet interfaces;
  every `gh` argv, cache, cap and zod schema keeps its current value. The old modules become
  re-export shims until the last import is gone.
- **Connection: `cli` (gh) only in phase 1** — exactly today's model; cezar holds no credential.
  `GITHUB_TOKEN`/`GH_TOKEN` keep working because `gh` itself reads them. A managed-store `token`
  connection (fed to `gh` as `GH_TOKEN`/`GH_ENTERPRISE_TOKEN`, never an own HTTP client) is phase 2.
- `/api/v1/github*`, `POST /runs/:id/pr`, `/projects/checkout` become **frozen adapters**: same
  chained family, same validators, same bodies, now calling the GitHub integration. Proved by
  **wire goldens** captured from the pre-migration handlers in step M0 and replayed after every step.
- Host discovery reuses `github-hosts.ts` unchanged (github.com, `*.ghe.com`, `gh`'s `hosts.yml`,
  `GH_HOST`); GHES API bases are derived, never configured.
- Zero visible change while GitHub is the only integration: nav label **GitHub**, `/github/*` URLs,
  no switcher strip. The Issues view appears when a second integration exists (umbrella phase 2).

## Problem

#847 inventories eight subsystems that bypass `ForgeDriver` and call `gh`/github.com directly.
Until GitHub itself sits on the seam, every other provider spec has nothing to plug into: the
review gate, the PR chips, the workflow PR nodes and automations are GitHub code paths, not facet
calls. GitHub is also the only provider with years of shipped behavior — so the hard requirement is
**no user-visible regression**, which "tests are green" does not prove on its own (AGENTS.md
§ Changing a mechanism that already works).

## Non-goals

- Replacing `gh` with an own REST/GraphQL client (rejected below), or changing any `gh` argv.
- Changing any frozen route shape, `GithubItem`, the `github` automation kind, `github.*` tokens,
  the `githubView` ui-state key or the `github.*` workflow node types.
- GitHub-only product surfaces with no facet: `POST /projects/create` + `/projects/github-owners`
  (repo creation, spec 2026-09-29), skills `owner/name` shorthand (`skills-remote.ts`). They stay
  GitHub-specific, untouched.
- Merge queue, rulesets, Actions job control, Discussions, Codespaces. GitHub Projects v2 is
  designed as **future work** only (§ Projects v2).

## Vendor research

### The CLI: `gh`

| Question | Finding | Tag |
| --- | --- | --- |
| Official / maintained | GitHub's own CLI, [github.com/cli/cli](https://github.com/cli/cli); release v2.103.0 published 2026-10-21. | [V-live] [V-local] |
| Install | `brew install gh` [V-local]; official apt (Debian/Ubuntu) and dnf/rpm repos ([install_linux.md](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)) [V-docs]; `winget install --id GitHub.cli` [A]. The Linux repos' **PGP signing key rotated on 2026-09-05** ([README](https://github.com/cli/cli#installation), cli/cli#13118) [V-docs] — `server-install/steps.ts`'s apt keyring step must be checked against the new key in M7. Supports github.com, GHEC and supported GHES versions. | [V-docs] [code] |
| Auth / storage | `gh auth login [--hostname H]` (browser or token paste); token in the OS keyring, else plaintext in `hosts.yml` under `GH_CONFIG_DIR` ([gh auth login](https://cli.github.com/manual/gh_auth_login)). Local `tokenSource: "keyring"`. | [V-live]; storage detail [A — re-check on the page] |
| Env | `GH_TOKEN`/`GITHUB_TOKEN` (github.com), `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` (GHES), `GH_HOST`, `GH_REPO`, `GH_CONFIG_DIR`, `GH_PROMPT_DISABLED`, `GH_NO_UPDATE_NOTIFIER`, **`GH_TELEMETRY`** (new: `0` disables gh's own telemetry, overrides `DO_NOT_TRACK`) ([gh help environment](https://cli.github.com/manual/gh_help_environment)). | [V-local] |
| `auth status` | **`--json hosts`** now exists: `{hosts:{<h>:[{state,active,host,login,tokenSource,scopes,gitProtocol}]}}`; `--hostname H`, `--active`, `--no-refresh`. No more prose scraping for the readiness ladder. | [V-local] [V-live] |
| JSON lists | `gh issue list` / `gh pr list --json <fields>` with `--state`, `--label`, `--search`, `--limit`, `--head`, `--base`; `pr list --state` adds `merged`. cezar's list path uses GraphQL instead (cursor pagination + totals, #1261) and keeps doing so. | [V-local] [code] |
| Raw passthrough | `gh api <path\|graphql>` with `-X`, `-f` (string) / `-F` (typed, `@file`), `-H`, `--hostname`, `-i/--include`, `--paginate` (+ `--slurp`), `--jq`, `--cache`; GraphQL `--paginate` needs `$endCursor` + `pageInfo{hasNextPage,endCursor}`; `{owner}/{repo}/{branch}` placeholders from cwd or `GH_REPO`. | [V-local] [V-docs: [gh api](https://cli.github.com/manual/gh_api)] |
| Search | `gh search issues\|prs` with `--json`, `--repo`, `--state`, `--label`, `--match title\|body\|comments`, **`--search-type lexical\|semantic\|hybrid`** (new). | [V-local] |
| Create / merge | `gh pr create --draft --base --head --title --body/--body-file` (no `--json`; prints URL). `gh pr merge --auto --disable-auto --match-head-commit SHA --merge\|--squash\|--rebase --admin`. | [V-local] |
| Projects v2 | `gh project item-list <n> --owner O --format json --query "<filter>"`; needs `read:project` scope. | [V-local] [V-docs] |
| Rate limits | REST 5 000 req/h per user (15 000 for GHEC-owned apps), 60/h unauthenticated; search 30 req/min (semantic/hybrid 10/min); GraphQL 5 000 points/h ([REST](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [search](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests), [GraphQL](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api)). Local `rate_limit`: core 5000, graphql 5000, search 30. GHES: admin-configured. | [V-docs] [V-live] |
| GHES / ghe.com | GHES REST at `https://HOST/api/v3`, GraphQL at `https://HOST/api/graphql`; `gh` addresses it by `--hostname`/`GH_HOST` ([GHES quickstart](https://docs.github.com/en/enterprise-server@latest/rest/quickstart)). GHEC with data residency lives on a dedicated `*.ghe.com` subdomain ([data residency](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency)). | [V-docs] |
| Gaps | No JSON from `pr create` (URL on stdout — scraped today), no batched checks command, auto-merge has **no REST endpoint** (GraphQL `enablePullRequestAutoMerge` / `gh pr merge --auto`). | [V-local] [V-live] |

### Recommendation: **`cli` (gh) — preferred and, in phase 1, only**

1. `gh` is official, current, cross-platform, owns auth for every GitHub host kind, and `gh api`
   reaches every REST and GraphQL endpoint — no facet is CLI-blocked. It is what ships today.
2. A **`token` connection** (phase 2, umbrella store) is offered for machines where the user will
   not run `gh auth login` (hosted cockpit, CI box): the managed token is passed to the **same `gh`
   argv** as `GH_TOKEN` (github.com) / `GH_ENTERPRISE_TOKEN` + `GH_HOST` (GHES) in the child env
   only. One transport, one schema set; the token never reaches agent env, logs or run records.
3. **No own HTTP client.** A `gh`-less GitHub path would duplicate ~3 500 lines of tested behavior
   for a machine that can `brew install gh`. Revisit only if a hosted cockpit cannot ship `gh` (open question 2).

## Inventory → facet mapping (#847, all eight subsystems)

Target directory `packages/cezar/src/integrations/github/`. "Proof" = the test that shows no change.

| # | Today ([code]) | Facet / target | Change | Proof |
| --- | --- | --- | --- | --- |
| 1a | `server.ts` `githubRoutes`: `GET /github`, `/github/search`, `/github/checks`, `/github/ref-status`, `/github/comments/:kind/:number`, `/github/prs/:number/{changes,merge-state}`, `POST …/merge` | frozen adapter → `workItems`, `changeRequests`, `merge` | handlers call `ctx.integrations.github()` facets instead of importing `forge/github.ts` | wire goldens (M0), `route-parity`, `contract-parity*`, `typed-bodies` |
| 1b | `POST /runs/:id/pr` → `server/pr.ts` → `createDraftPr` | `publish` via code host | adapter delegates to `POST /runs/:id/change-request` handler core | `draft-pr-autosave.test.ts` unchanged + golden |
| 1c | `GET /health` `forge` ← `resolveForge` + `detectGithubCached` | `availability()` (cached, SWR) | `forge` = `{ kind: codeHost.providerId, …availability }` | `health-forge.test.ts` |
| 2 | `forge/github.ts`: list (GraphQL, #1261 cursors), counts, checks (#664), ref-status, thread + timeline (#525), commit checks, PR diff, merge state/merge, draft PR, `updatePr`, `commentOnPr`, `commentOnIssue`, `detectGithub*`, `evictGithubProjectCaches` | split into `list.ts`, `thread.ts`, `checks.ts`, `ref-status.ts`, `diff.ts`, `merge.ts`, `publish.ts`, `availability.ts`; `dispose()` replaces eviction | code moved verbatim; module caches keyed `project + integrationId` (#847 `detectCache` singleton) | `forge/github.test.ts` (3 471 lines) moved, **no assertion edited** |
| 3 | `automations/github-poller.ts` (search + timeline), `scheduler.ts` `GithubRequestArbiter`, `task-template.ts` `github.*`, store `githubNumber…` | `automation` facet: `events.ts` wraps the poller as `AutomationEventSource` | arbiter becomes the GitHub per-provider budget; `github` kind keeps parsing and running | `github-poller.test.ts`, automations e2e |
| 4 | `server/checkout.ts` `parseRepoRef` (github.com + Enterprise), `ghCloneRunner` (`gh repo clone … -- --progress`, `GH_PROMPT_DISABLED=1`) | `clone` facet | `parseRepoRef` asks the registry which provider recognises the host; GitHub's clone keeps the argv | `checkout.test.ts` unchanged |
| 5 | `core/backend-detect.ts` `probeGh` (`gh auth token`), `readHostGithubToken`; `core/agent-env.ts` `GH_ALLOW_NAMES`; `core/secret-redaction.ts` `gh[pousr]_…`, `github_pat_…`; `server-install/steps.ts` gh | manifest `cli` descriptor, `agentAccess.envNames`, `redaction.patterns` | probes/lists read from the manifest; GitHub's **stay default-forwarded** (only new providers are opt-in) | `backend-detect.test.ts`, `agent-env.test.ts`, `secret-redaction.test.ts` |
| 6 | `runs/store.ts` `PR_URL_RE`/`ISSUE_URL_RE` (8 call sites), `runs/task-refs.ts` tier-1/2 regexes | manifest `referencePatterns` | GitHub's patterns are **today's regexes verbatim** — already host-agnostic (`/pull/N` on any host), must not narrow | `task-refs.test.ts`, `store.test.ts`, new "pattern identity" test |
| 7 | `workflows/run.ts` `github.draft-pr`, `github.wait-ci`, `github.pr-comment`, `github.pr-update`, `github.issue-comment` (`graph.ts`) | code host `publish` / `changeRequests.checks` / `link` | node types keep their names (persisted workflows); executor resolves the code host; absent facet → "not supported by <provider>" step error | `graph-system-nodes.test.ts`, `github-item-url.test.ts` |
| 8 | web: `api/client.ts`, `api/queries.ts` (`queryKeys.github`), `routes/github/*`, `routes.tsx`, `nav-items.ts` (`forge: true`), `lib/git-actions.ts` (`ForgeInfo`, "no supported forge remote (GitHub)"), `lib/github-task.ts` ↔ `task-refs.ts`, `lib/github-templates.ts`, `lib/bookmarklet.ts` (github.com matcher), `lib/tasks-table.ts`, `repo-git/repo-branches.tsx`, `task-thread/thread-state.ts`, `githubView`; e2e `github.e2e.ts` | Issues view (§ UI) over `/integrations/*`; GitHub rendering kept as the `github` provider panel | phase 1: no web change except `ForgeInfo.kind` widening; phase 2: Issues view | `github.test.tsx`, `github-route-wiring.test.tsx`, `github.e2e.ts` unchanged |

## Host discovery (github.com, ghe.com, GHES)

`integrations/github/discover.ts` classifies **every** remote with the existing
`isGithubHost(host)` from `packages/cezar/src/github-hosts.ts` — reused, not copied:

1. `github.com` → GitHub; `*.ghe.com` → GitHub without a login ("sign in to <host>" when signed out);
2. a host key in `gh`'s `hosts.yml` (`GH_CONFIG_DIR` → `XDG_CONFIG_HOME/gh` → `%AppData%\GitHub CLI`
   → `~/.config/gh`), or `GH_HOST` — synchronous read, 30 s TTL. Its line regex captures **top-level
   host keys only**, so a token value is never parsed into memory: this already satisfies the
   umbrella's "zod pick of host keys" rule and stays as is;
3. a host of a stored GitHub token connection (phase 2);
4. a bare `github.*` name is **not** GitHub (the file's own rule) — at most a Settings suggestion.

Precedence over other providers follows the umbrella (override > signed-in CLI > well-known).
The **anchor is the PR-target remote from `resolveTaskRemotes`** (`gh repo set-default`, else the
confirmed fork parent, else `origin`) — exactly what `gh` resolves today, so a fork clone keeps
listing the canonical repo. Further GitHub remotes become `github-2`… only when the user un-hides
them (default hidden: two GitHub tabs for one fork would be a visible change). Web origin =
`https://<host>`; API base derived (`api.github.com`, `https://<ghes>/api/v3`, `/api/graphql`) and
only ever used through `gh --hostname` / `GH_HOST`, which the code already pins per call
(`forge/github.ts` `GH_HOST: host`). `isSafeHostname` guards every host before argv or URL use.
Readiness (Settings only, off the request path, ≤ once/10 min): `gh auth status --json hosts
--hostname <h>` → `state`, `login`, `scopes`. Health keeps using `detectGithubCached`.

## Facet → `gh` argv table

All argv run via `integrations/shared/cli-exec.ts` (extracted `gh()`/`execTool`: cwd = repo root,
`GH_HOST` pinned, timeout, output cap, ENOENT → "Install gh", auth failure → "run `gh auth login`").
Rows marked *today* are the exact current argv ([code]); *new* rows are additions.

| Facet / op | argv | JSON fields used | |
| --- | --- | --- | --- |
| availability | `repo view --json nameWithOwner` (5 s) | `nameWithOwner` | today |
| readiness (Settings) | `auth status --json hosts --hostname H` | `state`, `login`, `scopes`, `tokenSource` | new [V-local] |
| workItems/changeRequests.list | `api graphql -f query=<issues+prs page> -F *Limit=N -f *Cursor=C` | `number,title,state,author,labels{name,color},createdAt,updatedAt,url,isDraft,comments.totalCount, pageInfo, totalCount` | today (#1261) |
| search (cross-state) | `searchGithubItems`: bare number → `{pr,issue} view <n> --json …`; text → `search {prs,issues} <q> --repo O/R --json …` (every state) | same item fields | today (#730) |
| checks glyphs | `api graphql` batched `statusCheckRollup{state}` ≤ 100 PRs | `state` | today (#664) |
| ref-status chips | `api graphql` `issueOrPullRequest(number:n)` aliases | `state,isDraft,reviewDecision,mergeable,commits(last:1)…` | today |
| thread | `api repos/{owner}/{repo}/issues/N/comments --paginate`; `api …/pulls/N/reviews --paginate`; bounded `api …/issues/N/timeline?per_page=…&page=k` loop | comment/review/timeline rows (zod) | today (#499, #525) |
| changes (diff) | `pr view N --json headRefOid`; `api …/pulls/N/files?per_page=100&page=k` | `filename,status,additions,deletions,patch,previous_filename` | today |
| merge.state | `api graphql` merge-state query (+ `pr view N --json statusCheckRollup`) | as `githubPrMergeStateSchema` + **new** `autoMergeRequest{enabledAt}`, `viewerCanEnableAutoMerge`, repo `autoMergeAllowed` | today + new [V-live] |
| merge.merge | `api --method PUT repos/O/R/pulls/N/merge -f sha=<head> -f merge_method=M` | `merged,sha` | today |
| merge.auto (new) | `api graphql -f query='mutation($id:ID!,$m:PullRequestMergeMethod,$h:GitObjectID){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m,expectedHeadOid:$h}){pullRequest{autoMergeRequest{enabledAt}}}}'`; cancel = `disablePullRequestAutoMerge` | `autoMergeRequest` | new [V-live: input fields `pullRequestId, mergeMethod, expectedHeadOid`] |
| publish | `git push -u <push remote> <branch>` → `pr list --head B --state open --json url,headRepositoryOwner` (reuse) → `pr create --draft <repoArgs> --base T --title … --body …`; URL scraped and validated against `https://<host>/…/pull/\d+` | `url`, `headRepositoryOwner` | today |
| publish follow-ups | `pr ready N`; `pr edit N --add-label … --add-reviewer …`; `pr comment N --body …` | — | today (workflow nodes) |
| link (work source) | `issue comment N --body …` | — | today (`github.issue-comment`) |
| clone | `repo clone <cloneUrl> <dir> -- --progress` with `GH_PROMPT_DISABLED=1` | — | today |
| automation | `api --method GET /search/issues -f q=…` (+ `--hostname H`); `api [--include] --method GET repos/O/R/issues/N/timeline` | `node_id,html_url,number,pull_request,labels,…`; timeline `event,created_at,label,requested_reviewer` | today |

Known stdout scrape: `pr create` prints only a URL. Kept (zero change); the validation regex is
moved into `publish.ts` with its tests. A JSON alternative (`api -X POST repos/O/R/pulls -F draft=true`)
is an option for later, not part of the migration.

## Frozen adapters for `/api/v1/github*`

Routes stay in the **same chained `githubRoutes` builder** in `server.ts`, mounted under `/api/v1`
and `/api/v1/p/:projectId`, with the **same validators and messages**. Only the handler bodies change:

```ts
// server/server.ts — shape of every adapted handler (illustrative)
.get('/github/checks', queryZodValidator(z.object({ prs: z.string().min(1) }), { message: 'missing prs query' }), async (c) => {
  const gh = c.get('project').integrations.byProvider('github'); // GithubIntegration | null
  if (!gh) return c.json(GITHUB_UNAVAILABLE_LEGACY);            // byte-equal to today's non-GitHub answer
  return c.json(await gh.legacy.checks(parsePrList(c.req.valid('query').prs)));
})
```

- `GithubIntegration` exposes the neutral facets **and** a `legacy` object returning the frozen
  `github.ts` contract shapes directly (`GithubData`, `GithubChecksData`, …). Frozen routes never
  round-trip through `WorkItem`, so no field can be lost in a normalize → denormalize pair.
  Neutral facets are built **on top of** the same internals (`WorkItem` from `GithubItem`).
- The frozen routes serve **only** the GitHub integration (never GitLab), selected by provider id,
  not by "code host", so a user who sets ADO as code host keeps a working `/github` tab.
- `POST /runs/:id/pr` keeps `createPrSchema` and its response; it delegates to the publish core
  shared with `POST /runs/:id/change-request`.
- `forgeInfoSchema.kind` widens to the remote-anchored enum; `git-actions.ts` copy "no supported forge
  remote (GitHub) detected" becomes manifest-driven ("…(GitHub, GitLab, Azure DevOps)") — the only
  wording change, and only once a second remote-anchored provider is registered.
- BACKWARD_COMPATIBILITY.md §2 gains "deprecated, adapter over the GitHub integration" on each route.

## Contract additions (GitHub-specific; all additive)

- None on frozen `github.ts` shapes. GitHub fills the umbrella's neutral `changeRequestMergeState`
  `autoMerge?: { available: autoMergeAllowed && viewerCanEnableAutoMerge, enabled: autoMergeRequest != null }`.
- Neutral merge body `autoMerge: true` → `enablePullRequestAutoMerge` with `expectedHeadOid` = the
  head the user reviewed (same stale-head rule as today's `sha`); response
  `{ merged:false, autoMergeEnabled:true }` (umbrella branch). Frozen `POST /github/prs/:n/merge`
  never sends it.
- `projects[].forge` stays `'github'`-valued for GitHub; `projects[].integrations?` (umbrella) adds
  `{ id, providerId }[]` so the sidebar can gate nav without a network call.
- Token form (phase 2): `{ host: hostname (default github.com), token: string.min(20) }`.

## UI: Issues view + provider switcher (owned here)

**Rule:** with exactly one integration, nothing changes — `GitHub` nav label, `/github/*` URLs,
today's `routes/github/github.tsx` render. The Issues view below is reached when the project has
≥ 2 visible integrations, or immediately when the only one is not GitHub.

**Routes** (`packages/web/src/routes.tsx`): `/p/:pid/issues` → last-selected integration
(`issuesView.integrationId`); `/p/:pid/issues/:iid` list; `/issues/:iid/i/:itemId` work item;
`/issues/:iid/cr/:itemId[/changes]` change request (`i`/`cr` keep GitLab `#12` vs `!12` apart).
With the Issues view active, `/github/issues/:n` → `/issues/github/i/:n`, `/github/prs/:n[/changes]` →
`/issues/github/cr/:n[/changes]`, `/github` → `/issues/github`, `/tracker[/:id]` →
`/issues/<tracker iid>[/i/:id]` — deep links keep working.

**Nav** (`nav-items.ts`): one item replaces `GitHub` + `Tracker`; label = provider label when one
integration, else **Issues**; icon = provider icon when one, else generic. Gated by
`projects[].integrations` (no network). `forge: true` / `tracker: true` flags collapse into `integrations: true`.

```text
┌ Issues ───────────────────────────────────────────────────────────────────────────────┐
│ [◉ GitHub · open-mercato/cezar] [◇ Jira · PROJ] [◆ Linear · ENG]          [+ Connect] │  ← switcher (tabs, ←/→ keys)
├───────────────────────────────────────────────────────────────────────────────────────┤
│ (Issues 42) (Pull requests 7)   State: [Open ▾]  Labels: [any ▾]   🔍 search…  ⟳ 1m   │  ← chips from manifest vocabulary
├────────────────────────────────────────┬──────────────────────────────────────────────┤
│ #1512  Fix flaky merge-state test  ✓  │ #1512 Fix flaky merge-state test     [Open ↗]│
│        bug · ci   @alice   2h   💬 4  │ ✓ checks passing · review required · mergeable│
│ #1509  Draft: Azure provider     ⧗  │ ───────────────────────────────────────────── │
│        enhancement  @bob   5h          │ body (Markdown) …                             │
│ #1498  Add GitLab subgroups     ✗  │ ── thread: comments + timeline events ─────── │
│ …                                      │ [ Hand to agent ▾ ]  [ Merge ▾ ]  [ Changes ] │
│ ── 3 of 7 · Load more ──               │  facets absent → button absent, never 5xx     │
└────────────────────────────────────────┴──────────────────────────────────────────────┘
  Jira tab: chips = status categories (To do · In progress · Done); key PROJ-42; no Merge/Changes.
  "Search covers ids only on Azure Repos PRs" — shown inline when search depth = 'id-only'.
```

- One list over `WorkItem` (`components/work-item-list.tsx`); GitHub rows keep checks glyphs
  (lazy `/integrations/github/change-requests/…/checks`), draft badge, comment count, label colors.
- One detail pane; hand-to-agent through `lib/work-item-task.ts` (generalises `github-task.ts` +
  `tracker-task.ts`). For GitHub the prompt heading stays **byte-identical** (`Address GitHub pull
  request #N` / `Fix GitHub issue #N`) — `task-refs.ts` tier-2 depends on it.
- Overflow ⋯ on a switcher tab: *Hide from this project*, *Open settings*. Disconnected / signed-out
  integration renders the tab with a ⚠ and the availability `reason` + one action (*Sign in*), never an empty list.
- Mobile: switcher becomes a select; list and detail stack (today's GitHub behavior).

### Settings → Integrations

The section id `integrations` already exists ("External integrations": the Tester Army e2e card,
`settings/integrations-section.tsx`). It is kept and gains a first tab; the e2e card becomes the
second tab, so no section is renamed away. `tracker-section.tsx` content moves into the Jira/Linear cards.

```text
Settings › Project › Integrations
 [ Issues & code ]  [ Test frameworks ]
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │ Connected in this project                                                     │
 │  ◉ GitHub · open-mercato/cezar   code host · gh 2.103 signed in as @alice  ⋯  │
 │  ◇ Jira · PROJ                   work source · token (Cloud)               ⋯  │
 ├───────────────────────────────────────────────────────────────────────────────┤
 │ Available                                                                     │
 │  ◆ GitLab        CLI missing          [Install glab ▾ brew/winget]  docs ↗    │
 │  ▣ Azure DevOps  CLI found, signed out  [Sign in (opens terminal)]           │
 │  ◆ Linear        token                 [Connect…]                             │
 │  ⓘ remote "mirror" on gitlab.acme.com looks like GitLab — [Sign in?]          │
 ├───────────────────────────────────────────────────────────────────────────────┤
 │ Code host: [GitHub · open-mercato/cezar ▾]   (publishes PRs, merge, PR chips) │
 └───────────────────────────────────────────────────────────────────────────────┘
```

Readiness ladder per card: `CLI missing → CLI found, signed out → Signed in → Connected (n)`, from
the manifest + cached `auth status --json`; install/sign-in actions only on a local cockpit
(`capabilities().localHandoff`), copy-paste commands otherwise. A GitHub card for a zero-config
repo shows **Connected** with no action required.

## Automations

`integrations/github/events.ts` adapts `github-poller.ts` to `AutomationEventSource`; cycle,
receipts, leases and baselining unchanged. Existing `github` automations keep their trigger
schema, event names and `github.*` tokens. A new `integration`-kind automation on GitHub maps:

| Frozen GitHub event | Neutral event | Verified from |
| --- | --- | --- |
| `issue.opened` | `work_item.created` | search `created:>cursor` |
| `issue.labeled` / `issue.unlabeled` | `work_item.labeled` / `.unlabeled` | timeline `labeled`/`unlabeled` |
| `pull_request.opened` / `.closed` / `.merged` | `change_request.opened` / `.closed` / `.merged` | search + `closed_at`/`merged_at` |
| `pull_request.review_requested` / `.rereview_requested` | `change_request.review_requested` / `.rereview_requested` | timeline `review_requested` |
| `pull_request.reviewed` | `change_request.review_submitted` | timeline `reviewed` |

For GitHub-sourced candidates both `item.*` and `github.*` tokens are filled (they are true);
other providers never fill `github.*` (GitLab spec agrees). `GithubRequestArbiter`'s search/core
buckets become GitHub's per-provider budget (30/min search, 5 000/h core).

## Run bookkeeping reference patterns

GitHub's manifest `referencePatterns` = today's expressions, moved, not rewritten:
`PR_URL_RE`, `ISSUE_URL_RE` (`runs/store.ts`), tier-1 URL and tier-2 worded patterns
(`runs/task-refs.ts`). They match `/pull/N` and `/issues/N` on **any** host today (an upstream
github.com PR cited from a GHES project); narrowing them to discovered hosts would drop chips →
forbidden. Bare `#N` = GitHub issue/PR when GitHub is the code host (umbrella).
`RunRecord.workItemRefs` entries: `{ providerId:'github', itemId:'12', key:'#12', kind, url }`;
`prNumber`/`issueNumber`/`referencedPullRequestUrl` keep being written for GitHub.

## Cross-provider linking

- **As work source:** footer `Fixes #12` when GitHub is also the code host and same repo,
  `Fixes owner/repo#12` for another GitHub repo ([closing keywords](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue) [V-docs] — auto-close only on merge into the default branch);
  a plain URL line when the code host is GitLab/ADO.
- **As code host:** `buildPrBody` appends the work-source footers (`PROJ-42`, `AB#1234`,
  `Fixes ENG-12`) under a `---` after today's body; a run with no foreign refs produces a
  byte-identical body (golden).
- `link` facet (opt-in, off): `issue comment` "cezar opened #N" on a GitHub work item.

## Agent access and redaction

- `agentAccess.envNames` = today's `GH_ALLOW_NAMES` (`GITHUB_TOKEN`, `GH_TOKEN`, `GH_HOST`,
  `GH_ENTERPRISE_TOKEN`, `GH_CONFIG_DIR`, …) and stays **forwarded by default** — removing that
  would break every agent that runs `gh` today. Only non-GitHub providers are opt-in.
- `redaction.patterns` = today's two. **Found while writing this spec:** GitHub rolls out stateless
  installation tokens **`ghs_<APPID>_<JWT>`** from 2026-04-27 ([token formats](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github#githubs-token-formats) [V-docs]);
  `gh[pousr]_[A-Za-z0-9]{20,}` does **not** match it (checked with node [V-local]). Add
  `ghs_[0-9]+_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` as an independent fix PR (with a
  backport decision), not inside the migration.

## Dry-run fixtures

`CEZ_DRY_RUN=1` paths (`mockGithubPage`, mock merge SHA, fake PR URL) move into
`integrations/github/fixtures/` + `dry-run.ts` unchanged, and are what the conformance suite runs.
Additions: `auth-status.{signed-in,signed-out,ghes}.json`, `automerge.{enabled,not-allowed}.json`.

## Migration order (umbrella phase 1) — each step one PR, all suites green

| Step | Does | Zero-change proof |
| --- | --- | --- |
| **M0** | Capture **wire goldens**: `integrations/github/__goldens__/` — every frozen route (both mounts) × {github remote ok, gh missing, signed out, non-GitHub remote, not a repo, dry-run}, with a fake `gh` runner; plus `buildPrBody`, hand-off prompt text, `extractTaskRefs` corpus, workflow-node argv logs. No product code. | goldens committed from **current** handlers |
| **M1** | `integrations/{types,registry}.ts`, `shared/cli-exec.ts` extracted from `gh()`/`execTool` (re-exported by `forge/github.ts`). | goldens + `github.test.ts` |
| **M2** | Move `forge/github.ts` into `integrations/github/*.ts`; `forge/github.ts`, `server/github.ts`, `server/pr.ts` become re-export shims. Caches keyed by project + integration; `dispose()` called where `evictGithubProjectCaches` was. | `github.test.ts` moved with zero assertion edits; `project-isolation` test for two GitHub projects |
| **M3** | `IntegrationResolver` in `project-context.ts`; `resolveForge`/`forgeKindOfRemote`/`forgeWebRoot` delegate to it. | `forge/index.test.ts`, `health-forge.test.ts`, projects `forge?` goldens |
| **M4** | `githubRoutes` + `POST /runs/:id/pr` + checkout → adapters; `/integrations/*` routes for GitHub. | M0 goldens byte-equal; `route-parity`, `bc-route-inventory`, `contract-parity*`, `typed-bodies` |
| **M5** | Workflow PR nodes via code-host facets. | node argv-log goldens; `graph-system-nodes.test.ts` |
| **M6** | Automations: `events.ts` wraps poller; arbiter → provider budget. | `github-poller.test.ts`, `scheduler` tests, automations e2e |
| **M7** | Host tooling from manifest: `backend-detect`, `agent-env`, `secret-redaction`, `server-install` gh step; reference patterns. | existing tests + **identity tests**: manifest list ≡ old literal list |
| **M8** | Web: `ForgeInfo.kind` widening, `git-actions.ts` type; `projects[].integrations`. Settings → Integrations tab (GitHub card only). | `github.e2e.ts`, `git-actions.test.ts`, settings tests |
| **M9** | Delete shims once `grep -r "server/forge/github"` is empty. | full gate |

The Issues view, switcher and redirects ship with umbrella phase 2 (Jira/Linear), on the same goldens.
Per AGENTS.md, each step's new regression tests are shown **red** against a deliberately broken
adapter (e.g. drop `labelColors`) before merging, so a green-either-way golden cannot pass.

## Tests

- **Wire goldens** (`integrations/github/goldens.test.ts`): normalized JSON bytes + status +
  headers per route/state; regenerating requires an explicit `UPDATE_GOLDENS=1` and a reviewer note.
- `integrations/conformance.test.ts` (umbrella) runs GitHub fixtures: pagination, empty vs
  unavailable vs not-found, cursor binding, no network on `create()`/`discover()` (spy on `execFile`).
- `discover.test.ts`: github.com, `x.ghe.com` signed out, GHES via `hosts.yml` and `GH_HOST`,
  `github.corp` not GitHub, fork clone anchors the parent, second GitHub remote hidden by default.
- `merge.test.ts`: auto-merge enable/disable, `expectedHeadOid` mismatch → 409 stale-head,
  frozen merge route never returns `merged:false` 200.
- `redaction` identity test + `ghs_` stateless sample (separate fix PR).
- E2E: `github.e2e.ts` untouched and green in M0–M9; phase 2 adds `issues.e2e.ts` (switcher with
  GitHub + dry-run Jira, deep-link redirects, hidden integration).

## Projects v2 (future work source — not built)

A GitHub Project is **scope-anchored** (owner + number), not a repo, so it is a separate provider
id `github-projects` sharing GitHub's transport and host discovery. Read path:
`gh project item-list <n> --owner O --format json --query "<filter>" --limit N` [V-local] or
GraphQL `node(id){… on ProjectV2 { items(first:,after:) { nodes { content { … on Issue|PullRequest|DraftIssue } fieldValues … } } } }`
(item content = `DraftIssue | Issue | PullRequest` [V-live]); REST project-item endpoints now exist
([REST project items](https://docs.github.com/en/rest/projects/items), API version `2026-03-10`) [V-docs].
Needs the `read:project` scope (`gh auth refresh -s read:project`) [V-docs:
[projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)] —
the Settings card shows "needs read:project" from `auth status --json` `scopes`. Status field →
`stateLabel`; draft issues are hand-off-able but have no URL-addressable issue (`key` = `draft`).
Deferred: needs its own spec; no events (no history for field changes without webhooks) [A].

## Backward compatibility

- Frozen: every `/api/v1/github*` route, `POST /runs/:id/pr`, `/projects/checkout`, `GithubItem`,
  `github` automation kind + events + `github.*` tokens + `githubNumber` log fields, `github.*`
  workflow node types, `githubView`, hand-off prompt wording, reference regexes.
- Additive: `forge.kind` / `backendCheckSchema.name` enums (consumers widened same commit),
  `projects[].integrations?`, neutral merge `autoMerge`.
- Zero-config: no `integrations.json` is written for GitHub; deleting it restores discovery only.
  No new env var (so `.env.example` is untouched by this spec).

## Acceptance criteria

1. M0 goldens are byte-equal after M9 for every frozen route on both mounts and every state.
2. `forge/github.test.ts` passes after the move with no assertion changed; `github.e2e.ts` green.
3. A GHES repo (`hosts.yml` host) and a `*.ghe.com` repo are discovered with no config; a fork clone lists the parent.
4. A workflow with `github.draft-pr` + `github.wait-ci` on a GitHub repo emits identical argv logs.
5. With GitHub + dry-run Jira, the switcher shows both; `/github/prs/12` redirects to `/issues/github/cr/12`;
   a Jira-launched task's draft PR body carries `PROJ-42` below today's body.
6. `gh` missing / signed out yields today's reasons in `/github` and a ladder state in Settings — never a 5xx.

## Open questions

1. Should a second GitHub remote (fork) ever be shown by default? Proposal: hidden, un-hide in Settings.
2. Hosted cockpit without `gh`: accept "install gh" as the requirement, or build an HTTP transport later?
3. Move `pr create` to `gh api -X POST repos/O/R/pulls` (JSON, no scraping) after the migration?
4. Should `projects/create` + `github-owners` become a `repoCreate` facet for GitLab/ADO, or stay GitHub-only?
5. Projects v2 as `github-projects` provider id vs a second anchor kind on `github` — decide in its own spec.
