# Git remote provider interface with pluggable forge adapters — GitHub + GitLab (SaaS and self-managed)

Source issue: #847

## 📝 TLDR

cezar's forge integration is shaped like an interface (`ForgeDriver`) but implemented as one hard-wired GitHub adapter that shells out to `gh`, with a one-member `ForgeKind` union, a two-row host constant, and six subsystems that reach around the seam to talk to `gh` or `github.com` directly. This spec finishes the seam and lands a second adapter: **GitLab, on gitlab.com and on self-managed/on-premise instances**, enabled by `glab` the same way GitHub is enabled by `gh`. The forge a repository belongs to is **discovered** — from the remote host, then from what the installed forge CLIs are authenticated against — never configured, so an on-premise instance at `gitlab.acme.internal` works with no config file. Everything degrades exactly as today: no CLI, no remote, unknown host all land on `forge: null` or `available: false` plus a human hint, never an error.

## 📝 Resolved assumptions (autonomous defaults)

This spec was written by an unattended run. The Open Questions below were resolved with the most reversible, smallest-scope answer available. **Review and override any of these before merge.**

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | Enabler for GitLab: the `glab` CLI, or a direct REST/GraphQL client with a personal access token? | **`glab`** | It preserves the property the whole design leans on — cezar never holds a credential (`readHostGithubToken`, the `agent-env` passthrough, `secret-redaction`, the automations poller all assume the CLI owns auth). `glab` also speaks self-managed instances natively (`GITLAB_HOST`, `glab auth login --hostname …`, per-host config). A REST fallback stays addable later without changing the seam; making cezar a credential store is not reversible in the same way. |
| Q2 | How is an on-premise instance at an arbitrary host recognized as GitLab? | **Discovered, not configured**: a well-known host table first, then a cached probe of what the installed forge CLIs are authenticated against; unknown → `forge: null` | AGENTS.md § Zero config is explicit — "when a feature seems to need configuration, the design is wrong; discover it, or default it." `glab auth status` already knows the operator's self-managed hosts, which is the same source of truth `gh` provides for GitHub Enterprise. No new required config key. |
| Q3 | Does cezar make its own HTTP request to an unknown host to sniff the forge (`GET /api/v4/version`)? | **No — CLI-only discovery** | It would add cezar's first outbound HTTP request to a host derived from repository content, plus a TLS-trust story for self-signed on-premise certificates. The CLI already solves both and is already trusted with the credential. Addable later as an extra rung if CLI-only discovery proves insufficient. |
| Q4 | Generalize GitHub Automations (`packages/cezar/src/automations/`) to GitLab in this spec? | **No — gate it on `forge.kind === 'github'`** | It is a second, independent `gh` client with its own event vocabulary, poll cursors and `github.*` template tokens; generalizing it is a spec of its own. Gating is three lines, honest (the nav item is absent rather than broken), reversible, and already how `CEZ_AUTOMATIONS` degrades. |
| Q5 | Introduce a neutral `/api/v1/forge*` route family now? | **No — the `/api/v1/github*` paths stay as they are** | BACKWARD_COMPATIBILITY.md §2 freezes them; a parallel family is new public surface serving identical payloads, which is exactly the "spec bloat" this change does not need. The routes become forge-agnostic behind the same URLs. Renaming is a later, separately reviewable decision. |
| Q6 | Rename the GitHub tab / `/github` route in the cockpit? | **No — keep the URL, drive the visible label and icon from `health.forge.kind`** | A URL rename costs a redirect, a nav-match rule and a ui-state key migration to change a string. Labelling the tab "GitLab" for a GitLab project is the whole user-visible need. |
| Q7 | One spec, or split (abstraction / GitLab adapter / clone-from-GitLab)? | **One spec, four phases** | The three parts share one seam and one discovery mechanism; splitting would fragment a single interface across three reviews and let the abstraction be designed twice. The **phases** are independently shippable, which is what the split was protecting. |

None of these carry a `⚠ NEEDS HUMAN CONFIRMATION` marker: each is reversible without a data migration or a contract removal.

## 📝 Problem Statement

`packages/cezar/src/server/forge/` was introduced by the cockpit-ui redesign spec (`.ai/specs/2026-07-14-cockpit-ui-redesign.md` §"Forge-driver seam") with an explicit promise: *"adding a forge = one new driver file behind `resolveForge`, no route or UI changes."* That promise does not currently hold. Concretely, on `origin/main` at `bbd77e9b`:

- **`ForgeKind` is `'github'`** (`forge/types.ts:12`) — a one-member union, so every consumer that narrows on it is written against a constant, including `forgeInfoSchema.kind = z.literal('github')` in `packages/contract/src/health.ts:25`, which `packages/web/src/lib/git-actions.ts` consumes directly.
- **Host resolution is a two-row constant** — `const FORGE_HOSTS: Record<string, ForgeKind> = { 'github.com': 'github' }` (`forge/index.ts:49`), read by both `forgeKindOfRemote()` and `resolveForge()`. There is no path by which `gitlab.acme.internal` becomes anything but `null`.
- **Four of the seven forge routes bypass the driver.** `GET /github`, `/github/comments/:kind/:number`, `/github/checks` and `/github/prs/:number/changes` import `fetchGithub` / `fetchGithubComments` / `fetchGithubChecks` / `fetchGithubPrDiff` from the GitHub module directly (`server.ts:4739`, `:4751`, `:4770`, `:4821`), as does `POST /runs/:id/pr` (via `server/pr.ts`). Only `/github/prs/:number/merge-state` and `/merge` go through `resolveForge` — that is the pattern the rest should follow.
- **Comment/timeline fetching and lazy checks are not on `ForgeDriver` at all**, so there is no interface for a second adapter to implement them against.
- **Five more subsystems know GitHub directly**: clone/checkout (`server/checkout.ts` accepts only `github.com` spellings and shells `gh repo clone`), host-tool detection and credentials (`core/backend-detect.ts`, `core/agent-env.ts`, `core/secret-redaction.ts`, `server-install/steps.ts`), run bookkeeping (`runs/store.ts:286-287` and `runs/task-refs.ts:31,33` hard-code `github.com` URL shapes), the cockpit (labels, copy, `lib/bookmarklet.ts`'s hard-coded matcher), and — newest and largest — **GitHub Automations** (`packages/cezar/src/automations/`, #801), a second independent `gh` client with its own poller, event vocabulary and `github.*` template tokens.

The user-visible consequence is simple: a team whose code lives on a self-managed GitLab gets plain-git cezar only. No issue/MR tab, no draft-MR from the review gate, no MR chip on a task, no clone-from-forge, no checks glyphs. Everything cezar does *around* the forge still works, which is what makes the gap worth closing rather than working around: the orchestrator is already useful there, and one adapter unlocks the rest.

On-premise is the specific pressure. GitLab self-managed is the common enterprise deployment, and it is exactly the case a hard-coded host table cannot serve — the instance lives at a hostname only the operator knows.

## 📝 Proposed Solution

Three moves, in order:

1. **Finish the seam.** Widen `ForgeKind`, add the missing capabilities to `ForgeDriver` as *optional* methods (the precedent `prMergeState?`/`mergePR?`/`prDiff?` already set), route the remaining four routes plus `POST /runs/:id/pr` through `resolveForge`, and extract the reusable CLI plumbing (cwd-scoped exec, ENOENT→install hint, caches, bounded pagination) out of `forge/github.ts` into a shared `forge/cli.ts`. This phase ships with GitHub as the only adapter and is behaviourally a no-op — which is the point: it is reviewable on its own, and every existing test is the regression suite.

2. **Discover the forge instead of configuring it.** Replace the const host table with a small registry plus a discovery ladder (below). No new required config key; the answer for `github.com` stays a synchronous string lookup, and an on-premise host is learned from the CLI that is already authenticated against it, cached under `~/.cache/cez/`.

3. **Add the GitLab adapter.** `packages/cezar/src/server/forge/gitlab.ts`, `glab`-backed, mapping GitLab's JSON into the existing normalized cockpit shapes (`ForgeItem`, `ForgeComment`, `ForgeTimelineEvent`, `ForgePrStatus`, `ForgePrDiffResult`), so the wire contract in `packages/contract/src/github.ts` is untouched and the cockpit renders a GitLab project through the code it already has.

### Alternatives considered

- **A config key listing forge hosts** (`forge: { hosts: [{ host, kind }] }`). Rejected on AGENTS.md § Zero config: it turns a working default into a knob, and it is a knob every on-premise user would have to find before cezar did anything for them. The discovery ladder answers the same question from data that already exists on the machine. An optional override key may be added later if discovery is ever wrong, but it must not be the mechanism.
- **A direct REST/GraphQL client per forge, dropping the CLI dependency.** Rejected as the default (Q1): it makes cezar a credential holder — a different security posture affecting `agent-env` passthrough, secret redaction, hosted-mode disclosure rules and the installer story — to remove an install step that already degrades quietly. It stays available as a later, additive rung behind the same driver interface.
- **A neutral `/api/v1/forge*` route family replacing `/api/v1/github*`.** Rejected (Q5): the v1 paths are frozen, so this is pure addition of surface serving identical payloads.
- **Generalizing Automations in the same change** (Q4). Rejected as scope: it doubles the spec and touches an independently-gated feature.

### Research — what the market does

- **`gh` and `glab` are deliberately parallel tools.** `glab` was built as GitLab's answer to `gh`, down to the verb grammar (`glab issue list`, `glab mr create`, `glab api`) and JSON output flags. That parallelism is what makes a shared `forge/cli.ts` plumbing layer honest rather than a false abstraction: the two adapters really do differ mainly in subcommand names and response shapes, not in execution model, failure modes or auth handling.
- **Self-managed support is a first-class `glab` feature**, not an add-on: `GITLAB_HOST`, `glab auth login --hostname`, and a per-host config file. This is why CLI-only discovery (Q3) is sufficient — the operator has already told `glab` about their instance, and cezar can simply ask.
- **Tools that solved this well pick a small normalized model and map into it** (the Forge abstractions in Gitea's mirroring layer, `hub`/`lab`-era wrappers, and IDE VCS-provider plugins all converge on: item list, item thread, PR/MR state, diff, web URL). cezar already has that model — `ForgeItem`/`ForgeComment`/`ForgeTimelineEvent` — which is the single biggest reason this is a tractable change.
- **What they carry that cezar should skip:** provider-agnostic *write* surfaces beyond opening a PR/MR (label management, review submission, approval rules), and per-provider settings UIs. cezar's forge integration is read-mostly plus one write (draft PR) plus one gated write (merge); keeping it that way is what keeps the interface small.
- **What they get right that this spec adopts:** capability negotiation rather than lowest-common-denominator flattening. GitLab has no GitHub-style `isDraft` boolean semantics, no identical timeline event vocabulary, and a different CI model. Optional driver methods plus honest "unavailable" answers beat pretending every forge has every feature.

## 📝 Architecture

### Components

```
packages/cezar/src/server/forge/
  types.ts     # ForgeDriver + normalized shapes. ForgeKind widens to 'github' | 'gitlab'.
               # New OPTIONAL methods: listComments?(), listChecks?()
  cli.ts       # NEW — shared adapter plumbing: cwd-scoped execFile, ENOENT→install hint,
               #       keyed caches, the bounded-pagination budget loop
  discovery.ts # NEW — the host→kind ladder + its cache (see below)
  index.ts     # registry: forgeKindOfRemote() (sync), resolveForge() (sync), plus
               #       warmForgeDiscovery() (async, fire-and-forget)
  github.ts    # unchanged behaviour, re-homed onto cli.ts
  gitlab.ts    # NEW — glab-backed adapter
```

### Forge discovery (replaces the const host table)

Three rungs, cheapest first. The contract of the sync entry points is unchanged: they always answer immediately, from a table or a warm cache.

1. **Well-known hosts** — a constant map, `github.com → github`, `gitlab.com → gitlab`. Pure string work, no I/O. This is what keeps `forgeKindOfRemote()` synchronous for the per-project registry probe (#698) and keeps the zero-config SaaS path exactly as fast as today.
2. **Warm discovery cache** — a `host → kind | 'none'` map persisted under `~/.cache/cez/forge-hosts.json`. Read synchronously at boot; written by rung 3. Deleting it costs one re-probe, nothing else (AGENTS.md § Zero config: state may be *written*, never *required*).
3. **CLI-authenticated hosts (async, off the request path)** — `warmForgeDiscovery()` asks each installed forge CLI which hosts it is authenticated against (`gh auth status`, `glab auth status`), parses the host list, and records `host → kind` in the cache. It runs at boot and on a bounded interval, never inside a request, following the exact stale-while-revalidate discipline `detectGithubCached()` already uses for availability.

An unknown host answers `null` — `forge: null`, plain-git features only, exactly today's behaviour for every non-GitHub remote. **No rung ever makes an HTTP request from cezar** (Q3).

`parseRemote()` gets one correctness fix independent of discovery: it takes the last two path segments, so a GitLab **subgroup** remote (`gitlab.com/group/sub/repo`) yields `owner: 'sub'` and silently drops the group. The parsed remote must carry the full project path (`group/sub/repo`) for GitLab; `ParsedRemote` grows an additive `path` field and `owner`/`repo` keep their current meaning for GitHub.

### Driver interface changes

`ForgeKind` widens to `'github' | 'gitlab'`. Two methods move onto the driver as **optional**, matching `prMergeState?`/`mergePR?`/`prDiff?`:

```ts
/** The conversation thread for one issue/PR — comments, reviews and timeline events. */
listComments?(kind: 'issue' | 'pr', number: number, opts?: { refresh?: boolean }): Promise<ForgeCommentsData>;
/** Lazy CI glyphs for on-screen PR rows (#664). */
listChecks?(numbers: number[]): Promise<ForgeChecksData>;
```

A route whose driver lacks the method answers the family's existing in-payload degradation (`{ available: false, reason }`) — never a 5xx, never a 404 for a capability gap.

### Caching

`forge/github.ts` currently holds module-level caches, one of which is a **single-slot** availability cache (`detectCache = { at, repoRoot, result }`, `github.ts:1530`) checked with `detectCache.repoRoot === repoRoot`. It is per-module, so a second adapter cannot poison it — but with more than one project open it already thrashes, and every miss triggers a background revalidate. `forge/cli.ts` replaces it with a small keyed LRU (`${kind}:${repoRoot}`) shared by both adapters, preserving the stale-while-revalidate semantics `detectGithubCached()` documents (serve the last known value, revalidate off the request path, `null` only before the first probe warms — the anti-flicker guarantee for the sidebar nav item). `evictGithubProjectCaches()` becomes `evictForgeProjectCaches(repoRoot)` and clears every kind for that root; the old name stays as a delegate.

### What is reused, not rebuilt

- The normalized cockpit shapes (`ForgeItem`, `ForgeComment`, `ForgeTimelineEvent`, `ForgePrStatus`, `ForgePrDiffResult`, `ForgePrMergeState`) — adapters map into them; **the wire contract does not change**.
- The degradation doctrine: availability lives *in the payload*, never in the status code.
- zod at the boundary, per adapter, over that adapter's own raw JSON.
- The route-family chaining, middleware validators and dual mounting (`/api/v1` + `/api/v1/p/:projectId`) required by AGENTS.md § The HTTP API.

## 📝 Data Model

No entities, no migrations, no schema versioning. Two additive state items:

| Item | Location | Shape | If deleted |
|---|---|---|---|
| Forge discovery cache | `~/.cache/cez/forge-hosts.json` | `{ version: 1, hosts: { "<host>": "github" \| "gitlab" \| "none" }, updatedAt: string }` | Re-probed on next boot; zero user impact |
| Per-project forge classification | already exists — `GET /api/v1/projects` `forge?` (#698) | additive value `'gitlab'` on an existing optional key | n/a |

No credentials are read, stored, forwarded or logged by cezar: `glab` owns GitLab auth exactly as `gh` owns GitHub auth. `core/secret-redaction.ts` gains the GitLab PAT patterns (`glpat-…`, and the CI job-token shapes) so a token that appears in agent output is redacted before it reaches the NDJSON transcript — a defensive addition, not a storage decision.

## 📝 API Contracts

**No route is added, removed or renamed** (Q5). Every `/api/v1/github*` path keeps its exact shape from BACKWARD_COMPATIBILITY.md §2 and answers for whichever forge the project is on:

| Route | Change |
|---|---|
| `GET /api/v1/github` | handler resolves the driver instead of importing `fetchGithub`; payload identical |
| `GET /api/v1/github/comments/:kind/:number` | via `forge.listComments?`; missing method → `{ available: false, reason }` |
| `GET /api/v1/github/checks` | via `forge.listChecks?`; same degradation |
| `GET /api/v1/github/prs/:number/changes` | via `forge.prDiff?`; same degradation |
| `GET /api/v1/github/prs/:number/merge-state`, `POST …/merge` | unchanged (already driver-routed) |
| `POST /api/v1/runs/:id/pr` | via `forge.createPR`; error strings become adapter-supplied |
| `GET /api/v1/health` | `forge.kind` may now be `'gitlab'` |
| `GET /api/v1/projects` | per-project `forge?` may now be `'gitlab'` |

Contract package changes, both additive widenings in `packages/contract/src/`:

- `health.ts` — `forgeInfoSchema.kind: z.literal('github')` → `z.enum(['github', 'gitlab'])`; `backendCheckSchema.name` gains `'glab'`.
- `projects.ts` — the per-project `forge?` value widens to the same enum.

Per AGENTS.md § The HTTP API, both are schema-first in `packages/contract` with types inferred, and `contract-parity*.test.ts` asserts both directions.

### Adapter → normalized mapping (GitLab)

| Cockpit concept | `glab` source | Notes |
|---|---|---|
| `listIssues` | `glab issue list -F json` | `iid` is the number the UI shows, not `id` |
| `listPRs` | `glab mr list -F json` | `draft`/`work_in_progress` → `isDraft` |
| `listComments` | `glab api projects/:id/issues/:iid/notes`, `…/merge_requests/:iid/notes` | system notes → `ForgeTimelineEvent`; user notes → `ForgeComment` |
| timeline events | `…/resource_label_events`, `…/resource_milestone_events`, plus system notes | mapped into the existing `ForgeTimelineEventKind` allowlist; **unknown kinds are dropped, never rendered** (the allowlist rule already documented in `types.ts`) |
| `listChecks` / `checks` glyph | pipeline status on the MR payload | `success`→`passing`, `failed`→`failing`, `running`/`pending`/`created`→`pending`, absent→`null` |
| `prDiff` | `glab api projects/:id/merge_requests/:iid/changes` | same file/patch caps as GitHub (`GH_PR_DIFF_FILE_CAP`, `GH_PR_PATCH_CAP`) — renamed to forge-neutral constants |
| `prStatus(branch)` | `glab mr list --source-branch <branch> -F json` | `merged`/`closed`/`opened` → the existing three states |
| `createPR` | `glab mr create --draft --source-branch --target-branch --title --description` | URL taken from `glab`'s stdout, matched against the **instance** host, not a hard-coded `github.com` |
| `viewUrl` | pure | `<scheme>://<host>/<full/path>/-/{issues,merge_requests,tree,commit}/<ref>` — note the `/-/` infix and that the instance origin comes from the parsed remote, not a constant |
| `detect` | `glab auth status` | ENOENT → "install the GitLab CLI and run `glab auth login`" |

## 📝 UI/UX

Only what is unique; the tab, list, thread and detail panes render unchanged from the normalized shapes.

- **Nav item and page label** read from `health.forge.kind`: `GitHub` + GitHub icon, or `GitLab` + GitLab icon. The route stays `/github` (Q6) and the `forge`-gated visibility rule in `components/nav-items.ts` is untouched.
- **The unavailable state** (`packages/web/src/routes/github/github.tsx`) currently hard-codes `gh auth login` in its copy. It becomes `forge.reason`-driven, so a GitLab project sees the GitLab hint the adapter produced. This is the one place the cockpit asserts a tool name.
- **`lib/git-actions.ts`** copy `"no supported forge remote (GitHub) detected"` becomes forge-neutral; the policy logic is unchanged.
- **Clone dialog** (`components/clone-project-dialog.tsx`): title becomes "Clone from a git forge", and the placeholder accepts a full URL on any discovered host in addition to `owner/repo`.
- **`lib/bookmarklet.ts`** generates its location matcher from the discovered hosts rather than a literal `github.com`, and matches GitLab's `/-/merge_requests/N` and `/-/issues/N` paths. The existing CSP caveat (documented in that file for github.com) must be re-verified against a real GitLab instance before the GitLab bookmarklet is advertised; if it fails the same way, the file says so and the generator still emits the GitHub form.
- **Automations** (Q4): the nav item and route are gated on `forge.kind === 'github'` in addition to the existing `capabilities.automations` gate. A GitLab project sees no Automations item — absent, not broken.

## 📝 Edge Cases & Failure Scenarios

| Scenario | Behaviour |
|---|---|
| `glab` not installed | `detect()` → `{ available: false, reason: 'glab CLI not found — install the GitLab CLI and run `glab auth login`' }`. Tab renders the hint; nav item hidden. Identical to today's `gh`-missing path. |
| `glab` installed but not authenticated to this host | `available: false` with `glab`'s own first line as the reason. |
| On-premise host never seen by any CLI | Discovery answers `null` → `forge: null` → plain-git cezar. The Git tab, diffs, commit and push all still work. |
| Discovery cache stale (host re-pointed, `glab` logged out) | Entries carry `updatedAt` and are revalidated on the same bounded interval; a driver whose `detect()` fails answers `available: false` regardless of what discovery believed, so a stale cache degrades to a hint, never to a wrong tab. |
| Self-signed CA on the instance | Owned by `glab` and the system trust store — cezar makes no HTTPS request of its own (Q3). If `glab` refuses the certificate, its error text becomes the `reason`. |
| Instance at a non-root path (`https://intranet/gitlab/`) | Carried by the remote URL and by `glab`'s host config; `viewUrl` builds from the parsed remote origin + path, so it composes correctly. |
| GitLab subgroups | `parseRemote()` fix (above); tested explicitly, including 3-level nesting. |
| Timeline event kind GitLab has and cezar does not | Dropped by the existing allowlist — the documented rule in `types.ts`. A new event type can never crash or clutter the thread. |
| MR with no pipeline | `checks: null` (no CI configured) — distinct from an absent field (query failed), the distinction `types.ts` already documents. |
| Rate limiting / slow instance | The shared bounded-pagination budget from `cli.ts` (deadline-aware, minimum viable page window) applies unchanged; a page that cannot finish is not spawned. |
| A repo whose remote is GitHub Enterprise | Discovered as `github` via `gh auth status` and served by the existing GitHub adapter. `viewUrl` must build from the parsed remote origin instead of the `https://github.com` literal it uses today — a small correctness win this change gets for free. |
| Two projects on different forges open at once | Caches are keyed `${kind}:${repoRoot}`; each project's availability is its own. |
| `POST /runs/:id/pr` on a GitLab project | Same flow — final autosave, push, then `glab mr create --draft`. The PR-URL scrape matches the instance host, not `github.com`. |
| `CEZ_DRY_RUN=1` | Each adapter keeps its own mock path, as `forge/github.ts` does today, so the whole flow stays testable without a network. |

## 📝 Risks & Impact Review

**Blast radius.** High by SDLC.md's rule — the HTTP API surface plus broad cross-cutting edits — but the change is arranged so the risky part is boring: Phase 1 is a behaviour-preserving refactor of GitHub-only code, verified by the existing 1 521-line `forge/github.test.ts` and the contract-parity and route-parity suites. Phases 2–4 add code paths that only execute for a forge that previously produced no code path at all.

**Protected surfaces touched** (BACKWARD_COMPATIBILITY.md §2):

- Every `/api/v1/github*` shape — **unchanged**, and asserted so by `contract-parity*.test.ts`, `route-parity.test.ts` and `bc-route-inventory.test.ts`. No path is added, renamed or removed.
- `forgeInfoSchema.kind` and `backendCheckSchema.name` widen. Additive on the wire; a **breaking type change** for every consumer narrowing on the literal, so those move in the same commit (`packages/web/src/lib/git-actions.ts` and any `ForgeInfo` consumer).
- `GET /api/v1/projects` `forge?` gains a value on an existing optional key.
- No config key is required; no state file must be authored or migrated.

**The zero-config default path** (AGENTS.md § Changing a mechanism that already works — *diff the default path, not the feature*): with every new mechanism at its shipped default, a GitHub repo with `gh` installed and no config must behave **byte-identically** to today — same routes, same payloads, same caches warm at the same times, same nav item, same hints. That is a stated acceptance criterion of Phase 1, not a hope: Phase 1 ships with no GitLab adapter registered at all, so any behavioural delta it produces is a bug in the refactor.

**What the old mechanism is load-bearing for.** Two guarantees are easy to lose while moving this code and are called out so they get replaced, not just moved: (1) `detectGithubCached()`'s stale-while-revalidate is the **anti-flicker** contract for the sidebar nav item (#508) — returning `null` on every cache expiry blinks the GitHub item out; the keyed LRU must preserve "serve stale, revalidate behind". (2) `forgeKindOfRemote()` is **synchronous and I/O-free** because the per-project registry probe (#698) calls it for every project on every listing; discovery must never make it async or make it shell out.

**Rollback.** Per phase, and each phase is a revert-clean commit. Phase 1 reverts to the direct imports. Phases 2–4 revert by removing the GitLab row from the well-known host table and the adapter registration — discovery then classifies every GitLab host as `null` and cezar is exactly the plain-git cezar it is today for those repos. No state to unwind: the discovery cache is disposable, and nothing was written to the forge.

**Deliberately not addressed** (each is a separate spec): generalizing Automations, a neutral `/api/v1/forge*` family, a token-based (CLI-less) transport, and adapters for Bitbucket / Gitea / Forgejo / Azure DevOps. The interface must not preclude them; this spec does not build them.

## 📋 Phasing

- **Phase 1 — Finish the seam (GitHub only, no user-visible change).** Widen the types, extract `forge/cli.ts`, route the remaining routes through the driver. Independently shippable; its acceptance test is "nothing changed".
- **Phase 2 — Discovery.** Registry + ladder + cache, `parseRemote` subgroup fix, `viewUrl` built from the parsed origin. Still GitHub-only in effect. Independently shippable.
- **Phase 3 — The GitLab adapter (read paths).** `forge/gitlab.ts` covering `detect`, `listIssues`, `listPRs`, `listComments`, `listChecks`, `prDiff`, `prStatus`, `viewUrl`, plus the cockpit label/copy work. This is the phase that lights the tab up. Independently shippable.
- **Phase 4 — Write paths and workspace integration.** Draft-MR creation, clone-from-GitLab, host-tool detection/installer/redaction, run-bookkeeping URL patterns, bookmarklet, the Automations gate. Independently shippable.

## 📋 Implementation Plan

### Phase 1 — Finish the seam

1. **Widen `ForgeKind` and add the optional capability methods.** In `packages/cezar/src/server/forge/types.ts`: `ForgeKind = 'github' | 'gitlab'`; add `listComments?()` and `listChecks?()` with the signatures above; add `ForgeChecksData` if the existing `GithubChecksData` is not already forge-neutral (re-home it from `forge/github.ts` if so). *Test:* `packages/cezar/src/server/forge/index.test.ts` compiles and the existing suite is green; a type-level test asserts a driver may omit the optional methods.
2. **Widen the contract schemas.** `packages/contract/src/health.ts` (`forgeInfoSchema.kind`, `backendCheckSchema.name` += `'glab'`) and `packages/contract/src/projects.ts` (per-project `forge?`). Update every consumer that narrows on the literal, notably `packages/web/src/lib/git-actions.ts`. *Test:* `contract-parity*.test.ts`, `api-types.test.ts` and `packages/web`'s typecheck all green.
3. **Extract `forge/cli.ts`.** Move the cwd-scoped `execFile` helper (`github.ts:268`), the ENOENT→install-hint mapping, the bounded-pagination budget loop (`TIMELINE_BUDGET_MS` / `TIMELINE_MAX_PAGES` / `TIMELINE_MIN_PAGE_MS`) and a keyed LRU cache into `forge/cli.ts`; re-home `forge/github.ts` onto it, replacing the single-slot `detectCache` with the keyed one while preserving stale-while-revalidate. Rename `evictGithubProjectCaches` → `evictForgeProjectCaches` with a delegate under the old name. *Test:* the whole of `forge/github.test.ts` unchanged and green; a new test asserts two repo roots do not evict each other's availability, and that an expired entry still returns the stale value while revalidating (the #508 anti-flicker guarantee).
4. **Route `GET /github` through the driver.** In `server.ts`'s `githubRoutes` chain, resolve via `resolveForge(await getRepoInfo(repoRoot))` and call `listIssues`/`listPRs`; keep the exact response assembly so the payload is byte-identical. *Test:* existing route tests green; add one asserting a `null` forge answers the documented unavailable payload rather than throwing.
5. **Route `GET /github/comments/:kind/:number` through `forge.listComments?`.** Move `fetchGithubComments` onto `createGithubDriver`. *Test:* the existing comments/timeline tests green through the driver; a driver without the method answers `{ available: false, reason }`.
6. **Route `GET /github/checks` through `forge.listChecks?`.** Same treatment for `fetchGithubChecks`; keep the `GH_CHECKS_MAX` cap and the 400s on a malformed `prs` list exactly as they are. *Test:* the #664 tests green; capability-absent degradation covered.
7. **Route `GET /github/prs/:number/changes` through `forge.prDiff?`** and `POST /runs/:id/pr` through `forge.createPR`, keeping `GithubPrNotFoundError`'s 404 mapping and the 409-with-`manual` fallback respectively. *Test:* `forge/github-pr-diff.test.ts` and `forge/draft-pr-autosave.test.ts` green; the review-gate e2e path green.
8. **Assert the no-op.** Run the full validation gate and confirm route parity and BC inventory are unchanged. *Test:* `route-parity.test.ts`, `bc-route-inventory.test.ts`, `health-forge.test.ts`, and the `packages/web/e2e/github.e2e.ts` smoke.

### Phase 2 — Discovery

9. **Add `forge/discovery.ts`.** Well-known host map (`github.com`, `gitlab.com`), the `~/.cache/cez/forge-hosts.json` reader/writer (zod-validated, corrupt file → empty map, never a throw), and `warmForgeDiscovery()` parsing `gh auth status` / `glab auth status`. *Test:* unit tests over each parser with real CLI output fixtures, a corrupt cache file, and an absent cache directory.
10. **Wire discovery into `forge/index.ts`.** `forgeKindOfRemote()` and `resolveForge()` consult well-known → warm cache → `null`, and stay synchronous and I/O-free; `warmForgeDiscovery()` is called at boot and on the existing bounded interval, never from a request. *Test:* `forge/index.test.ts` covers an on-prem host present in the cache, absent from it, and a cache entry of `'none'`.
11. **Fix `parseRemote` for subgroups and add `path`.** `ParsedRemote` gains `path` (the full project path); `owner`/`repo` keep their meaning. *Test:* table test over `gitlab.com/group/repo`, `gitlab.com/group/sub/repo`, 3-level nesting, scp-like and port-bearing spellings, plus every existing GitHub case unchanged.
12. **Build `viewUrl` from the parsed origin.** Replace the `https://github.com` literal in `createGithubDriver().viewUrl` with the parsed remote's origin, so GitHub Enterprise links resolve correctly. *Test:* `viewUrl` cases for github.com and an enterprise host.

### Phase 3 — The GitLab adapter (read paths)

13. **`forge/gitlab.ts` skeleton + `detect()`.** `glab auth status`, ENOENT hint, `CEZ_DRY_RUN` mock path, registration in the resolver. *Test:* `forge/gitlab.test.ts` — available, not-installed, not-authenticated, dry-run.
14. **`listIssues` / `listPRs`.** `glab issue list -F json`, `glab mr list -F json`, zod schemas over GitLab's payloads, mapping to `ForgeItem` (`iid`, `draft`, pipeline→`checks`, label colors). *Test:* fixture JSON → exact `ForgeItem[]`; empty, capped and malformed payloads.
15. **`listComments`.** Notes + resource-label events + system notes → `ForgeComment[]` / `ForgeTimelineEvent[]` through the existing allowlist and caps (`THREAD_ENTRY_CAP`, the 8 000-char body cap). *Test:* fixtures producing every mapped event kind, plus an unmapped kind that must be dropped.
16. **`listChecks` and `prStatus`.** Pipeline status → the glyph enum; `glab mr list --source-branch` → `ForgePrStatus`. *Test:* every status value including "no pipeline" → `null`.
17. **`prDiff`.** `…/merge_requests/:iid/changes` with the shared file/patch caps. *Test:* a large diff hitting each cap; a missing MR → the 404 mapping.
18. **`viewUrl` for GitLab.** `/-/` infix, instance origin from the parsed remote, per-segment encoding for branch names. *Test:* issues, MRs, branches with slashes, commits, and a non-root instance path.
19. **Cockpit label and copy.** Nav label/icon and page label from `health.forge.kind`; the unavailable-state copy from `forge.reason`; `git-actions.ts` copy made forge-neutral. *Test:* `nav-items` unit tests for both kinds; `github.test.tsx` renders a GitLab payload; `packages/web/e2e` covers the GitLab-shaped tab.

### Phase 4 — Write paths and workspace integration

20. **`createPR` for GitLab.** `glab mr create --draft …` with the base-branch rule the GitHub path uses (`run.baseBranch` normalized, raw SHA falls back to the default branch); URL matched against the instance host. *Test:* success, `glab` missing, auth failure, no-URL-in-output, and the conflicted-worktree refusal — mirroring `draft-pr-autosave.test.ts`.
21. **Clone from a GitLab remote.** `checkout.ts`: `parseRepoRef()` takes the discovered host set instead of hard-coding `github.com` (keeping the single-path-segment target rule and `cleanupCheckout`'s ownership proof **unchanged** — they are security invariants); `ghCloneRunner` becomes a per-kind runner (`glab repo clone`, else `git clone` of the remote URL). Dialog copy updated. *Test:* `checkout.test.ts` for GitLab URL spellings, an unknown host (400), and the cleanup guard still refusing everything it refuses today.
22. **Host tooling, credentials and installer.** `core/backend-detect.ts`: `probeGlab()` and the widened `BackendCheck['name']`; `readHostGithubToken()` → `readHostForgeToken(kind)`. `core/agent-env.ts`: forward `GITLAB_TOKEN` / `GITLAB_HOST` / `GLAB_*`. `core/secret-redaction.ts`: `glpat-…` and GitLab CI job-token patterns. `server-install/steps.ts`: install/remove `glab` on apt and brew. *Test:* redaction table test; `backend-detect` probe tests; installer step tests.
23. **Run bookkeeping URL patterns.** `runs/store.ts` (`PR_URL_RE`/`ISSUE_URL_RE` and their call sites) and `runs/task-refs.ts` learn `/-/merge_requests/N` and `/-/issues/N` on any discovered host. If the hand-off wording in `packages/web/src/lib/github-task.ts` is changed to say "merge request", `task-refs.ts` must change **in the same commit** — the coupling is documented in both files. *Test:* `task-refs` and `store` regressions over GitLab URLs, plus every existing GitHub case unchanged.
24. **Bookmarklet and the Automations gate.** `lib/bookmarklet.ts` generates its matcher from the discovered hosts (re-verifying the CSP caveat against a real instance and documenting the outcome); Automations nav item and routes additionally gated on `forge.kind === 'github'`. *Test:* bookmarklet generator unit tests for both forges; an automations test asserting a GitLab project hides the item and the routes still answer their existing gated response.
25. **Full gate and documentation.** Run every command in `.ai/agentic.config.json`; update `AGENTS.md` § Zero config's forge sentence, `BACKWARD_COMPATIBILITY.md` §2 for the widened enums, and the README's `gh` prerequisite line to name both CLIs. *Test:* the validation gate green end to end.
