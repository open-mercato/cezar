# Session Lifecycle Hooks — project-owned worktree setup and teardown (#653)

## 📝 TLDR

Let a project run its own setup script — submodules, `.env`, `pnpm install`, docker
ports — every time cezar hands an agent an unprovisioned task worktree, and its teardown
script when the run ends.

cezar materializes a task worktree with `git worktree add` and nothing else. Projects
whose checkout needs more than that get a half-prepared tree and must burn agent
tokens on deterministic script work. This spec adds **session lifecycle hooks**: a
`hooks` map in `.ai/cezar/config.json` binding lifecycle events to shell commands that
cezar itself runs, in the session's cwd, **runner-agnostic** (identical under claude /
codex / opencode / pi), with output streamed into the session event log. Two events —
`worktree-created` (fail-closed, fires whenever a worktree is **unprovisioned and about to
be used**, which includes a Continue after teardown already ran) and `run-end`
(best-effort, fires on **every** terminal transition via one store-bus observer, plus the
two routes that destroy a worktree without one) — and one action kind,
`run: "<shell command>"`. The pair is a bracket, and both sides must be idempotent. One
phase, no follow-up: the deterministic script is the whole feature.

## 📝 Open Questions

**None left.** Q1 — the anchor for teardown — was the one open question and it was settled
in review.

- **Q1 (settled): the store bus is the anchor.** Subscribing `RunManager` to `RunStore`'s
  `('run')` event (`packages/cezar/src/runs/store.ts:1060`) beats wiring teardown into
  `dropActive()` (`run.ts:1140`), for two reasons. The first is the one this spec argued and
  review verified independently: `dropActive` is **unreachable** from both review-gate
  exits. Two sites flip a review-resting run to `done` — `finish()` (`run.ts:1951`), which
  writes `status: 'done'` without ever touching `this.active`, and the create-draft-PR route
  (`server.ts:4206`), which guards its own entry with `if (manager.isActive(id)) return …
  409` (`server.ts:4182`) and so *refuses to run* unless the run has already left the active
  registry. Not a near-miss to be patched carefully — unreachable by construction, and it is
  the state a task sits in longest while holding containers and ports. The second reason is
  one this spec understated: the fallback it offered — `dropActive()` **plus** explicit
  teardown calls at those two sites — would put a teardown trigger inside an HTTP handler in
  `server.ts`, next to `createDraftPr`. That is a layering inversion this design would not
  accept anywhere else. "Risks & Impact Review" lists the structural controls that make the
  coupling safe; the load-bearing one is the **latch**, not the absence of a cycle — see the
  correction recorded there.

*Settled during review.* The teardown event is named **`run-end`**, not `session-end`: a
worktree is created once and outlives many sessions — every Continue opens a new one — so
teardown belongs to the run's terminal status, not to a session's. And there is **no
second phase**: [R2]'s "configurable AI prompt" is an alternative that lost on
determinism, not deferred scope. It is recorded under "Alternatives considered" and
"Non-goals" and nothing in the design is shaped to accommodate it.

## 📝 Problem Statement

> Path/line references are against `main` at `1912f2f2`, verified on 2026-08-17, and are
> paired with a symbol name — follow the symbol if a number has drifted.

### Background: what was actually said on #653

This spec is self-contained — every quote it argues with is reproduced here, so no reader
has to open the issue to follow the reasoning. Source:
[open-mercato/cezar#653](https://github.com/open-mercato/cezar/issues/653), opened
2026-07-24 by **@Nopik** (Kamil Burzyński).

**[R1] @Nopik, the request** (issue body):

> In some projects setting up worktree is more than just git clone. E.g. I'm working on a
> project where there are some git submodules needed to be fetched out as well, some
> `.env` file to be set up and perhaps `pnpm install` too. So, just plain git worktree
> might be good for quick tasks and short-lived things, but for anything more complex it
> will fail.
>
> So, it would be great if Cezar could support some worktree setup commands, perhaps
> optional (i.e. still allow some small tasks to run on 'bare' worktree).
>
> I guess this can be simulated to some extend with existing workflows and/or running a
> skill, though running AI agents and spending tokens to do the deterministic script work
> seems overkill.

**[R2] @pkarw, maintainer, 2026-07-24**
([comment](https://github.com/open-mercato/cezar/issues/653#issuecomment-5072457289)):

> yes, happy to accept such PR - please make the spec first; we can have like a
> configurable additional AI prompt run just after worktree setup and it'll be probably
> more easy to maintain than fixed scripts (would be hard to test them, problems with the
> paths etc)

**[R3] @pkarw, maintainer, 2026-07-24, one minute later**
([comment](https://github.com/open-mercato/cezar/issues/653#issuecomment-5072465770)):

> I think we could make it more general feature of hooks for certain session lifecycles
> like claude hooks or something likte this - but executed in the session context by cezar
> runner agnostic

**[R4] @Nopik, 2026-08-10**
([comment](https://github.com/open-mercato/cezar/issues/653#issuecomment-5238970396)) —
why this spec is written by someone other than the reporter:

> @wojciechszyjka thanks, but I ended up not using Cezar at all, at least not currently.
> Feel free to work on this feature or close the request as wontfix. For the time being
> I'm not planning to work on it myself.

**How this spec resolves them.** [R3] is adopted wholesale and is the shape of the whole
design: a general lifecycle-hook table, owned and executed by cezar so it works under
every runner. [R1]'s "perhaps optional … still allow some small tasks to run on 'bare'
worktree" is the per-task opt-out in "UI/UX". [R2]'s *AI prompt* is **rejected** — see
"Alternatives considered" — but the objection [R2] raises against scripts ("hard to test
them, problems with the paths") is treated as a binding requirement and answered by the
fixed cwd, the `CEZ_*` env contract, and the `cez hooks run` command. [R4] means there is
no reporter to consult on open questions; the one that remains is directed at the
maintainer.

### Why the current code cannot do it

`createWorktree` (`packages/cezar/src/git-worktree.ts:136`) does exactly one thing:
`git worktree add -b cez/<id8> .ai/cezar/worktrees/<runId> <base>`. The workflow runner
(`packages/cezar/src/workflows/run.ts:2536`) then seeds the personal agent-config layer
and spawns the agent. Nothing between those two points can prepare the tree.

For a repo where a working checkout is `git worktree add` **plus** submodule fetch,
`.env` materialization, dependency install, or per-worktree port allocation, every task
starts in a tree that does not build. The only workaround today is the one [R1] names and
rejects in the same breath — simulate it "with existing workflows and/or running a skill"
— which means paying an LLM to perform a deterministic script, per task, forever.

The two existing extension points do not cover it:

- **`check` steps** (`runCheckStep`, `packages/cezar/src/workflows/run.ts:3477`) run
  shell commands in the worktree, but they are *workflow* steps: they run after the
  agent step they follow, they are per-workflow rather than per-project, and every
  workflow would have to repeat them.
- **Runner-native hooks** (Claude Code's `settings.json` hooks) exist for exactly one of
  the four runners cezar supports. A project setup that only works when the task happens
  to be dispatched to claude is not a project setup.

So [R2] and [R3] read together set the design constraint: build the *general* mechanism (a
lifecycle-hook table, shaped like Claude Code hooks but owned and executed by cezar so it
works under every runner), and make the fragility [R2] warns about — untestable,
path-dependent scripts — an explicit part of the contract rather than a hope.

## 📝 Prior Art

Four ecosystems already solved "prepare an ephemeral checkout". What they agree on is
worth copying; what they carry that we can skip is worth naming.

| System | Lifecycle points | What it gets right | What we skip |
|---|---|---|---|
| **Dev Containers** (`devcontainer.json`) | `initializeCommand`, `onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand`, `postAttachCommand` | Splits *create* from *start* from *attach*, so an expensive install runs once and a cheap "start the DB" runs every time. Commands are string-or-array, and the create-time ones are cacheable into a prebuilt image. | Six events for a first cut. We ship the two that bracket a worktree's life and name the extension point for the rest. No prebuild/image layer — a git worktree is not an image. |
| **Gitpod / Codespaces prebuilds** (`.gitpod.yml` `before` / `init` / `command`) | Same create/start split, plus prebuilds that run `init` ahead of time on the org's infra | Names the real cost — dependency install dominates time-to-first-token — and answers it with a *shared cache*, not with a faster script. | No prebuild infrastructure. The equivalent answer for cezar is a shared store under `$CEZ_REPO_ROOT` (pnpm store, cargo registry), which a project's own script can point at today. |
| **Claude Code hooks** (`settings.json`) | `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `Stop`, … with `matcher`, `command`, `timeout` | The table shape this spec borrows wholesale: event key → array of actions, per-hook timeout, exit code decides whether the run continues. Proves the ergonomics. | Runner-specific by construction — which is precisely why cezar must own its own table ([R3]'s "runner agnostic"). We also skip `matcher` (nothing to match on at worktree creation) and JSON-on-stdin (an env contract is enough for a setup script). |
| **git's own `post-checkout` hook** | Fires after `git worktree add`, cwd = the new worktree — **verified empirically on git 2.53** | Zero new machinery, and it already covers *both* of cezar's materialization paths for free, including the retention re-materialization, because both route through `createWorktree`. | See "Alternatives considered" — it has no teardown, no per-task opt-out, no event-log integration, and it fires for the user's own manual `git worktree add` too. Rejected, but it is the strongest alternative and the reason the `fresh` flag below must earn its keep. |
| **`direnv` / `mise`** | Per-directory env on `cd` | The right answer for *env*, and worth pointing projects at: `.envrc` in the worktree needs no cezar feature at all. | Nothing to build. Named here so the spec does not reinvent per-directory env loading — it writes a `.env` and stops. |

The synthesis: copy Claude Code's table shape, copy Dev Containers' create-vs-reuse
distinction (that is what `fresh` is), copy Gitpod's honesty about install cost, and add
the one thing none of them has to solve — a **teardown** event, because cezar is the only
one of these that creates and destroys many checkouts against one long-lived repo.

## 📝 Proposed Solution

A `hooks` map on the existing per-project config, keyed by lifecycle event:

```jsonc
// .ai/cezar/config.json
{
  "hooks": {
    "worktree-created": [
      { "run": "bash scripts/cezar-setup-worktree.sh", "timeoutMs": 900000 }
    ],
    "run-end": [
      { "run": "docker compose down -v", "onFail": "warn" }
    ]
  }
}
```

**Events.** Two, chosen because they bracket the worktree's life and between them cover
the whole issue:

| Event | Fires | cwd | Default `onFail` |
|---|---|---|---|
| `worktree-created` | every time a worktree becomes **unprovisioned-and-in-use**: the directory was just materialized, *or* the run is being continued after its teardown already ran | the worktree | `fail` |
| `run-end` | on the run's transition into a terminal status (`done` / `failed` / `cancelled`), and on the two routes that destroy a worktree without any status transition, whenever the worktree directory still exists | the worktree | `warn` |

*Materialized* throughout this spec means "the worktree directory got created on disk
just now" — a checkout with no `node_modules`, no `.env`, no submodule contents — as
opposed to an existing directory being reused.

**The pair is a bracket, and the bracket is what the trigger keys off.** Materialization is
*not* the same question as provisioning: a run that finished (teardown fired, containers
gone) and is then Continued still owns its directory, so nothing was re-materialized — but
it is unprovisioned all the same, and setup must run again. Both events therefore key off a
`hooksProvisioned` bit on the run record rather than off directory freshness alone; see
"Setup fires on provisioning, not on materialization" below.

`worktree-created` is **fail-closed by default**: a hook exiting non-zero fails the run,
with the hook's output on the event stream. A silently half-provisioned worktree that
then burns a full agent session failing to build is strictly worse than a run that stops
with the install error visible.

`run-end` is best-effort — the work is already done and committed; a failing teardown
must never turn a successful run red.

### Both events need an anchor that no code path can miss

This is the load-bearing part of the design, and the naive reading of the runner gets it
wrong twice.

**Setup does not happen in one place.** A worktree directory is materialized on *two*
paths:

1. `execute()` → `createWorktree` (`run.ts:2536`) — a new run.
2. `runContinuation()` → `rematerializeReclaimedWorktree` (`run.ts:2106` →
   `packages/cezar/src/runs/retention.ts:68`) — a **Continue on a run whose directory
   retention already reclaimed**, which reattaches the surviving `cez/<id8>` branch into
   a tree with no untracked files and therefore no `node_modules`, no `.env`, no
   submodule contents.

A hook wired only into `execute()` leaves path 2 spawning an agent into an unprovisioned
tree — the exact failure the feature exists to prevent, arriving on the path where it is
hardest to notice. Both sites run the hook.

**Terminal transitions do not happen in one place either.** A run reaches a terminal
status from at least four:

1. `execute()`'s terminal block (`run.ts:2715-2731`) — cancelled / failed / done.
2. `execute()`'s early-return failure paths — worktree creation (`run.ts:2551-2560`), and
   now setup-hook failure.
3. `runContinuation()`'s `try/catch/finally` (`run.ts:2083` onward) — a Continue session
   reaching success, failure or cancellation on its own.
4. **`review` → `done`**, which happens in neither. Two sites, both flipping a run that is
   resting at the review gate:
   - `finish()` (`run.ts:1951`) — `this.store.updateRun(runId, { status: 'done' })` when
     the user accepts the review without a PR.
   - the create-draft-PR route (`packages/cezar/src/server/server.ts:4206`) — same
     `updateRun`, plus the PR url.

   A run at `review` is live: it still holds its worktree and, for the motivating use
   case, its containers and ports. This is precisely the path whose teardown must not be
   skipped, and it is the one that sits longest.

`dropActive()` (`run.ts:1140`) is the existing shared finalizer and is documented as
"every terminal path funnels through here" — it is where retention (`enforceRetention`,
`run.ts:1502`) and the run tmpdir cleanup already hang. It covers 1–3 but **not 4**, and
that gap is not a matter of interpretation:

- `finish()` reaches `updateRun` without ever touching `this.active`.
- the PR route guards its own entry with
  `if (manager.isActive(id)) return c.json({ error: 'run is still active — wait for the
  review gate' }, 409)` (`server.ts:4182`) — it *refuses to run* unless the run is
  inactive. A run that has left the active registry can never pass back through
  `dropActive`, so this exit is unreachable from it by construction.

So `run-end` anchors one level lower, on the store's status edge:

```ts
// RunManager constructor
this.offRunSettled = this.store.on('run', (run) => void this.maybeRunEndHooks(run));
```

`RunStore` is an `EventEmitter` whose private `touch()` emits `('run', RunRecord)` on
every `updateRun` (`packages/cezar/src/runs/store.ts:1060`). A single subscription there
covers all four paths, every review-gate exit, and every terminal path added in future,
with no obligation on the author of that path to remember a hook. Edge detection lives in a
`Map<runId, status>`; the hook fires only on a transition **into** `{done, failed,
cancelled}` from a non-terminal status, so `review` and `waiting` never trigger it and a
repeated `updateRun` carrying the same status cannot double-fire.

That last clause is the whole safety story, because the observer wakes on **more than
status writes**. `appendEvent` mostly emits `'event'` (`store.ts:797`), but past that its
"janitor trick" block scans every event's text for PR and issue URLs and writes what it
finds back onto the record — `this.updateRun(runId, { pullRequestUrl: created })`
(`store.ts:809`), `if (changed) this.touch(run)` (`store.ts:823`). So any agent event whose
text carries a PR or issue URL *does* wake the observer. The map latch is what makes that
harmless, and it is the primary control rather than a backstop; see the correction in
"Risks & Impact Review".

### Two routes destroy a worktree with no status transition at all

The store bus catches every *status* edge. It does not catch these, because neither writes
a status:

- `POST /api/v1/runs/:id/remove-worktree` (`packages/cezar/src/server/server.ts:4218`) — the
  explicit "🧹 Remove worktree" cleanup — calls `removeWorktree(...)` and then
  `store.updateRun(id, { worktreePath: undefined, branch: undefined })`. Not a status edge,
  so the observer no-ops; and because it clears `worktreePath`, nothing downstream can find
  the worktree afterwards either.
- `DELETE /api/v1/runs/:id` (`server.ts:4237`) — `store.deleteRun(id)` drops the record
  whose `worktreePath` was the only handle on the directory.

A user tidying up a finished task in the cockpit — the natural thing to do — would silently
accumulate orphaned containers. Both routes therefore **fire `run-end` explicitly, before
they remove anything**: each already holds the `run` record with its `worktreePath` in hand
one line earlier, so this is one call site apiece and no new mechanism. The call is awaited
rather than fire-and-forget, because the alternative races the teardown script against the
directory being deleted out from under it; the cost is that a slow teardown delays the
route's response up to the hook's own `timeoutMs`, which is the project's script being slow
and is reported honestly. Both routes are protected surfaces in `BACKWARD_COMPATIBILITY.md`
§2 — no request or response shape changes, only the side effect.

### Setup fires on provisioning, not on materialization

`createWorktree` is idempotent and already returns an existing worktree on
restart/Continue. Hooks must not re-run `pnpm install` on every Continue, so `WorktreeInfo`
(`git-worktree.ts:87`) grows a `fresh` flag: true for the `worktree add -b` path **and** the
reattach path (`git-worktree.ts:~204`), false only when an already-registered worktree at
the path is reused as-is (`git-worktree.ts:~198`). On the continuation path no new signal is
needed — `rematerializeReclaimedWorktree` already returns `true` *only* when it
re-materialized (`retention.ts:73-80`); the callsite at `run.ts:2106` currently discards
that boolean and must start capturing it.

**But freshness alone is the wrong trigger, and on the mainline path it is broken.** Take
the motivating flow: the run reaches `done` (the user clicks Finish at the review gate),
`run-end` fires, `docker compose down -v` removes the containers and releases the ports. The
worktree **directory survives** — `enforceRetention` reclaims only *over-limit* worktrees
(`run.ts:1502`) and this run's is the newest. The user then clicks Continue.
`rematerializeReclaimedWorktree` returns `false` because the directory is still there
(`retention.ts:74`), so on a freshness trigger setup does not re-run, and the agent spawns
into a tree whose containers are gone, whose ports are unbound, and whose database no longer
exists. That is the exact failure named in the Problem Statement, reached by the most
ordinary sequence in the product.

So the run record carries a `hooksProvisioned?: boolean`: **set** after `worktree-created`
completes successfully, **cleared** by `run-end`. Setup fires when the worktree is fresh
**or** the run is not currently provisioned. Freshness still matters — it is what keeps
`pnpm install` from re-running on an ordinary mid-run Continue, where the bracket never
closed — but provisioning is what closes the finish-then-continue hole.

This makes idempotency a **two-sided** contract term, stated in the docs and worth stating
here:

- **Teardown hooks must be idempotent** (`docker compose down` against nothing is already a
  no-op), because they may run for a worktree whose setup never completed, and they run
  again if the run is continued and re-finished.
- **Setup hooks must be idempotent too**, because on the finish-then-continue path they
  re-run against a directory that still holds `node_modules`, `.env` and submodule contents.
  A setup script that appends to `.env`, or that assumes a clean tree, breaks here. The
  worked example below is written to survive a second run.

Because `run-end`'s trigger is "terminal status **and** the worktree directory exists", a
run whose setup failed half-way — hook 1 allocated a port and started a container, hook 2
failed — is still a terminal run with an existing worktree, so teardown fires. Same for a
cancel landing mid-setup. `hooksProvisioned` is a hint for the setup side, never a guard on
the teardown side, so a partial setup is never stranded.

**One action kind: `run`, a shell command.** This is where the spec disagrees with [R2],
so it states the reasoning rather than hedging with a second phase. For every case [R1]
names — submodules, `.env`, `pnpm install`, and the port allocation such a setup implies —
determinism *is* the feature. An LLM asked to "allocate a free port and write `.env`" is
slower, costs tokens on every task forever (the exact cost [R1] filed the issue to
remove), and is not reproducible across tasks that must not collide. [R2]'s "hard to test
them, problems with the paths" objection is real, and it is answered by contract, not by
replacing the script with a model:

- **cwd is fixed and documented** — always the worktree root; relative paths in the
  command resolve there, never against the user's shell cwd.
- **an env contract** — `CEZ_WORKTREE`, `CEZ_REPO_ROOT`, `CEZ_TASK_ID`, `CEZ_BRANCH`,
  `CEZ_BASE_BRANCH`, `CEZ_EVENT` — so a script never has to guess a path or parse one out
  of `git worktree list`.
- **a timeout** (default 10 min, per-hook override) with SIGTERM → SIGKILL escalation, so
  a hook that hangs cannot wedge a task slot forever.
- **`cez hooks run <event>`**, a CLI that executes a project's hooks against a named
  worktree, so the script is testable without dispatching a task.

### Worked example — [R1]'s project, end to end

Both scripts are committed to the project repo; only the small `hooks` block is local per
checkout.

```jsonc
// .ai/cezar/config.json  (gitignored — local, written once per checkout)
{
  "hooks": {
    "worktree-created": [
      { "run": "bash scripts/cezar-setup-worktree.sh", "timeoutMs": 900000 }
    ],
    "run-end": [
      { "run": "bash scripts/cezar-teardown-worktree.sh", "onFail": "warn" }
    ]
  }
}
```

```bash
#!/usr/bin/env bash
# scripts/cezar-setup-worktree.sh — cwd is $CEZ_WORKTREE.
# MUST be idempotent: it runs again when a finished task is Continued, against a
# directory that already holds node_modules, .env and submodule contents.
set -euo pipefail

# Port block derived from the run id, NOT scanned: two tasks starting at the same
# moment cannot pick the same block, so no lock is needed. A collision between two
# LIVE worktrees is possible (~1 in 1000 per pair) and surfaces honestly as a
# compose port-bind error, not as silent cross-talk. Deriving it also means a
# re-run picks the same ports rather than migrating a live task onto new ones.
offset=$(( 0x${CEZ_TASK_ID:0:4} % 1000 ))
app_port=$(( 20000 + offset * 10 ))

git submodule update --init --recursive

# Written once. Not clobbered on re-run: by then the agent may have edited it.
if [ ! -f .env ]; then
  cp "$CEZ_REPO_ROOT/.env.example" .env
  cat >> .env <<EOF
APP_PORT=$app_port
DB_PORT=$(( app_port + 1 ))
COMPOSE_PROJECT_NAME=cez-${CEZ_TASK_ID:0:8}
EOF
fi

pnpm install --frozen-lockfile
docker compose up -d --wait
```

```bash
#!/usr/bin/env bash
# scripts/cezar-teardown-worktree.sh — cwd is $CEZ_WORKTREE.
# MUST be idempotent: it also runs when setup failed half-way, and again if the
# task is continued and finishes a second time.
set -euo pipefail
COMPOSE_PROJECT_NAME="cez-${CEZ_TASK_ID:0:8}" docker compose down -v --remove-orphans || true
```

Note what this example does *not* need: any channel for the hook to tell the agent which
port it got. The agent reads its ports out of the worktree's own `.env`, which compose
and most toolchains already load. That is why no hook→session env export is specified —
the file the hook already has to write is the channel.

### Alternatives considered

- **git's native `post-checkout` hook.** Verified to fire on `git worktree add` with cwd
  set to the new worktree, which means it would cover *both* materialization paths for
  free and delete the `fresh` flag and both callsites from this design — by far the
  cheapest option. Rejected on four counts, each fatal on its own: (a) no teardown
  counterpart exists in git at all, and teardown is half the issue; (b) `.git/hooks` (or
  `core.hooksPath`) is repo-wide, so it fires for a developer's own manual
  `git worktree add` as well as cezar's, with no way to tell them apart beyond sniffing
  env; (c) its stdout lands in cezar's git subprocess capture, not on the session event
  stream, so a failing install is invisible in the cockpit; (d) there is no per-task
  opt-out, which [R1] explicitly asks for ("perhaps optional … still allow some small
  tasks to run on 'bare' worktree"). Worth documenting in the README as the zero-feature
  option for projects that only need setup and are happy without visibility.
- **A dedicated `worktreeSetup: "<cmd>"` config string.** Smaller, and it satisfies [R1]
  exactly. Rejected: [R3] asked for the general lifecycle mechanism, and teardown is
  needed by the same users — a project that allocates ports and starts containers per
  worktree must release them.
- **Hooks that run an AI prompt instead of a command** — [R2], the maintainer's own
  counter-proposal. Rejected outright, not deferred, and this is the spec's one open
  disagreement with the person who has to accept it. [R1] filed the issue because
  deterministic setup work was being paid for in tokens ("running AI agents and spending
  tokens to do the deterministic script work seems overkill"); answering it with a
  per-task LLM call keeps that cost and adds non-reproducibility on top — two tasks
  running the same "allocate a free port" prompt can pick the same port, which is silent
  cross-talk rather than an honest bind error. [R2]'s stated motivation was that scripts
  are hard to test and path-fragile, and that objection is answered directly rather than
  dismissed: the cwd is fixed and documented, the `CEZ_*` env contract means a script
  never guesses a path, and `cez hooks run <event>` executes a project's hooks without
  dispatching a task — which is precisely the testability [R2] was worried about losing.
  If a genuine case for a prompt hook appears later, `run` is a plain object key and
  widening it to a union is a schema line; nothing here is shaped in advance for it.
- **Teardown wired into `dropActive()`** instead of the store bus. Tempting — it is the
  established terminal hook point. Rejected: it misses the review-gate exits (path 4
  above), which is the leak that matters most for container/port hooks. See Q1.
- **Teardown wired into each terminal callsite.** Rejected: four sites today, spread
  across `run.ts` and `server.ts`, and nothing stops a fifth being added without one.
- **A committed `.ai/cezar/hooks.yaml`.** Rejected: `.ai/cezar/` is gitignored, and that
  turns out to be a *security* property worth keeping — see Risks.
- **Reusing workflow `check` steps by auto-prepending one.** Rejected: check steps report
  as workflow steps in the UI, participate in retry/`onFail` routing, and would appear in
  every workflow's step list. Setup is not a step of the user's workflow.

## 📝 Architecture

**What is reused, not rebuilt:**

- `loadConfig(repoRoot)` (`packages/cezar/src/config.ts:147`) — already read once per run
  at `run.ts:2459`, already merges machine defaults, already degrades to defaults on
  malformed JSON. The hook table is one more additive key.
- The `runCheckStep` spawn shape (`run.ts:3477`) — `spawn('bash', ['-lc', cmd], { cwd, env })`,
  capped output collection, `state.interrupt` wiring for cancel. Extracted, not copied
  (below).
- `RunStore`'s existing `('run', RunRecord)` bus (`store.ts:1060`) — no new emitter, no
  new event type, and not a novel consumption pattern either: `index.ts:436` already
  subscribes to it outside SSE.
- `rematerializeReclaimedWorktree`'s existing `boolean` return as the continuation-path
  freshness signal — no signature change, only a callsite that stops discarding it.
- **Secret redaction — already free.** `appendEvent` runs every event through
  `this.redact(...)` before it touches disk or the wire (`store.ts:790-793`, #427). Hook
  output that goes through the normal event path is therefore redacted with **no new
  code**; the requirement is simply that hook output must not bypass `appendEvent`.
- The `note` and `check-output` session events — hook output needs **no new UI**.
  Verified, not assumed: the cockpit's `check-output` case
  (`packages/web/src/routes/task-thread/thread-state.ts:556`) reads only `command`, `text`
  and `exitCode` and renders them as an execute tool card with an exit-code pill — it
  never touches `stepId`, so hook events (which have no step) render exactly like a check
  step's. And `currentTurn()` is `turns.at(-1) ?? newTurn()` (`thread-state.ts:338`), so a
  `worktree-created` event arriving *before the first agent turn exists* still lands in a
  synthesized turn rather than being dropped.
- The existing worktree-failure path (`run.ts:2551-2560`) for a fail-closed setup hook:
  same `status: 'failed'`, same lifecycle event, same `dropActive`.
- `agentTmpEnv` / the `CEZ_*` env namespace convention (`run.ts:675`), and
  `enforceRetention`'s fire-and-forget-never-throw discipline (`run.ts:1502`) as the model
  for the teardown observer.

**What is new:**

1. **Config schema** (`packages/cezar/src/config.ts`), additive and degrade-safe in the
   established style (`systemPrompt`'s `.optional().catch(undefined)`):

   ```ts
   const hookSchema = z.object({
     run: z.string().trim().min(1).max(4_000),
     onFail: z.enum(['fail', 'warn']).optional(),      // default is per-event
     timeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
   });
   const hooksSchema = z
     .object({
       'worktree-created': z.array(hookSchema).max(10).optional(),
       'run-end': z.array(hookSchema).max(10).optional(),
     })
     .optional()
     .catch(undefined);
   ```

   A malformed `hooks` value degrades the key to `undefined` — never the whole config, and
   never a run that fails because someone typo'd a timeout.

2. **`spawnShell(opts)`** in a new `packages/cezar/src/workflows/shell.ts` — the primitive
   extracted from `runCheckStep`:

   ```ts
   spawnShell(opts: {
     command: string; cwd: string; env: NodeJS.ProcessEnv;
     timeoutMs?: number; outputCap?: number;
     onSpawn?: (child: ChildProcess) => void;      // keeps state.interrupt wiring at the callsite
   }): Promise<{ code: number; output: string; timedOut: boolean }>
   ```

   `runCheckStep` is rewritten on top of it with no behavior change. **There is no existing
   suite to gate that rewrite** — nothing under `packages/cezar` tests `runCheckStep`'s own
   behaviour; the workflow-level tests that use check steps all run a command that succeeds
   and assert on the workflow, not on the primitive. Characterization tests are therefore
   written against today's behaviour *first*, as their own step, before the extraction (see
   Implementation Plan step 2). New behavior lives only in the new options: `timeoutMs`
   (SIGTERM, then SIGKILL after 5 s — the escalation pattern from the OpenCode watchdogs,
   #858) and the `timedOut` flag.

3. **`runLifecycleHooks(...)`** in a new `packages/cezar/src/workflows/hooks.ts`:

   ```ts
   runLifecycleHooks(args: {
     event: 'worktree-created' | 'run-end';
     hooks: HookDef[];
     cwd: string; repoRoot: string;
     runId: string; branch?: string; baseBranch?: string;
     emit: (event: { type: string; [k: string]: unknown }) => void;
     onSpawn?: (child: ChildProcess) => void;
     env?: NodeJS.ProcessEnv;                       // injectable for tests
   }): Promise<string | null>                        // error message, or null
   ```

   Runs the array **sequentially** (setup steps are ordered by nature: submodules before
   install), stops at the first `onFail: 'fail'` failure, returns a message like
   `hook 1/2 "bash scripts/setup.sh" exited 1`. A `warn` failure emits a note and
   continues. Returns `null` when hooks are absent, empty, or `CEZ_DISABLE_HOOKS=1` is
   set. **Never throws.**

4. **`WorktreeInfo.fresh: boolean`** (`packages/cezar/src/git-worktree.ts:87`) — `true` on
   the `worktree add -b` and reattach paths, `false` on registered-path reuse. Purely
   additive on a type the store does not persist.

5. **Two setup callsites in `packages/cezar/src/workflows/run.ts`** — one per path that
   puts an agent into a worktree. Both set `hooksProvisioned: true` on success.

   - `execute()`, after `seedAgentConfigLocalLayer` (`~:2546`) and inside the existing
     `try`: `if (wt.fresh) { const err = await runLifecycleHooks({event: 'worktree-created', …}); if (err) throw new Error(\`worktree setup hook failed: ${err}\`); }`.
     Reusing the surrounding catch keeps the fail-closed path to the one already written,
     but that catch unconditionally builds `worktree creation failed: ${message}`
     (`run.ts:2551`) — which would blame git for a worktree that was in fact created
     perfectly. So the catch's template gains one guard:
     `const error = message.startsWith('worktree setup hook') ? message : \`worktree creation failed: ${message}\``.
     One line, the tested path stays intact, and the run's error reads
     `worktree setup hook failed: hook 1/2 "bash scripts/setup.sh" exited 1` — the string
     Edge Cases promises. (The alternative, moving the hook outside the shared `try`, buys
     the same accuracy at the cost of the "already tested" claim; not taken.)
   - `runContinuation()`, capturing the return of `rematerializeReclaimedWorktree`
     (`~:2106`, today discarded) and firing after the `cwd` resolution and before the
     session spawn, when the resolved `cwd` is the worktree (it falls back to `repoRoot`
     when re-materialization failed) **and** either that call returned `true` *or*
     `run.hooksProvisioned !== true`. The second disjunct is the finish-then-continue case:
     the directory survived, so nothing was re-materialized, but teardown already tore the
     environment down. A failure settles the run `failed` with
     `continue failed: worktree setup hook …` rather than spawning an agent into an
     unprovisioned tree.

6. **One teardown observer** — `maybeRunEndHooks(run)` in `RunManager`, subscribed to the
   store's `('run')` event in the constructor:
   - keeps `Map<runId, RunStatus>` for edge detection; acts only on a transition **into**
     `{done, failed, cancelled}`;
   - no-ops unless `hooks['run-end']` is configured, `run.hooksSkipped !== true`,
     `run.worktreePath` is set and the directory still exists. `hooksSkipped` is on the list
     because the observer runs outside the run and has no other way to know the task opted
     out — without it, a bare task would still get `docker compose down`. `hooksProvisioned`
     is deliberately **not** a guard here: teardown must still fire for a run whose setup
     died half-way;
   - reads its own config. It cannot borrow the run's: it runs outside `execute()`, where
     the config read at `run.ts:2459` lives, which is the same reason it has no `emit`
     closure to borrow. So it calls `loadConfig(this.repoRoot)` itself — async, and
     deliberately uncached (`config.ts:143`) — **inside the `setImmediate`, never on the
     emitter's stack**, which the control below requires. One consequence worth stating:
     if an operator edits `config.json` mid-run, the table used for teardown may differ from
     the one used for setup. That is accepted rather than fixed — the alternative is
     snapshotting config per run, which is the staleness bug `loadConfig` avoids on purpose
     — but it means a teardown script is not guaranteed to be the counterpart of the setup
     script that ran;
   - emits through `this.store.appendEvent(runId, …)`, which is also what buys the
     redaction;
   - runs a cheap, try/catch'd sync status comparison on the emitter's stack and hands
     everything else — the config read and the hook execution — to `setImmediate`, wrapped
     like `enforceRetention` so it can never delay or throw into the lifecycle;
   - clears `hooksProvisioned` on the run record after teardown completes, which is what
     re-arms setup for a later Continue;
   - drops the map entry on `deleteRun` (the store already emits `'deleted'`);
   - stores its unsubscribe handle as `offRunSettled`, released in `dispose()` beside
     `offUsage`/`offSemaphore` (`run.ts:588`).

   The same `maybeRunEndHooks` body is called directly — awaited, bypassing the status-edge
   check — by `POST /api/v1/runs/:id/remove-worktree` (`server.ts:4218`) and
   `DELETE /api/v1/runs/:id` (`server.ts:4237`), before either destroys the directory or the
   record. See "Two routes destroy a worktree with no status transition at all".

7. **`cez hooks run <event> [--worktree <path>]`** (`packages/cezar/src/index.ts`) —
   executes the project's hooks for an event against a worktree (default: the cwd),
   printing the same output the session log would show. This is what makes a hook script
   testable, and it is the answer to the "hard to test" objection.

**Runner-agnostic by construction.** Every callsite is in the manager or the store, above
`agent-runner.ts`. No runner module changes; hooks behave identically whether the task
runs on claude, codex, opencode, or pi, and they run even for a workflow with no agent
step at all.

## 📝 Data Model

```ts
interface HookDef {
  run: string;                                        // the shell command
  onFail?: 'fail' | 'warn';                           // default is per-event
  timeoutMs: number;                                  // default 600_000
}
type LifecycleEvent = 'worktree-created' | 'run-end';
type CezConfig = { /* … */ hooks?: Partial<Record<LifecycleEvent, HookDef[]>> };

type StartRunInput = { /* … */ hooks?: boolean };     // false = bare worktree, this task only
type RunRecord = {
  /* … */
  hooksSkipped?: boolean;                             // echoes that choice for the teardown observer
  hooksProvisioned?: boolean;                         // set by worktree-created, cleared by run-end
};
type WorktreeInfo = { /* … */ fresh: boolean };       // not persisted
```

Two optional run-record fields and no new state files: hooks otherwise leave their trace as
session events, which are already persisted per run.

`hooksProvisioned` **must** be on the record rather than in memory. It is read on the
continuation path, which can be days after the run finished and across a cezar restart; an
in-memory bit would be lost exactly when the finish-then-continue case needs it, and losing
it defaults to re-running setup on every Continue — the `pnpm install`-per-turn cost this
design exists to avoid. It is optional and absent-means-false, so every run that predates
the feature reads as unprovisioned and simply gets setup on its next Continue.

The teardown observer's status map, by contrast, is in-memory only — a cezar restart
re-seeds it from the first `('run')` emission per run, and a run that reached its terminal
status while cezar was down simply does not get a late teardown (documented; teardown is
best-effort by definition).

**Hook environment** — `{ ...process.env }` plus:

| Var | Value |
|---|---|
| `CEZ_EVENT` | `worktree-created` \| `run-end` — one script can serve both |
| `CEZ_TASK_ID` | the run id |
| `CEZ_WORKTREE` | absolute worktree path (equals cwd) |
| `CEZ_REPO_ROOT` | absolute main-checkout root — where shared caches/registries live |
| `CEZ_BRANCH` | `cez/<id8>` — may be **empty** under `cez hooks run` outside a task worktree |
| `CEZ_BASE_BRANCH` | resolved fork point — same caveat |

All six are always *set*; the two branch vars are the only ones that can be empty, and only
on the `cez hooks run` path. Scripts must not assume non-empty (`${CEZ_BRANCH:-}` under
`set -u`).

Agent-session vars (`CEZ_HANDOFF_FILE`, `CEZ_TODOS_FILE`, `TMPDIR` override) are
deliberately **not** exported: a hook is not an agent, and handing it the handoff/inbox
paths invites writes into files only the agent should own.

### What a hook can reach — stated plainly

A hook is an ordinary child process, **not a sandbox**. Being explicit, because "what can
the hook access" is a question the design must answer rather than leave to be discovered:

- **Filesystem: everything the cezar process can touch.** cwd is the worktree, but nothing
  confines it there. It can read and write `$CEZ_REPO_ROOT`, the user's home, anywhere.
  Unlike an agent, it gets no `agentDirectories`-style allowlist (`run.ts:379`) — there is
  no mechanism to enforce one on a shell command, and pretending otherwise would be worse
  than saying so.
- **Environment: the full inherited `process.env`**, plus the six `CEZ_*` vars above. That
  includes whatever the cezar server was started with — provider credentials,
  `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`. A hook that echoes its environment leaks them into
  the session log; `appendEvent`'s redaction pass is the backstop, not a guarantee.
- **Network: unrestricted.** `pnpm install` and `git submodule update` need it.
- **Not the task.** A hook does **not** receive the task text, the run record, the
  workflow, or the agent's messages. Setup is meant to be a function of the *repo*, not of
  what the user asked for — a hook that branches on task text is a workflow step wearing a
  disguise. Deferred rather than forbidden: if a real case appears, `CEZ_TASK_TITLE` is one
  line.

The trust boundary is therefore the same one the project already has: whoever can write
`.ai/cezar/config.json` on this machine can run commands as this user. That file is
gitignored and local, so a branch cannot introduce a hook — see Risks.

## 📝 API Contracts

Only what changes. Everything is additive; no request or response field is removed or
retyped. **Every path below is `/api/v1`** — the unversioned `/api/*` surface was removed
(`BACKWARD_COMPATIBILITY.md:21`), and `versioned-surface.test.ts` fails if any route appears
outside `/api/v1` (§2, "No unversioned twin"). Project-scoped routes also answer at
`/api/v1/p/<projectId>/<path>`.

**`GET /api/v1/config` → `200`, `PUT /api/v1/config`** — the config surface gains one
optional key, carried through the existing raw-file merge:

```jsonc
{
  "hooks": {
    "worktree-created": [{ "run": "string", "onFail": "fail|warn", "timeoutMs": 600000 }],
    "run-end":          [{ "run": "string", "onFail": "fail|warn", "timeoutMs": 600000 }]
  }
}
```

Validation: `run` is a non-empty string ≤ 4 000 chars; `onFail` ∈ `{fail, warn}`;
`timeoutMs` an integer in `[1_000, 3_600_000]`, default `600_000`; each array ≤ 10
entries. A `PUT` carrying a malformed `hooks` value is rejected with the route's existing
`400` shape; a malformed value already **on disk** degrades the key to `undefined` on read
rather than failing the whole config.

**`POST /api/v1/runs`** — request body gains `hooks?: boolean`, beside the existing
`worktree?: boolean`:

```jsonc
{ "task": "…", "worktree": true, "hooks": false }
```

`false` skips both lifecycle hooks for this run; `true`/absent keeps the project default.
The value is persisted on the run record as `hooksSkipped?: boolean` and echoed, together
with `hooksProvisioned?: boolean`, by every route that returns a `RunRecord`
(`GET /api/v1/runs`, `GET /api/v1/runs/:id`, the SSE run frames) via the contract schema in
`packages/contract/src/runs.ts` — both optional, in the established style of
`worktreeReclaimedAt` (`runs.ts:233`).

**`POST /api/v1/runs/:id/remove-worktree` and `DELETE /api/v1/runs/:id`** — no request or
response shape changes. Both gain one side effect: they fire `run-end` against the run's
worktree, awaited, before removing the directory or the record. Both are protected surfaces
in `BACKWARD_COMPATIBILITY.md` §2; a slow teardown delays the response up to the hook's
`timeoutMs`.

**Session events** — two shapes, both already rendered by the cockpit, no new event type:

| Emitted | Event |
|---|---|
| before each hook | `{ type: 'note', message: '$ bash scripts/cezar-setup-worktree.sh' }` |
| after each hook | `{ type: 'check-output', command: '<the command>', text: '<captured output>', exitCode: <n> }` |
| on a skipped run | `{ type: 'note', message: 'bare worktree — setup hooks skipped' }` |

Neither carries `stepId`; verified harmless at `thread-state.ts:556`.

**CLI**

- `cez run … --no-hooks` — sets `hooks: false` for that run.
- `cez hooks run <event> [--worktree <path>]` — executes the project's hooks for an event
  against a worktree (default: the cwd), printing the same output the session log would
  show. Exit contract: `0` when every hook succeeded **and** when the project configures
  no hooks for that event (printing `no <event> hooks configured` — "nothing to do" is not
  an error); `1` on the first `onFail: 'fail'` failure or a timeout. A synthetic
  `CEZ_TASK_ID` is used when the path is not a task worktree, so a script that keys off it
  still runs. `CEZ_BRANCH` and `CEZ_BASE_BRANCH` are derived from the target worktree's own
  git state (`git rev-parse --abbrev-ref HEAD` and the configured base) and are **the empty
  string** when that fails — outside a task worktree there is no `cez/<id8>` to report, and
  inventing one would be worse than an empty value. Hook scripts must therefore tolerate
  both being empty; the env table below says so too. Honors `CEZ_DISABLE_HOOKS=1` (prints
  that it was skipped, exits `0`).

**Environment**

- `CEZ_DISABLE_HOOKS=1` — machine-wide kill switch (naming follows
  `CEZ_DISABLE_REPO_LOCK`). Per `AGENTS.md` it **must** land in `.env.example` and the
  README env table in the same commit that introduces it.

## 📝 UI/UX

Almost nothing is new, which is the point — hook output reuses the check-step card that
already exists.

**In the thread.** A `worktree-created` hook renders as an execute tool card with the
command as its title and an exit-code pill, identical to a check step, arriving before the
first agent turn (the `currentTurn()` fallback at `thread-state.ts:338` synthesizes a turn
for it). A `warn`-level failure adds a note line beneath it; a `fail`-level failure is
followed by the run's existing `failed` lifecycle event, so the thread reads: command →
output → "task stopped before workflow execution". Long output is capped by `spawnShell`'s
`outputCap`, matching check-step behavior — no new truncation UI.

**In the composer.** One checkbox, `Run setup hooks`, next to the existing worktree
toggle, checked by default and **hidden entirely when the project configures no hooks** —
a zero-config project sees no new control. Unchecking it sets `hooks: false`. It follows
the same keyboard order and labelling as the worktree toggle; no new interaction pattern,
so no new accessibility surface beyond the checkbox's own label.

**On the run.** A task started with hooks off carries a `bare worktree — setup hooks
skipped` note in its thread, so a later "why doesn't this build" is traceable to the
choice rather than only to the run record.

**Where hooks are edited.** The config file, and `GET/PUT /api/v1/config` for anything that
already edits it. No Settings screen: the table is four lines of JSON written once per
checkout, sitting beside `maxParallel` and `defaultRunner`, which have no dedicated editor
either. Building one now would be UI for a mechanism nobody has run yet.

### Keeping "bare worktree" available per task

[R1] asks for setup to be *optional* — "perhaps optional (i.e. still allow some small
tasks to run on 'bare' worktree)". Project-level opt-in is not enough on its own: once a
project configures a
4-minute `pnpm install`, every quick one-line fix pays for it.

So hooks get a **per-task opt-out**, mirroring the worktree toggle that already exists one
field over (`StartRunInput.worktree?: boolean`, `run.ts:325`). Persisting it as
`hooksSkipped` on the record is required, not cosmetic: the teardown observer runs
*outside* the run and has no other way to know that setup never happened — without it, a
bare task would still run `docker compose down`.

Three layers of "off", each at its own scope, none of which changes the zero-config
default: no `hooks` key (project), `hooks: false` on the task (one run),
`CEZ_DISABLE_HOOKS=1` (machine).

## 📝 Edge Cases & Failure Scenarios

- **Setup hook fails on a new run** → run `failed`, error `worktree setup hook failed: …`,
  hook output on the stream, worktree left in place for inspection (never auto-removed —
  it may hold a partial install worth debugging). The failed status then triggers
  `run-end`, so a partial allocation from an earlier hook in the array is released.
- **Setup hook fails on a Continue** → run `failed` with
  `continue failed: worktree setup hook …`; no session is spawned; `run-end` fires for the
  same reason.
- **Hook times out** → SIGTERM, SIGKILL after 5 s, treated as a failure with
  `timed out after Nms` in the message. Bounded by the per-hook `timeoutMs`, so a hung
  hook cannot hold a `maxParallel` slot indefinitely.
- **Task cancelled while setup runs** → `onSpawn` wires `state.interrupt` to kill the
  child; the run settles `cancelled` through the existing path, and that transition fires
  `run-end`.
- **Run rests at `review`, user clicks Finish / Create PR / Discard** → `review → done`
  (or `cancelled`) on the store bus fires `run-end`. This is the path a `dropActive`-based
  design silently skips.
- **Run continued after finishing** → the mainline case, and the one a materialization-only
  trigger gets wrong. Teardown already fired at `done` and cleared `hooksProvisioned`, but
  the worktree **directory survived** (`enforceRetention` reclaims only over-limit
  worktrees, `run.ts:1502`, and this one is the newest), so
  `rematerializeReclaimedWorktree` returns `false` (`retention.ts:74`). Setup fires anyway,
  on the `hooksProvisioned !== true` disjunct, rebuilding the containers and ports teardown
  removed. On the way out, `done → running` is not a terminal edge so the map simply
  updates, and the next terminal transition fires `run-end` again. Setup **and** teardown
  idempotency are the contract terms that make this safe.
- **Run continued mid-run, without having finished** → nothing was torn down,
  `hooksProvisioned` is still `true`, and the worktree is not fresh, so setup does **not**
  re-run. This is what keeps `pnpm install` off the per-Continue path.
- **Task opts out (`hooks: false`)** → no setup, and `hooksSkipped` on the record
  suppresses teardown too. A `bare worktree — setup hooks skipped` note lands in the thread
  so a failing build is traceable to the choice.
- **Task opts out, then is continued after retention reclaimed its worktree** → still
  bare. `hooksSkipped` is a property of the run, not of one session.
- **Worktree opt-out (`input.worktree === false`) or non-git project** → nothing was
  materialized, so `worktree-created` does not fire; `run-end` does not fire either (its
  worktree-exists guard fails, and the run is in the user's own working tree — a teardown
  paired with a setup that never ran is a footgun). Documented; revisit if asked for.
- **Continue / restart on an existing worktree** → `fresh === false` /
  `rematerializeReclaimedWorktree` returns `false`, so setup re-runs **only if** the run is
  no longer provisioned (`hooksProvisioned !== true`, i.e. teardown has already fired for
  it). Otherwise no re-run.
- **`POST /api/v1/runs/:id/remove-worktree`** (`server.ts:4218`) → fires `run-end` against
  the still-present worktree, awaited, *before* `removeWorktree(...)` and before the
  `updateRun` that clears `worktreePath`. Ordering is the whole point: after that
  `updateRun` there is no handle left to tear anything down with.
- **`DELETE /api/v1/runs/:id`** (`server.ts:4237`) → same, before `store.deleteRun(id)`
  drops the record carrying `worktreePath`.
- **Teardown fails on either destructive route** → `onFail: 'warn'` semantics as everywhere
  else: the failure is a note on the event stream and the removal proceeds. A user asking to
  remove a worktree gets it removed; a teardown that cannot clean up is not a reason to
  refuse.
- **Reclaimed then continued** → reattach re-materializes, setup re-runs, which is correct:
  the untracked half of the tree is gone.
- **Retention reclaims the worktree while teardown runs** → the teardown observer and
  `enforceRetention` are triggered by the same terminal transition. In practice they cannot
  collide: retention reclaims *over-limit* worktrees oldest first, and the run that just
  finished is the newest. The observer resolves its cwd once and treats a vanished
  directory as a warn-level spawn failure, so even the impossible case degrades to a note.
- **Two tasks start at once and both run setup** → cezar does **not** serialize hooks. They
  run inside their own run slots, so `maxParallel` bounds how many run at a time but
  nothing orders them. A hook that *scans* for a free port and then binds it is a race:
  both tasks can see the same port free. The fix belongs in the hook, and it is the reason
  the worked example derives its port block **deterministically from `CEZ_TASK_ID`**
  instead of scanning — no shared state, no lock, nothing to race. A hook that genuinely
  needs exclusivity should take its own lock (`flock` on a file under `$CEZ_REPO_ROOT`).
  Called out because the motivating use case — per-worktree docker ports — is exactly where
  a naive implementation races.
- **`CEZ_DRY_RUN=1`** → hooks **do** run. Dry-run mocks the agent CLIs, not the shell, and a
  dry run that skipped setup would not exercise the thing under test. This repo configures
  no hooks, so `npm run test:e2e` is unaffected; a project that wants its hooks skipped in
  dry runs branches on the variable inside its own script.
- **Malformed `hooks` config** → key degrades to `undefined`, run proceeds exactly as
  today; the config API's raw-file merge is untouched.
- **Two `RunManager`s for one project** (a rebuilt project context,
  `project-context.ts:216`) → the second subscription would fire teardown twice.
  `dispose()` must release `offRunSettled`; `store.setMaxListeners(100)` (`store.ts:494`)
  means a leaked listener would surface no warning, so this is a test, not a hope. A second,
  independent guard already exists: context teardown at `project-context.ts:243` calls
  `ctx.manager.dispose()` **and** `ctx.store.removeAllListeners()`, so even a missed
  `offRunSettled` is swept on rebuild. The test still belongs — the sweep is incidental to
  this design, not a contract it can rely on.
- **Windows** → `bash -lc`, same as `check` steps today. No new gap; WSL users are already
  served by the existing `packages/cezar/src/server/wsl.ts` path.

## 📝 Risks & Impact Review

- **risk-high per `SDLC.md`** — the change lands on worktree/branch handling and executes
  commands unattended before an agent starts. It touches `run.ts`'s `execute()` and
  `runContinuation()`, `git-worktree.ts`, two server routes, and adds a manager subscription
  to the store bus.
- **The store subscription is a new coupling**, mitigated structurally rather than by
  discipline — each control has a precedent in the manager's constructor:
  - *The edge map is a latch* — **the primary control.** It fires only on a transition
    **into** terminal from non-terminal, then records terminal, so any later `'run'`
    emission for that run — including one the observer caused — is a no-op rather than a
    loop. Recursion cannot amplify.
  - *The listened channel does carry a cycle, and the latch is what closes it.* An earlier
    draft of this spec claimed there was no cycle at all, on the grounds that `appendEvent`
    emits `'event'` (`store.ts:797`) and never calls `touch()`. That is **false**, and the
    correction matters more to the risk analysis than to the design. Past the line range that
    draft cited, `appendEvent`'s "janitor trick" scans every event's text for PR and issue
    URLs and writes what it finds back: `this.updateRun(runId, { pullRequestUrl: created })`
    (`store.ts:809`), `if (changed) this.touch(run)` (`store.ts:823`). So hook output
    containing a PR or issue URL — entirely plausible; a teardown script echoing a CI link
    would do it — routes through `appendEvent` and *does* re-enter the observer. It does not
    loop, because the latch already records terminal for that run. The design is unchanged;
    what changes is that the latch is load-bearing rather than one of four redundant
    controls, and that the "observer never calls `updateRun`" test below is a real gate.
  - *Nothing slow or throwable runs on the emitter's stack.* `EventEmitter.emit` is
    synchronous, so the listener runs inside `updateRun`'s own call and anything it throws
    lands on `updateRun`'s caller — which could break a status write (e.g. inside
    `settleSuccess`). So the listener does one cheap thing — compare old status to new,
    inside a `try/catch` that swallows everything — and hands the actual hook run to
    `setImmediate`. Same shape as `onUsage((s) => void this.enforceMemoryLimit(s))`
    (`run.ts:573`).
  - *An unsubscribe handle released in `dispose()`*, exactly like `offUsage` and
    `offSemaphore` (`run.ts:588`).
  - The "observer never calls `updateRun`" test is a **primary gate**, not belt-and-braces,
    and it must exercise the real path: hook output carrying a PR or issue URL, routed
    through `appendEvent`, must not produce a second teardown. That is the concrete way
    re-entrancy is reachable on today's `store.ts`.

  Edge detection lives in the manager, not the store: `onRunSettled(cb)` on the store would
  be a cleaner boundary but is an interface with one consumer. Move it there if a second
  appears.
- **Arbitrary command execution.** Mitigated more than it first looks:
  `.ai/cezar/config.json` is **gitignored**, so a hostile branch cannot ship a hook — the
  config is local, written by the operator, exactly like `maxParallel`. The *script* the
  hook invokes does come from the checkout, but a cezar run already executes that branch's
  code through `check` steps and through the agent itself. Net-new surface: setup now runs
  **before** any agent, unattended. Answer: opt-in (absent key = today's behavior byte for
  byte), the command is echoed as a `$ …` note before it runs, and `CEZ_DISABLE_HOOKS=1`
  disables the whole mechanism machine-wide.
- **Secret leakage into the event log.** Hook output is streamed, and a hook that echoes
  its environment would print provider credentials. The mitigation costs nothing to build
  — `appendEvent` already redacts every event (`store.ts:790-793`) — but it constrains the
  design: **hook output must go through `appendEvent` and never around it**. A future
  optimisation that streams hook stdout straight to the SSE wire would silently remove this.
- **Slower time-to-first-token.** A project with `pnpm install` on `worktree-created` adds
  that to every fresh task. Inherent to per-task worktrees, and cheaper than the agent
  doing it. Concurrency is already bounded — hooks run inside the run's slot, so
  `maxParallel` caps concurrent installs. The docs should point at the real fix — a shared
  store/cache under `$CEZ_REPO_ROOT`, the Gitpod-prebuild answer scaled down — rather than
  pretend it away.
- **`runCheckStep` refactor.** The one behavior-preserving edit to a hot path — and the one
  step with **no gate today**. Nothing under `packages/cezar` tests `runCheckStep`'s own
  behaviour; every workflow-level test that uses a check step runs a command that succeeds
  and asserts on the workflow. So characterization tests are written first (step 2), against
  today's behaviour, or the refactor lands unguarded on a path every workflow uses.
  `spawnShell`'s new options default to today's behavior (no timeout).
- **Rollback.** Three levels, all instant and none requiring a redeploy: delete the `hooks`
  key (project), uncheck the composer box (one run), `CEZ_DISABLE_HOOKS=1` (machine). A bad
  release is backed out by the env var without touching anyone's config.
- **Backward compatibility.** Additive. No `hooks` key → no hook, no spawn, no event, no
  subscription work, identical run flow. `WorktreeInfo.fresh` is additive on a
  non-persisted type; `hooksSkipped` and `hooksProvisioned` are optional record fields whose
  absence reads as `false`. No request or response shape changes beyond
  `POST /api/v1/runs` accepting one optional field and `GET/PUT /api/v1/config` carrying one
  more key through its existing raw-merge; `POST /api/v1/runs/:id/remove-worktree` and
  `DELETE /api/v1/runs/:id` gain a side effect but no shape change. **All paths are
  `/api/v1`** — the unversioned surface was removed and `versioned-surface.test.ts` fails on
  any route outside it (`BACKWARD_COMPATIBILITY.md:21`, §2). Add the config key and both
  record fields to `BACKWARD_COMPATIBILITY.md`, the new env var to `.env.example` and the
  README env table, and the feature to the README configuration section (`README.md:691`)
  and worktree section.

## 📋 Non-goals

- **Sandboxing hooks.** A hook is a shell command with the cezar process's full
  filesystem, env and network reach. Stated, not fixed — see "What a hook can reach".
- **Hooks that see the task.** No task text, run record, workflow or agent messages.
  Setup is a function of the repo.
- **Serializing hooks across runs.** `maxParallel` bounds concurrency; ordering and
  mutual exclusion belong to the hook (`flock`, or a deterministic derivation from
  `CEZ_TASK_ID`).
- **Dependency caching / prebuilds.** The Gitpod answer to install cost is out of scope; a
  project points its hook at a shared store under `$CEZ_REPO_ROOT` today.
- **Committed, version-controlled hook tables.** `.ai/cezar/` is gitignored and that is a
  security property this spec keeps.
- **More lifecycle events** (`turn-end`, `pre-pr`, `worktree-removed`), machine-wide hook
  defaults in `~/.cezar/config.json`, per-workflow hook overrides. The event name is a
  string key on a map: adding one is a schema line plus a trigger.
- **Prompt (AI) hooks.** Rejected on determinism, not deferred — see "Alternatives
  considered". `run` is a plain object key, so widening it to a union later costs a schema
  line; nothing here is pre-shaped for it.
- **A hook → session env channel** (`CEZ_HOOK_ENV` or similar). Unnecessary: a hook that
  allocates a port writes it into the worktree's `.env`, which compose and most toolchains
  already load, and which the agent can read like any other file. Revisit only if a real
  case appears that a file cannot serve.
- **A Settings screen for the hook table.** It is four lines of JSON beside `maxParallel`,
  which has no editor either.

## 📋 Phasing

**One phase, and that is the whole feature.** `hooks` config key, `spawnShell` extraction
(with its characterization tests first), `runLifecycleHooks`, the `fresh` flag and the
`hooksProvisioned` bit, two setup callsites, the terminal observer plus the two destructive
routes, the per-task opt-out, `cez hooks run`, docs. It ships the deterministic setup [R1]
asks for, tears the worktree down again, brings it back up when the task is continued, and
keeps bare worktrees one checkbox away.

There is deliberately no phase two. An earlier draft parked [R2]'s prompt hooks, a
hook→session env channel and a Settings editor in one — three capabilities that share
nothing but this table, none of which a user has asked for, and one of which (the prompt)
this spec argues *against* shipping at all. Carrying them as "phase 2" would have made a
rejected alternative look like committed roadmap and pre-shaped the schema around a union
with one member. They are recorded under "Non-goals" with the extension point named, which
is what a deferred idea is worth.

## 📋 Implementation Plan

Thirteen steps. Each leaves the application working and is verifiable by a test; steps 1–6
are self-contained units that land before anything is wired, so a bisect lands on a small
diff.

1. **Characterization tests for `runCheckStep`** (`run.ts:3477`), written against today's
   behaviour **before** anything is extracted. There is no existing suite to lean on — no
   `*.test.ts` under `packages/cezar` exercises `runCheckStep` at all, and the workflow-level
   tests that use check steps (`run.test.ts:799`, `workspace-semaphore.test.ts:55`,
   `run-isolation.test.ts:62` and the rest) all run a command that succeeds and assert on the
   workflow around it. Without this step the refactor in step 3 lands unguarded on a path
   every workflow uses.
   *Tests (`check-step.test.ts`):* exit code propagated to the step result; the 20 000-char
   output cap enforced at its exact boundary; a spawn error (nonexistent binary) resolves
   with `exitCode: -1` rather than throwing; `state.interrupt` SIGTERM-kills the child and
   settles the step. Step 2's `shell.test.ts` is a superset of these at the primitive level;
   this step pins the *caller's* observed behaviour so the extraction is provably neutral.
2. **`packages/cezar/src/workflows/shell.ts` — `spawnShell`.** `timeoutMs` / `timedOut`,
   SIGTERM→SIGKILL after 5 s, capped output, `onSpawn` passthrough.
   *Tests (`shell.test.ts`):* exit code propagated, output cap enforced, timeout kills and
   sets `timedOut`, spawn error resolves rather than throws.
3. **Rewrite `runCheckStep` on `spawnShell`** (`run.ts:3477`). No behavior change.
   *Test:* step 1's characterization suite passes untouched — that is the gate.
4. **`packages/cezar/src/config.ts` — `hookSchema` / `hooksSchema`.**
   *Tests (`config.test.ts`):* valid table parses with defaults applied; malformed `hooks`
   degrades to `undefined` while the rest of the config survives; an 11-entry array is
   rejected; out-of-range `timeoutMs` is rejected.
5. **`packages/cezar/src/git-worktree.ts` — `fresh` on `WorktreeInfo`.**
   *Tests (`git-worktree.test.ts`):* fresh `worktree add -b` → `true`; registered-path
   reuse → `false`; reattach-after-reclaim → `true`.
6. **`packages/cezar/src/workflows/hooks.ts` — `runLifecycleHooks`.** Sequential, per-hook
   `onFail`, env contract, `CEZ_DISABLE_HOOKS`, never throws.
   *Tests (`hooks.test.ts`, injected env + temp dir):* sequential order; stop at first
   `fail`; `warn` continues and emits a note; the six `CEZ_*` vars are present and the
   agent-session vars are absent; `CEZ_BRANCH`/`CEZ_BASE_BRANCH` are set-but-empty rather
   than missing when unresolvable; `CEZ_DISABLE_HOOKS=1` returns `null` without spawning;
   an empty/absent array returns `null` without spawning.
7. **Wire the two setup callsites and the provisioning bit** — `execute()` (`~:2546`, with
   the `worktree setup hook` prefix guard on the catch at `run.ts:2551`) and
   `runContinuation()` (`~:2106`, capturing the previously discarded boolean and reading
   `hooksProvisioned`). Both set `hooksProvisioned: true` on success.
   *Tests (`hooks-wiring.test.ts`, modeled on `retention-wiring.test.ts`):* setup fires
   once on a fresh worktree and not on reuse; **setup fires on a Continue that
   re-materialized a reclaimed worktree** and not on a Continue that reused a
   still-provisioned one; a non-zero setup hook fails the run on **both** paths, no session
   spawns, and the persisted error reads `worktree setup hook failed: …` rather than
   `worktree creation failed: …`.
8. **Wire the terminal observer** — `maybeRunEndHooks` + `offRunSettled` in `dispose()`,
   clearing `hooksProvisioned` after teardown, plus the two explicit calls from
   `POST /api/v1/runs/:id/remove-worktree` and `DELETE /api/v1/runs/:id`.
   *Tests (same file):* `run-end` fires for `done`, `failed` and `cancelled` from
   `execute()`, from `runContinuation()`, and from **`review → done` via `finish()`**; it
   fires after a *partial* setup failure (hook 1 ok, hook 2 fails); it fires on both
   destructive routes, **before** the worktree or record is gone, and its output is not lost
   when the record is deleted; it does **not** fire for `review`, `waiting`, or a requeue to
   `queued`, not twice for one transition, and not at all when `hooksSkipped` is set; a
   failing `run-end` hook leaves the run's status untouched and does not block either
   destructive route; the observer performs no `updateRun` **even when hook output contains
   a PR or issue URL routed through `appendEvent`** (the re-entrancy path on today's
   `store.ts:809`); a hook that throws synchronously does not propagate into the `updateRun`
   caller; a disposed manager fires no teardown and a rebuilt project context does not
   double-fire.
9. **The finish-then-continue regression gate** — its own step because it is the hole this
   revision closes and it spans both wirings.
   *Test (`hooks-wiring.test.ts`):* a run that reached `done` (teardown fired, worktree
   directory still present, `hooksProvisioned` cleared) and is then Continued **does** re-run
   `worktree-created`, and the second setup runs against the existing directory. Paired with
   the negative: a mid-run Continue on a still-provisioned worktree does not.
10. **Per-task opt-out.** `hooks?: boolean` on `StartRunInput` (`run.ts:306`),
    `hooksSkipped` and `hooksProvisioned` on the run record and
    `packages/contract/src/runs.ts`, `POST /api/v1/runs` passthrough, `cez run --no-hooks`.
    *Tests:* a task with `hooks: false` runs neither setup nor teardown; the skip survives a
    Continue; both fields round-trip through the contract schema.
11. **Composer checkbox** beside the worktree toggle, hidden when the project configures no
    hooks.
    *Test:* the control is absent with an empty `hooks` config and posts `hooks: false` when
    unchecked.
12. **`cez hooks run <event> [--worktree <path>]`** in `packages/cezar/src/index.ts`.
    *Tests (package test):* exits `0` with no hooks configured and prints
    `no <event> hooks configured`; exits `1` on a failing hook; synthesizes `CEZ_TASK_ID`
    outside a task worktree; sets `CEZ_BRANCH`/`CEZ_BASE_BRANCH` empty rather than unset
    there; honors `CEZ_DISABLE_HOOKS=1`.
13. **Docs.** README configuration section (`README.md:691`) and worktree section,
    including git's `post-checkout` named as the zero-feature alternative and the
    two-sided idempotency contract stated for both events; the `CEZ_DISABLE_HOOKS` entry in
    **`.env.example`** and the README env table (required by `AGENTS.md` in the same commit);
    `BACKWARD_COMPATIBILITY.md` entries for the config key, both record fields, and the new
    side effect on the two destructive routes; the two scripts from "Worked example" shipped
    as copy-pasteable docs.

QA: `needs-qa` — a real project with a `worktree-created` hook, one passing and one
failing, plus a Continue after retention reclaim, a review-gate Finish, a **Finish then
Continue** (the environment must come back), and a "🧹 Remove worktree" on a finished task
(the containers must go away), all verified in the cockpit event stream.
