# Execution plan — forge provider adapters (GitHub + GitLab)

**Date:** 2026-09-22
**Slug:** forge-provider-adapters
**Branch:** `feat/forge-provider-adapters` (fork `roszekF/cezar`) — upstream PR open-mercato/cezar#1226, implementing #847
**Source spec:** `.ai/specs/2026-08-10-forge-provider-adapters.md` — upstream spec PR open-mercato/cezar#848; committed on this branch byte-identical to #848 (Step 5.12), so the two merge in either order
**Base:** `main` @ `4763447f` (v0.11.1)
**Engine:** om-auto-create-pr-loop (steps: 28, --loop: no)

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and set `Commit` to `pending`; the next checkpoint commit backfills the real short SHAs (a commit cannot contain its own SHA). The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids and `Exec` cells are immutable once the plan is committed — per-Step commits touch only `Status` and `Commit`.

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 1 | 1.1 | Widen ForgeKind and add optional driver capabilities | dispatch | done | 5c03e161 |
| 1 | 1.2 | Widen the contract schemas and their narrowing consumers | dispatch | done | d72ef57d |
| 1 | 1.3 | Extract forge/cli.ts shared adapter plumbing | dispatch:capable | done | a45d4b4e |
| 1 | 1.4 | Route GET /github and /github/search through the driver | dispatch:capable | done | d078b602 |
| 1 | 1.5 | Route GET /github/comments through forge.listComments | dispatch | done | a05ebeda |
| 1 | 1.6 | Route GET /github/checks through forge.listChecks | dispatch | done | 336d55bb |
| 1 | 1.7 | Route GET /github/ref-status through forge.refStatus | dispatch | done | ea6aada9 |
| 1 | 1.8 | Route PR changes and draft-PR creation through the driver | dispatch | done | 81a4912b |
| 2 | 2.1 | Add forge/discovery.ts with the host ladder and cache | dispatch | done | 92d7c5c5 |
| 2 | 2.2 | Wire discovery into forge/index.ts and the boot warm-up | dispatch:capable | done | 84ecc7dd |
| 2 | 2.3 | Carry path and web origin on ParsedRemote | dispatch | done | ce018c43 |
| 2 | 2.4 | Build the GitHub viewUrl from the parsed origin | dispatch:cheap | done | ec1ee5e8 |
| 3 | 3.1 | GitLab driver skeleton with detect and registration | dispatch:capable | done | 8209bd0d |
| 3 | 3.2 | GitLab listIssues and listPRs | dispatch | done | 0d5cd2ee |
| 3 | 3.3 | GitLab listComments with timeline events | dispatch | done | bbd3f755 |
| 3 | 3.4 | GitLab listChecks and prStatus | dispatch | done | c9217a48 |
| 3 | 3.5 | GitLab prDiff with forge-neutral caps | dispatch | done | c5978f60 |
| 3 | 3.6 | GitLab searchItems | dispatch:cheap | done | 172419f5 |
| 3 | 3.7 | GitLab viewUrl | dispatch:cheap | done | d7db20ab |
| 3 | 3.8 | Cockpit forge label, icon and copy from health.forge.kind | dispatch | done | 41d044a5 |
| 3 | 3.9 | Forge-neutral task reference chips in the cockpit | dispatch | done | bd6f6668 |
| 4 | 4.1 | GitLab draft merge request creation | dispatch:capable | done | 16dc31b7 |
| 4 | 4.2 | Clone from a GitLab remote | dispatch:capable | done | dbca8223 |
| 4 | 4.3 | Host tooling, agent env and redaction for glab | dispatch | done | de170f1d |
| 4 | 4.4 | Run bookkeeping learns GitLab URL shapes | dispatch | done | 2a49957a |
| 4 | 4.5 | Bookmarklet matcher from discovered hosts | dispatch:cheap | done | 64d4a00a |
| 4 | 4.6 | GitHub-event automations require a GitHub forge | dispatch | done | 8d4a2079 |
| 4 | 4.7 | Documentation for the second forge | inline | done | 7482493a |
| 1 | 1.7-review-fix | Type the driver-stub test payloads explicitly | inline | done | 5f7bae12 |
| 1 | 1.8-review-fix | Keep the pre-seam draft-PR path when no forge resolves | inline | done | 7ec3ab5f |
| 3 | 3.2-review-fix | Freeze the clock in the GitLab dry-run list test | inline | done | 927f232b |
| 3 | 3.8-review-fix | Finish forge-aware copy across the forge tab | dispatch | done | b195fece |
| 3 | 3.1-review-fix | Name GitLab in the merge-state fallback | inline | done | b9f7d22b |
| 4 | 4.2-review-fix | Persist the glab credential helper after a GitLab clone | dispatch | done | b22c4a50 |
| 4 | 4.5-ds-fix | Keep the design guardian green in the bookmarklet test | inline | done | 1a1260f8 |
| 3 | 3.8-review-fix-2 | Forge kind per viewed project, not the boot project | dispatch | done | 13e2fbc1 |
| 4 | 4.4-review-fix | Match http and on-prem ports in GitLab run-bookkeeping URLs | dispatch | done | ee513720 |
| 4 | 4.4-review-fix-2 | Keep the foreign-reference guard working on GitLab | dispatch | done | 21029c40 |
| 4 | 4.5-review-fix | Escape every regex metacharacter in bookmarklet hosts | dispatch | done | b614b2d8 |
| 4 | 4.6-review-fix | Keep GitHub-event automations on github.com only | dispatch | done | 92973497 |
| 4 | 4.3-review-fix | Keep the glab probe off the health request path | dispatch | done | 50b6bfd1 |
| 3 | 3.4-review-fix | Bound the GitLab checks fan-out with one deadline | dispatch | done | 28636fcf |
| 2 | 2.2-review-fix | Load the discovery cache before the first request | dispatch | done | cccbd9fd |
| 4 | 4.4-review-fix-3 | Restore the partial forge mock in the repo-handle test | inline | done | e340385d |
| 5 | 5.1 | Reclaim a lease whose age exactly equals the window | dispatch | done | e280b9a8 |
| 5 | 5.2 | Trim and validate the host in parseRemote and checkout | dispatch | done | 19b2defd |
| 5 | 5.3 | Share one budget across the glab probe reads | dispatch:cheap | done | 0965f799 |
| 5 | 5.4 | Count GitLab diff lines without dropping content | dispatch:cheap | done | fd36e221 |
| 5 | 5.5 | Read every auth-status host line in discovery | dispatch | done | 989ea31f |
| 5 | 5.6 | Drop the non-null assertions in the GitLab adapter | dispatch:cheap | done | 56d1c663 |
| 5 | 5.7 | Match http GitLab hosts in the bookmarklet | dispatch | done | c99f0cad |
| 5 | 5.8 | Seed gitlab.com only for a registered GitLab project | dispatch | done | 22b37df1 |
| 5 | 5.9 | Make the foreign-reference guard host-aware | dispatch:capable | done | 1060c4e2 |
| 5 | 5.10 | Forge-aware copy in the reference-status chip | dispatch | done | 0c00a3eb |
| 5 | 5.11 | Correct the Second forge compatibility claims | inline | done | a4bd7da5 |
| 5 | 5.12 | Land the spec so its citations resolve | inline | done | 2347212c |

## Goal

Finish the `ForgeDriver` seam and add a `glab`-backed GitLab adapter so a project on gitlab.com or a self-managed GitLab gets the forge tab, draft merge requests from the review gate, linking task chips, clone-from-forge and CI glyphs — discovered, never configured — while a GitHub project behaves byte-identically to today.

## Scope

- `packages/cezar/src/server/forge/` (types, cli, discovery, index, github, gitlab), the `/github*` route family and `POST /runs/:id/pr` in `server.ts`, `packages/contract/src/{health,projects}.ts`.
- Workspace integration: `server/checkout.ts`, `core/{backend-detect,agent-env,secret-redaction}.ts`, `server-install/steps.ts`, `runs/{store,task-refs}.ts`, automations availability.
- Cockpit: nav label/icon, unavailable-state copy, `lib/{git-actions,tasks-table,bookmarklet}.ts`, clone dialog copy.

## Non-goals

- GitLab reference-status chips (`/github/ref-status`), merge-state and merge: the optional driver methods stay absent for GitLab and the routes answer their existing in-payload degradation — chips render neutral, the merge panel reads unavailable.
- Generalizing Automations to GitLab (event poller, `github.*` tokens), a neutral `/api/v1/forge*` family, renaming `/github` routes or the cockpit URL, a token/REST transport, Bitbucket/Gitea/Forgejo/Azure adapters (spec § Deliberately not addressed).
- `runs/arm-repo-handle.ts` (`gh`-only repo handle memo): on a GitLab repo it already fails quietly and memoizes the negative; untouched.
- `readHostGithubToken` → `readHostForgeToken(kind)` (spec Step 22): the function has no callers on `main`, so renaming dead code is dropped.

## Review of the spec (upstream #848, sheeerth, CHANGES_REQUESTED 2026-08-14) — how each finding lands

| Finding | Resolution in this plan |
|---|---|
| Major 1 — the cockpit's duplicated remote parser (`tasks-table.ts` `githubRepoBase`/`synthesizeUrl`) is in no phase; GitLab chips ship inert or 404 | New Step 3.9: `forgeRepoBase(remote, kind)` with the same subgroup fix as 2.3, `synthesizeUrl` emits `/-/merge_requests/N` and `/-/issues/N` for `gitlab`, the "change both parsers in one commit" rule documented in both files. |
| Major 2 — `ParsedRemote` gains only `path`, but `viewUrl` needs scheme and port | Step 2.3 adds `path` **and** `origin` (web origin). Rule: `http(s)://` remotes keep scheme and port; `ssh://`, `git://` and scp-form remotes map to `https://<host>` with no port (an SSH port is never a web port). `forgeWebRoot` builds from `origin` + `path`. Table tests assert the built URL for `http://`, port-bearing and scp on-prem remotes. |
| Major 3 — Automations gate contradicts itself; gating `/api/v1/automations*` would break a §2-protected family | Resolved as **availability-only**, and re-based on main's automations redesign (2026-09-14): the nav item already no longer requires a GitHub remote, and schedule automations work anywhere. Step 4.6 makes *GitHub-event* automations available only when `forge.kind === 'github'` (the `available` flag of `GET /automations`, the manual check, boot poller registration — which today compare the literal host `github.com`). No route, status code or nav gate changes; a GitLab project reads like a repo without a GitHub remote today. |
| Minor 4 — `forgeWebRoot` is a third `FORGE_HOSTS` reader; rebase + re-inventory | Rebased (spec branch now on `4763447f`), inventory re-run 2026-09-22 (Drift below). Step 2.2 routes `forgeWebRoot` through discovery; `repoUrl` on `GET /api/v1/projects` widens to GitLab web roots in the same step. |
| Minor 5 — one `path` cannot serve both `viewUrl` and `glab api` `:id` on a non-root instance | `glab api` is always called with `cwd = repoRoot` and the `:fullpath` placeholder, so `glab` resolves the project from its own host config — cezar never builds `:id` from `path`. `viewUrl` prefers the project `web_url` that `detect()` caches from `glab repo view --output json` (exact for non-root instances), falling back to `origin` + `path`. |
| Extra test — read-only cache directory | Step 2.1 tests a read-only `~/.cache/cez` (AGENTS.md § Zero config: a read-only home degrades, never fails boot). |

## Drift since the spec (`bbd77e9b` → `4763447f`)

- **Five** `/github*` routes bypass the driver, not four: `/github/search` (#730) and `/github/ref-status` are new. 1.4 and 1.7 cover them; `ForgeDriver.searchItems?` already exists.
- `server.ts` reaches the GitHub module through re-export shims `server/github.ts` and `server/pr.ts`.
- `detectCache` is already a keyed LRU with in-flight join (`github.ts:2580`), so 1.3 extracts it rather than rewrites it; the stale-while-revalidate guarantee (#508) is pinned by a test that must stay green.
- Latent bug found: `evictGithubProjectCaches` clears comments with a `${root}:` prefix, but comment keys are `${root}\0${kind}#${n}` — comments are never evicted. 1.3 fixes it in `evictForgeProjectCaches`.
- `glpat-` redaction already exists (`secret-redaction.ts:68`); 4.3 adds the remaining GitLab token prefixes only.
- `glab` (1.118) flags differ from the spec's mapping table: `glab issue list` uses `-O/--output json` (its `-F` is `--output-format`), `glab mr list`/`repo view` use `-F/--output json`. Always spell `--output json`. MR list payloads carry no pipeline; the MR detail's `head_pipeline.status` does. `…/merge_requests/:iid/changes` is deprecated upstream — use `…/diffs` (paged) plus the MR detail for `sha`.

## Decisions (autonomous defaults, reversible)

- D1 — Capability absence answers the existing payload degradation with forge-neutral copy only where the string is a *reason* (`{available:false, reason}`); route status codes and shapes never change (BACKWARD_COMPATIBILITY.md §2).
- D2 — Discovery warm-up (`warmForgeDiscovery`) runs only in a real server (gated like `warmAgentKnowledge` on `deps.socketHub`) and on an `unref`'d bounded interval; tests never spawn it. The cache path defaults to `join(homedir(), '.cache', 'cez', 'forge-hosts.json')` like `skills-remote.ts`, injectable for tests. No new `CEZ_*` variable.
- D3 — Web origin rule for `ParsedRemote.origin` as stated under Major 2.
- D4 — Old exported names stay as delegates where anything imports them (`evictGithubProjectCaches`, `GH_PR_DIFF_FILE_CAP`, `GH_PR_PATCH_CAP`, re-export shims), so the diff never removes a symbol.
- D5 — GitLab `listPRs` keeps `checks: null` on list rows, hydrated lazily through `listChecks` exactly like GitHub since #664.
- D6 — `glab` is installed by the server installer only through brew; on apt it is attempted and a failure degrades to a one-line hint (it is not in every distro's archive), never failing the install.

## Implementation Plan

Every Step is one commit and carries its own tests. Conventions for all Steps: strict TS, `.ts` import extensions as the surrounding code uses them, zod at every CLI boundary, `execFile`/`spawn` with argument arrays, `CEZ_DRY_RUN=1` keeps working, no new runtime dependency, comments cite `spec 2026-08-10-forge-provider-adapters` or the issue. Run tests through `npm test -- <path>` (never `npx vitest`).

### Phase 1 — Finish the seam (GitHub only, behaviour-preserving)

Acceptance for the phase: a GitHub repo with `gh` and no config behaves byte-identically — same routes, payloads, caches, nav, hints. Checkpoint 1 runs the full gate plus `route-parity`, `bc-route-inventory`, `health-forge`, `contract-parity*`.

#### 1.1 Widen ForgeKind and add optional driver capabilities
- `forge/types.ts`: `ForgeKind = 'github' | 'gitlab'`. Add optional `listComments?(kind, number, opts?: {refresh?}) : Promise<ForgeCommentsData>`, `listChecks?(numbers): Promise<ForgeChecksData>`, `refStatus?(prs, issues): Promise<ForgeRefStatusData>` to `ForgeDriver`.
- Re-home the forge-neutral payload types (`GithubChecksData` → `ForgeChecksData`, `GithubRefStatusData`/`ReferenceStatus` → `ForgeRefStatusData`/`ForgeReferenceStatus`) into `types.ts`, keeping the old names as type aliases exported from `github.ts` and the `server/github.ts` shim.
- Tests: `forge/index.test.ts` type-level case that a driver object may omit every optional method; existing suites green.

#### 1.2 Widen the contract schemas and their narrowing consumers
- `packages/contract/src/health.ts`: `forgeInfoSchema.kind` → `z.enum(['github','gitlab'])`; `backendCheckSchema.name` gains `'glab'`. Mirror `BackendCheck['name']` in `core/backend-detect.ts`.
- `packages/contract/src/projects.ts`: per-project `forge` → the same enum.
- Consumers that narrow on the literal move in the same commit: `web/src/components/project-groups.tsx:558` (`project.forge === 'github'` → forge present), `web/src/lib/git-actions.ts` `ForgeInfo` use. Server keeps emitting only `'github'` in this Step.
- Tests: `contract-parity*.test.ts`, `api-types.test.ts`, web typecheck; a `project-groups` case showing a `gitlab` project keeps the forge item.

#### 1.3 Extract forge/cli.ts shared adapter plumbing
- New `forge/cli.ts`: cwd-scoped `runCli(bin, repoRoot, args, {timeoutMs, maxBuffer})`; `isNotFound(err)` + `notFoundReason(tool)` building the existing ENOENT hints (GitHub text byte-identical: ``gh CLI not found — install it and run `gh auth login` ``); the bounded page loop (`fetchBoundedPages` — deadline + min-page budget + page cap, page-1 rethrow, later-page stop-short) generalized from `fetchTimelinePages`; a keyed stale-while-revalidate cache (`createSwrCache` — fresh hit, in-flight join, serve-stale-and-revalidate, `null` only when cold, LRU bound) generalized from `detectCache`/`detectInflight`.
- Re-home `forge/github.ts` onto it (`gh()`, the seven ENOENT sites, `fetchTimelinePages`, `detectGithub`/`detectGithubCached`). Constants and caps keep their names and values.
- `evictForgeProjectCaches(repoRoot)` clears every per-root cache (list, merge-state, comments, checks, prDiff, refStatus, detect) — fixing the comments-key prefix bug — with `evictGithubProjectCaches` kept as a delegate.
- Tests: new `forge/cli.test.ts` (runner ENOENT mapping, page loop budget/cap/stop-short, SWR cache: two roots never evict each other, expired entry returns stale while revalidating, cold → null). `forge/github.test.ts` unchanged and green. A regression test that eviction now clears comments (fails on `main`).

#### 1.4 Route GET /github and /github/search through the driver
- `server.ts` `githubRoutes`: resolve `resolveForge(await getRepoInfo(repoRoot))`; `null` forge answers the exact unavailable payload the route family uses today (read `fetchGithub`'s no-remote/no-gh answers and keep them byte-identical — reason text may become forge-neutral only where today's text is produced by the route, not by `gh`).
- Listing: if `listIssues`/`listPRs` cannot reproduce `fetchGithub`'s full payload (labelColors, truncation, availability) byte-identically, add an optional `listAll?(opts): Promise<ForgeListData>` (re-homed `GithubData`) and have the GitHub driver implement it with `fetchGithub`; the route uses it.
- `/github/search`: via `forge.searchItems?`; absent → `{available:false, reason, items:[]}` in the existing shape.
- Tests: existing github list/search API tests green; new cases: `null` forge → unavailable payload (no throw), driver without `searchItems` → degraded payload.

#### 1.5 Route GET /github/comments through forge.listComments
- Move `fetchGithubComments` behind `createGithubDriver().listComments`; route calls the driver; missing method → `{available:false, reason, comments:[]}`.
- Tests: `github-comments-api.test.ts` green through the driver; capability-absent degradation.

#### 1.6 Route GET /github/checks through forge.listChecks
- Same for `fetchGithubChecks`; `GH_CHECKS_MAX` cap and the 400s (`missing prs query`/`invalid prs query`) unchanged.
- Tests: `github-checks-api.test.ts` green; capability-absent degradation.

#### 1.7 Route GET /github/ref-status through forge.refStatus
- GitHub driver implements `refStatus` with `fetchGithubRefStatus`; the route calls the driver; absent → `{available:false, reason, recheckAfterMs:null}` (a forge that cannot answer has nothing to recheck). `forgetRefStatus`/`readCachedRefStatuses`/`refNumberFromUrl` stay module helpers (cache-only, harmless for non-GitHub roots).
- Tests: `github-ref-status-api.test.ts`, `ref-status-invalidation.test.ts`, `runs-index-api.test.ts` green; capability-absent degradation.

#### 1.8 Route PR changes and draft-PR creation through the driver
- `GET /github/prs/:number/changes` via `forge.prDiff?` keeping the `GithubPrNotFoundError` → 404 mapping; `POST /runs/:id/pr` via `forge.createPR` (null forge → the existing 409 with `manual: git merge <branch>`); the `refNumberFromUrl`+`forgetRefStatus` follow-up unchanged.
- Tests: `github-pr-changes-api.test.ts`, `forge/github-pr-diff.test.ts`, `forge/draft-pr-autosave.test.ts` green; null-forge 409 case.

#### 1.7-review-fix Type the driver-stub test payloads explicitly
- Appended mid-run: the 1.7 executor's follow-up commit annotating two test stubs with `ForgeChecksData`/`ForgeRefStatusData` so `npm run typecheck` passes (commit `ea6aada9` alone does not typecheck — known bisect gap, recorded in NOTIFY).

#### 1.8-review-fix Keep the pre-seam draft-PR path when no forge resolves
- Found at Phase 1 close: 1.8's null-forge early 409 skipped `createDraftPr`'s final autosave (so the `git merge` hint lost the task's last edits), its actionable "no git remote — add one" text, and the `CEZ_DRY_RUN` fake PR. With no resolved driver, `POST /runs/:id/pr` now calls `createDraftPr` exactly as before the seam.
- Tests: dry-run no-remote worktree → 201 fake PR; non-dry-run no-remote → 409 with the original text.

### Phase 2 — Discovery (still GitHub-only in effect)

#### 2.1 Add forge/discovery.ts with the host ladder and cache
- Well-known map `{ 'github.com': 'github', 'gitlab.com': 'gitlab' }`; `readForgeHostCache(file)` / `writeForgeHostCache(file, map)` — zod `{version:1, hosts: Record<host, 'github'|'gitlab'|'none'>, updatedAt}`, corrupt or absent → empty map, never a throw; atomic tmp+rename write; a read-only or missing directory → write skipped silently.
- Parsers `parseGhAuthHosts(text)` / `parseGlabAuthHosts(text)` over real `gh auth status` / `glab auth status` output (both print to stderr; hosts are the unindented header lines and the `Logged in to <host>` lines). Fixtures captured 2026-09-22 (tokens redacted).
- `warmForgeDiscovery({cacheFile, run})`: probes whichever CLIs exist, merges hosts into the cache, never throws.
- Tests: `forge/discovery.test.ts` — each parser (logged-in, logged-out, multiple hosts, enterprise host), corrupt cache, absent directory, read-only directory, CLI missing.

#### 2.2 Wire discovery into forge/index.ts and the boot warm-up
- Replace `FORGE_HOSTS` with `forgeKindOfHost(host)`: well-known → in-memory cache (loaded synchronously once, refreshed after each warm) → `null`; `'none'` → `null`. `forgeKindOfRemote`, `resolveForge`, `forgeWebRoot` all read it and stay synchronous and I/O-free on the call path.
- `resolveForge` builds the GitHub driver for any `github` host (GitHub Enterprise via `gh auth status`); the `gitlab` branch returns `null` until 3.1.
- Boot: `warmForgeDiscovery()` fire-and-forget beside `warmAgentKnowledge` (gated on `deps.socketHub`), plus an `unref`'d interval (e.g. 10 min); never from a request.
- `GET /api/v1/projects` `repoUrl` widens to any discovered forge's web root (still credential-free, built from the parse).
- Tests: `forge/index.test.ts` — on-prem host present in cache, absent, `'none'`; `forgeKindOfRemote` performs no I/O (spy); `workspace/projects.test.ts` and `health-forge.test.ts` green.

#### 2.3 Carry path and web origin on ParsedRemote
- `ParsedRemote` gains `path` (full project path, `.git` stripped, e.g. `group/sub/repo`) and `origin` (D3). `owner`/`repo` keep their meaning. `forgeWebRoot` = `origin` + `/` + `path`.
- Tests: table over `gitlab.com/group/repo`, `…/group/sub/repo`, 3-level nesting, scp-form, `ssh://…:2222/…`, `http://gitlab.acme.internal:8929/group/repo`, `https://intranet/gitlab/group/repo`, credentials in URL (never in `origin`), plus every existing GitHub case unchanged; assert the built `forgeWebRoot` for each.

#### 2.4 Build the GitHub viewUrl from the parsed origin
- `createGithubDriver(repoRoot, {owner, repo, origin})`; `viewUrl` base = `origin/owner/repo` instead of the `https://github.com` literal.
- Tests: `viewUrl` for github.com (unchanged strings) and an enterprise host.

### Phase 3 — The GitLab adapter (read paths)

All GitLab calls run `glab` with `cwd = repoRoot` through `forge/cli.ts`; `glab api` endpoints use the `:fullpath` placeholder (never a path cezar derived). Every payload is zod-validated; fixtures come from real gitlab.com responses captured 2026-09-22 (public `gitlab-org/cli`), trimmed. `CEZ_DRY_RUN=1` has a mock per method, mirroring GitHub's.

#### 3.1 GitLab driver skeleton with detect and registration
- `forge/gitlab.ts` `createGitlabDriver(repoRoot, parsed)`; `detect()` via `glab repo view --output json` (auth + existence in one call) through the shared SWR cache; caches the project `web_url` and `path_with_namespace` per root; ENOENT → ``glab CLI not found — install the GitLab CLI and run `glab auth login` ``; auth failure → `glab`'s own first line. `resolveForge` returns it for `gitlab` hosts. `evictForgeProjectCaches` covers its caches.
- Tests: `forge/gitlab.test.ts` — available, not installed, not authenticated, dry-run; `health-forge.test.ts` case where a GitLab remote reports `forge.kind: 'gitlab'`.

#### 3.1-review-fix Name GitLab in the merge-state fallback
- Found by the checkpoint-5 browser pass: with a GitLab driver registered (3.1), an MR's merge box rendered "GitHub merge state is unavailable". The merge-state/merge fallbacks now say "Merging from cezar is not supported for GitLab merge requests" for a GitLab driver; GitHub and no-forge keep the original text.

#### 3.2 GitLab listIssues and listPRs
- `glab issue list --output json --per-page N`, `glab mr list --output json --per-page N`; map to `ForgeItem` (`iid` → `number`, `web_url`, `author.username`, `labels`, `description` capped like GitHub, `user_notes_count`, `draft || work_in_progress` → `isDraft`, `checks: null` per D5). Label colors from `glab api projects/:fullpath/labels`, best-effort. Implement `listAll` too if 1.4 introduced it.
- Tests: fixture → exact `ForgeItem[]`; empty, capped, malformed payloads.

#### 3.2-review-fix Freeze the clock in the GitLab dry-run list test
- Appended mid-run: the 3.2 dry-run test compared `listAll()` with `listIssues()`/`listPRs()`, each building its mock catalog from `Date.now()`, so it failed whenever the calls straddled a millisecond. Freeze `Date` in that test.

#### 3.3 GitLab listComments with timeline events
- `glab api projects/:fullpath/{issues|merge_requests}/:iid/notes?per_page=100&sort=asc` via the bounded page loop; user notes → `ForgeComment` (`kind:'comment'`), system notes and `resource_label_events` → `ForgeTimelineEvent` through the existing allowlist (labeled/unlabeled, closed/reopened/merged, assigned, renamed where the system note is recognizable), unknown kinds dropped; caps `THREAD_ENTRY_CAP` and the 8 000-char body cap.
- Tests: fixtures producing each mapped kind, an unmapped kind dropped, cap/truncation flag.

#### 3.4 GitLab listChecks and prStatus
- `listChecks(numbers)`: per MR `glab api projects/:fullpath/merge_requests/:iid` → `head_pipeline.status` (`success`→`passing`, `failed`→`failing`, `running|pending|created|waiting_for_resource|preparing|scheduled`→`pending`, `canceled|skipped|manual`→`null`, no pipeline → `null`); bounded concurrency, cap `GH_CHECKS_MAX`.
- `prStatus(branch)`: `glab mr list --source-branch <branch> --all --output json` → newest MR → `ForgePrStatus` (`opened`→`open`, `merged`, `closed`), with checks from its pipeline.
- Tests: every status value incl. no pipeline; branch with no MR → `null`; `glab` failure → `null`.

#### 3.5 GitLab prDiff with forge-neutral caps
- Rename `GH_PR_DIFF_FILE_CAP`/`GH_PR_PATCH_CAP` to `FORGE_PR_DIFF_FILE_CAP`/`FORGE_PR_PATCH_CAP` in a neutral place (old names kept as aliases, D4). GitLab: MR detail for `sha`, then `…/merge_requests/:iid/diffs?per_page=100` pages through the bounded loop; map `new_file`/`deleted_file`/`renamed_file` to statuses, count `+`/`-` lines from `diff`, apply caps; 404 → `GithubPrNotFoundError`-equivalent (the route's existing 404 mapping).
- Tests: diff hitting each cap, renamed/added/deleted files, missing MR → 404 path.

#### 3.6 GitLab searchItems
- `glab issue list --search <q> --all --output json` / `glab mr list --search <q> --all --output json`, capped at `GH_SEARCH_MAX`, `checks: null`, `truncated` when capped.
- Tests: fixture hits, empty result, `glab` failure → `{available:false}`.

#### 3.7 GitLab viewUrl
- Base = cached `web_url` (3.1) else `origin/path` (2.3); `/-/issues/N`, `/-/merge_requests/N`, `/-/tree/<branch>`, `/-/commit/<sha>`; per-segment encoding for branch names with slashes.
- Tests: each kind, branch with slashes, non-root instance (`https://intranet/gitlab/group/repo`).

#### 3.8 Cockpit forge label, icon and copy from health.forge.kind
- Nav item label/icon and route `pageLabel` from `health.forge.kind` (`GitHub`/GitHub icon, `GitLab`/GitLab icon — add a small inline `GitlabIcon` beside `GithubIcon`); `/github` URL and the `forge` gate unchanged.
- `routes/github/github.tsx` unavailable state: title and hint driven by `forge.kind`/`reason` (no hard-coded `gh auth login` for GitLab); "Open all files on GitHub" and similar copy take the forge name. `lib/git-actions.ts` "no supported forge remote (GitHub) detected" → forge-neutral. `components/tools-menu.tsx` `forgeNote` forge-neutral.
- Tests: `nav-items` both kinds; `github.test.tsx` renders a GitLab payload and the GitLab unavailable hint; `git-actions.test.ts`, `tools-menu.test.tsx` updated.

#### 3.8-review-fix Finish forge-aware copy across the forge tab
- Found by the checkpoint-5 browser pass on a dry-run GitLab project: the nav reads "GitLab", but the page header still reads "GitHub", the detail link "open on GitHub", the tab "Pull requests", and ~20 more strings in `routes/github/` (empty states, "Found on GitHub", "Searching GitHub…", loading subtitle, thread/comment/event link labels, checks link) still name GitHub. Every user-visible forge name and PR noun in the tab follows the forge kind; GitHub output byte-identical.

#### 3.9 Forge-neutral task reference chips in the cockpit
- `web/src/lib/tasks-table.ts`: `githubRepoBase` → `forgeRepoBase(remote, kind?)` mirroring the server parse including the 2.3 subgroup/origin rules (well-known hosts only when no kind is given; any host when the server's `forge` kind says so); `synthesizeUrl`/`taskIssueUrl` emit `/-/merge_requests/N` and `/-/issues/N` for `gitlab`. `api/queries.ts` `useProjectRepoBase` passes the project's forge kind (registry `forge` + `repoUrl` preferred, as today). Document the parser-duplication rule (change both copies in one commit) in both `tasks-table.ts` and `forge/index.ts`.
- Tests: `tasks-table.test.ts` — self-managed GitLab subgroup remote → linking chip with `/-/` grammar for MR and issue; every existing GitHub case byte-identical.

### Phase 4 — Write paths and workspace integration

#### 4.1 GitLab draft merge request creation
- `createPR` on the GitLab driver mirroring `createDraftPr`: same autosave/push preflight and base-branch rule (`run.baseBranch` normalized; raw SHA → default branch), then `glab mr create --draft --source-branch <b> --target-branch <base> --title <t> --description <body> --yes`; URL taken from stdout matched against the instance host (`/-/merge_requests/\d+`); one-line human errors for missing `glab`, auth failure, no URL; dry-run fake URL on the instance.
- Tests: success, `glab` missing, auth failure, no-URL-in-output, conflicted-worktree refusal (mirroring `draft-pr-autosave.test.ts`).

#### 4.2 Clone from a GitLab remote
- `server/checkout.ts`: `parseRepoRef()` accepts `owner/repo` (GitHub, unchanged) and full URLs on any discovered forge host (GitLab subgroups allowed in the source path); the single-path-segment **target** rule and `cleanupCheckout`'s ownership proof unchanged (security invariants). Per-kind runner: `gh repo clone` (unchanged, incl. its credential helper) or `glab repo clone <url>`; unknown host → 400. Server validator message and `POST /projects/checkout` shape unchanged except the 400 text naming "a git forge repository".
- Copy: clone dialog title "Clone from a git forge", placeholder accepts a full URL; `app-shell.tsx` menu item and `settings/projects-section.tsx` hint neutral.
- Tests: `checkout.test.ts` GitLab spellings (https, ssh, subgroup), unknown host 400, `glab` missing → 503 hint, cleanup guard refusing everything it refuses today; `clone-project-dialog.test.tsx` copy.

#### 4.2-review-fix Persist the glab credential helper after a GitLab clone
- Raised by the 4.2 executor: the GitHub clone path writes `credential.https://github.com.helper = !gh auth git-credential` into the clone so later task-worktree pushes authenticate through `gh`; the GitLab path wrote nothing, so an HTTPS GitLab clone could fail its first `git push`. Mirror it with `credential.<origin>.helper = !glab auth git-credential` (glab 1.118 provides `glab auth git-credential`).

#### 4.3 Host tooling, agent env and redaction for glab
- `core/backend-detect.ts`: `probeGlab()` (`glab auth status`, hint "install the GitLab CLI and run `glab auth login` (only needed for GitLab projects)"), added to `detectEnvironment` checks as `'glab'` (optional, never an error).
- `core/agent-env.ts`: forward `GITLAB_TOKEN`, `GITLAB_HOST`, `GLAB_CONFIG_DIR`, `GITLAB_URI`, `GITLAB_API_HOST` beside `GH_ALLOW_NAMES`.
- `core/secret-redaction.ts`: GitLab prefixes beyond `glpat-`: `gloas-`, `gldt-`, `glrt-`, `glcbt-`, `glptt-`, `glft-`, `glimt-`, `glagent-`, `glsoat-`, `glffct-`, `glwt-`.
- `server-install/steps.ts`: `glab` in the dependency step per D6 (brew install; apt best-effort with a hint), remove hints.
- Tests: redaction table, agent-env allowlist, `steps.test.ts` glab branches, health checks include `glab`.

#### 4.4 Run bookkeeping learns GitLab URL shapes
- `runs/store.ts` `PR_URL_RE`/`ISSUE_URL_RE`/`refUrlRepo`/`CREATED_PR_RE` (and their call sites) learn `https://<host>/<path>/-/merge_requests/N` and `/-/issues/N` on any host, plus `glab mr create`; `runs/task-refs.ts` URL regexes likewise; `refNumberFromUrl` accepts MR URLs. GitHub wording in `web/src/lib/github-task.ts` is unchanged (so the documented coupling needs no edit).
- Tests: `store.test.ts` and `task-refs.test.ts` GitLab URLs incl. subgroups, every GitHub case unchanged.

#### 4.5 Bookmarklet matcher from discovered hosts
- `lib/bookmarklet.ts` builds its matcher from the known forge hosts (github.com always; GitLab hosts from the projects' `repoUrl`s) and matches `/-/merge_requests/N` and `/-/issues/N`; the CSP caveat is recorded as unverified for GitLab (not re-tested against a live instance in this run), and the GitHub form is emitted unchanged.
- Tests: generator for both forges; GitHub output byte-identical.

#### 4.5-ds-fix Keep the design guardian green in the bookmarklet test
- Found by the final gate's design-system pass (`packages/web/src/design-guardian.test.ts`, which runs inside `npm test`): the 4.5 tests asserted the emitted program's dialog call verbatim, and the no-native-dialogs rule scans test sources too (its allowance covers `src/lib/bookmarklet.ts` alone). The assertions now pin the message text only.

#### 4.6 GitHub-event automations require a GitHub forge
- `server.ts`: `GET /automations` `available`, the manual check, and boot `registerAutomationProject` decide "GitHub events are possible here" from `forgeKindOfRemote(remote) === 'github'` instead of `parsed.host === 'github.com'` / "any forge". Reason copy for a GitLab project: "GitHub automations need a GitHub remote". No route, status code, schema or nav change; schedule automations untouched.
- Tests: `automations-api`/`automations-gate` — a GitLab-remote project answers `available:false` for the GitHub kind, schedule create still succeeds, every existing case unchanged; GitHub Enterprise host counts as GitHub.

#### 4.7 Documentation for the second forge
- `AGENTS.md` (Zero config forge sentence; GitHub-integration routing row names `forge/` and GitLab), `BACKWARD_COMPATIBILITY.md` §2 (health `forge.kind`/`checks[].name` widen, projects `forge?`/`repoUrl?` widen, ref-status/merge degrade for GitLab, automations availability note), README prerequisites (`gh` or `glab`), `docs/reference.md` if it names `gh` as the only forge CLI. No env var added (D2), so `.env.example` is unchanged.
- Tests: `bc-route-inventory.test.ts` green; docs-only.

### Review fixes (authoritative end-of-run review)

#### 3.8-review-fix-2 Forge kind per viewed project, not the boot project
- **major**, found by the end-of-run review. The forge tab, app shell title and hand-off body read `useHealth().data?.forge?.kind`, but `/health` is workspace-level and always describes the BOOT project (`useProjectRepoBase` guards for exactly this reason, #526). In a workspace whose boot project is GitHub and whose second project is GitLab, `/p/gl/github` lists real GitLab MRs under a "GitHub"/"Pull requests" label, tells the user to run `gh auth login`, and writes "Address GitHub pull request #12" into a run's prompt for a merge request (and the mirror case). Resolve the kind per scoped project from the registry (`projects.find(...)?.forge`), falling back to health only for the boot project.

#### 4.4-review-fix Match http and on-prem ports in GitLab run-bookkeeping URLs
- **major**, found by the end-of-run review. `runs/store.ts`'s `GITLAB_PROJECT_URL` hardcodes `https:\/\/` while `parseRemote` deliberately preserves `http://` + port for on-prem instances (D3) and `runs/task-refs.ts` uses `https?`. An agent printing `http://gitlab.acme.internal:8929/group/repo/-/merge_requests/12` gets no PR chip from the store while the same URL in the prompt IS picked up by task-refs — the two halves disagree about the same run.

#### 4.4-review-fix-2 Keep the foreign-reference guard working on GitLab
- **major**, found by the end-of-run review. `isRepoScopedRef` (the #945 foreign-URL guard) returns `true` whenever the store has no `RepoHandle`, and the only producer, `resolveRepoHandle`, shells `gh repo view` — so it never answers on a GitLab project and the guard is inert there: a GitLab task citing another project's merge request adopts it as its own subject, the exact defect #945 fixed for GitHub. Resolve a handle for GitLab too (or compare against the parsed project path) and correct the stale comment.

#### 4.5-review-fix Escape every regex metacharacter in bookmarklet hosts
- **minor**, found by the end-of-run review. `escapeHostDots` escapes `.` only, and the host comes from `new URL(repoUrl).host`, which for an IPv6 instance is `[2001:db8::1]:8929`: spliced into the generated matcher it becomes a character class (wrong matches), and an unbalanced `[` makes the in-page `new RegExp` throw, breaking the bookmarklet entirely.

#### 4.6-review-fix Keep GitHub-event automations on github.com only
- **major**, found by the end-of-run review. Step 4.6 widened the automations gate from the literal host `github.com` to `forgeKindOfRemote(...) === 'github'`, which now also classifies GitHub **Enterprise** hosts. `automations/github-poller.ts` passes no `cwd` and no `--hostname`, so its `gh api`/`gh search` calls resolve to github.com, and it filters candidates against the literal `https://api.github.com/repos/<owner>/<repo>`. A project on `ghe.acme.corp/acme/widgets` would therefore be offered the GitHub trigger and then poll **github.com/acme/widgets** — a different, possibly stranger's repository — and launch agent runs from its issues. Restore the github.com-only gate for automations (the poller's API shape is github.com's); widening needs a host-aware poller first.

#### 4.3-review-fix Keep the glab probe off the health request path
- **major**, found by the end-of-run review. `probeGh` deliberately reads local config (`gh auth token`); `probeGlab` runs `glab auth status`, which validates the token against each configured host over the network, with a 10 s timeout, inside `detectEnvironment` → `healthSnapshot`. Offline with `glab` configured, `GET /api/v1/health` can blow the bookmarklet's latency budget and read as absent (CODE_REVIEW.md priority 2: offline must still work). Probe presence locally and fast; leave authentication to the off-path discovery warm-up.

#### 3.4-review-fix Bound the GitLab checks fan-out with one deadline
- **major**, found by the end-of-run review. `fetchGitlabChecks` fans out up to `GH_CHECKS_MAX` (100) per-MR detail calls at concurrency 5, each with its own 10 s timeout and no shared budget, so a slow instance can hold `GET /github/checks` for minutes and spawn 100 `glab` processes. Every other multi-call GitLab path uses `fetchBoundedPages`'s shared budget. Give the fan-out one deadline and return the glyphs resolved so far.

#### 2.2-review-fix Load the discovery cache before the first request
- **minor→major for GitHub Enterprise**, found by the end-of-run review. The discovery map is read lazily on first use, which in practice happens inside a request (`/api/v1/projects` → per-project probe), and the boot warm-up is fire-and-forget. Before this branch the `/github*` routes shelled `gh` directly, so a GHE project worked immediately; now, until discovery answers, its host is unclassified and those routes degrade to "No supported forge remote detected". Load the cache eagerly in `createApp` beside the warm-up, and state the remaining first-probe window in the docs.

#### 4.4-review-fix-3 Restore the partial forge mock in the repo-handle test
- Collision between two review fixes made in parallel: 3.4-review-fix made `forge/gitlab.ts` import `TIMELINE_BUDGET_MS` from `forge/github.ts`, while 4.4-review-fix-2's new `arm-repo-handle.test.ts` mocks that module with a bare factory — so the whole file failed to collect (`No "TIMELINE_BUDGET_MS" export is defined on the mock`). The mock now spreads `importOriginal()`.

### Phase 5 — Second-pass review fixes

Found by the independent second review of the finished branch (its report is the PR comment; severities as given there). 5.1 is the only blocker: the validation gate was red.

#### 5.1 Reclaim a lease whose age exactly equals the window
- **blocker (gate red).** `automations/store.ts` `isLeaseAbandoned` compares `now - mtimeMs > staleAfterMs`, so `acquireLease(0)` does not reclaim a lock whose mtime falls in the same millisecond, and `automations/store.test.ts` "falls back to the age rule for a lock whose pid cannot be read" fails (1 in 3 isolated runs; also red on `main`). Use `>=` so a window of `0` means "reclaim now", and make the test drive the injected clock rather than race it.

#### 5.2 Trim and validate the host in parseRemote and checkout
- **minor.** `parseRemote` captures the host as `[^/:]+`, admitting spaces and newlines; classification trims but `origin` keeps the raw bytes, so `https://gitlab.com /group/repo` passes checkout's 400 gate and a malformed origin reaches `repoUrl` on `GET /api/v1/projects`. Trim and hostname-validate at the parse, and check the host in `parseGitlabRef` as the path segments already are.

#### 5.3 Share one budget across the glab probe reads
- **minor.** `probeGlab`'s two local reads are sequential with the full timeout each, so its worst case in the health snapshot is 5 s rather than the 2.5 s the fix was sized for.

#### 5.4 Count GitLab diff lines without dropping content
- **minor.** `countDiffLines` skips any line starting with `+++`/`---` to avoid diff headers, but GitLab's `diffs` payload carries hunks only — so it drops real content lines and under-reports a diff that deletes a `---` YAML fence.

#### 5.5 Read every auth-status host line in discovery
- **minor.** `parseAuthHosts` reads unindented header lines only, though its docstring and Step 2.1 promise the `Logged in to <host>` lines too; a CLI that re-words or indents the header silently yields zero hosts and every Enterprise/self-managed project degrades with no diagnostic.

#### 5.6 Drop the non-null assertions in the GitLab adapter
- **nit.** `items[index]!`, `first!`, `counts[i]!` silence the checker where narrowing would do (CODE_REVIEW.md § TypeScript strictness); also import `GLAB_NOT_FOUND_REASON` in `checkout.ts` instead of duplicating its text.

#### 5.7 Match http GitLab hosts in the bookmarklet
- **minor.** The generated matcher is pinned to `https://` while the harvested hosts preserve `http` + port for on-prem, so a self-hosted instance is collected and can never match — the same defect 4.4-review-fix fixed in `runs/store.ts`, in the third copy of the shape.

#### 5.8 Seed gitlab.com only for a registered GitLab project
- **minor.** `gitlabHostsFromProjects` always seeds `gitlab.com`, so every production launcher gets the GitLab alternation and the wider alert, making the "GitHub output byte-identical" claim true only of a default no caller uses.

#### 5.9 Make the foreign-reference guard host-aware
- **minor.** `RepoHandle` carries no host and the GitLab URL pattern accepts any host, so two instances sharing a project path are indistinguishable: a task on `gitlab.com/acme/widgets` adopts a mirror's `gitlab.internal.corp/acme/widgets` merge request as its own subject. Before this branch only github.com URLs reached the guard.

#### 5.10 Forge-aware copy in the reference-status chip
- **minor.** `components/reference-chip.tsx` was outside the Step 3.8 sweep, so a GitLab task's chip tooltip still reads "Checking GitHub…" / "GitHub has no such number here".

#### 5.11 Correct the Second forge compatibility claims
- **minor.** Three claims in `BACKWARD_COMPATIBILITY.md` are not true of the code: `POST /github/prs/:number/merge` answers `409 {error}` rather than the in-payload degradation; `repoUrl` is not byte-identical for an `http://github.com/...` remote (D3 preserves the scheme); and the `checkoutSchema` validator message is a third 400-text change.

#### 5.12 Land the spec so its citations resolve
- **minor.** ~112 code comments plus `AGENTS.md` and `BACKWARD_COMPATIBILITY.md` cite `.ai/specs/2026-08-10-forge-provider-adapters.md`, which is committed only on `spec/forge-provider-adapters`. On this fork there is no spec PR to merge it, so the implementation branch carries the spec (rebased copy, unchanged) and every citation resolves.

## Risks

- Phase 1 is a refactor of 2 952 lines of working GitHub code; any payload delta is a bug — mitigated by keeping `forge/github.test.ts` untouched and asserting byte-identity at checkpoint 1.
- Cross-cutting (27 files): each Step is revert-clean; Phase 3/4 only add code paths for a forge that previously had none.
- No live self-managed GitLab instance is available; GitLab behaviour is proven by fixtures from real gitlab.com responses, not end-to-end against a server. The bookmarklet CSP caveat is unverified.
- Known flaky baseline test: `automations/store.test.ts` "falls back to the age rule for a lock whose pid cannot be read" fails under full-suite load on `main` and passes alone (observed 2026-09-22).

## External References

None (`--skill-url` not passed).
