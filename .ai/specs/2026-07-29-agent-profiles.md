# Agent profiles — a second login of the same agent CLI

Status: implemented · 2026-07-29

### `default` on the wire is not the same as sending nothing

The flat list needs to say three different things, and two of them look alike:

| `agentProfile` | means |
| --- | --- |
| absent | follow the repo's setting — what an untouched pill sends, and it stays true if that setting changes before the task starts |
| `"default"` | the DISCOVERED account, explicitly. `selectProfile` takes `profileId ?? selectionFor(...)`, so this beats the repo's selection |
| a stored id | that account |

The middle row is what makes `claude · Default` mean it in a repo set to `Klaudiusz`. Sending an
absent key there would run the task on Klaudiusz — the opposite of what the row says. Verified on a
real server with the repo pointed at the second account: the three states record `profileId` as
`default`, `second-account` and `second-account` respectively.

`DEFAULT_AGENT_ACCOUNT_ID` therefore lives in `packages/contract` and is imported by both sides,
rather than being spelled `'default'` in the cockpit and again in the store.

## The problem

The same agent CLI can be logged in under several config dirs. The binary is identical; only the
environment differs:

```
claude                                       # the discovered account → ~/.claude
CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude # a second login         → ~/.claude-klaudiusz
```

cezar knew exactly one dir per agent, so a user with two accounts could not tell it which one a
project should run under — every task billed the personal subscription, and the Agent config pane
only ever showed the personal account's files.

## Verified vendor facts

Established against the shipped CLIs and against real directories on disk, 2026-07-29. This table
is the reason the design looks the way it does; re-verify before changing any of it.

| Fact | How it was established |
| --- | --- |
| `CLAUDE_CONFIG_DIR` relocates Claude Code's whole per-user home | `~/.claude-klaudiusz/` holds `.claude.json`, `settings.json`, `projects/`, `sessions/`, `history.jsonl`, `plugins/` |
| `.claude.json` is a **sibling** of `~/.claude` by default but moves **inside** an overridden dir | `~/.claude.json` exists; `~/.claude/.claude.json` does not; `~/.claude-klaudiusz/.claude.json` does |
| `CODEX_HOME` relocates Codex's identity too | `auth.json` lives inside `~/.codex`, beside `config.toml` and `sessions` |
| OpenCode has **no** single home var | `OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG` move config only; credentials live in `~/.local/share/opencode/opencode.db`, behind a separate `OPENCODE_DB` |

`claude --settings <file>` is **not** a substitute: it merges a settings file and relocates
nothing — not credentials, not sessions, not projects. `--add-dir` is unrelated (extra working
dirs), already covered by `AgentRunSpec.additionalDirectories`.

## Design

### The default profile is discovered, never stored

`agentHomePaths()` already honours the vendors' own env vars, so it *is* the discovery of the
default profile — setting `CLAUDE_CONFIG_DIR` on the cezar process moves the default rather than
being ignored. An absent `agent-accounts.json` therefore behaves exactly as cezar always has, and
`default` is a reserved id that is never written to the file.

### No globbing

cezar does **not** scan for sibling dirs. On a real machine `~/.claude*` matches `~/.claude`,
`~/.claude-klaudiusz`, `~/.claude.json` *and* `~/.claude.json.backup` — half of them files — and a
directory's existence proves nothing about a login. The zero-config rule is "discover it, or
default it", and the default IS discovered; an extra account is an act the user performed (they
set a variable and logged in a second time), so adding one is an act too. What is cheap instead:
the same folder browser "Add project" uses, plus an **advisory** marker-file probe whose answer is
a warning line, never a refusal — because *add → Connect → the CLI creates the folder* is the real
first-run sequence.

### Storage: its own file, not `config.json` and not the repo

`~/.cezar/agent-accounts.json` holds both the accounts and the per-project selections.

**Not the repo config.** A `configDir` is an absolute local path and an account id means nothing on
a teammate's machine; every key in `<repo>/.ai/cezar/config.json` is a *team* decision (base
branch, review gate, default runner) whereas "which of my two logins" is personal — and committing
it would publish that someone runs a second account on this repo.

**Not `config.json` either, which is where this started.** Accounts and a per-project
`agentProfile` first lived in the workspace config, relying on `.passthrough()` to survive a cezar
downgrade. Measured against this repo's own history, that held. It is still the wrong bet:

- it depends on a modifier in **another version's** source, which this repo cannot promise;
- it fails completely in the case that matters most — a version that cannot parse `config.json`
  degrades to in-memory defaults, and its **next merge-write persists those**, silently dropping
  everything it did not understand. No amount of passthrough covers that.

A version that has never heard of accounts does not open `agent-accounts.json`, so it cannot lose
them. That is the whole argument, and it is why the selections moved off `projects[]` too — they
belong beside the accounts they name, which additionally keeps "delete an account and scrub every
reference to it" a single atomic write.

Selections are keyed by the project's **realpath'd root**, not its registry slug: the root is what
every consumer already holds (`resolveProfileEnvForRoot` takes it), it survives the registry being
rebuilt, and it means this file needs no cross-reference into `config.json`. An orphaned entry — a
deregistered project — resolves to nothing and is inert.

Accounts written into `config.json` by the first cut are imported once, non-destructively:
`config.json` keeps its keys, so an older cezar sharing the home reads what it always read, and
the import is idempotent because it only runs while `agent-accounts.json` is absent.

**Extension point, deliberately not built:** a future per-repo "which agents may be used here"
(`allowedRunners` in the repo config) is a *team* decision and therefore the other axis. Nothing
here blocks it — resolution is per `(project, provider)`, so a provider allowlist composes as a
filter in front of it.

### Two degradation rules, deliberately different

- **Unknown profile id → the discovered default, silently.** A dangling reference names no
  account, the default is the only safe answer, and this matches the file's `.catch` doctrine.
- **Known id, missing directory → keep it. Do NOT fall back.** The listing reports `exists:
  false` and the run fails on auth. Silently using the personal account because the work folder is
  absent would run the task on the wrong subscription while the UI still said "Work" — a billing
  and privacy boundary, not a preference. This is the one place "degrade quietly" must not apply.

The same asymmetry appears at the route layer: a *user* naming an account that does not exist gets
a 400, because they can act on it; a *run* replaying a stored id gets the default, because it
cannot.

### `sessionId` and `profileId` are a pair

A session id only resolves inside the config dir that created it. So each step records the profile
it actually spawned under (`steps[].profileId`), and resume/Continue/the terminal handoff read
that recorded value — never the project's current selection. Without it, switching a project's
account would make Continue reattach against a different account's session store, and
`claude --resume` would silently start a fresh conversation with no error.

This is what makes the per-task composer override safe.

### Resolution order, per step

1. the step's already-recorded `profileId` (resume / Continue);
2. the run's composer override, but only for steps on the run's own runner — "use my other Claude
   login" says nothing about which Codex account a mixed-backend workflow should bill;
3. the project's stored selection;
4. the discovered default.

Read fresh every time: `~/.cezar/` is shared by every cezar process on the machine, so a cached
snapshot is a staleness bug, and one small JSON read is free next to spawning a CLI.

### OpenCode is deferred

`PROFILE_ENV_VAR.opencode = null`. A config-dir-only account would swap settings but not the
login — the UI would say "Work" and the run would not be, which is the worst possible failure and
precisely what this feature exists to prevent. Revisit if OpenCode documents a single home
variable. `XDG_CONFIG_HOME` is rejected regardless: it is machine-wide and would relocate every
other XDG-aware tool the agent's own Bash calls touch.

## Surface

| Where | What |
| --- | --- |
| `packages/cezar/src/core/agent-profiles.ts` | `PROFILE_ENV_VAR`, `profileEnv`, `looksLikeProfileDir` — the vendor knowledge, pure. Sibling of `agent-config/catalog.ts`, which owns config-FILE knowledge. |
| `packages/cezar/src/core/shell-env.ts` | Rendering the variable into a shell command, per platform, refusing rather than guessing. |
| `packages/cezar/src/workspace/agent-profiles.ts` | Resolution against the workspace config. |
| `packages/cezar/src/workspace/agent-accounts.ts` | `~/.cezar/agent-accounts.json` — the store, its house rules, and the one-time import from `config.json`. `config.json`'s own schema is untouched by this feature. |
| `packages/contract/src/agent-profiles.ts` | The wire shapes. |
| `GET/POST /api/v1/workspace/agent-profiles`, `PATCH/DELETE …/:id` | Workspace-level, single-mount, `localHandoff`-gated. |
| `PUT /api/v1/workspace/agent-profiles/selection` | Which account a project uses. On the accounts family, so `PATCH /api/v1/projects` and the project registry are untouched. |
| `POST /api/v1/runs` | Gains `agentProfile` — the composer's per-task override. |
| `POST /api/v1/runs/:id/continue` | Gains `agentProfile` too — the same override, after the task has started. Omitted means "keep the account this run is on", which is what an untouched Continue sends. A switch does NOT resume: the session id lives inside the previous account's config dir, so it starts a fresh session exactly as switching runner does. Persisted on the record before scheduling, next to the runner/model pair — and a runner switch that names no account CLEARS the previous one, since an account belongs to one agent. |
| Settings → Agent accounts (global) | One TAB per agent: install state + version from `/api/v1/health`, then that agent's logins. Every agent gets a tab, including OpenCode — the tab is where "is it installed?" is answered. |
| Settings → Agents (per project) | "Default agent" is ONE control, the same flat list the composer uses: `claude · Default`, `claude · Klaudiusz`, `codex`. The repo's default agent and its account are the same decision — "what does this repo run by default" — so splitting them meant reading two fields to learn one fact. Each row names the FOLDER it resolves to (the labels are cezar's invention; the folder is the account), and a folder that does not exist yet is called out, since a run under it fails on auth by design. An agent with a single login stays a single row, so a machine with no extra accounts sees the control it always saw — still titled "Default runner", since no account is in play. |
| Settings → Agent accounts, "Defaults for new projects" | The same flat control, plus per-agent default models, answering "what does a project run when it has chosen nothing" — so a second login is set up ONCE instead of per checkout. On the accounts page rather than one of its own: it is the same subject, and a separate page would mean adding an account in one place and going elsewhere to say "use it". Above the per-agent tabs, because it is a cross-agent answer. Written to `~/.cezar/config.json` (`agentDefaults.runner`, `agentDefaults.models`) and `~/.cezar/agent-accounts.json` (`defaults`). |
| Defaults, never overrides | The resolution order is task override → repo choice → machine default → discovered. A repo that has chosen is NEVER moved by a later change to the machine default; the default only fills silence. That is the whole safety property: changing a global setting must not quietly re-point work someone already configured onto another subscription. Applied to the RAW config object before parsing, because `defaultRunner`'s `.default('claude')` materializes the key — after a parse there is no telling "chose claude" from "said nothing" — and `models` merges per RUNNER so pinning one repo's claude model cannot discard the machine's codex preset. |
| The task header's agent badge | Reads `claude · Klaudiusz · opus` beside the bot icon, with the labelled breakdown still in its menu. Visible text rather than icon-only: #416 moved runner/model out of the loose dot-list to cut noise, and that holds — they are not separate chips — but an icon alone made "which agent, account and model produced this?" unanswerable without knowing to click, which is the one question the badge exists for. The account comes from the STEP that spawned (`steps[].profileId`), never the run's composer override or the project's current selection: the override is absent whenever the run simply followed the project, and the selection can have changed since — either would name an account the run may never have touched. A run from before accounts existed shows no account line rather than claiming the discovered one; a removed account is shown as `<id> (removed)`, because the id is the only remaining pointer to the folder its sessions live in. |
| Signing a second account in | The account row carries **Connect** (hidden once that account is connected) and **Check again**. Connect posts `{provider, profileId}` to `POST /api/v1/providers/connect`, which renders `CLAUDE_CONFIG_DIR=… claude /login` for that account and fails closed rather than running the bare command. Without this the pane told the user three times to press Connect and offered none: the engine was complete and unreachable, and an added account had no in-product way to log in. Two rules the route now keeps for a NAMED account: it evicts that account's cached status first, so Connect after a terminal `/logout` cannot answer "already connected" out of the ten-minute window; and it refuses in hosted mode **before** resolving anything, so no host path is built and a wrong id is not an enumeration oracle for ids the hosted listing withholds. |
| One click, two stores | That row writes `defaultRunner` to the repo's committable config and the account to `~/.cezar/agent-accounts.json`. The split is the point: the runner is a team decision, the account is personal and per-machine — committing it would publish which login someone works under. The copy says so, because every other field in that pane is shared. Picking an agent with one login writes NO selection: recording a choice the user was never offered would be state nobody asked for. |
| The composer's runner pill | The per-task override is not a pill of its own; the runner pill lists every agent-and-login as one FLAT row — `claude · Default`, `claude · Klaudiusz`, `codex`. Every row is a concrete thing that can run this task, so what will happen is readable at a glance instead of assembled from a runner choice plus a nested account choice. An agent with a single login stays a single row, so a host with no extra accounts sees the list it always saw. The row the repo resolves to is the one selected until the user picks another; on a host with ONE runner the pill appears whenever a second login exists, because a single runner is not a choice but a second login is. |
| The thread's Continue pill | The SAME control, on the same terms — a task that has started must be able to change login, not only agent. One difference, and it follows from `sessionId`/`profileId` being a pair: the row selected until the user picks another is the account the RUN is on (`steps[].profileId`), not the project's current selection, which may have moved since. Switching agent falls back to what the project resolves to for that agent, because the account belonged to the previous one. `useAgentAccounts` is where both surfaces read the logins and the selection, so the two pills cannot drift into looking alike and picking differently. |
| Both | Hidden entirely when no extra account exists. |

## The listing never shells out

Auth status started out inline on the accounts listing. That was a mistake with a measurable price:
each probe spawns an agent CLI, once per provider **plus once per account**, so a cold load cost
0.67s with no extra accounts and **2.5s on a real machine with four** — for a route whose actual job
(what accounts exist) is a JSON read and a handful of `stat`s, which takes about 3ms.

`GET /api/v1/health` had already established the rule: *serve whatever the cache holds, never pay a
`gh` shell-out*. So the listing now serves only cached auth, `status` is **absent until a probe has
warmed**, and `GET …/:id/status` is what actually probes. The cockpit paints from the listing
immediately and fills each row's dot in as its own answer arrives.

Measured on the same machine and the same four accounts: **2.5s → 12ms** cold.

### Auth state is operating knowledge, so it lives in memory

Which login an agent is signed into matters for every run and changes only when someone runs
`claude auth login`. So it is warmed once at boot (behind the same live-server gate `refreshHealth`
uses, so tests never spawn) and then kept, rather than re-probed on a timer.

The warm covers **every account, not just the three discovered defaults** — an extra account is
exactly the row `providerAuth.status()` does not know about, and warming only the defaults would
leave the first reader of each extra account paying a shell-out. Measured on this machine, one extra
account: the whole set is warm **1.6s after the port opens**, well before a browser has finished
fetching the bundle, and every listing after that is ~2ms with zero spawns. Extra accounts are
warmed one at a time, after the defaults: each is a CLI spawn, nothing is waiting on the result, and
a machine with several accounts should not fan out a spawn storm at the moment the cockpit is
loading. A brand-new or repointed account is warmed on the spot for the same reason — it is the one
thing boot could not have known.

Eviction is **targeted**, keyed by `(provider, accountId)`. It has to be, once the cache is
something the server maintains rather than a five-second scratchpad: the first cut cleared the whole
per-account map, so re-checking one row — or renaming one — silently made every other account cold
again.

Reading it is **stale-while-revalidate**, the same policy as the health snapshot: once anything is
known, a reader gets it immediately and an expired cache is refreshed *behind* the answer. Awaiting
that refresh is what made `GET /api/v1/providers/status` cost 0.8s here (≈3s on a slower box) every
time the window lapsed — on an endpoint the cockpit polls, so "occasionally slow" reads as "slow,
unpredictably". Only a genuinely cold cache waits, and after the boot warm there isn't one.

The lifetime is **asymmetric**:

- a **connected** answer stands for minutes — nothing is lost if it ages, because a credential that
  has really gone bad surfaces as a runtime auth failure, which is already latched and overrides the
  cache on the spot;
- a **not-connected** answer is re-checked sooner, for display self-healing only: cezar cannot see
  `claude auth login` happen, so a card that says disconnected has to find out on its own. A minute,
  not seconds — every expiry now costs a background probe, and a polling cockpit would turn a
  five-second window into a spawn every five seconds, forever, on any machine where one provider is
  logged out.

### Verify before you refuse

The short window used to be a *correctness* mechanism: `provider-action-gate.ts` refuses to start a
run against a provider it believes disconnected, and a stale negative would lock someone out of
their own cockpit after a terminal login. Keeping the whole cache young to protect that one reader
is what taxed every other reader.

Inverted: the gate re-probes before it refuses, and only a refusal that survives the fresh answer is
returned. The cost lands where it belongs — the common path (connected, warm) pays nothing, and a
spawn happens only when cezar is about to say no, which is rare and interactive. Two things it
deliberately does not do: re-probe a **disabled** provider (that is a settings fact, and re-reading
it with a CLI spawn would learn nothing), and escape a **runtime auth latch** (`withRuntimeFailures`
keeps forcing the row disconnected until the user acknowledges that exact incident, so a re-probe
cannot talk cezar out of a rejection it actually observed).

And the **peeks ignore the window entirely**: they answer with the last thing known, however old.
That distinction was found by measuring, not by reasoning: applying the window to peeks made the
whole cache expire in five seconds on any machine where a single provider is logged out — which is
most of them, since few people are signed into all three — putting the shell-out straight back on
the page load. A peek blocks nothing; it fills in a dot on a page that offers Connect and a
re-check right beside it.

Anything cezar *can* observe invalidates explicitly rather than waiting for either window: opening a
login, repointing or removing an account, and a runtime rejection.

**Known coarseness:** the window still applies to the whole three-provider response, so one
logged-out provider drags the two connected ones into revalidating with it. That is wasted work
rather than a wrong answer, and it is now paid in the background; fixing it properly means
per-provider timestamps and merging partial probe results.

Two details worth keeping:

- `status` is **spread conditionally**, never written as `status: maybeUndefined`. Hono would type
  the key as always-present while `JSON.stringify` drops it — one of the two recurring contract
  mismatches AGENTS.md names, and `contract-parity` catches it.
- "Checking…" is a distinct state from every probe RESULT. Rendering `unknown` for an answer that
  has not arrived would claim a verification that never ran.

## Identity is opt-in, and "hidden" means absent

"Show details" reveals the email, organization and plan an account is signed in as, read from the
account's own files: Claude's `.claude.json` `oauthAccount`, Codex's `auth.json` `id_token` claims.

That is a deliberate exception to the boundary `provider-auth.ts` keeps — *credentials, account
identity, and raw CLI output never cross this boundary* — so it is built to stay a narrow one:

- **Its own on-demand route**, not a field on the listing. Had the listing carried an email, hiding
  it in the UI would be theatre: it would already be in the response, the query cache and devtools.
  The route is fetched only once a row is expanded, so until someone asks, the data is absent from
  the page rather than merely unrendered.
- **Named fields only, never pass-through.** `auth.json` holds `OPENAI_API_KEY`, `access_token` and
  `refresh_token` right beside the claims, and `.claude.json` holds far more than `oauthAccount`.
  Every reader picks fields by name and builds a fresh object, so a key a vendor adds tomorrow
  cannot leak through. Tested by asserting credential-shaped values never appear in the answer.
- **localHandoff-gated** like the rest of the family, and never logged or persisted.

Version and install state are shown separately, once per agent, because they describe the *binary*
and come from the existing health probe — every login of one CLI shares them.

## Opening an account's own config files

Each account lists its agent's USER-scope config files, resolved inside **that** account's folder,
so a second login's `settings.json` is the one you open. They come straight from
`agent-config/catalog.ts` — the single home of config-file vendor knowledge — with an
`AgentHomePaths` whose slot for that provider is the account's dir.

`POST …/:id/open` takes a **catalog id** (or the keyword `folder`), never a path: the client cannot
name a location, so the route has no traversal surface at all, which is the same rule
`/api/v1/agent-config/:id` follows. A file the agent has not written yet answers 409 rather than
handing the OS a missing path and reporting success.

An optional `target` names a detected app (`GET /api/v1/open-targets`); absent means the OS default
handler. Which targets APPLY is enforced by the route, not left to the UI, because two families are
actively wrong rather than merely useless: `terminal` runs `cd <path>`, which fails on a file, and a
`cli:<runner>` handoff would start an agent session inside the config folder. Both are 400s, as is
an app this machine does not have.

The menu is the task thread's own **Open in…** component, extracted to
`packages/web/src/components/open-in-menu.tsx` when this pane needed the same question answered —
one menu, one icon table, one place where an unrecognised target degrades to a generic glyph. What
stays with each caller is anything about *what* is being opened: the run header keeps its resume
item and agent-availability filtering, this pane keeps its per-file target filter.

## Not in this cut

- **Agent config files per account.** The pane still resolves to the discovered account's files.
  Editing the wrong account's `settings.json` is annoying; it is not billing-affecting, which is
  why it ranked below everything above. The seam is ready: `resolvePath`/`listAgentConfig`/`seed`
  need an injected `AgentHomePaths`, and the catalog's opaque ids must stay unchanged.
- **Skills mirrors do not follow the profile**, deliberately: a skill is *content*, and a second
  login is not a second skill library. `skills.ts` carries a comment saying so.
- **Model catalogs are profile-unaware** (`codex-model-catalog.ts`, `runner-model-catalog.ts`).
  Available models can differ by plan; low impact, noted so it is not later found as a bug.
- **`backend-detect.ts` needs no per-profile probes** — `--version` is profile-independent.
