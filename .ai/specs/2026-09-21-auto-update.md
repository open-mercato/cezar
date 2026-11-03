# Auto-update — keep a local and a VPS cezar on the latest release

## 📝 TLDR

cezar detects a newer release today and then stops: `checkForUpdate` prints `⬆ cezar X is available — restart with: npx cezar-cli@latest` and lights the version chip, but nothing applies it. This spec proposes an **apply half** for that check — one `UpdateService` that discovers which of four install shapes is running cezar (npx cache, global npm install, git checkout, systemd service) and re-runs *that* shape's own update path in the background. A local cockpit updates for its **next** launch; a hosted cockpit, which nobody is sitting at, restarts itself once no run is active and proves it came back. Zero new configuration: the shape is discovered, not declared, and the only knob is a kill switch.

## 📝 Problem Statement

### The local user on `npx cezar-cli` can be permanently stale

`packages/cezar/src/update-check.ts` opens with the diagnosis already written down:

> the root cause behind most "bug already fixed" reports is `npx` happily reusing a stale cached version forever

npm resolves `npx cezar-cli` once and caches the result under `~/.npm/_npx/<hash>`, then reuses it. The remedy the banner prints — relaunch with `npx cezar-cli@latest` — can hand back the same build. The repository has already paid for this lesson once: issue #696, *"server-deploy never updates an npx-based install (npx cache is reused)"*, was exactly this bug on the server side, and the fix (`refreshNpxCacheForRedeploy`, `platforms/ubuntu-vps.ts:886-940`) is cache invalidation, not a version specifier. The same invalidation has never been wired to the local path.

### The VPS owner has to SSH in to get a fix

The README sells the hosted setup as *"your agents keep working when your laptop is closed."* A cockpit installed by `server-install` is a `systemd` unit nobody looks at. Adopting a release means opening a terminal and running `cezar server-deploy` — precisely what the laptop-closed user is not doing. Two things make that worse than "manual":

1. **`server-deploy` on a global-install unit is a silent no-op.** `serviceExecStart` (`ubuntu-vps.ts:827-839`) emits three ExecStart shapes. For the npx shape, `redeploy` clears the npx cache so the restart re-resolves `latest`. For the **`<node> <globalBin>`** shape it clears nothing and runs no `npm install -g` — it just restarts the unit, which re-execs the identical code. The deploy then reports *"complete — the service was reloaded and verified"*, because `confirmServiceRestarted` proves the **process** changed, not that the **version** did. Confirmed by reading the whole deploy path: `runDeploy` (`engine.ts:352-386`) delegates to `strategy.redeploy` and nothing else, and ubuntu-vps's `redeploy` issues no install command of any kind. (Restart-only is *correct* for the checkout shape — the operator built that tree themselves. The defect is specific to the global shape.)
2. **A stale hosted cockpit is invisible.** Locally the banner nags on every start. A service prints its banner into the journal once, at boot, and nobody reads it.

### What already exists, and must be reused rather than rebuilt

| Piece | Where | What it already does |
|---|---|---|
| `checkForUpdate` / `isNewerVersion` | `src/update-check.ts` | registry query, 3s timeout, fail-silent, numeric semver compare |
| `serviceExecStart` / `isNpxExecStart` | `ubuntu-vps.ts:812-882` | classifies a launch as npx-cache / checkout / global-bin |
| `refreshNpxCacheForRedeploy` | `ubuntu-vps.ts:886-940` | surgically clears `cezar-cli` entries from `~/.npm/_npx` |
| `globalShimPaths` / `PACKAGE_NAME` | `src/install-as-command.ts:15-72` | where a global install's bins land, on POSIX and Windows |
| `redeploy` + `confirmServiceRestarted` + `confirmCezarRunning` | `ubuntu-vps.ts` | restart a unit, prove the PID changed (#912), re-verify the cockpit answers |
| `SkillsUpdateService` / `SkillsUpdateCoordinator` | `src/skills-update.ts` | the house pattern for a default-on background updater: TTL cache, `~/.cache/cez/` cross-process lock with stale recovery, bounded `npx` argument arrays, `shell: false`, silent degradation |
| `openStore(root, { keepLive: true })` + `manager.recover()` | `src/index.ts:200-239`, `workflows/run.ts:1555-1665` | brings every `queued` / `waiting` / `running` run to a defined state across a process exit — see the table below, because "survives" is not uniform |

The last row is what makes this feature possible at all — but it is **not** free, and the design depends on reading it exactly. `recover()` has five branches:

| Prior status | What a restart does to it | Cost |
|---|---|---|
| `queued` | revived and re-queued | none |
| `running`, no `sessionId` on any step yet | steps → `pending`, run → `queued`, revived | none |
| `running` mid-turn | run marked **`failed`** (*"interrupted — cezar process exited during the run"*), then force-resumed via `continueRun` with `RESTART_CONTINUATION_PROMPT` | an extra continuation turn — model tokens, possibly repeated tool work |
| `waiting`, **not** `askParked` | open steps forced `done`, run **settled as success** | the user never sees the final session |
| `waiting` **and** `askParked` (a `CEZ:ASK` park, #917) | run marked **`failed`** — *"interrupted — cezar process exited while the task was waiting for an answer"*; only a human pressing Continue reopens it | the agent's question is stranded until someone returns |

That last row is the sharp one, and it is aimed straight at this feature's target user: a hosted cockpit whose owner is asleep is exactly where an `askParked` run sits for hours. An updater that restarts through it converts "waiting for you" into "failed". The idle gate (§ Phase 2, Step 3) exists for this row first and the mid-turn row second — and § Edge Cases carries the consequence that a long-parked run must not defer the update *forever*.

Success means: a cockpit on any of the four shapes reaches the newest published `latest` without a human running a command; a git checkout is never touched; and every failure mode — offline, registry 404, read-only `$HOME`, missing `npm`, a competing cockpit, a release that will not boot — degrades to a no-op or an automatic revert, never to a dead cockpit.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why | Confirm? |
|---|---|---|---|---|
| Q1 | Is automatic **application** on by default, or opt-in? | **Default-on**, with `CEZ_AUTO_UPDATE=0` as the kill switch and a Settings toggle that overrides the env default (same tri-state shape as `skillsAutoUpdate`). | AGENTS.md § *Changing a mechanism that already works* is explicit: *"a replacement that ships OFF is not a replacement… the change removed a mechanism and added a setting."* A default-off updater leaves the #696 trap exactly where it is. AGENTS.md § Zero config nonetheless requires the owner to grant this class of exception personally — it has been granted three times (dispatch, automations, skills updates) and never inferred. | ⚠ NEEDS HUMAN CONFIRMATION |
| Q2 | May a service install restart itself unattended? | **Yes**, gated on zero `running`/`waiting` runs, and only after a proven restart + health re-verify, with an automatic revert to the previous version when that verification fails. | The entire value for the laptop-closed user is the restart; the unit is `Restart=on-failure`, so a release that cannot boot crash-loops into systemd's start limit and the cockpit stays down until someone SSHes in. That risk is what the revert path (§ Reversibility) exists for, and it is the owner's call whether it is enough. | ⚠ NEEDS HUMAN CONFIRMATION |
| Q3 | Does a **local** (non-service) cockpit ever restart itself? | **No.** The update lands for the next launch; the banner and chip change from *"restart with …"* to *"updated to X — restart to use it."* | Restarting a process a human is typing at destroys their view for a benefit that can wait ten minutes. Claude Code's own CLI draws the same line: it updates its installation silently but ships an explicit `claude respawn` *"so it runs the current Claude Code version"* rather than respawning a live session for you. | reversible |
| Q4 | Check cadence? | **24 h** TTL, first attempt armed after the server is listening. | Stable releases here are owner-driven `workflow_dispatch` runs (`docs/publishing.md`) — a 6 h TTL (what `skills-update.ts` uses for a community repo) buys nothing and costs three extra registry round-trips a day. | reversible |
| Q5 | One spec, or split local and VPS? | **One spec, two phases.** Phase 1 ships the shared detect+apply core and the local shapes; Phase 2 adds the service shape. Each is independently deployable. | The shapes differ only in their apply step; splitting the spec would duplicate the detection model, the lock, the scheduler and the kill switch across two documents and invite two divergent implementations. | reversible |
| Q6 | Does the updater follow release channels (`nightly`, `develop`, `pr-*`)? | **No — `latest` only**, and a cockpit launched from a pinned version (`npx cezar-cli@0.11.0`) is left alone entirely. | Channels are a deliberate opt-in per `docs/publishing.md`; silently moving someone off `@nightly` onto `latest`, or off their pin, would be a downgrade they never asked for. Smallest scope that still ships something working. | reversible |
| Q7 | Does the updater mutate a **global** npm install (`npm i -g`)? | **Yes**, under the same lock and kill switch — it is how that shape is updated, and `install-as-command.ts` already owns the package name and shim locations. A `npm link`ed checkout is detected and excluded. | Excluding the global shape would leave the most common deliberate install with no update path at all, which is the Q1 failure mode in miniature. Distinguishing `link` from a real global install is a `lstat` on the shim's target. | reversible |

Q1 and Q2 gate merge: they are recommendations, not decisions. Until the owner answers them the PR stays draft.

## 📝 Proposed Solution

One service, `UpdateService`, that answers two questions and does nothing else clever:

1. **What shape of installation is running me?** — discovered from the running package root and the host's own records, never configured.
2. **What is that shape's own update command?** — reuse the one the repository already ships for it.

```
                        ┌───────────────────────────────┐
  boot (server listening)│  UpdateCoordinator (24h TTL)  │
  ────────────────────► │  ~/.cache/cez/update.lock      │
                        └──────────────┬────────────────┘
                                       │ checkForUpdate()  (existing, unchanged)
                                       ▼
                        ┌───────────────────────────────┐
                        │  detectInstallShape()         │
                        └──┬─────────┬─────────┬────────┘
                npx cache  │ global  │ checkout│ service
                           ▼         ▼         ▼        ▼
                    clear _npx   npm i -g    NO-OP   server-deploy
                    entries      @latest     (print)  engine path
                           │         │                  │
                           └────┬────┘                  │
                                ▼                       ▼
                   "updated to X — restart"   restart when idle,
                   (next launch adopts it)    verify, revert on failure
```

### Alternatives considered

- **A hand-rolled downloader** (fetch the tarball, verify a checksum, swap the directory — the Go/Rust `self_update` idiom). Rejected: npm is already the transport, already resolves `latest`, and already publishes with `--provenance` (`docs/publishing.md`). A parallel download path would need its own signature story to be no worse than what npm gives for free.
- **A `systemd` timer unit, or a cron entry, that runs `cezar server-deploy`.** Rejected on AGENTS.md § Zero config: *"prefer a proxy-free, daemon-free mechanism… no process to manage, no port to remember, no file to edit."* A timer is a second artifact `server-uninstall` must learn to reverse, and it re-runs the installer on a box the user may have customized.
- **Pin `@latest` harder in the unit's `ExecStart`.** Rejected: it is already `npx --yes cezar-cli`, i.e. already unpinned. #696 proved the version specifier is not the mechanism — cache invalidation is.
- **Route it through the automations scheduler** (`src/automations/scheduler.ts`), which already owns cron and GitHub polls. Rejected: an automation launches a budgeted *agent task*. Maintenance would show up in the user's task list, consume model tokens and need a runner. Wrong primitive, right-looking shape.
- **Containerize and let Watchtower do it.** Rejected: cezar deliberately runs the operator's own logged-in `claude`/`codex`/`gh` from their home directory. Containerizing is a different product.
- **Keep it manual and just make `server-deploy` louder.** Rejected as insufficient on its own — but its component parts are kept: this spec does fix the global-install no-op in `server-deploy` itself (§ Phase 2, Step 2.1), because a correct manual path is a prerequisite for a correct automatic one.

### What the market does, and what cezar should take from it

Evidence below is from the `claude` CLI installed on the development host (`claude --help`); no network research was possible in this run (§ Review limits).

- **Claude Code** ships `claude update|upgrade` (*"Check for updates and install if…"*), `claude install [stable|latest|<version>]`, and — the interesting one — `claude respawn … "so it runs the current Claude Code version"`. The installation updates itself quietly; a **running** session is only moved onto the new version when the user asks. That is exactly the local/hosted split proposed in Q3 and Q2: update the installation always, restart the process only when nobody is in it.
- **Package-manager-fronted CLIs** (`gh`, `npm` itself) notify and stop, deferring to the OS package manager. cezar cannot: its install shapes are npm-internal, and the npx shape has no package manager to defer to.
- **Long-running agents that do auto-update** (Tailscale's `--auto-update`, node-exporter-style deployments) converge on the same three-part shape — update through the platform's own package mechanism, restart the service, verify it came back. Phase 2 is that shape, with cezar's extra constraint that the service may be mid-run.

What none of them carry, and this spec skips: channel switching, delta patching, staged rollouts, a signing infrastructure of our own.

## 📝 Architecture

New module `packages/cezar/src/update-apply.ts`, sibling to the existing `update-check.ts` (which is unchanged — its `checkForUpdate` stays the detection half). Two pure-ish exports plus one service:

```ts
export type InstallShape =
  | { kind: 'npx'; cacheRoot: string }
  | { kind: 'global'; binDir: string }
  | { kind: 'checkout'; root: string }        // includes `npm link`
  | { kind: 'service'; platform: string; instanceId: string }
  | { kind: 'pinned'; spec: string }          // launched as cezar-cli@<version>
  | { kind: 'unknown' };

export function detectInstallShape(env: {
  pkgRoot: string; execPath: string; argv1: string;
  serverInstances: ServerInstanceRecord[]; home: string;
}): InstallShape;                              // pure — unit-testable per shape

export function planUpdate(shape: InstallShape, latest: string): UpdateStep[];
```

`detectInstallShape` is pure and takes its world as an argument, in the style of `pack-check.ts` and `install-as-command.ts` (both explicitly kept "dependency-free and side-effect-free" so the decisions are testable). Its rules, in order:

1. `/_npx/` in `pkgRoot` → `npx` (the same regex `isNpxExecStart` already uses — lift it into a shared helper rather than writing a third copy).
2. A `server-instances/` record whose recorded `ExecStart` resolves to this process → `service`. This is checked **before** the npx/global rules, because a service install is also one of those shapes underneath; the service wrapper is what dictates the apply step.
3. `pkgRoot` inside a git work tree, or a global shim that is a symlink into one (`npm link`) → `checkout`.
4. `pkgRoot` under the global prefix (`globalShimPaths`) → `global`.
5. A resolved version that is not the registry's `latest` line for the package, i.e. an explicit pin → `pinned`.
6. Otherwise `unknown` — and `unknown` is a no-op, not a guess.

`UpdateService` mirrors `SkillsUpdateService`'s surface and constraints one for one — `check()` / `apply()` / `snapshot()`, an in-process serializer, an exclusive `~/.cache/cez/update.lock` with PID + timestamp stale recovery (so two cockpits on one box cannot both `npm i -g`), `execFile` with argument arrays and `shell: false`, bounded output, a hard timeout, and silence on every failure. Deliberately copied, not abstracted: the two services will diverge (one restarts a systemd unit) and a premature shared base class would fight that.

`UpdateCoordinator` arms after `startServer` is listening — never during boot — exactly as the skills coordinator does. It is one machine-global concern, not per project: there is one cezar binary regardless of how many projects the workspace serves.

### Cross-system effects

- `src/index.ts:242-250` — the existing fire-and-forget `checkForUpdate` call keeps its banner but gains the applied state, so the message becomes *"updated to X — restart to use it"* once the apply half has run.
- `GET /api/v1/health` — `latestVersion` (`packages/contract/src/health.ts:86`) gains optional siblings `updateState` and `updateAppliedVersion`. Additive and optional; a cockpit that never updates sends neither.
- `app-shell.tsx:827-840` — the version chip already renders `update available: vX`. It gains one more state, *"updated — restart to apply"*, and stays a chip; no new route, no new page.
- `src/server-install/` — `refreshNpxCacheForRedeploy`, `isNpxExecStart` and `serviceExecStart` move from `platforms/ubuntu-vps.ts` into `src/server-install/launch-shape.ts`, re-exported from their old location so `ubuntu-vps.ts` and its 40 KB test file keep compiling unchanged.

**`macosx-ngrok` is explicitly out of scope, and not because it was forgotten.** Its `redeploy` (`platforms/macosx-ngrok.ts:337-351`) `launchctl kickstart`s the two agents and re-runs the identity step. It has **no** npx-cache refresh — so it carries the #696 bug this spec closes everywhere else — and **no** PID-change proof, which is open issue **#1011** (*"macosx-ngrok redeploy reports success when launchctl kickstart failed"*). Auto-updating a platform whose manual deploy both fails to fetch and lies about restarting would automate a false success. #1011 is the prerequisite; extending `service` support to this platform is a follow-up, and until then `detectInstallShape` reports it as a service that plans zero mutating steps.

## 📝 Data Model

No new state file, and that is a design constraint rather than an omission: AGENTS.md § Zero config — *"New state may be **written**, never **required**"*. Everything the feature needs is either in memory or already on disk.

| Datum | Where | Shape |
|---|---|---|
| last check / last applied | in-memory on `UpdateService` | as `SkillsUpdateService` does — a restart may recheck; the TTL, the lock and npm's own idempotence make that safe |
| cross-process exclusion | `~/.cache/cez/update.lock` | `{ pid, startedAt }`, stale after 2 min — the existing `skills-update.lock` format |
| the preference | `~/.cezar/config.json` → `autoUpdate?: boolean \| null` | optional, nullable, `.passthrough()` schema, identical tri-state to `skillsAutoUpdate` (§ BC 9) |
| previous version, for revert | the service instance record under `server-instances/` | one optional `previousVersion` field, written before a service update and cleared after a verified restart |

No PII, no credentials. The registry call is unauthenticated and sends nothing but a package name — as it already does today.

## 📝 API Contracts

Additive only, and every addition optional.

```ts
// packages/contract/src/health.ts — extends the existing response
latestVersion:        z.string().optional(),   // unchanged
updateState:          z.enum(['idle','checking','available','applying','applied','deferred','failed','unsupported']).optional(),
updateAppliedVersion: z.string().optional(),   // set once applied, pending restart
```

```
POST /api/v1/update/check     → UpdateState   (force a check; never applies)
POST /api/v1/update/apply     → UpdateState   (explicit user action from the chip)
```

Registered by chaining into a family builder in `server.ts`, with body/params validated as route middleware through `src/server/validators.ts` — the four HTTP invariants in AGENTS.md, including the one #694 broke by using a loose `app.get`. A `GET` never applies; only the coordinator and an explicit `POST /apply` mutate anything.

CLI: `cezar update` (additive under § BC 1) — reports the shape, the current and latest version, and applies. `--check` reports without applying; `--dry-run` prints the plan. This is also how a user on a `checkout` or `pinned` shape gets a useful answer instead of silence.

## 📝 UI/UX

Nothing new to navigate to. The version chip in the sidebar footer (`app-shell.tsx:827-840`) already has `update available` and gains one state:

| State | Chip | Tooltip |
|---|---|---|
| current | `v0.11.1` | `v0.11.1` |
| available, not yet applied | `v0.11.1` + pending dot | `update available: v0.12.0` |
| applied, pending restart | `v0.11.1` + pending dot | `updated to v0.12.0 — restart cezar to use it` |
| deferred, a run is mid-turn | `v0.11.1` + pending dot | `v0.12.0 ready — will restart when no task is running` |
| deferred, a run is waiting on an answer | `v0.11.1` + pending dot | `v0.12.0 ready — deferred by a task waiting for your answer` |

Settings → a toggle beside the existing *"Update Open Mercato skills automatically"* row in `settings/skills-section.tsx`, reusing that section's tri-state "On (default)" / explicit / *Reset to default* pattern verbatim. No mockups were rendered for this spec (§ Review limits) — every surface above is an added state on a component that exists.

## 📝 Edge Cases & Failure Scenarios

| Scenario | Behavior |
|---|---|
| Offline, registry 5xx/404, slow registry | `checkForUpdate` already returns `null` on any failure within 3 s. No banner, no apply, no log noise. |
| Read-only `$HOME`, no `~/.cache` | Lock cannot be created → automation disabled *for that attempt only*; manual `cezar update` still works. |
| `npm`/`npx` absent (standalone node) | Shape resolves, apply reports `unsupported`, chip keeps saying *update available*. Boot unaffected. |
| Two cockpits on one box | The `~/.cache/cez/update.lock` holder wins; the other skips this tick. Stale (>2 min, dead PID) locks are recovered. |
| `npm i -g` fails (EACCES on a root-owned prefix) | `failed` state, one journal line naming the prefix, no retry until the next TTL. The old version keeps running. |
| Service update, a run is `running` mid-turn | Restart **deferred**, state `deferred`, retried next tick. Never interrupts a turn. |
| Service update, a run is `waiting` on a `CEZ:ASK` | Also deferred — restarting would mark it `failed` (§ Problem Statement, `recover()` table). **But** an ASK park can last days, and a permanently-deferred updater is a broken updater for the one user this feature targets. So the deferral is *visible*, not silent: the chip reads *"v0.12.0 ready — deferred by a task waiting for your answer"*, the journal says the same once per transition, and answering the task (or an explicit `cezar update` / `POST /api/v1/update/apply`) proceeds immediately. No new knob, no time-based override that could restart through a live question. |
| Service restarted but the new version will not boot | `Restart=on-failure`/`RestartSec=5` crash-loops it into systemd's start limit → cockpit down. The one genuinely dangerous path; see § Reversibility. |
| Service restarted, new version boots | `recover()` brings every prior run to a defined state — with the per-branch costs in the § Problem Statement table. The gate above means the expensive branches should not be reachable via an *auto* update; they remain reachable via an operator's own `server-deploy`, unchanged. |
| Git checkout / `npm link` | Never mutated. `cezar update` prints `git pull && npm run build`. |
| Pinned launch (`cezar-cli@0.11.0`) | Never mutated; the pin is an instruction. |
| A release is published mid-apply | The lock serializes; the next TTL picks up whatever is newest. |
| `latest` is *older* than the running version (a nightly, or an unpublish) | `isNewerVersion` already returns false. Never downgrades. |

## 📝 Risks & Impact Review

**Reversibility — the load-bearing section.** Every shape must be undoable, and the service shape must be undoable *without a human*:

- **npx** — the update is a cache deletion. Reverting is running `npx cezar-cli@<old>` once. Nothing was overwritten.
- **global** — record the version before `npm i -g`; revert is `npm i -g cezar-cli@<old>`, the same bounded call.
- **service** — before applying, write `previousVersion` onto the instance record. After the restart, run the installer's existing `confirmServiceRestarted` (PID changed — the #912 check) **and** `confirmCezarRunning` (the port answers). If either fails, or the unit enters `failed` within a bounded window, re-pin to `previousVersion` (an `ExecStart` naming `cezar-cli@<old>`, or `npm i -g cezar-cli@<old>`), restart again, and leave a loud journal line plus a `failed` state visible on the chip. Clear `previousVersion` only after a verified restart. **A service auto-update without this path must not ship** — it is the difference between an unattended convenience and an unattended outage.
- **The feature itself** — `CEZ_AUTO_UPDATE=0`, or the Settings toggle, stops all application; detection stays read-only.

**Who bears the impact.** Every cezar user, on the default path. That is the point of Q1 and also the reason it needs the owner rather than this document.

**Protected surfaces** (`BACKWARD_COMPATIBILITY.md`): § 1 CLI (`cezar update` is a new command, additive), § 2 HTTP API (two new routes, two optional response fields), § 9 `~/.cezar/` (one optional nullable key). Absence of every addition reproduces today's behavior exactly, so no migration is required. If Q1 is answered *default-on*, the implementation PR **must** amend AGENTS.md § Zero config and `BACKWARD_COMPATIBILITY.md` in the same change to record the owner-approved exception, its off switch and its bounds — as #615 did for skills updates and #801/#1016 did for automations. Review treats omission of that documentation as blocking. Adding `CEZ_AUTO_UPDATE` also obliges `.env.example` and the `docs/reference.md` env table in the same commit (AGENTS.md env contract).

**A direction call, not a defect:** this spec argues that fixing `server-deploy`'s global-install no-op (Phase 2, Step 1) is in scope because an automatic path built on a silently-lying manual path inherits the lie. The behavior itself is **confirmed at the code level** — `runDeploy` delegates to `strategy.redeploy` alone, and ubuntu-vps's `redeploy` issues no install command — but it has **not** been reproduced on a live host in this run, so Step 1 still begins by pinning it with a failing test rather than trusting the reading.

## 📋 Phasing

- **Phase 1 — local shapes.** Shared detection, the apply half, the coordinator, the kill switch, the chip state, `cezar update`. Ships value alone: the npx trap is closed for every local user.
- **Phase 2 — the service shape.** The `server-deploy` global-install fix, the idle gate, the verified restart and the revert path. Depends on Phase 1's detection but nothing else.
- **Phase 3 — surface polish.** The Settings toggle and `/api/v1/update/*`. Optional; Phases 1–2 work with the env var and the CLI alone.

## 📋 Implementation Plan

### Phase 1 — local shapes

1. **Extract the launch-shape helpers.** Move `isNpxExecStart`, `serviceExecStart` and `refreshNpxCacheForRedeploy` from `platforms/ubuntu-vps.ts` to `src/server-install/launch-shape.ts`; re-export from the old module. *Test:* `ubuntu-vps.test.ts` and `strategies.test.ts` pass untouched — a pure move.
2. **Add `detectInstallShape`** in `src/update-apply.ts`, pure, world-as-argument. *Test:* a table-driven unit test, one row per shape, including `npm link` (shim symlinked into a work tree) vs a real global install, and a pinned launch.
3. **Add `planUpdate`** — shape → bounded `UpdateStep[]` (argument arrays, never strings). *Test:* asserts the exact argv per shape and that `checkout` / `pinned` / `unknown` plan **zero** mutating steps.
4. **Add `UpdateService.apply()`** for `npx` and `global`, under the `~/.cache/cez/update.lock` (lock helper lifted from `skills-update.ts`). *Test:* against a fake runner — cache entries cleared for npx; exact `npm i -g` argv for global; concurrent callers serialize; a held lock skips.
5. **Add `UpdateCoordinator`**, armed after `startServer` listens, 24 h TTL, honoring `CEZ_AUTO_UPDATE`. *Test:* fake clock — one attempt per TTL, none before listening, none when disabled, silent on a throwing service.
6. **Wire the banner** in `src/index.ts` to the applied state. *Test:* boot with a stubbed service; assert the *"restart to use it"* wording and that a failing service does not affect the exit path.
7. **Add `cezar update [--check] [--dry-run]`.** *Test:* the e2e packaged-CLI suite (`test/e2e/`) runs `cezar update --dry-run` in an isolated consumer and asserts the reported shape and the planned, unexecuted argv.
8. **Document the env var** — `.env.example` + the `docs/reference.md` env table. *Test:* the repo's env-contract check, if one exists; otherwise a unit test asserting the var appears in `.env.example`.

### Phase 2 — the service shape

1. **Pin the `server-deploy` global-install gap with a failing test,** then fix `redeploy` to fetch before restarting on the `<node> <globalBin>` ExecStart shape. *Test:* `ubuntu-vps.test.ts` — global-shape redeploy issues the install step; npx-shape redeploy still only clears the cache; checkout-shape redeploy still mutates nothing. Prove it red first (AGENTS.md § *Prove the regression test fails without the fix*).
2. **Teach `detectInstallShape` the service shape** from the `server-instances/` records. *Test:* fixture records for user-scope and system-scope units, and for a second instance on the same box (#1003/#913 territory) — the record matched must be **this** process's.
3. **Add the idle gate** — no apply while any run is `running` or `waiting`; state `deferred`, with the *reason* carried (mid-turn vs waiting-on-an-answer) so the chip and the journal can say which. *Test:* one `running` run defers and retries next tick; one `waiting` + `askParked` run defers with the answer-reason; an empty store proceeds; an explicit `apply` call overrides the deferral. Pin the underlying fact the gate exists for — a `recover()` test asserting an `askParked` run becomes `failed` — so a future change to `recover()` cannot silently make this gate look unnecessary.
4. **Add the verified restart with revert.** Record `previousVersion`, delegate the restart to the existing engine path, then `confirmServiceRestarted` + `confirmCezarRunning`; on failure re-pin and restart. *Test:* fake runner — a failing health check triggers exactly one revert with the recorded version; a successful one clears `previousVersion` and never reverts.
5. **Surface it in the journal** — one line per outcome (applied / deferred / reverted), because the journal is the hosted user's only channel. *Test:* asserts one line per outcome and none on a no-op tick.

### Phase 3 — surfaces

1. **Extend the health contract** with the two optional fields; chain the two `/api/v1/update/*` routes into a family builder with middleware validators. *Test:* `contract-parity*.test.ts` in both directions; a `GET` never mutates.
2. **Add `autoUpdate` to `~/.cezar/config.json`** with the tri-state precedence (explicit → `CEZ_AUTO_UPDATE` → `true`). *Test:* precedence table; a corrupt config falls back without throwing.
3. **Add the chip state and the Settings toggle.** *Test:* component tests for each chip state; a settings test for set / unset / reset-to-default, mirroring `skills-section.test.tsx`.

## 🔍 Review limits

- **No network research was possible in this run** (the web-search tool was denied), so the market comparison is grounded only in the `claude` CLI installed on the development host and in `docs/publishing.md`. The Tailscale / node-exporter comparison is recollection and should be verified before it is cited as precedent in review.
- Every in-repo claim (file, line, symbol, behavior) was read directly from the working tree at `4763447`. A second verification pass re-read the whole deploy path and all five `recover()` branches and **corrected three claims in the first draft**: `recover()` is not uniform (an `askParked` run is marked `failed` by a restart, which is why the idle gate and its visible-deferral escape exist); `macosx-ngrok` does *not* inherit the fix for free and is now explicitly out of scope behind #1011; and the `server-deploy` global-install no-op is confirmed at the code level rather than merely inferred.
- Nothing was executed against a live VPS or a live macOS host. The global-install no-op is code-confirmed but not reproduced, and Phase 2 Step 1 pins it with a failing test before fixing it.
- No UI mockups were rendered; every UI change described is a new state on an existing component.
- The scope-cohesion review that `om-spec-writing` delegates to a fresh-context subagent was performed by the author instead, because this session's tool policy forbids spawning subagents. An adversarial re-read by someone other than the author is still owed — the relevant question is Q5 (one spec, three phases) in the assumptions table.
