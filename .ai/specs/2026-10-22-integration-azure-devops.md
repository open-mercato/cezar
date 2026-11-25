# Integration provider: Azure DevOps (Services + Server)

> Slug: `integration-azure-devops` · Issue: #1617 · Updated: 2026-10-22 · Status: draft for review.
> Builds on the binding umbrella spec [integration-providers](2026-10-22-integration-providers.md)
> (manifest, facets, anchors, connections, contract, routes, Issues view, automations, linking).
> Sibling for shape and shared decisions: [GitLab](2026-10-22-integration-gitlab.md).
> Answers #1085 (Azure DevOps automations; the six scope questions in its triage comment are
> resolved in § Answers to #1085) and #1484 ("Azure DevOps integration").

## Evidence legend

- **[docs]** — read on 2026-10-22 from the cited Microsoft Learn page (fetched in this session).
- **[docs-unverified]** — an official page exists and is cited, but it was not re-read in this
  session; the implementer checks it in phase A0.
- **[local]** — verified on the writing machine (`brew info azure-cli` → cask **2.91.0**,
  depends on `python@3.14`; `az` not installed).
- **[assumption]** — design inference; must be proved by a test or a live check before shipping.

No live Azure DevOps organization was available; nothing here is **[live]**. Phase A0 exists to
fix that.

## TLDR

- **One provider, `azure-devops`, one integration per `(organization, project)` that serves both
  roles.** An Azure Repos remote yields a remote-anchored integration that is the **code host**
  (PRs, threads, policies → checks, complete/auto-complete, draft publish, clone) **and** a **work
  source** for the same project's Boards, with zero setup — org and project are in the remote URL.
  Teams on GitHub/GitLab code + Azure Boards add a **scope-anchored** `azure-devops` integration
  (Boards only) through the existing picker. Not two providers: same auth, same org, same REST
  base, and a split would make the zero-config ADO-only team connect twice.
- **Connection, in preference order: `cli` (Azure CLI as an Entra token broker) → `token` (PAT).**
  The `cli` strategy calls core `az account get-access-token --resource 499b84ac-…` (no
  `azure-devops` extension needed), keeps the 1-hour token **in memory only**, and talks REST
  directly. `az devops invoke` is a degraded fallback transport only for users signed in via
  `az devops login` (PAT in the az store). **Azure DevOps Server is `token`-only** — Microsoft's CLI
  extension does not support Server.
- Because `az` is a large Python install and Server excludes it anyway, the Settings flow offers
  the PAT form as an **equal** first choice, not a fallback hidden behind "Install CLI".
- Automations advertise only history-verifiable events: work item created / state changed / tag
  added-removed (work item **updates** API), PR opened / completed / abandoned (PR search by
  time), and — unlike GitLab — **reviewer added** and **vote cast**, because Azure Repos records
  both as system threads (`ReviewersUpdate`, `VoteUpdate`).

## Problem

An Azure DevOps team gets plain-git cezar: `parseRemote` turns
`https://dev.azure.com/acme/Web/_git/shop` into owner `_git`, repo `shop`; no work items, no PRs,
no draft PR from the review gate, no automations, and run bookkeeping drops every
`/_git/…/pullrequest/N` and `/_workitems/edit/N` link. #1085 asked for automations on work items
and PRs; triage split it because PRs needed the forge seam the umbrella now provides. #1484 asks
for the whole integration.

## Non-goals

- Azure Pipelines management (queue/retry runs), Test Plans, Artifacts, Wiki, Delivery Plans.
  Builds appear only as PR checks via policy evaluations.
- TFVC repositories (Git only). Azure DevOps Server < 2022 (see § Compatibility floor).
- Creating or editing work items beyond the opt-in `link` facet (comment / PR artifact link) and
  the existing agent-requested state transition (umbrella § Cross-provider linking).
- Service hooks / webhooks — polling only (umbrella non-goal; #1085 Q6).
- Windows-integrated auth (NTLM/Kerberos) to Server, OAuth app registration, service principals.
- Voting on, or bypassing policies of, a PR from cezar (a cezar user approving their agent's PR
  defeats the gate — same rule as GitLab approvals).

## Vendor research

### Products and hosts

| Flavor | Web / API base | Git remotes | Tag |
| --- | --- | --- | --- |
| Services | `https://dev.azure.com/{org}` | `https://[{org}@]dev.azure.com/{org}/{project}/_git/{repo}`, `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}` | [docs-unverified: [clone URLs](https://learn.microsoft.com/en-us/azure/devops/repos/git/clone)] |
| Services, legacy host | `https://{org}.visualstudio.com` (optionally `/DefaultCollection`) | `https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}`, `{org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}` | [docs-unverified] |
| Server (on-prem) | `https://{host}[:port][/{vdir}]/{collection}` (`/tfs` vdir common) | `https://{host}[:port][/{vdir}]/{collection}/{project}/_git/{repo}`, `ssh://{host}:22[/{vdir}]/{collection}/{project}/_git/{repo}` | [docs-unverified]; PAT portal URL shape `https://{server}/{collection}` / `http://{server}:{port}/tfs/{collection}` [docs: [PATs](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)] |

Project and repo names may contain spaces (`%20` in URLs) [assumption]; a repo named like its
project may appear as `/{org}/_git/{repo}` [assumption]. The `_git` segment is the invariant
discovery keys on.

### The CLI: `az` + `azure-devops` extension

| Question | Finding | Tag |
| --- | --- | --- |
| Official? | Yes — Microsoft's Azure CLI (current **2.91.0**) plus the `azure-devops` extension (groups `devops`, `repos`, `boards`, `pipelines`, `artifacts`; GA). Docs updated 2026-09/10. | [docs: [install](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli), [az devops](https://learn.microsoft.com/en-us/cli/azure/devops)] [local] |
| Server support | **None**: "The Azure DevOps CLI extension works only with Azure DevOps Services (cloud). It doesn't support Azure DevOps Server (on-premises)." | [docs: [get started](https://learn.microsoft.com/en-us/azure/devops/cli/)] |
| Install | Windows: WinGet / MSI / ZIP; Linux: apt, dnf, zypper, tdnf (installs into `/opt/az` or `/lib64/az`); macOS: Homebrew (`brew install azure-cli`, depends on `python@3.14`); Docker image. Extension: `az extension add --name azure-devops`; it also **auto-installs on first `az devops/repos/boards` use**. | [docs: [install](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli), [az repos pr](https://learn.microsoft.com/en-us/cli/azure/repos/pr)] [local] |
| Install weight | A bundled-Python application; the download and on-disk footprint are hundreds of MB [assumption — A0 measures `du -sh` per platform]. Each `az` start pays a Python start-up of the order of a second [assumption — A0 measures]. | [local: python dep] |
| Auth | `az login` (interactive Entra ID) — "The `az devops` commands support sign-in through `az login`"; `az devops login --organization URL` (PAT prompt or stdin); env `AZURE_DEVOPS_EXT_PAT` used when neither login exists; guest users: `az devops login` only. | [docs: [PAT sign-in](https://learn.microsoft.com/en-us/azure/devops/cli/log-in-via-pat)] |
| Entra token for REST | `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv`; tokens "only last for one hour"; send as `Authorization: Bearer`. Core `az`, **no extension required**. | [docs: [Entra tokens via CLI](https://learn.microsoft.com/en-us/azure/devops/cli/entra-tokens)] |
| Credential storage | `$HOME/.azure` (`%USERPROFILE%\.azure`) is `AZURE_CONFIG_DIR`. Where `az devops login` keeps the PAT (OS keyring vs file) was not confirmed. | [docs: install FAQ] [assumption: keyring] |
| Defaults / detection | `az devops configure --defaults organization=… project=…`; `--detect` derives org/project from the cwd's git remote. | [docs: [az devops](https://learn.microsoft.com/en-us/cli/azure/devops)] |
| JSON | `--output json` is the default for every command; `--query` JMESPath. | [docs] |
| Raw passthrough | `az devops invoke --area A --resource R --route-parameters k=v … --query-parameters … --http-method M --in-file F --api-version V`; "use only json output as the response of this command is not fixed"; **default api-version 5.0** (always pass one). No response headers, no full-URL mode. | [docs: [az devops invoke](https://learn.microsoft.com/en-us/cli/azure/devops#az-devops-invoke)] |
| Command coverage | `az repos pr create` (`--draft`, `--auto-complete`, `--squash`, `--delete-source-branch`, `--work-items`, `--transition-work-items`, `--labels`), `pr list` (`--status`, `--source-branch`, `--top`, `--skip`), `pr show`, `pr update` (`--draft false` publishes, `--status completed`, `--auto-complete`, `--bypass-policy`), `pr policy list`, `pr reviewer list`, `pr work-item add`; `az boards work-item show` (`--expand`, `--fields`, `--as-of`), `az boards query --wiql`. | [docs: [az repos pr](https://learn.microsoft.com/en-us/cli/azure/repos/pr), [az boards work-item](https://learn.microsoft.com/en-us/cli/azure/boards/work-item)] |
| Gaps | No PR threads, PR iterations/changes, policy evaluations, work item updates/comments subcommands (→ `invoke`); `pr update` has no merge-strategy flag beyond `--squash`; no Server. | [docs] |
| Rate limits | Global per-identity limit **200 TSTUs per sliding 5 min**; delays up to 30 s, then HTTP 429; headers `Retry-After`, `X-RateLimit-Resource/Delay/Limit/Remaining/Reset/Cost` — and `Retry-After` may arrive **on a 200**. | [docs: [rate limits](https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rate-limits)] |
| PAT climate | Microsoft steers to Entra; orgs may restrict PAT creation; **global PATs stop working on 2026-12-01** (org-scoped PATs keep working); Entra-backed PATs go inactive after 90 days without sign-in. PAT = 84 chars with a fixed `AZDO` signature. | [docs: [PATs](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)] |

### REST endpoints used

Base: Services `https://dev.azure.com/{org}` (legacy host as discovered); Server the collection
URL. Always an explicit `api-version` (Services `7.1`; Server per § Compatibility floor). Paging:
`$top`/`$skip` on Git and policy lists, `continuationToken` on comments, none on WIQL (keyset
cursor below). Auth: `Authorization: Bearer <entra>` or `Basic base64(":" + PAT)` [docs: PATs].
Endpoint list is the facet table; each row cites its page.

### Recommendation: **both — `cli` (Entra broker) preferred on Services, `token` (PAT) otherwise**

1. **`cli` = `az` as a token broker, not as a command set.** One `az account get-access-token`
   per ~55 minutes (refreshed before `expiresOn`), then plain HTTPS through
   `integrations/shared/http-transport.ts`. Why: PAT-free (the direction Microsoft and
   PAT-restricting org policies push), honours Conditional Access/MFA through `az login`, needs
   only core `az` (no extension, no extension auto-install side effect), pays Python start-up
   once an hour instead of per request, and keeps response headers so the TSTU budget and
   `Retry-After` work. The token lives only in the integration's memory, is never logged,
   cached to disk or forwarded to agents — a narrow, explicit deviation from the umbrella's
   "cezar holds no credential" for `cli` (see report suggestion 1).
2. **`cli` fallback transport `az devops invoke`** — only when `get-access-token` fails but the
   user is signed in with `az devops login` (guest accounts, MSA-backed orgs) [assumption: how to
   detect cheaply — A0]. Slower, header-blind; the integration reports `degraded: 'invoke'` and
   automations poll at ≥ 2× the interval.
3. **`token` (PAT)** through the managed per-project store: the **only** path for Azure DevOps
   Server, for machines without `az`, and for users who will not install a ~hundreds-of-MB Python
   tool to read a backlog. Org-scoped PAT; fields in § Connection.
4. Not used: `az repos`/`az boards` subcommands (coverage gaps, per-call Python start-up, output
   shape tied to extension version), and `AZURE_DEVOPS_EXT_PAT` from `process.env` (a repository
   `.env` is never auto-loaded; token connections never fall back to env — umbrella).

## Integration shape — one provider, both roles

| Situation | Integrations created | Roles |
| --- | --- | --- |
| Repo with an Azure Repos remote | `azure-devops` (remote anchor `{org, project, repo}`), auto, not persisted | code host + work source (Boards of `project`) |
| Same, user wants Boards from another project | + stored scope-anchored `azure-devops-<project>` | work source |
| GitHub/GitLab repo, backlog in Azure Boards | stored scope-anchored `azure-devops-<project>` via picker | work source |
| Two ADO remotes (fork + upstream) | one per `(org, project, repo)`; the base remote's is the code host | per umbrella |

A remote-anchored integration's Boards scope defaults to the **whole project**; an optional
`areaPaths[]` / `team` narrowing lives in `integrations.json` (written only when the user picks
one). The manifest declares `anchor: ['remote','scope']`. Work-source visibility can be hidden per
project (umbrella), so a team that tracks work in Jira hides ADO Boards with one click.

## Mapping onto the umbrella facets

### Discovery (zero-network)

`discover()` classifies every remote with `parseAzureRemote()` (new, in
`integrations/azure-devops/remote.ts`; `parseRemote` keeps its GitHub semantics and gains the
umbrella's additive `path`):

1. host `dev.azure.com` / `ssh.dev.azure.com` (`v3/` prefix) / `*.visualstudio.com` /
   `vs-ssh.visualstudio.com` → Services; org from the path (or subdomain), `DefaultCollection`
   and a leading `{org}@` userinfo stripped;
2. any other host whose path contains a `_git` segment (HTTPS) or ends in
   `/{collection}/{project}/_git/{repo}` (SSH) → **Server candidate**. Path is split at `_git`;
   the segments before it are `[vdir…]/collection/project`. The collection base is ambiguous
   with a vdir (`/tfs/Coll` vs `/Coll`), so a Server remote becomes an active integration only
   once a `token` connection supplies the collection URL (strip-the-instance-base rule, as GitLab);
   until then Settings shows *"Looks like Azure DevOps Server — connect with a PAT"*;
3. signed-in state for `cli` is read **synchronously, TTL 30 s**, from `AZURE_CONFIG_DIR`
   (`azureProfile.json` `subscriptions[].user.name` / `tenantId` only — a zod **pick**; the MSAL
   token cache is never opened) [assumption: file name/shape, A0]. `az` presence = `PATH` lookup.
   No `az` process at boot, health or render.

Anchor: `{ kind:'remote', remote, host, path: '{org}/{project}/_git/{repo}', org, project, repo }`;
id `azure-devops` (`azure-devops-2` for a second repo). Web URLs come from the API's
`repository.webUrl` once fetched, never hand-built from an SSH remote.

### Transport (`integrations/azure-devops/transport.ts`)

```ts
interface AdoTransport {          // JSON + headers, or a typed failure; never throws
  request(method: 'GET'|'POST'|'PATCH', url: AdoUrl, body?: unknown, opts?: { apiVersion?: string; contentType?: string }): Promise<AdoResponse>;
}
```

- **HttpTransport** (both `cli`-broker and `token`): shared http-transport (deadline, size cap, no
  cross-origin redirect); `Authorization` from an `AuthSource` (`entraBroker` | `pat`); optional
  per-connection CA (`caFile` → undici `Agent`, as GitLab) for Server. Honours `Retry-After` on
  any status and tracks `X-RateLimit-Remaining` into the per-provider budget (umbrella).
- **EntraBroker**: `execFile('az', ['account','get-access-token','--resource',ADO_RESOURCE,'--output','json'])`
  via `integrations/shared/cli-exec.ts` (cwd = project root, 20 s timeout, stdin closed,
  `AZURE_CORE_NO_COLOR=1` [assumption]); zod-picks `accessToken`, `expiresOn`, `tenant`. Failure
  text maps to `reason`s: not logged in → *"Run `az login`"*; tenant mismatch → *"Signed in to a
  tenant that does not own {org}"* (401 from REST after a fresh token) [assumption].
- **InvokeTransport** (degraded): `az devops invoke --organization <base> --area … --resource …
  --route-parameters … --api-version 7.1 --http-method M [--in-file <tmp>] --output json`; the
  area/resource pair per endpoint comes from a static table checked in A0 (`az devops invoke
  --query "[?area=='git']"` lists them [docs]).
- `AdoUrl` builders are the only place a URL is assembled; every path segment is
  `encodeURIComponent`ed (project names with spaces); WIQL text is built only from validated ids,
  enum values and **single-quote-escaped** strings, never raw user input concatenated.

### Facet → endpoint table

`P` = `{base}/{project}`, `R` = `P/_apis/git/repositories/{repoId}`. Each row runs through either
transport (`invoke` form: area/resource from the A0 table).

| Facet / op | Request | JSON fields used | API docs |
| --- | --- | --- | --- |
| availability | `GET {base}/_apis/connectionData` | `authenticatedUser.id`, `.providerDisplayName`; `instanceId` | [docs-unverified: connectionData is undocumented-but-stable; A0 decides, else `GET {base}/_apis/projects?$top=1`] |
| repo | `GET P/_apis/git/repositories/{name}` | `id`, `name`, `defaultBranch`, `webUrl`, `remoteUrl`, `sshUrl`, `project.id`, `isFork`, `parentRepository` | [repositories](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/repositories/get-repository) [docs-unverified] |
| workItems.list | `POST P/_apis/wit/wiql?timePrecision=true&$top=51` with `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject]=@project [AND [System.AreaPath] UNDER '…'] [AND [System.State] IN (…)] [AND [System.ChangedDate] < '…'] ORDER BY [System.ChangedDate] DESC, [System.Id] DESC`; then `POST P/_apis/wit/workitemsbatch` (≤ 200 ids) | `workItems[].id`, `asOf`; batch `fields`: `System.Title`, `System.State`, `System.WorkItemType`, `System.Tags`, `System.AssignedTo`, `System.CreatedBy`, `System.CreatedDate`, `System.ChangedDate`, `System.AreaPath`, `System.IterationPath`, `System.CommentCount` | [WIQL](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql) [docs], [batch](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch) [docs] |
| workItems.search | same WIQL + `[System.Title] CONTAINS WORDS '…'` (or `[System.Id] = n` for `AB#n`/digits) | as above | WIQL syntax [docs-unverified: [WIQL reference](https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax)] |
| workItems.get | `GET P/_apis/wit/workitems/{id}?$expand=relations` | + `System.Description` (HTML), `Microsoft.VSTS.TCM.ReproSteps`, `Microsoft.VSTS.Common.AcceptanceCriteria`, `relations[]` (`ArtifactLink` → linked PRs), `_links.html.href` | [get work item](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-item) [docs-unverified] |
| workItems.thread | `GET P/_apis/wit/workItems/{id}/comments?$top=100&order=asc&api-version=7.1-preview.4` (+ `continuationToken`); `GET P/_apis/wit/workItems/{id}/updates?$top=200&$skip=N` | comments `id`, `text`, `format` (`markdown`/`html`), `createdBy.displayName`, `createdDate`, `isDeleted`; updates `rev`, `revisedBy`, `revisedDate`, `fields.{System.State,System.Tags,System.AssignedTo}.{oldValue,newValue}`, `relations.added[]` | [comments](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/get-comments) [docs], [updates](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/updates/list) [docs] |
| filter options | `GET P/_apis/wit/workitemtypes`, `GET P/_apis/wit/workitemtypes/{type}/states`, `GET P/_apis/wit/tags`, `GET P/_apis/wit/classificationnodes?$depth=3` | type `name`; state `name`, `category` (`Proposed`/`InProgress`/`Resolved`/`Completed`/`Removed`); tag `name`; area/iteration paths | [states](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-type-states/list), [tags](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/tags/list), [classification nodes](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/classification-nodes/get-classification-nodes) [docs-unverified] |
| changeRequests.list | `GET R/pullrequests?searchCriteria.status=active\|completed\|abandoned\|all&$top=50&$skip=N` | `pullRequestId`, `title`, `description` (**truncated to 400 chars** [docs] → `excerpt` only), `status`, `isDraft`, `createdBy`, `creationDate`, `closedDate`, `sourceRefName`, `targetRefName`, `mergeStatus`, `reviewers[].{displayName,vote,isRequired}`, `labels[].name`, `lastMergeSourceCommit.commitId` | [get pull requests](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests) [docs] |
| changeRequests.search | **id-only**: `!123`/digits → `GET R/pullrequests/{id}`; the API has no title search | as above | same [docs] |
| status by branch | `GET R/pullrequests?searchCriteria.sourceRefName=refs/heads/B&searchCriteria.status=all&$top=5` | newest `pullRequestId`, `status`, `isDraft` | same [docs] |
| changeRequests.thread | `GET R/pullRequests/{id}/threads` | `id`, `status`, `threadContext.filePath`/`rightFileStart.line`, `comments[].{content,commentType,author,publishedDate,isDeleted}`, `properties.CodeReviewThreadType` (`ReviewersUpdate`, `VoteUpdate`, `RefUpdate`, `MergeAttempt`, …) + their typed properties | [PR threads](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list) [docs] |
| changes (diff) | `GET R/pullRequests/{id}/iterations` → last `id`; `GET R/pullRequests/{id}/iterations/{it}/changes?$compareTo=0&$top=2000` | `changeEntries[].{item.path,originalPath,changeType}` | [iterations](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list), [iteration changes](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get) [docs-unverified] |
| checks | `GET P/_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}&api-version=7.1-preview.1`; `GET R/pullRequests/{id}/statuses` | `status` (`queued`/`running`/`approved`/`rejected`/`notApplicable`/`broken`), `configuration.{isBlocking,isEnabled,type.displayName,settings.displayName}`, `context.buildId`; statuses `state`, `context.{genre,name}`, `targetUrl` | [policy evaluations](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations/list) [docs], [PR statuses](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-statuses/list) [docs-unverified] |
| merge.state | PR detail + evaluations + `GET P/_apis/policy/configurations?repositoryId=…&refName=…` (merge-strategy policy) | `mergeStatus`, `isDraft`, `autoCompleteSetBy.id`, `reviewers[]`, merge-strategy settings `allowSquash`/`allowNoFastForward`/`allowRebase`/`allowRebaseMerge` | [PR update](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update) [docs]; [configurations](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/configurations/list) [docs-unverified] |
| merge.merge | `PATCH R/pullrequests/{id}` `{ status:'completed', lastMergeSourceCommit:{commitId}, completionOptions:{ mergeStrategy, deleteSourceBranch, transitionWorkItems:false, mergeCommitMessage } }` | `status`, `mergeStatus`, `lastMergeCommit.commitId`, `closedDate` | PR update [docs] |
| merge.autoMerge on/off | same PATCH with `autoCompleteSetBy:{id:<me>}` + `completionOptions` / `autoCompleteSetBy:{id:'00000000-0000-0000-0000-000000000000'}` | `autoCompleteSetBy` | PR update [docs]; clearing via the zero GUID [assumption] |
| publish | `POST {base}/{project}/_apis/git/repositories/{repoId}/pullrequests` `{ sourceRefName, targetRefName, title, description, isDraft:true, workItemRefs?:[{id}] }` | `pullRequestId`, `repository.webUrl` | [create PR](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create) [docs-unverified] |
| publish → ready | `PATCH R/pullrequests/{id}` `{ isDraft:false }` | `isDraft` | `az repos pr update --draft false` "Publish the PR" [docs]; REST field acceptance [assumption, A0] |
| link (opt-in) | `POST P/_apis/wit/workItems/{id}/comments?api-version=7.1-preview.4` `{text}`; or `PATCH …/workitems/{id}` JSON-Patch `add /relations/-` `ArtifactLink` `vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{prId}` | `id` | [add comment](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/add-comment) [docs-unverified]; artifact id template [docs: PR `artifactId`] |
| clone | `git clone <remoteUrl>` | — | — |

**Normalization** (each a fixture test):
- `WorkItem.id` = numeric id as string; `key` = `AB#123` for work items, `!45` for PRs (ADO's own
  PR mention syntax); `stateLabel` = the process state name (`Active`, `Resolved`); `state` from
  the **state category**: `Completed`/`Removed` → `closed`, else `open`. PR: `active`+`isDraft` →
  `draft`, `active` → `open`, `completed` → `merged`, `abandoned` → `closed`.
- `labels` = `System.Tags` split on `;`, trimmed (no colour); PR `labels[].name`. Work item type
  rides as `excerpt` prefix and a filter chip, not a label.
- `author`/`assignees` = `displayName` (ADO identities have no login handle; `uniqueName` is often
  an email and is **not** surfaced [privacy]).
- Body: `System.Description` / `ReproSteps` / `AcceptanceCriteria` are HTML → Markdown through
  `integrations/shared/markdown.ts` with `bodyLoss` for tables, inline images (`_apis/wit/attachments`
  links stay links; no fetch), mentions. If the field is already Markdown (newer Services) pass
  through [assumption: detect via `multilineFieldsFormat` in the response, A0].
- Thread: comments (format-aware) + timeline events derived **only** from `updates`
  (`System.State` → `status_changed`, `System.Tags` diff → `labeled`/`unlabeled`, `AssignedTo` →
  `assigned`, `relations.added` ArtifactLink → `linked_change_request`). PR threads: `text`
  comments → comments (diff comments keep `filePath:line`); system threads map by
  `CodeReviewThreadType` (`VoteUpdate` → `review_submitted`, `ReviewersUpdate` →
  `review_requested`/`review_request_removed`, `RefUpdate` → `pushed`, `StatusUpdate` → state);
  the localized system `content` prose is never parsed.
- Diff: the REST API returns a **file list** with `changeType`, not patches [assumption: no
  unified-diff endpoint]. `changes` returns that list; line counts and patches come from local
  `git diff <lastMergeTargetCommit>...<lastMergeSourceCommit>` when both commits are present in
  the project's object store (after the usual fetch), else `truncated:true` with the file list —
  never a fabricated `0/0`.
- Checks glyph: over **enabled** evaluations — any `rejected`/`broken` with `isBlocking` → failing;
  any `queued`/`running` → pending; all `approved`/`notApplicable` → passing; none → `null`.
  PR statuses (`failed`/`error` → failing, `pending` → pending) fold in. The list view has no
  batched endpoint, so glyphs are fetched for at most the first 10 visible active PRs per page
  and cached 60 s; the rest show `null` until opened [budget].

### Merge facet

| cezar field | Azure Repos source |
| --- | --- |
| `mergeable` | `mergeStatus`: `succeeded` → mergeable; `conflicts` → conflicting; `queued`/`notSet` → unknown; `rejectedByPolicy`/`failure` → blocked (`mergeFailureMessage` as detail) |
| `reviewDecision` | any reviewer `vote` −10 (rejected) or −5 (waiting for author) → `changes-requested`; a required-reviewers / minimum-reviewers evaluation not `approved` → `review-required`; else `approved` (votes 10/5) |
| `methods`/`defaultMethod` | merge-strategy policy on the target ref: `allowNoFastForward` → `merge`, `allowSquash` → `squash`, `allowRebase`/`allowRebaseMerge` → `rebase` (+ raw `rebaseMerge` kept for the body); no policy → all four allowed, default `merge` (`noFastForward`) [docs: strategy enum] |
| `eligibility`/`blockers` | `isDraft` → blocker `draft`; each enabled, blocking evaluation not `approved`/`notApplicable` → one blocker, code = `configuration.type.displayName` (`Minimum number of reviewers`, `Build`, `Work item linking`, `Comment requirements`, `Required reviewers`), `running`/`queued` → pending |
| `canMerge` | not knowable without a permission probe → `true` and let the PATCH answer (403 → reason) [assumption] |
| `canOverride` | always `false`: cezar never sends `bypassPolicy` |
| `autoMerge` | `{ available: status === 'active' && !isDraft, enabled: !!autoCompleteSetBy }` |

**Completion is asynchronous** [assumption from `completionQueueTime`/`mergeStatus` semantics]:
after the PATCH, cezar re-reads the PR up to 5× over ~10 s; `completed` → `{ merged:true }`;
still active with `completionQueueTime` set → the umbrella's non-merged 200 branch with
`autoMergeEnabled:false, queued:true` — **an umbrella contract addition** (report suggestion 2).
Always send `lastMergeSourceCommit` so a moved head is refused (409 *"the branch moved"*).
403 → *"Your identity cannot complete PRs into {target}"*; 400 policy errors → 409 with blockers.

### Publish facet

Prelude as GitHub/GitLab (`preparePublish`). Then one POST; the run stores
`repository.webUrl + '/pullrequest/' + id` after validating its origin equals the integration's
web origin. `description` is capped at **4000 characters** [docs: PR update] — the composer
truncates the body *before* the cross-provider footer so the footer always survives. When the run
has ADO work-item refs in the **same organization**, `workItemRefs` carries them (native
Development link) instead of relying on text. Fork PRs (`forkSource`) are deferred
(open question 4) — the push remote must be the base repo or the facet answers *"publishing from
a fork is not supported yet"*.

### Clone facet

`parseRepoRef` accepts `https://dev.azure.com/{org}/{project}/_git/{repo}`, the legacy host, and
Server URLs for hosts with a token connection. Plain `git clone` with `GIT_TERMINAL_PROMPT=0`; the
user's Git Credential Manager supplies credentials [docs-unverified: [GCM](https://learn.microsoft.com/en-us/azure/devops/repos/git/set-up-credential-managers)].
cezar **never** writes a PAT or bearer into the URL, `.git/config`, argv or `http.extraHeader`.
An auth failure maps to *"Git could not authenticate to {host} — set up Git Credential Manager"*.

### Agent access and redaction

Manifest env names (forwarded only on per-run opt-in): `AZURE_DEVOPS_EXT_PAT`, `AZURE_CONFIG_DIR`.
Redaction patterns: new-format PAT (84 chars, `AZDO` signature [docs]) and legacy 52-char
base32 PATs [assumption], plus `Bearer eyJ…` JWTs (Entra) — exact offsets pinned in A0 from a
real token shape; `secret-redaction.test.ts` covers both.

## Connection and auth

| Strategy | Ready when | Settings flow |
| --- | --- | --- |
| `cli` (Services only) | `az` on PATH and a profile in `AZURE_CONFIG_DIR`; first REST call with a brokered token succeeds | **Install Azure CLI** (manifest hints: `brew install azure-cli`, `winget install -e --id Microsoft.AzureCLI` [docs-unverified id], apt script) shown with the install-size note → **Sign in** opens `az login` in the user's terminal (`open-in-terminal.ts`) |
| `token` | managed record exists and `connectionData` succeeds | write-only form: **Organization / collection URL** (`https://dev.azure.com/acme`, `https://acme.visualstudio.com`, `https://tfs.acme.local/tfs/DefaultCollection`), **Personal access token** (secret; scopes `Work Items (Read)`, `Code (Read)`; `Code (Read & write)` for publish/merge; `Work Items (Read & write)` for `link`), **CA file** (optional, Server) |

Both cards are visible side by side for Services; Server shows only `token`. Copy notes the
2026-12-01 global-PAT retirement: *"use an organization-scoped token"*. A PAT that later 401s →
*"Azure DevOps rejected the token for {org} — it may have expired or been revoked"*.

## Contract additions (ADO-specific, on top of the umbrella)

All in `packages/contract/src/integrations.ts`; no frozen `/github*` or `/tracker*` shape changes.

- `integrationProviderIdSchema` already contains `azure-devops`.
- `azureDevopsTokenFieldsSchema = { instanceUrl: httpsUrl (http allowed only for a non-public Server host? → open question 3), token: string.min(20).max(200), caFile?: absolute path }`.
- `azureDevopsScopeSchema = { org, project, projectId: uuid, areaPaths?: string[].max(20), team?: string, workItemTypes?: string[].max(30) }` — the scope anchor payload and the `integrations.json` narrowing.
- Neutral merge-state already gains `autoMerge?` (umbrella); ADO adds nothing else. Merge body
  method enum gains no value: `rebaseMerge` is sent when `rebase` is chosen and the policy allows
  only `rebaseMerge` [assumption].
- Neutral merge response: `queued?: true` on the non-merged branch (suggestion 2).
- `integrationAvailabilitySchema` gains optional `degraded?: 'invoke'` (suggestion 3).
- `backendCheckSchema.name` gains `az`; `forgeInfoSchema.kind` gains `azure-devops` (umbrella-owned).

## UI specifics

- Switcher: `Azure DevOps · acme/Web/shop` (remote) and `Azure Boards · acme/Web` (scope-only);
  Server shows the host (`Azure DevOps · tfs.acme.local · Coll/Web/shop`).
- Vocabulary: work item key `AB#123` shown as `Bug 123` in rows (type + id, ADO convention);
  change request "pull request", key `!45`.
- Work-item filters from the manifest: **state category** chips (Proposed / In progress /
  Resolved / Completed), type multi-select, area path picker (from classification nodes), an
  `@CurrentIteration` toggle when a `team` is set, tag chips. PR filters: Active / Completed /
  Abandoned / Drafts; PR search box accepts only `!123` and says so.
- PR rows: Draft badge, policy glyph, required-reviewer votes (`2/3 ✓`), auto-complete badge.
- Merge panel: strategy picker limited by policy; **"Set auto-complete"** / **"Cancel
  auto-complete"**; never a "bypass policies" control.
- Links: work item `{web}/{project}/_workitems/edit/{id}`; PR `{repo.webUrl}/pullrequest/{id}`.

## Automations

Event source `integrations/azure-devops/events.ts` over the shared poll cycle (cursor, receipts,
leases, baselining unchanged). Default interval 1800 s (tracker default; #1085 Q6). Every event is
**verified from vendor history**:

| Neutral event | Candidate query | Verification |
| --- | --- | --- |
| `work_item.created` | WIQL `[System.CreatedDate] > '<cursor>'` (+ scope, `timePrecision=true`) | `fields.System.CreatedDate` > cursor |
| `work_item.status_changed` | WIQL `[System.ChangedDate] > '<cursor − lookback>'` | `updates[]` row with `fields.System.State.{oldValue,newValue}` and `revisedDate` > cursor; filter `targetStatusIds` = state **names** or `category:<Category>` |
| `work_item.labeled` / `.unlabeled` | same WIQL | `updates[]` row where the `System.Tags` set diff (old vs new, case-insensitive [assumption]) adds/removes a `changedLabelIds` tag; `revisedDate` > cursor |
| `change_request.opened` | `R/pullrequests?searchCriteria.status=all&searchCriteria.queryTimeRangeType=created&searchCriteria.minTime=<cursor>` | `creationDate` > cursor |
| `change_request.merged` / `.closed` | same, `queryTimeRangeType=closed`, status `completed` / `abandoned` | `closedDate` > cursor, `status` |
| `change_request.review_requested` | active PRs (`$top=50`) whose `reviewers[]` id set differs from the stored snapshot | a `ReviewersUpdate` thread with `CodeReviewReviewersUpdatedAddedTfId`/`AddedDisplayName` and `publishedDate` > cursor; reviewer filter matches display name or id |
| `change_request.review_submitted` | active PRs whose `reviewers[].vote` changed vs snapshot | a `VoteUpdate` thread (`CodeReviewVoteResult`, `CodeReviewVotedByDisplayName`) after cursor |

The reviewer snapshot is only a **candidate trigger** (it saves a threads call per PR per poll);
the event fires solely on the matching system thread, so a missed snapshot cannot invent one.
Reviewers present at creation have no `ReviewersUpdate` thread [assumption] — they are covered by
`change_request.opened`, and the editor says so. Template tokens: `item.*` plus `item.type`,
`item.areaPath`, `item.iterationPath`, `item.state`, `item.org`, `item.project`; no `github.*`
aliases. Budget per poll per integration: ≤ 2 WIQL + ≤ 1 batch + ≤ 25 `updates` + ≤ 3 PR lists +
≤ 10 threads — far below 200 TSTU/5 min for a typical user [assumption: per-call cost, A0 reads
`X-RateLimit-Cost`]; the cycle backs off on `Retry-After` or `X-RateLimit-Remaining` < 20 %.

### Answers to #1085

1. **Scope:** work items **and** Azure Repos PRs — the umbrella seam removes the reason to split.
2. **Hosting:** Services (both hosts) and Server ≥ 2022; Server through PAT only.
3. **Auth:** Entra via `az login` (brokered) preferred, org-scoped PAT supported; no OAuth app.
4. **Association scope:** the **project**, optionally narrowed by area paths / team.
5. **Status / tag ids:** states match by **name** across all work item types, or by **state
   category** (`category:Resolved`) to be process-agnostic; tags match by name.
6. **Polling:** yes, ~30 min default; service hooks stay out of scope.

## Run bookkeeping reference patterns

- URLs (host set = `dev.azure.com`, `*.visualstudio.com`, token-connected Server bases):
  `https?://<base>/(?<project>[^/\s]+)/_git/(?<repo>[^/\s]+)/pullrequest/(?<n>\d+)` and
  `https?://<base>/(?<project>[^/\s]+)/_workitems/edit/(?<n>\d+)`; percent-decoded project names.
- Keys: `AB#\d+` (work item, anywhere); `!\d+` (PR) and bare `#\d+` (= **ADO work item**, ADO's
  own mention syntax) only when this integration is the code host.
- Worded: `work item 123`, `PR 45`, `pull request !45`; hand-off headings `Fix Azure Boards
  work item AB#123` / `Address Azure DevOps pull request !45` — `lib/work-item-task.ts` and
  `task-refs.ts` change in one commit.
- `RunRecord.workItemRefs`: `{ providerId:'azure-devops', itemId:'123', key:'AB#123', kind:'issue', url }`.

## Cross-provider linking

As a **work source**, the footer depends on the code host:
- ADO code host, same org → `workItemRefs` on the PR plus `#123` in the description; no automatic
  state transition (`transitionWorkItems:false`) unless the user opts in.
- GitHub code host → `AB#123` in the PR **description** (a title or comment does not link
  [docs]); requires the Azure Boards GitHub app on that repo [docs: [link from GitHub](https://learn.microsoft.com/en-us/azure/devops/boards/github/link-to-from-github)].
  Default is link-only; `Fixes AB#123` (transition to the Resolved category on merge into the
  default branch [docs]) only with the per-integration opt-in.
- GitLab / other → a plain work item URL line.
As a **code host**, the PR description carries the other source's footer (`PROJ-42`, `Fixes
TEAM-12`, `#12`) verbatim. `link` facet (opt-in): comment or ArtifactLink on the work item.

## Dry-run fixtures

`integrations/azure-devops/fixtures/` — **raw REST JSON** shared by dry-run and tests:
`connection-data.json`, `repository.json` (project name with a space), `wiql.page1/2.json`,
`workitems-batch.json` (Bug with ReproSteps, User Story with tags), `workitem-detail.html-body.json`,
`comments.json` (markdown + html), `updates.json` (state + tags + relation), `types.json`,
`states.bug.json`, `tags.json`, `classification-nodes.json`, `pullrequests.{active,completed,draft}.json`,
`pr-threads.json` (text, diff comment, ReviewersUpdate, VoteUpdate, MergeAttempt),
`pr-iterations.json`, `pr-iteration-changes.json`, `policy-evaluations.{passing,build-running,min-reviewers}.json`,
`policy-configurations.merge-strategy.json`, `pr-create.json`, `pr-complete.{queued,completed,conflict}.json`,
`az-get-access-token.json` (fake token), `azureProfile.json` (fake, with a token-shaped decoy that
must never surface). `CEZ_DRY_RUN=1` uses a fixture transport; draft PR returns
`…/_git/shop/pullrequest/777`.

## Implementation phases (umbrella phase 3)

Prereq: umbrella phase 1 merged (seam, registry, shared `cli-exec`, `http-transport`, `markdown`).

- **A0 — verification spike (no product code):** a free Services org + an Azure DevOps Server
  trial VM; re-check every **[docs-unverified]** row; measure `az` install size and start-up;
  confirm `AZURE_CONFIG_DIR` profile shape, `isDraft` PATCH, async completion timing, auto-complete
  clear, reviewer-at-creation threads, `multilineFieldsFormat`, `invoke` area/resource names, PAT
  regex offsets, Server api-version range; capture real fixtures.
- **A1 — discovery + Boards read:** `integrations/azure-devops/{index.ts,manifest.ts,remote.ts,discover.ts,transport.ts,auth.ts,schemas.ts,normalize.ts,wiql.ts}`;
  `git-remotes.ts` additive `path`; registry line; scope picker (`GET {base}/_apis/projects`,
  paginated `continuationToken` [docs-unverified]); workItems list/search/get/thread + filter options.
- **A2 — Repos read:** PRs list/get/thread, status by branch, iteration changes + local-git diff,
  policy checks.
- **A3 — code host:** `publish.ts`, `merge.ts` (async completion, auto-complete),
  `server/checkout.ts` clone, `workflows/run.ts` PR nodes through the code-host facets.
- **A4 — host tooling:** `core/backend-detect.ts` `az` probe from the manifest,
  `server-install/steps.ts` (brew/winget/apt), `core/agent-env.ts`, `core/secret-redaction.ts`,
  `runs/store.ts` + `runs/task-refs.ts` patterns, bookmarklet URL shapes.
- **A5 — automations:** `events.ts`, event options (states with categories, tags), editor copy for
  the reviewer-at-creation limitation.
- **A6 — Server + fallbacks:** collection-URL token flow, CA file, api-version negotiation,
  `InvokeTransport`, `link` facet.

Each phase ships alone; without `az` and without a PAT an ADO repo stays plain-git with a
*"Connect Azure DevOps"* hint.

## Tests

- `integrations/conformance.test.ts` (umbrella) for `azure-devops` with HttpTransport (bearer and
  basic auth sources) and InvokeTransport fixtures.
- `azure-devops/remote.test.ts`: every remote shape in § Products (userinfo, `DefaultCollection`,
  `v3/` SSH, vs-ssh, `/tfs/Coll`, no-vdir Server, `%20` names, project-named repo); `github.com`
  and GitLab `/-/` URLs rejected; Server without a token → candidate only.
- `azure-devops/discover.test.ts`: no network, no `az` spawn, profile read is a pick (decoy token
  never escapes), 30 s TTL.
- `azure-devops/auth.test.ts`: token refreshed before `expiresOn`; concurrent callers share one
  broker spawn; broker failures → readable reasons; the token appears in no log, error, cache file
  or API response.
- `azure-devops/wiql.test.ts`: quote escaping (`O'Brien`), area `UNDER`, keyset cursor stable
  across equal `ChangedDate`, `timePrecision` always set.
- `azure-devops/normalize.test.ts`: state categories, PR status/draft, tag split, HTML body loss,
  thread-type mapping, glyph table, 400-char list description → excerpt only.
- `azure-devops/merge.test.ts`: strategy policy → methods; queued completion → `queued:true`;
  moved head → 409; `bypassPolicy` never sent.
- `azure-devops/publish.test.ts`: 4000-char cap keeps the footer; `workItemRefs` only for the same
  org; URL origin validation.
- `azure-devops/events.test.ts`: tag add without other change fires once; state change verified by
  `updates`; reviewer snapshot change without a `ReviewersUpdate` thread does **not** fire;
  baseline never replays history; `Retry-After` on a 200 delays the next call.
- `runs/task-refs.test.ts`: `AB#123`, PR/work-item URLs on all three host shapes; bare `#N` only
  when ADO is the code host.
- E2E (`packages/web/e2e/issues.e2e.ts`): ADO dry-run project — switcher, work items, PR list,
  merge panel with auto-complete.
- Regression-proof rule (AGENTS.md): the `parseRemote` `_git` misparse test is shown red first.

## Compatibility floor and backward compatibility

- Services (`dev.azure.com`, `*.visualstudio.com`), api-version `7.1` (`-preview.N` where the page
  says so). Server: **Azure DevOps Server 2022 and later** (REST 7.0+; the docs list
  `azure-devops-server-rest-7.0/7.1` [docs]); cezar asks `7.1`, falls back once to `7.0` on a
  version-out-of-range 400 and caches the answer per collection [assumption: error shape].
  Older Server → availability `reason` names the version.
- No frozen route changes; `/api/v1/github*` never serves ADO data; `/api/v1/tracker*` serves an
  ADO scope integration only if the umbrella's "first scope-anchored integration" adapter rule
  picks it (its shapes already fit; `trackerKindSchema` is **not** widened — the adapter maps).
- Automations `github`/`tracker` kinds untouched; ADO automations use the umbrella's
  `integration` kind only.
- `.ai/cezar/integrations.json` holds optional scope narrowing; nothing is required.
- `parseRemote` output for non-ADO remotes is byte-identical (additive `path` only).

## Acceptance criteria

1. A repo cloned from `dev.azure.com` with `az login` done and no cezar settings shows **Azure
   DevOps** in the switcher with work items (state categories, tags, area filter) and PRs
   (policy glyphs, threads, diff file list).
2. The same project works with only an org-scoped PAT and no `az` installed.
3. An Azure DevOps Server 2022 collection under `/tfs/` with a private CA works with a PAT.
4. The review gate creates a **draft PR**, links same-org work items natively, and the run records
   `!N` and its URL; "Ready" publishes it.
5. Merge completes with each policy-allowed strategy; auto-complete sets and clears; a moved head
   is refused; queued completion is reported as queued, not as failure or success.
6. A GitHub repo + scope-anchored Azure Boards: a task launched from `AB#123` opens a GitHub PR
   whose description contains `AB#123`.
7. Automations fire once each for work-item created / state changed / tag added and PR opened /
   reviewer added / vote cast, never on baseline history.
8. No Entra token or PAT appears in logs, transcripts, cache files or API responses (test-enforced).
9. `CEZ_DRY_RUN=1` exercises every facet offline.

## Open questions

1. **Brokered tokens under `cli`:** accept that cezar holds a ≤ 1 h Entra token in memory (proposed),
   or require `az devops invoke` for every call to keep the "holds nothing" property at the cost of
   per-call Python start-up and no rate-limit headers?
2. **PR search:** ADO has no title search for PRs. Ship id-only search with honest copy
   (proposed), or a bounded client-side scan of the newest N active PRs labelled "recent only"?
3. **`http://` Server URLs:** many on-prem collections run plain HTTP on an intranet. Allow `http`
   for private-address hosts with a warning, or require https?
4. **Fork PRs** (`forkSource`): needed in the first code-host cut?
5. **Default footer for GitHub-hosted code:** link-only `AB#123` (proposed) or `Fixes AB#123`?
</content>
</invoke>
