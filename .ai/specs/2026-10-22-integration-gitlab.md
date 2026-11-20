# Integration provider: GitLab (GitLab.com, Dedicated, self-managed)

> Slug: `integration-gitlab` · Issue: #1616 · Updated: 2026-10-22.
> Status: draft for review. Provider spec under the umbrella
> [integration-providers](2026-10-22-integration-providers.md) — binding for the seam, contract,
> routes, persistence and phasing; this file only says how GitLab fills it.
> Supersedes the GitLab half of #847 (its seam half is the umbrella). Related: #698, #1383.
> Every vendor claim cites a doc. **[V]** = verified against the vendor's docs source on
> 2026-10-22; **[A]** = assumption to confirm during implementation.

## TLDR

`gitlab` is a **remote-anchored code host** provider: issues, merge requests (MRs), notes,
label/state resource events for the timeline, pipelines → checks glyphs, MR diffs, merge
(including auto-merge "when checks pass" and approval state), draft-MR publish from a run branch,
clone, and automation events. It works on GitLab.com, GitLab Dedicated and self-managed
instances, including **subgroups** (`group/sub/sub2/repo`), **non-root instance paths**
(`https://intra.acme/gitlab/…`) and **private CAs**.

Connection preference: **`cli` (glab) first, `token` (PAT via the managed credential store)
second.** Both run the **same REST v4 requests through one client** with two transports —
`glab api` for `cli`, `fetch`/`node:https` with `PRIVATE-TOKEN` for `token` — so there is one
zod schema set, one normalizer and one fixture set. `glab` porcelain is used only where it adds
something the API cannot: `glab auth status` (readiness), `glab auth login` (terminal handoff) and
`glab repo clone`.

## Problem

- A GitLab remote today resolves to `forge: null` (`forge/index.ts` `forgeKindOfHost`): no Issues
  tab, no Create PR, no merge, no PR chip, no automations. #847 is the oldest open forge request.
- `parseRemote` (`git-remotes.ts`) keeps only the **last two path segments** — a subgroup remote
  `gitlab.com/acme/platform/api` becomes `platform/api`, the wrong project.
- Run bookkeeping (`runs/store.ts` `PR_URL_RE`/`ISSUE_URL_RE`, `runs/task-refs.ts`) only knows
  `/<owner>/<repo>/pull/N`; GitLab's `/-/merge_requests/N` matches nothing, so a GitLab run loses
  its chip and `#N` prefix silently.
- Self-managed is the common GitLab deployment, and its realities (any hostname, sub-path installs,
  self-signed CAs, custom PAT prefixes, admin-tuned rate limits) must be designed in, not patched.

## Non-goals

- Epics, boards, iterations, milestones as first-class lists; CI job control (retry/cancel/play);
  merge trains as a UI; approval-rule editing; GitLab Duo. (Merge-train routing still happens
  server-side when the project enables it — § Merge.)
- `skip_tls_verify` in token mode (never). Users who need it can set it inside `glab`, their call.
- Webhooks. Polling only (umbrella).
- GitLab < 16.0 — `glab` itself only supports 16.0+ ([glab README §Requirements][glab-readme]) **[V]**;
  the token transport may work on older servers but is not tested there.

## Vendor research

### `glab` — the official GitLab CLI

| Property | Finding | Source |
| --- | --- | --- |
| Status | Official GitLab project since 2022 (adopted from `profclems/glab`), `gitlab.com/gitlab-org/cli`. Weekly releases: v1.122.0 (2026-10-09), v1.123.0 (10-13), **v1.124.0 (2026-10-20)**. **[V]** | [README][glab-readme], [releases API][glab-releases] |
| Server support | GitLab 16.0+ officially. **[V]** | [README][glab-readme] |
| Install | macOS/Linux: `brew install glab` (the only *officially supported* manager). Windows: `winget install glab.glab`, `choco install glab`, `scoop install glab`. Linux: `sudo snap install glab` (+ `snap connect glab:password-manager-service` for keyring), WakeMeOps apt repo, nixpkgs, Arch, Alpine, `mise`, `asdf`; release binaries/build from source. **[V]** | [installation options][glab-install] |
| Credential store | OS keyring by default (macOS Keychain, Windows Credential Manager, Secret Service); plaintext `config.yml` when no keyring, `--insecure-storage`, or CI. `GITLAB_TOKEN` / `GITLAB_ACCESS_TOKEN` / `OAUTH_TOKEN` override stored credentials. **[V]** | [`glab auth login`][glab-login], [authentication][glab-auth] |
| Config location | `$GLAB_CONFIG_DIR/config.yml` → `~/.config/glab-cli/config.yml` (legacy, checked first on every OS) → `$XDG_CONFIG_HOME/glab-cli/config.yml` (macOS `~/Library/Application Support/glab-cli/`, Windows `%LOCALAPPDATA%\glab-cli\`) → `/etc/xdg/glab-cli/config.yml`; per-repo `.git/glab-cli/config.yml`. **[V]** | [configuration][glab-config] |
| Host selection | Inside a repo: the GitLab remote's host; else `GITLAB_HOST`/`GITLAB_URI`/`GL_HOST`; else config `host`; else `gitlab.com`. An env host "always wins, and glab errors if no remote matches it". **[V]** | [`glab config`][glab-config-cmd] |
| Self-managed knobs (per host) | `api_host`, `api_protocol`, **`subfolder`** (non-root installs, nested allowed, HTTP only), **`ca_cert`**, `client_cert`/`client_key` (mTLS), `skip_tls_verify`, `ssh_host`, `proxy`, `custom_headers`. Env twins: `GITLAB_SUBFOLDER`, `GLAB_CA_CERT`, `GITLAB_API_HOST`… **[V]** | [`glab config`][glab-config-cmd] |
| Prompts / noise | `GLAB_NO_PROMPT=1`, `GLAB_CHECK_UPDATE=false`, `GLAB_DISPLAY_HYPERLINKS=false`, `GLAB_SEND_TELEMETRY=0` (glab sends usage data **to the user's own instance** when on). **[V]** | [`glab config`][glab-config-cmd] |
| Raw API | `glab api <endpoint\|graphql>`: placeholders `:fullpath :id :branch :group :namespace :repo :user :username` from the cwd repo; `--hostname`; `-X`; `-f/-F` fields; `--input`; `-i` headers; `--paginate` (REST and GraphQL with `$endCursor` + `pageInfo`); `--output json\|ndjson`. **[V]** | [`glab api`][glab-api] |
| JSON porcelain | `glab mr list/view`, `glab issue view`, `glab auth status`: `-F/--output json`. **`glab issue list` differs: `-O/--output json`, while its `-F` is `--output-format details\|ids\|urls`.** `glab mr create` has **no** JSON output. **[V]** | [mr list][glab-mr-list], [issue list][glab-issue-list], [mr create][glab-mr-create] |
| Merge trap | `glab mr merge` **defaults `--auto-merge=true`** while a pipeline runs; `--sha` guards the head. **[V]** | [`glab mr merge`][glab-mr-merge] |
| Readiness | `glab auth status [--hostname H] [--all] --output json`; it *verifies* (network). **[V]** (JSON field names **[A]**) | [`glab auth status`][glab-auth-status] |

### GitLab REST v4 facts the design leans on

- `:id` accepts the numeric id **or the URL-encoded full path** (`acme%2Fplatform%2Fapi`) — this is
  what makes subgroups free. **[V]** ([REST namespaced paths][rest-index])
- Offset pagination, `per_page` max **100**, `x-next-page`/`x-total` headers; keyset on selected
  endpoints. **[V]** ([REST pagination][rest-index])
- Auth header `PRIVATE-TOKEN: <token>`. **[V]** ([REST authentication][rest-auth])
- MRs: `detailed_merge_status` (supersedes deprecated `merge_status`), `draft`, `user_notes_count`,
  `head_pipeline`, `diff_refs.{base,start,head}_sha`. **[V]** ([MR API][mr-api])
- `GET …/merge_requests/:iid/changes` is **deprecated (v5 removal)**; use `GET …/diffs`
  (`collapsed`, `too_large` since 18.4). **[V]** ([MR API][mr-api])
- Merge: `PUT …/merge` with `sha`, `squash`, `auto_merge`, `should_remove_source_branch`;
  `merge_when_pipeline_succeeds` **deprecated in 17.11** for `auto_merge`. Errors: 400 *SHA must
  be provided* (group/instance setting since 19.2), 401, 405 *cannot merge*, 409 *SHA does not
  match*. Auto-merge routes to the merge train where enabled (19.1). **[V]** ([MR API § Merge][mr-api])
- Merge method is a **project** setting (`merge_method`: `merge | rebase_merge | ff`;
  `squash_option`: `never | always | default_on | default_off`), not a per-merge choice. **[V]**
  ([projects API][projects-api])
- Approvals: `GET …/approvals` (`approved`, `approvals_left`, `approved_by`; CE returns only
  `approved`, `approved_by`, `user_can_approve`, `user_has_approved`); `GET …/approval_state`
  (Premium rules). **[V]** ([MR approvals API][approvals-api])
- Timeline sources: `resource_label_events` (issues, MRs), `resource_state_events` (issues, MRs);
  notes carry `system: true` for system notes. No structured assignee/rename events in REST **[A]**.
  ([label events][label-events], [state events][state-events], [notes][notes-api])
- Reviewers: `GET …/merge_requests/:iid/reviewers` → `{ user, state, created_at }`, states include
  `unreviewed`, `reviewed`; `requested_changes` appears as a `detailed_merge_status`. Full state
  list **[A]**. ([MR API § reviewers][mr-api])
- Pipeline statuses: `created waiting_for_resource preparing waiting_for_callback pending running
  success failed canceling canceled skipped manual scheduled`. **[V]** ([pipelines API][pipelines-api])
- Rate limits: GitLab.com per-plan, per-user/top-level-group burst + sustained limits;
  unauthenticated 60/min; self-managed admin-configurable. 429 + `Retry-After` **[V]**/`RateLimit-*`
  headers **[A]**. ([GitLab.com rate limits][com-rate-limits], [REST rate limits][rest-index])
- Token prefixes: `glpat-` (personal, project, group, impersonation), `gldt-`, `glrt-`, `glcbt-`,
  `glptt-`, `glft-`, `glimt-`, `glagent-`, `glwt-`, `glsoat-`, `glffct-`, `gloas-`. **The PAT
  prefix is configurable on self-managed.** **[V]** ([token prefixes][tokens])
- Default closing pattern (`Closes #4`, `Fixes`, `Resolves`, `Implements`), cross-project
  `Closes group/project#4`. **[V]** ([managing issues][closing])

### Recommendation: `cli` then `token`, one REST client underneath

`glab` is official, weekly-released, on every package manager, keeps the secret in the OS keyring
and already solves the hardest self-managed problems (subfolder, CA, mTLS, proxy, API host
override) in a per-host config the user owns. That preserves the "cezar never holds a credential"
posture #847 asked for, and makes on-prem zero-config for anyone who already uses `glab`.

But the porcelain is uneven (flag spelling differs between `issue list` and `mr list`; `mr create`
prints text; `mr merge` auto-merges by default), and its JSON is the REST object anyway **[A]**.
So cezar calls **`glab api` for every vendor read and write**, and porcelain only for readiness,
login and clone. The `token` transport then sends the *identical* requests to
`<baseUrl>/api/v4/…` — no second integration, only a second transport. `token` exists for:
machines that can't install `glab`, CI-like hosts, users who prefer a scoped project/group access
token, and headless/remote cockpits.

## Mapping onto the umbrella seam

### Manifest

```ts
// packages/cezar/src/integrations/gitlab/manifest.ts (data, served at GET /integrations/providers)
{ id: 'gitlab', label: 'GitLab', icon: 'gitlab', anchors: ['remote'], connections: ['cli', 'token'],
  cli: { bin: 'glab', minVersion: '1.60.0' /* [A] — pin to the release that has `auth status --output json` */,
         install: { darwin: 'brew install glab', linux: 'brew install glab  # or: sudo snap install glab',
                    win32: 'winget install glab.glab' },
         authStatus: ['auth', 'status', '--hostname', '{host}', '--output', 'json'],
         login: ['auth', 'login', '--hostname', '{host}'], docsUrl: 'https://docs.gitlab.com/cli/' },
  tokenFields: [ { name: 'baseUrl', label: 'Instance URL', example: 'https://gitlab.acme.internal/gitlab' },
                 { name: 'token', label: 'Access token', secret: true },
                 { name: 'caFile', label: 'CA certificate (PEM path, optional)' } ],
  vocabulary: { workItem: 'issue', changeRequest: 'merge request', issueKey: '#12', changeRequestKey: '!17' },
  facets: ['workItems', 'changeRequests', 'merge', 'publish', 'automation', 'link', 'clone', 'agentAccess'],
  env: ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'GITLAB_HOST', 'GITLAB_URI', 'GL_HOST', 'GLAB_CONFIG_DIR'],
  redaction: [/\bgl(?:pat|dt|rtr?|cbt|ptt|ft|imt|agent|wt|soat|ffct|oas)-[A-Za-z0-9_-]{20,}/],
  referencePatterns: /* § Run bookkeeping */ }
```

### Anchor, discovery and host classification (zero network)

`discover()` classifies every remote. A host is GitLab when, in precedence order:

1. `integrations.json` overrides it (`{ host, provider: 'gitlab', baseUrl? }`) — optional, never required;
2. a `token` connection record names it;
3. `glab` knows it: top-level keys of `hosts:` in the first existing glab `config.yml` from the
   search order above **[A: key layout]**, plus `GITLAB_HOST`/`GITLAB_URI`/`GL_HOST` — read as a
   file, like `github-hosts.ts` reads `gh`'s `hosts.yml` (30 s TTL, never throws);
4. it is `gitlab.com`.

A bare `gitlab.*` hostname is **not** a signal (same rule `github-hosts.ts` applies to
`github.*`). A host claimed by both GitHub and GitLab rules goes to the explicit override, else
GitHub (today's behaviour cannot regress). No `glab` spawn and no HTTP happen in discovery.

**Subgroups.** `ParsedRemote` gains an additive `path: string[]` (all namespace segments + repo,
`.git` stripped); `owner`/`repo` keep their last-two meaning for GitHub callers. GitLab uses
`fullPath = path.join('/')` everywhere and sends it URL-encoded as `:id`.

**Non-root instance paths.** An HTTPS remote `https://intra.acme/gitlab/acme/api.git` is ambiguous
(`gitlab/acme/api` vs subfolder `gitlab` + `acme/api`); an SSH remote never carries the subfolder.
Resolution: the subfolder comes from (a) the token record's `baseUrl`, (b) glab's per-host
`subfolder` config, (c) the override. Absent all three, `availability()` (the first network-allowed
call) probes `GET projects/:encodedPath` for each split of an HTTPS remote's path, longest project
path first, **at most 3 requests**, and caches the winner per project; SSH remotes with no known
subfolder report `available:false, reason:'GitLab is installed under a sub-path? Set it with glab config set subfolder … --host <host>'`.

**Project identity.** `availability()` resolves `GET projects/:encodedFullPath` once → numeric
`id`, `path_with_namespace`, `web_url`, `merge_method`, `squash_option`, `default_branch`,
`forked_from_project.id`. Every later request uses the numeric id (survives renames mid-session);
`web_url` becomes the source of every link — never string-built from the remote.

### Transports

```ts
// integrations/gitlab/client.ts
interface GitlabTransport {           // both never throw past the client; map to GitlabError
  request(method, path, { query?, body?, signal? }): Promise<{ status, headers, json }>;
}
glabTransport(host, cwd)   // execFile('glab', ['api', '--hostname', host, '-X', method, '-i', path, ...fields])
tokenTransport(record)     // fetch(`${baseUrl}/api/v4/${path}`, { headers: { 'PRIVATE-TOKEN': token } })
```

- `glab` env: inherited env minus nothing secret-adding, plus `GLAB_NO_PROMPT=1`,
  `GLAB_CHECK_UPDATE=false`, `GLAB_DISPLAY_HYPERLINKS=false`, `GLAB_SEND_TELEMETRY=0`,
  `NO_COLOR=1`. `-i` gives status + `x-next-page` + `Retry-After`. Timeout 20 s, stdout cap 8 MiB.
  Exit with "401"/"authentication" → `signedIn:false`; ENOENT → `Install glab`.
- **We never use `--paginate`** (unbounded). Pagination is explicit `page`/`per_page=100` with a
  per-facet page cap and the shared time budget (`integrations/shared/cursor.ts`).
- Token transport: shared `http-transport.ts` (deadline, size cap, cooldown, **no cross-origin
  redirects** — a redirect would leak `PRIVATE-TOKEN`). A `caFile` becomes a per-connection
  `node:https` `Agent({ ca })`; never `rejectUnauthorized:false`, never `NODE_EXTRA_CA_CERTS`
  mutation. `baseUrl` must be `https:` unless the host is loopback.
- Rate limiting: per-integration budget in the shared arbiter; on 429 honour `Retry-After`, put
  the integration in cooldown, surface `reason: 'GitLab rate limit — retrying in Ns'`.

### Facet → request table

All paths are relative to `/api/v4/`; `P` = numeric project id. CLI argv is
`glab api --hostname <host> -i [-X M] <path> [-f k=v …]`; the token transport sends the same.
Porcelain rows are marked.

| Facet / operation | Request | Fields used |
| --- | --- | --- |
| readiness (cli) | porcelain `glab auth status --hostname <host> --output json` | signed-in flag, user **[A]** |
| availability + identity | `GET projects/<urlencoded fullPath>` | `id path_with_namespace web_url default_branch merge_method squash_option forked_from_project.id` |
| issues list | `GET projects/P/issues?state=opened&order_by=updated_at&per_page=100&page=N` | `iid title author.username created_at updated_at labels[] assignees[].username web_url user_notes_count state` |
| MRs list | `GET projects/P/merge_requests?state=opened&order_by=updated_at&per_page=100&page=N` | above + `draft source_branch target_branch` |
| search (any state) | same two with `state=all&search=<q>&in=title,description` | as list |
| label colours | `GET projects/P/labels?per_page=100&include_ancestor_groups=true` | `name color` |
| lazy checks + diffstat (list rows) | `POST graphql` `project(fullPath){ mergeRequests(iids:[…]){ nodes{ iid headPipeline{status} diffStatsSummary{additions deletions} } } }` **[A: field names]** | → `checks`, `additions`, `deletions` |
| detail | `GET projects/P/issues/:iid` / `merge_requests/:iid` | `description` (Markdown, 8 000-char cap as today) |
| thread: comments | `GET …/:iid/notes?sort=asc&order_by=created_at&per_page=100` (≤5 pages) | `id body author created_at system` — `system:true` dropped |
| thread: labels | `GET …/:iid/resource_label_events` | `action add\|remove label.{name,color} user created_at` → `labeled/unlabeled` |
| thread: state | `GET …/:iid/resource_state_events` | `state closed\|reopened\|merged user created_at` → `closed/reopened/merged` |
| thread: commits (MR) | `GET projects/P/merge_requests/:iid/commits` | `id title author_name created_at` → `committed` |
| branch → MR status | `GET projects/P/merge_requests?source_branch=<b>&state=all&order_by=updated_at&per_page=5` then `GET …/:iid` | `iid web_url state draft head_pipeline.status` |
| MR diff | `GET projects/P/merge_requests/:iid/diffs?per_page=100&page=N` (≤3 pages = 300 files) | `old_path new_path new_file renamed_file deleted_file diff too_large collapsed` |
| merge state | `GET …/:iid` + `GET …/:iid/approvals` + `GET projects/P/pipelines/:pid/jobs?per_page=100` | § Merge |
| merge | `PUT projects/P/merge_requests/:iid/merge` `sha squash auto_merge` | `state merged_at merge_commit_sha squash_commit_sha` |
| cancel auto-merge | `POST projects/P/merge_requests/:iid/cancel_merge_when_pipeline_succeeds` **[A: 19.x rename]** | — |
| publish | `POST projects/<push project>/merge_requests` | § Publish |
| clone (cli) | porcelain `glab repo clone <web_url> <dir> -- --progress` | — |
| clone (token / no glab) | `git clone <remote url as given>` | — |
| automation poll | § Automations | |

### `workItems` + `changeRequests`

- `WorkItem` mapping: issue `{ id: String(iid), key: '#'+iid, kind:'issue' }`, MR
  `{ id: String(iid), key: '!'+iid, kind:'change_request', state: draft ? 'draft' : opened→'open' |
  merged→'merged' | closed|locked→'closed' }`; `commentCount = user_notes_count`.
- **Ids are IIDs** (project-scoped), never global `id`. Work-item ids in routes are URL-segment
  safe by construction.
- No legacy adapter: `/api/v1/github*` stays GitHub-only and never serves a GitLab integration;
  GitLab is reachable only through `/integrations/*`.
- Server-side search always; a GitLab `search` shorter than 3 characters is rejected by GitLab
  **[A]** — the route answers an empty result with `reason`, not an error.
- Confidential issues are returned only when the identity can read them; nothing to do.
- Body Markdown is GitLab-flavoured; render through the existing Markdown renderer. Relative
  upload links (`/uploads/…`) are rewritten against the project `web_url`; images stay links
  (no authenticated fetch through cezar).

### Checks glyphs (pipelines)

`head_pipeline.status` → glyph: `success` → `passing`; `failed` → `failing`; `created
waiting_for_resource preparing waiting_for_callback pending running scheduled canceling` →
`pending`; `canceled skipped manual` → `null` (rendered as "no result", same as GitHub's
neutral). No pipeline → `null`. `head_pipeline` absent because the identity can't view pipelines
→ glyph absent (distinct from `null`, as in `ForgeTimelineEvent.checks`).

### `merge`

`ChangeRequestMergeState` (umbrella re-export of `ForgePrMergeState`) is filled as:

| Field | GitLab source |
| --- | --- |
| `mergeable` | `detailed_merge_status`: `mergeable` → `mergeable`; `conflict`, `need_rebase` → `conflicting`; `checking unchecked preparing approvals_syncing` → `unknown`; everything else → `mergeable` with a blocker |
| `reviewDecision` | approvals `approved` → `approved`; status `requested_changes` → `changes-requested`; `not_approved` → `review-required`; else `unknown` |
| `checks` / `checksTier` | jobs of `head_pipeline` → one row each (`name`, status→state, `required: !allow_failure`, `web_url`) = `detailed`; only `head_pipeline.status` readable = `aggregate`; none = `none` |
| `methods` / `defaultMethod` | `['merge']`, plus `'squash'` unless `squash_option = never`; only `['squash']` when `always`; default `squash` for `always/default_on`. **`rebase` is never offered** — GitLab's rebase is a project merge method or a separate `PUT …/rebase`, not a per-merge choice |
| `blockers` | every other `detailed_merge_status` value, verbatim code + human copy (`ci_must_pass`, `discussions_not_resolved`, `draft_status`, `not_approved`, `merge_time`, `jira_association_missing`, `locked_paths`, `title_regex`, …) |
| `eligibility` | `mergeable` → `ready`; `ci_still_running` → `pending`; `not_open` → `terminal`; 401/403 → `unauthorized`; blockers → `blocked` |
| `canOverride` | always `false` — GitLab has no admin-bypass merge in the API |

Additive optional fields (contract, § Contract): `approvals?: { approved, left: number|null,
approvedBy: string[] }`, `autoMerge?: { enabled: boolean, available: boolean }`,
`mergeMethodLabel?: 'merge commit' | 'merge commit with semi-linear history' | 'fast-forward'`.

Merge always sends `sha = expectedHeadSha` (GitLab may *require* it — 19.2 setting), never uses
`glab mr merge` (its `--auto-merge` default would silently schedule instead of merge). Status
mapping: 200 + `state:merged` → `merged:true`; 200 + still `opened` with auto-merge set →
`{ merged:false, scheduled:true }`; 401 → 403; 405 → 409 `not-mergeable` + fresh `current`;
409 → 409 `head-moved`; 400 → 409 with GitLab's message; 5xx/transport → 502.

The merge panel offers **Merge** and, when the head pipeline is not finished, **Merge when
checks pass** (`auto_merge=true`; label copy "Set to auto-merge"), plus **Cancel auto-merge** when
scheduled. Approving is out of scope for phase 3 (a review action on the user's behalf);
`approvals` is read-only.

### `publish` (draft MR from a run branch)

Same pipeline as `createDraftPr` up to the push (autosave commit → `git push -u <push remote>
<branch>` via `resolveTaskRemotes`); then:

```
POST projects/<source project id>/merge_requests
  source_branch=<branch> target_branch=<run base branch> title="Draft: <title>"
  description=<handoff body + linked-work-item footer> remove_source_branch=<omit → project default>
  target_project_id=<base project id>   # only when push remote ≠ base remote (fork flow)
```

- Draft is the `Draft:` title prefix (GitLab's canonical draft marker) **[A: whether create also
  accepts a `draft` param on the server's version]**; publishing *ready* omits it.
- The response JSON yields `web_url` and `iid` — **no URL scraping**.
- 409 "Another open merge request already exists for this source branch" → look up that MR by
  `source_branch` and return its URL (`ok:true`), matching the idempotent GitHub behaviour.
- `CEZ_DRY_RUN=1` returns `https://gitlab.example.com/acme/platform/api/-/merge_requests/1`.

### `clone`

`parseRepoRef` (umbrella: any host a provider recognises) accepts `https://<gitlab host>/<path…>`,
`git@<host>:<path…>.git`, and `<host>/<path…>`; a bare `group/repo` stays GitHub-only (ambiguous).
`cli` → `glab repo clone <url> <dir> -- --progress` (uses glab's git protocol + credential setup);
otherwise plain `git clone <url>`. **A token is never embedded in a clone URL.** Target-path and
ownership-proof rules in `checkout.ts` are unchanged.

### `link` (as work source, and as code host for other work sources)

- Footer when GitLab is the **work source** and code host: `Closes #12`; when the code host is a
  different GitLab project: `Closes group/project#12`; when the code host is another provider
  (GitHub/ADO), the footer is a plain link — GitLab cannot close across vendors.
- When GitLab is the **code host** for Jira/Linear/ADO work items, the MR body carries the work
  source's footer (umbrella). GitLab's own Jira integration, if the admin enabled it, picks up the
  key; cezar does nothing extra.
- Optional backlink (opt-in, off): `POST projects/P/issues/:iid/notes body="cezar opened !17"`.

### `agentAccess`

Agents inherit the user's `PATH` and `HOME`, so a signed-in `glab` already works inside a run,
exactly as `gh` does. Forwarding `GITLAB_TOKEN`/`GITLAB_HOST` into the agent env is **opt-in per
integration** (umbrella rule). A `token` connection's secret is never forwarded by default.

### Redaction

`core/secret-redaction.ts` gains the manifest pattern above. Because a self-managed **PAT prefix is
configurable** ([tokens][tokens]), the redactor also registers the **exact value** of every stored
GitLab token at load time (and `glab auth status --show-token` is never called).

## Automations

`integration` automation kind, `providerId: 'gitlab'`. Each event is advertised only if verifiable
from history:

| Neutral event | GitLab verification | GitHub-kind analogue |
| --- | --- | --- |
| `work_item.created` | issue `created_at` ≥ baseline | `issue.opened` |
| `work_item.labeled` / `work_item.unlabeled` | `resource_label_events` `action add/remove`, `created_at` | `issue.labeled/unlabeled` |
| `work_item.status_changed` | `resource_state_events` `closed/reopened` | — |
| `change_request.opened` | MR `created_at` ≥ baseline | `pull_request.opened` |
| `change_request.merged` / `change_request.closed` | MR `resource_state_events` `merged/closed` | `pull_request.merged/closed` |
| `change_request.review_requested` | `reviewers[].created_at` ≥ baseline **[A: the timestamp is assignment time]** | `pull_request.review_requested` |
| not advertised | re-review request, review submitted/approved (no timestamped history in REST) | `pull_request.rereview_requested`, `pull_request.reviewed` |

Poll (per enabled automation, bounded): `GET projects/P/issues|merge_requests?updated_after=<checkpoint>&order_by=updated_at&sort=asc&state=all&per_page=100`
→ for each candidate, fetch only the resource-event stream its trigger needs. Checkpoint =
`updated_at` + `iid` tiebreaker; `complete:false` when a page cap hits. Filters: `labels`,
`author`, `assignee`, `reviewer`, `draft`. Template tokens `item.*` (`item.key` = `#12`/`!17`).
`checkout: 'pr-head'` maps to fetching `refs/merge-requests/<iid>/head` **[A]** from the base remote.

## Run bookkeeping

`referencePatterns` (host list = every GitLab host the project's integrations know, with the
optional subfolder):

- MR URL: `https?://<host>(/<subfolder>)?/(?:[\w.-]+/)+[\w.-]+/-/merge_requests/(\d+)`
- Issue URL: `…/-/issues/(\d+)` and `…/-/work_items/(\d+)` **[A: newer issue URLs]**
- Worded: `\b(?:merge\s+request|MR)\s*!?\s*(\d+)` and `!(\d+)` (MR); `#(\d+)` = issue only when
  GitLab is the code host.
- Hand-off wording (in `lib/work-item-task.ts`, coupled to `task-refs.ts` in the same commit):
  "Address GitLab merge request !N", "Fix GitLab issue #N".

`RunRecord.prNumber`/`prUrl` are populated for a GitLab MR (it is the code host's change request);
`workItemRefs` gets `{ providerId:'gitlab', key:'!17', kind:'change_request' }`.

## Contract additions (GitLab-specific, all additive)

In `packages/contract/src/integrations.ts` / `github.ts` re-exports:

- `changeRequestMergeStateSchema`: optional `approvals`, `autoMerge`, `mergeMethodLabel`.
- Merge body: optional `autoMerge?: boolean`; merge result: new `{ merged:false, scheduled:true,
  number, url }` variant; `POST …/change-requests/:itemId/merge/cancel-auto` (capability-gated).
- `integrationAvailabilitySchema.cli` already covers `glab`; add optional `instance?: { baseUrl,
  version? }` (version from `GET version` only on explicit refresh **[A]**).
- `backendCheckSchema.name` gains `'glab'` (manifest-driven, umbrella).
- `forgeInfoSchema.kind` gains `'gitlab'` (umbrella widening).
- Token connection record: `{ provider:'gitlab', baseUrl (https URL, may include path), token,
  caFile? }`; `baseUrl`'s host must equal the remote host or the override.

## Cockpit

- Switcher entry `GitLab · acme/platform/api` (full path, middle-truncated).
- Filter chips **Issues / Merge requests**; MR rows show `!17`, a *Draft* badge, pipeline glyph.
- Detail: thread interleaves notes + label/state events + commits; no review rows in phase 3
  (honest gap, shown as approval summary in the merge panel instead).
- Merge panel: approvals `2 of 3 · approved by …`, merge-method label, auto-merge button.
- Review gate: **Create MR** / **View MR** (vocabulary from manifest).
- Settings → Integrations → GitLab card: hosts found (from remotes), per host *glab missing /
  signed out / signed in* with **Install glab** and **Sign in** (`glab auth login --hostname <host>`
  in the user's terminal), or **Use a token** form (Instance URL, token, CA file). Token scope copy:
  `read_api` for browsing; `api` for publish/merge.
- Clone dialog accepts GitLab URLs (placeholder lists both).

## Dry-run fixtures

`packages/cezar/src/integrations/gitlab/fixtures/`: `project.json` (subgroup path, `merge_method`),
`issues.json`, `merge-requests.json` (draft, merged, pipeline states), `notes.json` (with system
notes to drop), `label-events.json`, `state-events.json`, `diffs.json` (incl. `too_large`),
`approvals.json` (CE and Premium shapes), `jobs.json`, `merge-405.json`, `merge-409.json`,
`auth-status.json`. `CEZ_DRY_RUN=1` serves them through a fixture transport — the same seam as
`glabTransport`/`tokenTransport`.

## Implementation steps (umbrella phase 3)

1. **3a Remote parsing + classification** — `git-remotes.ts` (`ParsedRemote.path`), new
   `gitlab-hosts.ts` (mirror of `github-hosts.ts`), `forge/index.ts` `forgeKindOfHost` → `'gitlab'`
   via the registry; tests for subgroups, ports, `ssh://`, scp, subfolder ambiguity.
2. **3b Client + transports** — `integrations/gitlab/{client,transport-glab,transport-token,schemas,normalize}.ts`;
   zod over every response; error mapping; pagination caps.
3. **3c Read facets** — `workItems`, `changeRequests`, thread, diff, checks; Issues view entry;
   bookkeeping patterns in `runs/store.ts` + `runs/task-refs.ts`.
4. **3d Write facets** — `publish`, `merge` (+ auto-merge, cancel), `clone` (`checkout.ts`),
   Settings card, `server-install/steps.ts` glab install hints, `backend-detect.ts` glab probe,
   redaction, `.env.example` only if a `CEZ_*` var is added (none planned).
5. **3e Automations** — `integrations/gitlab/events.ts` implementing `AutomationEventSource`.

## Tests

- `integrations/gitlab/*.test.ts`: fixture → normalized shapes for every row of the request table;
  pipeline → glyph table; `detailed_merge_status` → mergeable/eligibility table; merge status-code
  table; publish 409-existing; fork publish sets `target_project_id`.
- Transport: glab argv snapshot (no `--paginate`, env flags present, `-i` parsed), ENOENT /
  signed-out / 429 mapping; token transport refuses cross-origin redirect, uses `caFile`, never
  disables TLS verification.
- Discovery: no `glab` spawn and no network (spy), glab `config.yml` parsing across the search
  order, `GITLAB_HOST`, GitHub-vs-GitLab precedence, `gitlab.corp` not classified.
- Subfolder probe: ≤3 requests, cached, SSH-without-subfolder reason.
- Bookkeeping: MR/issue URLs with subgroups + subfolder, `!N`, coexisting GitHub URLs untouched.
- Redaction: every prefix + exact-value registration for a custom-prefix PAT.
- Umbrella conformance suite runs the GitLab fixtures; `route-parity`, `contract-parity*`,
  `typed-bodies` cover the merge/cancel-auto additions. E2E: Issues view against GitLab dry-run.
- Regression proof per AGENTS.md: the bookkeeping and `parseRemote` tests fail with the source
  change stashed.

## Backward compatibility

- `ParsedRemote.path` is additive; `owner`/`repo` semantics unchanged for every existing caller.
- A GitLab remote previously yielded `forge: null`; it now yields `'gitlab'` — the widened enum is
  the umbrella's breaking-type change, shipped with its consumers.
- `/api/v1/github*` never serves GitLab data. No frozen shape changes.
- GitHub-host precedence keeps every GitHub/GHES project classified exactly as today.
- No new config file, no new required env var; `integrations.json` entries optional.

## Acceptance criteria

- A repo whose `origin` is `git@gitlab.com:acme/platform/api.git`, with `glab` signed in and no
  cezar config, shows GitLab issues and MRs, opens a draft MR from a run, shows its pipeline
  glyph, and merges it with a head-SHA guard.
- The same on `https://intra.acme/gitlab/acme/api.git` with a private CA, via glab's `subfolder` +
  `ca_cert` — and via a token connection with `baseUrl` + `caFile`.
- Merge on a running pipeline offers "Merge when checks pass"; the result reports *scheduled*,
  never a false *merged*.
- A GitLab run keeps its MR chip and `!N` prefix; GitHub runs unchanged.
- Discovery and health never spawn `glab` or make a request; `CEZ_DRY_RUN=1` exercises all facets.

## Open questions

1. Phase 3 has no review rows in the MR thread (REST has no timestamped review history). Accept,
   or add GraphQL / parse English system notes ("approved this merge request")?
2. Offer **Approve** in the merge panel (`POST …/approve` with `sha`)? It is a review on the
   user's behalf — proposed out of scope.
3. Should GitLab issues on **another** project/group (the `-g group` scope `glab` supports) be a
   scope-anchored work source? Proposed: later, as a `scope` anchor on the same provider.
4. Minimum `glab` version to pin (`auth status --output json` availability) — measure in 3b.

[glab-readme]: https://gitlab.com/gitlab-org/cli/-/blob/main/README.md
[glab-releases]: https://gitlab.com/gitlab-org/cli/-/releases
[glab-install]: https://gitlab.com/gitlab-org/cli/-/blob/main/docs/installation_options.md
[glab-login]: https://docs.gitlab.com/cli/auth/login/
[glab-auth]: https://docs.gitlab.com/cli/authentication/
[glab-auth-status]: https://docs.gitlab.com/cli/auth/status/
[glab-config]: https://docs.gitlab.com/cli/configuration/
[glab-config-cmd]: https://docs.gitlab.com/cli/config/
[glab-api]: https://docs.gitlab.com/cli/api/
[glab-mr-list]: https://docs.gitlab.com/cli/mr/list/
[glab-mr-create]: https://docs.gitlab.com/cli/mr/create/
[glab-mr-merge]: https://docs.gitlab.com/cli/mr/merge/
[glab-issue-list]: https://docs.gitlab.com/cli/issue/list/
[rest-index]: https://docs.gitlab.com/api/rest/
[rest-auth]: https://docs.gitlab.com/api/rest/authentication/
[mr-api]: https://docs.gitlab.com/api/merge_requests/
[projects-api]: https://docs.gitlab.com/api/projects/
[approvals-api]: https://docs.gitlab.com/api/merge_request_approvals/
[label-events]: https://docs.gitlab.com/api/resource_label_events/
[state-events]: https://docs.gitlab.com/api/resource_state_events/
[notes-api]: https://docs.gitlab.com/api/notes/
[pipelines-api]: https://docs.gitlab.com/api/pipelines/
[com-rate-limits]: https://docs.gitlab.com/user/gitlab_com/rate_limits/
[tokens]: https://docs.gitlab.com/security/tokens/
[closing]: https://docs.gitlab.com/user/project/issues/managing_issues/

## Appendix: live evidence carried over from #1226

A second, independently written draft of this spec (task b10c058f) drew on the live runs of
PR #1226 (glab 1.118 against gitlab.com) and the downstream fork on self-managed 19.x CE
([#1226 comment](https://github.com/open-mercato/cezar/pull/1226#issuecomment-6217599142)).
Its findings that this spec must also honor:

- `glab api` **exits 0 on an HTTP 404** and reports only on stderr. Always call it with
  `--include` and decide success from the status line, never from the exit code. Test: exit-0 404 → not-found.
- `glab api --paginate` emits **one JSON array per page**, not a merged array; the parser reads a
  stream of arrays.
- `glab mr create --no-editor` still prompted in 1.118 — one more reason publish uses
  `POST projects/:id/merge_requests` through `glab api`.
- The old `NO_PROMPT` env var is deprecated; use `GLAB_NO_PROMPT=1`.
- **Plain-git tier** (no glab, no token): the remote still shows as "Sign in to <host>", clone uses
  `git clone`, and publish may fall back to GitLab push options
  (`git push -o merge_request.create -o merge_request.draft`,
  [push options](https://docs.gitlab.com/topics/git/commit/#push-options-for-merge-requests)), reading the MR
  URL from the `remote:` lines. [assumption: `merge_request.draft` availability per version]
- This spec supersedes the GitLab half of #847 and its unmerged spec PR #848. Code from #1226 may be
  ported; its `ForgeDriver` shape is not.
