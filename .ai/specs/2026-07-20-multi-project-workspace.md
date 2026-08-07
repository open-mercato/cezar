# Multi-project workspace

> Status: draft
> Supersedes: PR #406 *multi-project switcher* (closed unmerged — the per-process
> instances + loopback-proxy design is abandoned; this spec replaces it with a
> single-process workspace).
> Mockups: [sidebar](assets/2026-07-20-multi-project-workspace/sidebar.html) ·
> [add project](assets/2026-07-20-multi-project-workspace/add-project.html) ·
> [new task](assets/2026-07-20-multi-project-workspace/new-task-project.html) ·
> [global settings](assets/2026-07-20-multi-project-workspace/settings-global.html)
> — light/dark screenshots alongside each `.html`.
> Implementation evidence: [independent project folders](assets/2026-07-20-multi-project-workspace/settings-project-roots-dark.png).

## TLDR

One `cezar serve` becomes a **workspace over all of the user's projects**. A
per-user registry in `~/.cezar/config.json` remembers every project cezar has
ever run in — running cezar in an unknown folder adds it. The cockpit sidebar
lists every project as a collapsible group with its own Tasks / Git / GitHub /
Skills / Workflows / Settings, the ten most recent tasks and a "More…" link;
every page URL carries the project id (`/p/<projectId>/…`) so any pane
deep-links. Projects can also be added from the GUI: browse the server's home
folder from a configurable browse root, or `gh`-clone a GitHub URL into an independent checkout root
(default `~/cezar/projects/<name>`). Global preferences — appearance,
notifications, resources — move from per-repo files into `~/.cezar`, and a new
boot-time config-migration step upgrades existing installs so the user running
the new version notices no difference.

## Problem Statement

cezar is per-repo by construction: `repoRoot` is resolved once at boot
(`src/index.ts:82-85`) and closed over by every route (`createApp`,
`src/server/server.ts:363-365`). Working on three repos means three processes,
three ports, three cockpits — and each cockpit is blind to the others:

- **No memory of projects.** Nothing records where cezar has run. Every repo is
  rediscovered from `cwd` and forgotten on exit.
- **The UI has zero project identity.** One `health.repo`, flat routes
  (`/tasks/:id`), global localStorage keys. A URL never says which project it
  belongs to, so nothing project-scoped can be bookmarked or shared.
- **Settings that are really per-user live per-repo.** Appearance,
  notifications and resource caps (`maxParallel`, `memoryLimitMb`) are stored
  in `.ai/cezar/{config,ui-state}.json` of whichever repo the process happens
  to serve — the same knob has N values on one machine, and resource caps that
  exist to protect the *host* are enforced per-repo, so N cockpits multiply
  them.
- **The previous answer (PR #406) was per-process instances behind a loopback
  proxy.** It kept process isolation but added a registry of *live* processes,
  a proxy with SSE subtleties, version-skew rules, and still required one
  process per repo. The user has rejected that direction: one server should
  simply host all projects.

## Proposed Solution

**One process, N projects, in-process.** The server keeps one HTTP listener and
one cockpit bundle, and multiplexes projects by an explicit id in the path:

- `~/.cezar/config.json` — the per-user **workspace config**: schema version,
  global settings, and the **project registry**. Booting in an unregistered
  folder appends it (state is *written, never required* — delete the file and
  it rebuilds from the next boots).
- A **`ProjectContext`** per registered project — `{ store, manager, dataDir,
  config }` — built from the same constructors the process uses today
  (`RunStore.open`, `new RunManager`); the exploration confirmed these layers
  are already fully parameterized by `repoRoot`/`dataDir` and need no changes.
  Contexts live in a `Map<projectId, ProjectContext>`, created lazily.
- **Project-scoped API + UI routes**: `/api/p/:projectId/*` mirrors today's
  `/api/*`; the cockpit mounts under `/p/:projectId/*`. Legacy unprefixed
  routes keep working against the **boot project** (the repo `cezar` was
  started in), which preserves every protected surface in
  `BACKWARD_COMPATIBILITY.md` including the bookmarklet deep-link grammar.
- All project *state* stays where it is — `.ai/cezar/` inside each repo. Only
  user-level preferences move to `~/.cezar`. No task data migrates at all.

### Why this shape, and not the alternatives

**Rejected — per-process instances + reverse proxy (PR #406).** Explicitly
abandoned by the user. Beyond that decision it also carried real cost: version
skew between one project's bundle and another's server, SSE proxy corrections,
pid-liveness pruning, and it never solved "cezar knows all my projects when
none of them are running".

**Rejected — N ports, one launcher.** A thin `cezar workspace` that spawns one
server per project keeps today's code untouched but re-imports every #406
problem (port discovery, cross-origin, N processes to babysit) and makes
"one sidebar over everything" impossible without a proxy again.

**Chosen — one server, project-scoped routes.** The exploration
(`src/server/server.ts`, `src/runs/store.ts`, `src/workflows/run.ts`) shows the
seams already exist: stores, managers, worktree helpers, config, git and forge
code all take `repoRoot` per call or per instance. The genuinely global state
is a short, closed inventory — six items, all fixable:

1. the todos watcher latches to the first `dataDir` (`src/todos.ts:161-172`);
2. the process-usage sampler is module-global
   (`src/core/process-usage.ts:110-113`);
3. `/api/health` advertises exactly one repo (`server.ts:441-471`);
4. the GitHub list cache is a single process-global `GithubData` **not keyed
   by `repoRoot`** (`src/server/forge/github.ts:194`) — within its 60s TTL,
   project B would be served project A's (possibly private) issues/PRs;
5. the GitHub comments cache is keyed by `"kind#number"` only
   (`forge/github.ts:420`) — two projects each having a PR #42 collide;
6. the team-skills cache is module-global (`src/skills-remote.ts:403-404`) —
   the first repo's `skillsRepos` set would be served to every project.

Items 4–6 are also **cross-project data-isolation bugs** the moment a second
project exists, so they are fixed (keyed per project) in the same phase that
introduces the second project, with regression tests that one project's data
is never served under another's scope. Everything else is closure plumbing.

## Architecture

### What is reused (unchanged)

- `RunStore.open(dataDir, opts?)` — one store per project, exactly as today
  (`store.ts:266`). Stores stay separate event buses; they are never merged.
- `RunManager(store, repoRoot)` — one manager (queue, workers, worktrees) per
  project (`run.ts:245-249`). Worktrees stay at
  `<repo>/.ai/cezar/worktrees/<runId>`.
- `loadConfig(repoRoot)`, skills discovery, workflow loading, `getRepoInfo`,
  forge/PR code — already per-call on `repoRoot` *except their module-level
  caches* (singleton inventory items 4–6 above), which get keyed per project.
- The static cockpit shell — one bundle for all projects; any `/p/…` SPA route
  cold-loads it via the existing catch-all. `src/server/static-ui.ts` owns the
  routing decision only (`resolveGetRequest`, passthrough for `/api/*` and
  assets, everything else → shell); the package-relative resolution is
  `resolveWebDir()` (`server.ts:1663`, wired at `:380`). Neither needs a
  change — the shell is project-agnostic.
- `src/paths.ts` — `cezarHomeDir()` / `CEZ_HOME` is the single home resolver;
  this spec only adds path helpers to it.

### What is new

| Component | File | Responsibility |
|---|---|---|
| Workspace config | `src/workspace/config.ts` (new) | Read/merge/write `~/.cezar/config.json` (zod, `.passthrough()`, atomic tmp+rename, `0600`; read-modify-write merge so concurrent processes don't drop registrations). |
| Project registry ops | `src/workspace/projects.ts` (new) | `registerProject(root)`, `listProjects()`, `removeProject(id)`, slug allocation, realpath dedupe, existence/git probing. |
| Migrations | `src/workspace/migrations.ts` (new) | Ordered, idempotent boot-time config migrations keyed by `schemaVersion` (below). |
| Project contexts | `src/server/project-context.ts` (new) | Lazy `Map<projectId, ProjectContext>`; builds `{store, manager, dataDir, launchKey}` per project (launch-key ensured at context build, today's `server.ts:372`); dispose on removal closes the store **and** calls a new `RunManager.dispose()` (unsubscribes its `onUsage` listener — `run.ts:252` currently never unsubscribes — and clears timers/queue). |
| Route multiplexing | `src/server/server.ts` (edit) | Register every project route once under `/api/p/:projectId/*`; resolve the context from the param; keep unprefixed aliases bound to the boot project. |
| Global settings API | `src/server/server.ts` (edit) | `GET/PUT /api/workspace/config`, `GET/PUT /api/workspace/ui-state` (backed by `~/.cezar/{config,ui-state}.json`). |
| Folder browser + checkout | `src/server/fs-browse.ts`, `src/server/checkout.ts` (new) | `GET /api/fs/browse` (`browseRoot`-rooted dir listing) and `POST /api/projects/checkout` (`gh repo clone` into the independent checkout root). |
| De-singletonized todos | `src/todos.ts` (edit) | Watcher/emitter per `dataDir` (`Map`), scoped `onTodosChanged(dataDir, cb)`. |
| Per-project cache keying | `src/server/forge/github.ts`, `src/skills-remote.ts` (edit) | Key the GitHub list cache, GitHub comments cache and team-skills cache by project (`repoRoot`), following the pattern `detectCache` already uses (`forge/github.ts:641`). |
| Scoped usage fan-out | `src/core/process-usage.ts` + `run.ts` (edit) | Managers filter usage snapshots to their own runIds; SSE relays only the owning project's samples. |
| Workspace scheduler cap | `src/workflows/run.ts` (edit) | A shared workspace-level semaphore so the **global** `maxParallel` caps concurrent agent runs across all projects. |
| Cockpit project scope | `web/app/src/…` (edit) | `/p/:projectId` route prefix, project-scoped API client + queries, multi-project sidebar, new-task project selector, add-project dialog, settings split. |

### Project identity

`projectId` is a **human-readable slug** derived from `basename(root)`
(lowercased, `[^a-z0-9-]` → `-`, pinned to `^[a-z0-9][a-z0-9-]{0,63}$`),
deduplicated with a numeric suffix (`api`, `api-2`). Slugs appear in URLs and
API paths, are stable for the lifetime of the registry entry, and are validated
at every route boundary (zod) before touching any map or path. Resolution is
always **by registry lookup**, never by joining the id into a filesystem path.

**`default` is a reserved alias, never an allocated slug.** Wherever a
`projectId` appears — `/p/default/…`, `/api/p/default/…` — it resolves to the
**boot project** (the repo this server was started in), exactly like the
unprefixed legacy routes do. This gives external tooling and docs a stable id
that works before the author knows any real slug. Slug allocation skips
`default` and the shell's own top-level path segments (`new`, `settings`,
`api`, `p`, `assets`) so a repo named `default/` becomes `default-2` and can
never shadow the alias or a route.

### Boot flow

```
cezar serve (in /Users/x/proj-b)
  ├─ runMigrations()                       # ~/.cezar schemaVersion → latest (idempotent)
  ├─ ws = loadWorkspaceConfig()            # degrade: unreadable → in-memory defaults
  ├─ boot = registerProject(cwd-repoRoot)  # appends if unknown; bumps lastOpenedAt
  ├─ contexts = ProjectContexts(ws)        # lazy — nothing instantiated yet
  ├─ context(boot.id)                      # boot project eagerly: recover(), pruneOrphans()
  ├─ startServer({contexts, bootId, …})    # one port, loopback, as today
  └─ open http://127.0.0.1:<port>/p/<boot.id>/
```

**Registration guards** — auto-registration is suppressed (the process still
serves the folder, it just doesn't pollute the registry) when the resolved
`repoRoot` is: inside any path matching `…/.ai/cezar/worktrees/…` (task
worktrees and nested `cez` invocations — the same nesting reality the
`CEZ_TODOS_FILE=''` guard in `run.ts:294-305` acknowledges), or the user's
home directory itself. Headless `cezar run` applies the same guards.

Other registered projects get their `ProjectContext` on first API touch
(sidebar expand, deep link). Recovery/pruning for a project runs when its
context is built. A registered project whose `root` no longer exists (or is
unreadable) is listed with `status: 'missing'` and never instantiated.

Concurrent `cezar serve` processes remain allowed (each picks its own port, as
today). Registry writes are read-modify-write + atomic rename, and
registration is additive, so the worst race outcome is a lost `lastOpenedAt`
bump — never a lost project.

### Resource governance (why resources go global)

`maxParallel` and `memoryLimitMb` protect the *host*, not a repo. They move to
`~/.cezar/config.json`. The semantics are deliberately plain: **the global
value is the only effective one.** Leftover per-repo `maxParallel` /
`memoryLimitMb` keys are imported once by Migration 001 and ignored
afterwards; the settings UI stops writing them. `worktreeRetention` stays
**per-project** (it sizes a repo's own worktree pool), with the global
`resources.worktreeRetentionDefault` applying only to projects that don't set
it — per-project value wins. `baseBranch`, `defaultRunner`, models, system
prompt, `reviewGate`, `skillsRepos` stay per-project — they describe the repo,
not the machine.

Enforcement follows the value: the parallel cap becomes a **workspace-level
semaphore** shared by all managers, and the memory guard
(`enforceMemoryLimit`, `run.ts:264` — today re-reading `loadConfig(repoRoot)`
every 2s tick) switches to the workspace config, **cached in memory** and
refreshed on `PUT /api/workspace/config` — not N per-tick file reads across N
projects. The semaphore contract: a slot is acquired before a manager starts
an agent process and released when the run settles (finish/fail/cancel, or
memory-pause frees its slot); variants queue as today. **The #347 exception
must be carried over exactly as it is today** (`run.ts:384-386`, inside
`pump()`): a `waiting` run does *not* hold a slot, and a message into a
waiting run resumes it immediately even when that momentarily exceeds
`maxParallel`. This is queue-slot accounting, not crash recovery — making a
resumed `waiting` run acquire a workspace slot would hang the resume whenever
the workspace-wide cap is saturated by other projects, which is the exact
failure #347 fixed. Crash recovery (`RunManager.recover`) is a separate path
and acquires slots normally.

## Data Model

### `~/.cezar/config.json` (new — workspace config + registry)

```jsonc
{
  "schemaVersion": 1,                    // migration cursor (int, .catch(0))
  "browseRoot": "~/",                    // folder-browser root; validated writable on change
  "projectsDir": "~/cezar/projects",     // checkout root; validated writable on change
  "resources": {                          // moved from per-repo config.json
    "maxParallel": 2,                     // workspace-wide cap, 1-16
    "memoryLimitMb": null,
    "worktreeRetentionDefault": 10        // default for projects that don't override
  },
  "projects": [
    {
      "id": "cezar",                      // slug, unique, ^[a-z0-9][a-z0-9-]{0,63}$
      "root": "/Users/x/Projects/cezar",  // absolute, realpath-normalized
      "name": "cezar",                    // display name (basename by default)
      "addedAt": "2026-07-20T10:00:00Z",
      "lastOpenedAt": "2026-07-20T10:00:00Z",
      "source": "local"                   // 'local' | 'checkout'
    }
  ]
}
```

House rules apply verbatim: every field optional/defaulted (`.catch`),
`.passthrough()` so newer keys survive an older writer, `.max()` bounds on
strings, atomic tmp+rename `0600`, corrupt file → in-memory defaults plus a
one-line boot warning (the registry rebuilds as projects are opened — losing
it is an inconvenience, not data loss).

### `~/.cezar/ui-state.json` (new — global GUI state)

The workspace twin of the existing per-repo `ui-state.json`, reusing the same
`.passthrough()` + merge-on-write + key-cap pattern. Note that pattern is
currently **split**: `src/ui-state.ts` is only the read path
(`uiStatePath`/`readUiState`, degrading to `{}`), while the schema
(`server.ts:285`), the `UI_STATE_MAX_KEYS = 200` cap (`:361`) and the
merge-on-write (`:493`) live in the route. Factor the shared half out rather
than copying it:

```jsonc
{
  "appearance": { "accent": "violet", "density": "comfortable" },  // moved global
  "notifications": { "enabled": true },                            // moved global
  "sidebar": {
    "collapsed": { "cezar": false, "other-repo": true }            // per-project collapse
  }
}
```

Theme stays in browser localStorage (`cez-theme`) — it is per-device by
nature. Project-scoped UI prefs (`githubView`, dismissed banners, prompt
templates) stay in each repo's `.ai/cezar/ui-state.json`.

### Per-project state — unchanged

`runs.json`, NDJSON event logs, worktrees, launch-key, workflows, skills,
`config.json` (minus the moved resource keys) all remain under
`<repo>/.ai/cezar/`. A project checked out on another machine carries its
cezar history with it; removing a project from the registry touches nothing in
the repo.

### Migrations (new framework + first migration)

`src/workspace/migrations.ts` — deliberately tiny, config-files-only (run
state keeps the existing additive-zod convention and never migrates):

```ts
interface WorkspaceMigration {
  to: number;                 // schemaVersion this migration produces
  id: string;                 // e.g. '001-workspace-config'
  run(ctx: { home: string; bootRepoRoot: string | null }): Promise<void>; // idempotent
}
```

At boot, before anything else: read `schemaVersion` (absent file or key → 0),
run every migration with `to > current` in order, persist the new
`schemaVersion` after each. Rules: each migration is **idempotent** (safe to
re-run after a crash mid-way), **additive** (never deletes or rewrites the
user's repo files), and **non-blocking** (a failing migration logs one warning
and boots degraded with in-memory defaults — never a boot failure; the
zero-config law "a read-only home degrades to a smaller cockpit" holds).
Concurrency: migrations take the same read-modify-write + atomic-rename path
as all workspace writes; two processes racing the same migration both produce
the same result because each step is idempotent.

**Migration 001 — `workspace-config` (`schemaVersion 0 → 1`)**, the "current
version up" migration the user asked for:

1. Create `~/.cezar/config.json` with defaults if absent.
2. If booting inside a repo: import that repo's `.ai/cezar/config.json`
   `maxParallel` / `memoryLimitMb` into `resources`, and its `appearance` /
   `notifications` keys from `.ai/cezar/ui-state.json` into
   `~/.cezar/ui-state.json`. Keys already set globally are never overwritten
   (this is what makes a crash-interrupted re-run safe).
3. Leave every per-repo file untouched in place, so an older cezar run in the
   same repo still works (forward compatibility is free; the old version
   simply keeps reading its local copies).

Registering the boot repo is **not** part of the migration — the normal boot
flow owns registration (single owner, no divergent `addedAt`/`source`).

An upgraded user therefore boots the new version in their usual repo and sees
the same settings, the same tasks, one registered project — no visible
difference until they add a second project.

## API Contracts

### Workspace-level (new)

| Route | Shape | Notes |
|---|---|---|
| `GET /api/projects` | `{ projects: [{id,name,root,branch?,status,source,lastOpenedAt}], bootProject: string, projectsDir: string }` | `status ∈ 'ok' \| 'missing' \| 'not-git'` (`not-git` is fully usable — same degraded single-queue mode as today; only `missing` blocks). Status/branch probes are cached with a short TTL and refreshed async — the sidebar load must not shell `git` N times per render. Never 404s. |
| `POST /api/projects` | `{ root } → { project }` | Registers an existing folder (folder-browser flow). 400 non-absolute/nonexistent path; 409 already registered (returns the existing entry). |
| `POST /api/projects/checkout` | `{ url, name? } → { project }` \| `{ error }` | `gh repo clone <url> <projectsDir>/<name>`; zod-validates `url` as a GitHub repo URL/`owner/name`; 409 target dir exists; degrades to `{ error, reason }` when `gh` is unavailable (mirrors `github.ts` degradation). Long-running: answers when the clone finishes; the dialog shows progress from `checkout-progress` SSE events. |
| `DELETE /api/projects/:projectId` | `{ ok: true }` | Unregisters only. 409 while the project has running tasks. Never deletes files. |
| `GET /api/fs/browse?path=` | `{ path, parent, dirs: [{name, path, isRepo}] }` | Directories only, rooted at `browseRoot`; rejects paths escaping it (realpath check); dotfolders hidden by default, `showHidden=1` opts in. |
| `GET/PUT /api/workspace/config` | global settings (`browseRoot`, `projectsDir`, `resources`) | Each root validates independently on PUT: expand `~`; require `browseRoot` to already be a directory, use `mkdir -p` for `projectsDir`, then probe writability (`access W_OK` + create/delete a probe file). On failure → 400 `{ error }` and no change. Defaults come from `CEZ_BROWSE_ROOT` (`~/`) and `CEZ_PROJECTS_DIR` (`~/cezar/projects`). |
| `GET/PUT /api/workspace/ui-state` | global GUI state | Same merge/cap semantics as the per-repo ui-state route. |

### Project-scoped (mirrored)

Every existing project route gains a scoped twin:
`/api/p/:projectId/<existing path minus /api/>` — e.g.
`POST /api/p/cezar/runs`, `GET /api/p/cezar/skills`,
`GET /api/p/cezar/events` (SSE), `GET /api/p/cezar/runs/:id/events` (SSE),
`GET/PUT /api/p/cezar/config`, `GET /api/p/cezar/github`,
`GET /api/p/cezar/launch-key`, workflows, repo, todos, worktrees, groups —
the full table from `server.ts` unchanged in shape. Implementation registers
each handler once against a context-resolver (`c.get('project')`), not two
copies: unknown/missing `projectId` → 404 `{ error }`; a `missing`-status
project → 409 `{ error: "project folder not found: …" }`.

### Legacy aliases (protected surfaces)

Unprefixed `/api/*` routes stay mounted and resolve to the **boot project** —
byte-identical behavior for every consumer in `BACKWARD_COMPATIBILITY.md`
(bookmarklet `/new?skill=&auto=&key=&ref=` grammar, `/api/health` CORS
discovery, CLI reads of `ui-state.json`). That includes the legacy
`GET /api/events` stream: it keeps emitting **only the boot project's**
events, filtered — widening it to all projects would be a behavioral break on
a §2 surface dressed up as additive, so the workspace gets its own stream
instead (below). `/api/p/default/*` is the explicit spelling of the same
thing (see Project identity). `GET /api/health` keeps its current fields
(still describing the boot project) and additively gains
`projects: [{id, name}]` and `bootProject: <id>` so bookmarklets and
external tooling can enumerate the workspace without a breaking change.
**`root` is deliberately absent from the health payload.** Health is the one
CORS-open route, and `server.ts:462` already trims `repoRoot` to a basename
under `CEZ_REMOTE` precisely so a cross-origin reader cannot learn the
developer's absolute path and username (#431). Shipping `projects[].root`
there would reintroduce that leak once per registered project; `id` + `name`
are all enumeration needs. Absolute roots stay on `GET /api/projects`, which
is same-origin and behind the cockpit.

### SSE streams

One SSE connection per cockpit stays doctrine — it just moves up a level:

- **`GET /api/workspace/events` (new)** — the cockpit's single EventSource.
  Carries events from every instantiated project, each stamped
  `project: <id>`, plus workspace events `project-added`, `project-removed`,
  `checkout-progress`. `usage` events are **filtered, not stamped**: the
  payload is a per-run record (`Record<runId, ProcessUsage>`), so the relay
  splits the sampler snapshot by each project's owned runIds and emits one
  `usage` event per project that has live runs.
- **`GET /api/p/:projectId/events`** — one project's stream (the scoped twin
  of today's shape); `GET /api/p/:projectId/runs/:id/events` unchanged per
  run.
- **`GET /api/events` (legacy)** — boot project only, unchanged shape.

### CLI

- `cezar serve` — as today, plus registration + migrations (above).
- `cezar run "<task>"` — headless, unchanged, still operates on cwd's repo
  (registers it as a side effect).
- `cezar projects` (new, small) — list registered projects with status; handy
  for scripting and for the server-install autostart unit (below).

## UI/UX

Mockups (real cockpit look, light/dark, standalone HTML per house convention)
live in `assets/2026-07-20-multi-project-workspace/`.

### URL scheme

Every route from `routes.tsx` moves under a project prefix — `/p/:projectId/`
(`/p/cezar/tasks/abc123`, `/p/cezar/github/prs/42`, `/p/cezar/settings/agents`)
— via one pathless layout route supplying `ProjectScopeContext` (id + scoped
API base). **Backward compatibility of URLs is two-layered:** legacy flat URLs
(`/tasks/:id`, `/new?...`) redirect to `/p/<boot>/…` preserving params, and
the reserved `/p/default/…` prefix resolves to the boot project too
(normalized to the real slug with a `replace` navigation on load) — so a URL
with **no project id or with `default`** always lands in the project cezar
was started in, and old bookmarks plus the bookmarklet contract survive. One
known limit: a legacy `/tasks/:id` bookmark whose run belongs to a non-boot
project 404s on the boot project — acceptable, since all pre-multi-project
bookmarks point at what is now the boot project. React Router stays basename-less; the prefix is an ordinary param
route, and the API client prefixes `/api/p/<id>` from the scope context
(single seam: the module-private `send()` in `web/app/src/api/client.ts:131`,
which every `request`/`requestText`/`get`/`mutate` wrapper funnels through,
plus the four known non-`send()` URL sites incl. both EventSources and image
URLs). TanStack Query keys gain a
leading `projectId` segment.

### Sidebar (mockup: `sidebar.html`)

- **Header** — brand tile + wordmark; beneath it the **New task** CTA and, next
  to it, a **folder-open icon button** → the *Add project* dropdown with two
  options: "Open local folder…" and "Clone from GitHub…" (the second disabled
  with a reason when `gh` is unavailable). (The brief says "top right by the
  new task button" — in the current shell the New task button lives at the top
  of the sidebar, so the add-project button sits beside it there; on mobile it
  joins the drawer header.)
- **Project groups** — one collapsible group per registered project, ordered by
  `lastOpenedAt`. Group header: chevron, project name, current branch,
  attention badge (needs-you count). Expanded, a group shows:
  - its nav — Tasks, Inbox (the existing `capabilities.followups`-gated item,
    omitted from the mockup), Git, GitHub (gated per project's forge),
    Skills, Workflows, Settings — each linking to `/p/<id>/…`;
  - its **10 most recent tasks** (reusing `TaskQuickList` grouping, capped at
    10 across buckets) and a **"More…"** row linking to `/p/<id>/` (the tasks
    pane).
- Collapse state persists per project — **superseded on storage (2026-08-04):**
  in the browser's own `localStorage` (`packages/web/src/lib/sidebar-collapse.ts`,
  key `cez-sidebar-collapsed`), not in `~/.cezar/ui-state.json`. Sharing one map
  across every browser meant collapsing a group on a phone collapsed it on the
  desktop, and each toggle cost a PUT a second cockpit could clobber; which groups
  are shut describes the window you are looking at. It still survives reloads and
  server restarts, per browser. The server keeps accepting the legacy
  `sidebar.collapsed` key for older cockpits. The active project (from the URL) auto-
  expands; a `missing` project renders greyed with a "folder not found —
  remove?" affordance.
- **Footer** — unchanged (tools, version, theme) plus a **Global settings**
  link (`/settings/global/*`, outside any project scope).

### New task (mockup: `new-task-project.html`)

`/p/:projectId/new` keeps the full-screen composer. A **project pill** joins
the composer footer next to the Source pill — a searchable dropdown of
registered projects, **preselected from the URL scope**. Changing it swaps the
scope: skills/workflows/backends/base-branch pickers, `/`-autocomplete and the
draft key all re-resolve against the selected project (each project has its
own skills and settings), and submit posts to
`POST /api/p/<selected>/runs`. The localStorage draft key becomes per-project
(`cez-new-task-draft:<projectId>`) so switching projects doesn't leak drafts.

### Settings split (mockup: `settings-global.html`)

- **Project settings** (`/p/<id>/settings/…`) — Agents, Resources→**Worktrees**
  (retention + worktree panel stay; the parallel/memory knobs move out),
  Bookmarklets, Prompt templates — served by the project-scoped config/ui-state
  routes. The settings registry gains a `scope: 'project' | 'global'` field and
  renders accordingly.
- **Global settings** (`/settings/global/…`) — Appearance, Notifications,
  Resources (workspace-wide `maxParallel`/`memoryLimitMb`), and **Projects**:
  the registry list (name, path, status, remove), the **browse root** (default
  `~/`) and the independent **checkout root** (default `~/cezar/projects`),
  whose save buttons validate writability
  server-side and surfaces the 400 reason inline (mockup shows the error
  state).

### Add project (mockup: `add-project.html`)

Option A — **Open local folder**: a dialog listing directories from
`GET /api/fs/browse`, starting at `browseRoot`, breadcrumb navigation, git repos marked
with a badge; selecting a folder calls `POST /api/projects` and navigates to
`/p/<new>/`. Non-git folders are allowed (cezar degrades exactly as `cezar
serve` in a non-git dir does today).

Option B — **Clone from GitHub** (gh-gated): a URL/`owner/repo` input, the
resolved target path preview (`<projectsDir>/<name>`, editable name), a
progress state driven by `checkout-progress` SSE, then registration +
navigation as above. Errors (`gh` auth, network, existing dir) surface in the
dialog verbatim from `{ error }`.

### Bookmarklets — project-oriented

The bookmarklets pane lives under each project's settings; generated
bookmarklet URLs become `<origin>/p/<projectId>/new?skill=…&key=<that
project's launch-key>` and the visible label keeps the project name stamp.
Each project keeps its own `.ai/cezar/launch-key`. Legacy `/new?...`
bookmarklets keep working via the redirect (boot project).

## Edge Cases & Failure Scenarios

| Scenario | Behavior |
|---|---|
| `~/.cezar` unwritable / read-only home | Boot proceeds with an in-memory single-project workspace (boot repo only); one boot-time warning. Nothing requires the file. |
| Corrupt `~/.cezar/config.json` | Degrade to defaults + warning; registry rebuilds as projects are opened. Never crash, never overwrite the corrupt file until the next successful merge-write. |
| Registered project folder deleted/moved | `status: 'missing'`: greyed in sidebar, panes 409, remove offered. Never auto-removed. |
| Project registered twice (symlink, trailing slash) | Realpath-normalized on registration → dedupe to the existing entry. |
| `cezar` invoked inside a task worktree / nested `cez` / `$HOME` | Registration guard suppresses the registry write; the process still serves that folder normally. |
| Deep link `/p/default/…` or unprefixed legacy URL | Resolves to the boot project (reserved alias / redirect); normalized to the real slug in the address bar. |
| Slug collision (`~/work/api`, `~/personal/api`) | Second registration gets `api-2`; sidebar disambiguates with the parent-dir segment like the group header tooltip. |
| Deep link to unknown `projectId` | Cockpit shows a "project not registered here" screen with the registry list; API returns 404 `{ error }`. |
| Two `cezar serve` processes concurrently | Both serve the full registry on different ports; registry writes merge additively; per-project `.ai/cezar` files keep their existing single-writer-per-repo assumptions (unchanged from today — two processes in *one* repo were never supported). |
| Run started in project B while A's tasks run | Independent stores/managers; workspace semaphore caps total agent processes at global `maxParallel`. |
| `gh` missing / unauthenticated | Clone option disabled with reason (same degradation contract as the GitHub pane). |
| Clone fails mid-way (network, auth) | Partial target dir removed if the clone created it; dialog shows the error; nothing registered. |
| `browseRoot` or `projectsDir` set to an unwritable path | 400 with reason on save; setting unchanged (validated server-side, shown inline). A missing browse root is rejected; a missing checkout root is created recursively. |
| Checkout target already exists | 409; offer "register the existing folder instead". |
| Migration crashes mid-run | `schemaVersion` unbumped → re-run next boot; steps idempotent. |
| Older cezar run after the new one | Reads its per-repo files as always (they were left in place); ignores `~/.cezar/config.json` extras (`.passthrough()` both ways). |
| Boot in a folder while home has 40 registered projects | Contexts are lazy; only the boot project (plus any the user touches) instantiates. Sidebar virtualizes/scrolls; collapsed groups cost one registry row. |
| Hosted mode (`CEZ_REMOTE=1`) | Whole workspace is reachable through the one exposed cockpit — by design now (the operator's own projects). `fs/browse` is restricted to `browseRoot`; operators should set `CEZ_BROWSE_ROOT` narrowly when the default home root is too broad. `open-in-*` capability gating is unchanged. Documented in `.env.example`. |

## Risks & Impact Review

- **Blast radius: the route layer and the shell.** Store/manager/git/forge
  layers are untouched by design. The multiplexing refactor of `server.ts`
  (closures → context resolver) is the riskiest single change and lands first
  with alias parity tests: every unprefixed route must behave byte-identically
  for the boot project.
- **Six singleton fixes** (todos watcher, usage-sampler fan-out, health shape,
  GitHub list cache, GitHub comments cache, team-skills cache) are correctness
  bugs the moment a second project exists. The three cache fixes are also
  **data-isolation** fixes — the GitHub list cache would serve one project's
  private issues/PRs under another project's scope. Each gets a regression
  test asserting one project's data is never served under another's scope.
- **Protected surfaces**: `/api/health` (additive fields only), bookmarklet
  grammar (redirect keeps it), `ui-state.json` CLI reads (per-repo file stays),
  run-record schema (untouched). `BACKWARD_COMPATIBILITY.md` gains sections for
  `~/.cezar/config.json`, `~/.cezar/ui-state.json`, `/api/projects`,
  `/api/p/*`, `/p/*` URLs, the `project` SSE field, and the migration
  framework. Per the document's preamble ("additive changes are fine … a
  breaking change requires a documented path") and its §2 route inventory,
  **each section lands in the same PR as the code that creates the surface**,
  not in Phase 5 — Phase 5 only carries the prose that has no earlier home
  (README, `.env.example`). Phase 1 therefore documents `~/.cezar/*`,
  `/api/projects` and the health additions; Phase 2 documents `/api/p/*`, the
  workspace SSE stream and the `project` field; Phase 3 documents `/p/*` URLs
  and the bookmarklet redirect.
- **Rollback.** Config moves are additive and non-destructive: downgrading
  restores exactly today's behavior because per-repo files were never removed.
  The URL change ships with permanent legacy redirects. No flag: the feature
  doesn't widen network exposure (same port, same loopback bind) and degrades
  to today's single-project behavior when the registry is empty/unavailable —
  zero-config compliant (state written, never required).
- **Zero-config check.** No required file or env var; `browseRoot` and
  `projectsDir` have working environment-backed defaults; the registry is a
  side effect of running; migrations are invisible and optional-to-succeed.
  Browse and checkout locations are independent user choices.
- **Server-install alignment.** Unchanged mechanics: host-level state stays at
  `~/.cezar/server.json` + `~/.cezar/server-instances/<slug>.json` and
  coexists with `config.json` in the same home. The topology *simplifies*: one
  autostart unit now serves every project of its unix user, so multi-repo
  hosts no longer need one unit per repo; domain-keyed instances that want
  disjoint project sets run with distinct `CEZ_HOME` (existing, documented
  mechanism — each home carries its own registry and global config). The
  `~/.cezar/instances/` live-instance dir from #406 is never created;
  `liveInstancesExist()` (`server-install/engine.ts:380`, module-private, called
  at `:271`) keeps working (always empty) and its removal is noted as a
  follow-up cleanup, not part of this spec — being unexported, that cleanup is
  purely internal and breaks no surface.
- **Memory footprint.** N instantiated managers hold N recovered run indexes;
  mitigated by lazy contexts and the existing `MAX_RUNS_KEPT` caps. Usage
  sampler remains one timer.

## Research — market anchors

- **VS Code** splits storage exactly along this spec's line: `globalStorage` +
  user settings vs `workspaceStorage` per folder, with a persisted "recently
  opened" registry — the model users already understand. Its multi-root
  workspace also shows the sidebar-of-projects pattern scales.
- **GitHub Desktop** keeps a repository list plus a single global "clone path"
  default (`~/Documents/GitHub`) — the exact `projectsDir` ergonomic,
  validated on change.
- **Slack/Linear sidebars** demonstrate collapsible per-container groups with
  per-container recents and a "more" overflow — the sidebar shape chosen here.
What we deliberately skip from all three: cross-machine sync, per-project
windows, and any daemon — one process, plain files, loopback only.

## Phasing

Each phase ships independently and leaves the app fully working.

- **Phase 1 — Workspace foundation (invisible).** `~/.cezar/config.json` +
  registry + migrations framework + migration 001; boot registration;
  `GET /api/projects`; health additions. Cockpit unchanged.
- **Phase 2 — Project-scoped server.** Context map, `/api/p/:projectId/*`,
  legacy aliases, singleton fixes, workspace semaphore, workspace
  config/ui-state routes, SSE `project` stamping. Cockpit still unprefixed
  (boot project) — proven by alias parity.
- **Phase 3 — Project-scoped cockpit.** `/p/:projectId` routes + redirects,
  scoped API client/queries, multi-project sidebar with persisted collapse,
  10-recent + More…, new-task project pill, settings split, project-scoped
  bookmarklets.
- **Phase 4 — Add project GUI.** `fs/browse`, folder-browser dialog, `gh`
  checkout flow, `projectsDir` setting with writable validation.
- **Phase 5 — Docs + server-install alignment.** BACKWARD_COMPATIBILITY,
  AGENTS.md routing rows, README, `.env.example` (`CEZ_HOME` note, hosted
  exposure), `cezar projects` CLI, uninstall live-check follow-up issue.

## Implementation Plan

### Phase 1 — Workspace foundation

1.1 `src/paths.ts`: add `workspaceConfigPath()`, `workspaceUiStatePath()`
    (under `cezarHomeDir()`); update the stale `:56-57` docstring that still
    points the "per-project registry" at `~/.cezar/instances/` (the abandoned
    #406 design). *Test:* unit, `CEZ_HOME` override.
1.2 `src/workspace/config.ts`: zod schema (all fields `.catch`/optional,
    `.passthrough()`), `loadWorkspaceConfig`, `mergeWriteWorkspaceConfig`
    (read-modify-write + tmp/rename `0600`). *Test:* round-trip, corrupt →
    defaults, concurrent merge keeps both writers' projects, unknown keys
    survive.
1.3 `src/workspace/projects.ts`: `registerProject` (realpath dedupe, slug
    allocation), `listProjects` (status probe), `removeProject`. *Test:* unit —
    dedupe, collision suffix, missing-root status, never touches repo files.
1.4 `src/workspace/migrations.ts` + migration 001. *Test:* fresh home; home
    with existing per-repo config (values imported once); re-run idempotent;
    unwritable home degrades without throwing; schemaVersion bump persisted
    per migration.
1.5 `src/index.ts`: run migrations + registration (with the worktree/`$HOME`
    guards) in `serveCommand` and `runCommand`. *Test:* e2e dry-run — serve
    in a fresh repo registers it; serve inside `…/.ai/cezar/worktrees/…` does
    not.
1.6 `GET /api/projects` + additive `/api/health` fields (`projects`,
    `bootProject`). *Test:* server unit — shapes; health's existing fields
    byte-identical.

### Phase 2 — Project-scoped server

2.1 `src/server/project-context.ts` + `RunManager.dispose()`: lazy context
    map (store+manager+launch-key per project, recover/prune on first build,
    dispose on remove — store closed, manager's `onUsage` unsubscribed,
    timers cleared). *Test:* unit — lazy instantiation, missing project never
    instantiated, disposed manager receives no further usage ticks.
2.2 `server.ts` refactor: route registrar takes a context-resolver; mount the
    full table under `/api/p/:projectId/*` (zod-pinned param) and as
    unprefixed aliases bound to the boot project. *Test:* alias parity suite —
    for every route, unprefixed vs `/api/p/<boot>/…` byte-identical; unknown
    id 404; missing project 409.
2.3 `src/todos.ts`: per-dataDir watcher/emitter map; scoped
    `onTodosChanged(dataDir, cb)`. *Test:* two dataDirs, events don't cross.
2.4 Usage fan-out scoping in `run.ts` + per-project `usage` filtering in the
    SSE relay (split by owned runIds, never stamped). *Test:* A's stream
    excludes B's samples; memory enforcement unaffected.
2.5 Workspace semaphore honoring global `resources.maxParallel` across
    managers (acquire before agent start, release on settle, memory-pause
    frees the slot, #347 resume exception preserved); memory guard + cap read
    the **cached** workspace config (refreshed on PUT), not per-tick file
    reads; per-repo legacy keys ignored post-migration. *Test:* two projects,
    cap 2 → third run queues; a message into a `waiting` run resumes it even at
    cap (#347 exemption, asserted across projects); config PUT takes effect
    without restart.
2.6 Per-project cache keying: GitHub list cache, GitHub comments cache
    (`forge/github.ts:194`, `:420`), team-skills cache
    (`skills-remote.ts:403`) keyed by project. *Test:* regression per cache —
    project A's data is never served under project B's scope (incl. same PR
    number in both).
2.7 `GET/PUT /api/workspace/config` (with `projectsDir` writability probe) and
    `/api/workspace/ui-state`. *Test:* unwritable dir → 400 + unchanged;
    merge semantics.
2.8 `GET /api/workspace/events`: all-project stream with `project` stamps,
    per-project `usage` filtering, `project-added/removed` /
    `checkout-progress`; legacy `/api/events` stays boot-project-filtered.
    *Test:* legacy stream carries only boot-project events, byte-identical
    shape; workspace stream carries both projects'.

### Phase 3 — Project-scoped cockpit

3.1 API client scope seam: `ProjectScopeContext`, `send()` prefixing, the four
    non-`send()` URL sites, the single EventSource moves to
    `/api/workspace/events`, query keys gain `projectId`. *Test:* unscoped =
    byte-identical paths (critical assertion), scoped prefixes everywhere.
3.2 Routes under `/p/:projectId/*` + legacy redirects preserving params
    (`/new?...` included) + the `default` alias normalizing to the boot slug.
    *Test:* router unit — every legacy path lands scoped with params intact;
    `/p/default/tasks/x` → `/p/<boot>/tasks/x`.
3.3 Sidebar: project groups (collapse persisted via workspace ui-state),
    per-project nav + attention badges, 10-recent + "More…", missing-project
    state, add-project button placement. *Test:* component units — cap at 10,
    More… link target, collapse round-trips, single-project workspace renders
    (degenerate case ≈ today).
3.4 New-task project pill: scope swap re-resolves skills/workflows/config,
    per-project draft keys, submit targets selected project. *Test:* switch
    project → picker data and draft isolated.
3.5 Settings split: registry `scope` field, global sections (Appearance,
    Notifications, Resources, Projects) under `/settings/global`, project
    sections under `/p/<id>/settings`. *Test:* appearance/notifications write
    global store; agents write project store.
3.6 Bookmarklets: scoped URLs + per-project keys; legacy redirect e2e. *Test:*
    generated URL carries `/p/<id>/new` + that project's key.

### Phase 4 — Add project GUI

4.1 `GET /api/fs/browse` (`browseRoot`-rooted, realpath containment, dirs only).
    *Test:* escape attempts rejected; environment default; isRepo flag.
4.2 Folder-browser dialog → `POST /api/projects`. *Test:* register + navigate;
    non-git allowed.
4.3 `POST /api/projects/checkout` + `checkout-progress` SSE + partial-clone
    cleanup; dialog flow. *Test:* dry-run fake clone; error surfaces; existing
    dir 409 path.
4.4 Global Projects settings pane: list/remove, independent `browseRoot` and
    `projectsDir` fields with inline validation errors. *Test:* 400 reason
    rendered; recursive creation; running-tasks 409 on remove.

### Phase 5 — Docs + alignment

5.1 `AGENTS.md` routing rows (`src/workspace/`, project-scoped routes),
    README multi-project section, `.env.example` prose (`CEZ_HOME`, hosted
    exposure note).
5.2 `cezar projects` CLI + server-install docs note (one unit serves the
    user's workspace; `CEZ_HOME` for disjoint sets). *Test:* e2e package test
    lists the registered project.
5.3 Follow-up issue: retire `liveInstancesExist()`/`~/.cezar/instances/`
    remnants of #406.

### Validation

`npm run typecheck && npm test && npm run test:unit && npm run build &&
npm run test:package`; Phases 3-4 additionally `npm run test:e2e`
(`TEST_E2E_STATUS=skipped` is not a pass). The e2e and `test:package`
harnesses must pin `CEZ_HOME` to a temp dir from Phase 1 on — they boot the
real CLI, which now writes migrations and registrations, and must never touch
the developer's real `~/.cezar`.
