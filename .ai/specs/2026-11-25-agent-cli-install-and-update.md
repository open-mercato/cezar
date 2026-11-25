# Agent CLI install and update from the cockpit

Date: 2026-11-25 · Task eb5c2575 · Builds on `2026-10-26-first-run-onboarding` ("Set up an agent here") and
`2026-11-18-inline-account-reconnect`.

## Problem

A provider row that is not ready was a dead end. The picker greyed it out with "Connect this provider before
selecting it.", and installing meant copying a hint into a terminal. cezar learned that a CLI was too old only when a
run failed with "X or newer is required". The install commands lived in three places that disagreed:
`server/agent-setup.ts`, `server-install/steps.ts` and the hint strings.

## Shape

- **One recipe table**, `core/agent-install.ts`. For each agent it holds the install methods (native, npm, brew,
  script) with their install and update commands, a docs link, the npm package and allowed major, whether the vendor
  auto-updates, and a minimum version. Every surface reads it: the setup routes, the first-run page, `server-install`,
  the detection and provider hints, and the runners' "not found" errors.
- **Trust.** cezar runs a command only when its `trust` is `docs` (checked against the vendor's docs on 2026-11-25) or
  `shipped` (cezar already ran it, or it is the npm upgrade of a package cezar already installs). Anything
  `unverified` is shown with Copy and the docs link. OMP is `copyOnly` by owner decision (third-party tap).

  | Agent | cezar runs | Shown to copy |
  | --- | --- | --- |
  | Claude Code | native script, npm, brew cask on macOS (docs); `claude update` | — |
  | Codex | npm install and `@latest` upgrade (shipped); on macOS `brew install --cask codex`, `brew upgrade --cask codex` (owner-verified 2026-11-25) | a Linuxbrew/formula copy: `brew upgrade codex` |
  | OpenCode | `npm i -g opencode-ai@1`, `opencode upgrade` (shipped) | brew |
  | Cursor | install script, `agent update` (shipped) | — |
  | Copilot | npm install and `@latest` upgrade (shipped) | — |
  | Antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`, Windows `irm https://antigravity.google/cli/install.ps1 \| iex` (docs: Google's download page, 2026-11-25); `agy update` (shipped) | — |
  | Gemini, pi, Junie | — | npm install and upgrade |
  | Kimi | — | docs link only |
  | OMP | — | `brew install can1357/tap/omp` (always) |

- **Install order.** A method cezar runs beats one it only shows. Within those the recipe's order applies, except that
  npm needs a writable global folder. `sudo npm` comes last, and never for Claude Code (Anthropic: a root-owned install
  cannot update itself). Claude Code now prefers its native installer, as its docs recommend.
- **Update follows the install.** `locateInstalledCli` finds the binary cezar spawns, resolves symlinks and reads the
  method from where it lives: `Cellar`/`Caskroom` means brew, `node_modules` means npm, and
  `~/.local/share/{claude,cursor-agent}` means native or script. The update is that method's own (brew upgrades a brew
  install), else the CLI's self-update. `POST /providers/:provider/update` uses the same plan and answers a copy-only
  plan with 409 plus the command.
- **Casks are macOS-only.** A recipe command may name a `macos` slot ahead of `unix`; the Claude Code and Codex casks
  live there, so Linux (Linuxbrew) never gets `brew install --cask` and falls back to npm (`sudo npm` when its global
  folder needs root). A Homebrew binary under `Caskroom` is a cask, under `Cellar` a formula: a formula copy never gets
  the cask's `--cask` upgrade, but the CLI's own updater, else `brew upgrade <formula>` to copy. An npm update with no
  npm on the machine is only shown, never run.
- **Versions.** The installed version comes from `--version` (health), cached 15 s and cleared at the moment an
  install or update session exits (the session's own exit notification), so the sheet reads the new version before it
  says "updated". `minVersion` is the recipe's, raised by an "X or newer is required" an agent error states at runtime
  (`noteAgentErrorVersion`, in memory) only when the sentence names the agent, or says "version", right before the
  number, with no runtime or system (Node.js, git, macOS…) in that span: an allowlist, because a minimum someone else
  owns is one Update could never clear. The latest version
  comes from npm (`/<pkg>/latest`, or the newest stable within `npmMajor`), only when `GET /providers/setup` carries `x-cezar-latest: 1`,
  cached for 6 h (30 min after a failure). `CEZ_AGENT_VERSION_CHECK=0` turns it off. Chips: below the minimum is
  "X required", behind npm is "X available".

## `GET /api/v1/providers/setup`

The state is one flat object, `{available, reason, interactive, agents, session}`, and lists every agent even when setup
is unavailable, so a hosted cockpit can still copy commands (without sign-in or update lines, which name host paths).
Each entry carries `install` and `update` plans (`{command, runnable, sudo}`), `docsUrl`, `installed`, `version`,
`method` (how the installed copy got there), `minVersion`,
`latestVersion` and `activeRuns`. `POST /sessions` accepts `action: 'update'`, and the `x-cezar-force: 1` header to update while tasks run; joining a
running session answers 201 like a fresh start, marked by an `x-cezar-joined: 1` header so a sheet only cancels a sign-in it started (a landed sign-in is cancelled whoever started it), and "could not be checked" answers 409.

**Why so flat.** The typed API (`AppType`) sits at the compiler's declaration-length limit (TS7056): with `main` at
`3bc0ef093`/`4ce90da91` it had about 100 characters to spare. A union of two states spelled the agent list out twice,
a second success status spelled the session out twice, and `versionState` and `installCommand` repeat what the other
fields already say, so the reader derives those two (`entryVersionState`, `install.runnable ? install.command : null`).
The entry has no `installHint` or `autoUpdates` either (the first-run row shows the copy line or the docs link, and the
"updates itself" note is gone), and "look up the newest releases" is the `x-cezar-latest: 1` header rather than a
query, which would join the typed route signature. Windows checks out CRLF, and its count of the same `AppType` runs a
little longer: `main` itself sits within a character of the limit there, so this family must cost less than `main`'s.
`POST /providers/:provider/update` folds "cezar does not run this update itself" into its hosted refusal for the same
reason. When `main` grew again (#2490), the entry also lost `copyOnlyReason` (the sheet says "not verified yet, or a
third-party installer" for every copy-only line) and the install plan its `method`, and `force` became the
`x-cezar-force: 1` header: this family now costs about 400 characters less than `main`'s.
Every refusal in the family is plain `{ error }`, as on `main`: a second error shape (`{ error, command }`) was reduced
away on macOS but not on Windows, which tipped the Windows build over. The command to copy is in the listing.

## The sheet

Every greyed row in the default-agent pickers (repo and machine-wide) and in the Providers card offers **Install**,
**How to install**, **Sign in** or **Update**, opening one sheet (a dialog on desktop, a bottom sheet on a phone):

1. **Confirm**: the exact command with Copy, the method, the versions, the docs link, and why a command will not run
   (copy-only, unverified, unavailable here, or needs a password on a phone).
2. **Run**: the setup PTY, with the first-run outcomes ("did not install", "cezar cannot find it"). Closing the sheet
   leaves it running; reopening rejoins it.
3. **Sign in**: the reconnect card for agents with a headless sign-in. For terminal-only agents (pi, Gemini,
   Antigravity, Junie, OMP), the sign-in is **Open terminal here** on the computer, or **Finish on my computer** on a
   phone.
4. **Done.**

The update-required card in a task thread opens the same sheet.

**Running tasks.** A task counts against the agent `taskAgentSelection` resolves for it: a run with no `runner` takes its
project's `defaultRunner`, and a workflow step on its own backend counts against that backend. An update with tasks
running on that agent answers 409 unless `force` is set. The sheet offers
**Update when they finish** (it polls `activeRuns` and starts at zero) or **Update now**, and warns that npm replaces
files in place. New starts are not held during the swap; brew, native and script installs swap a versioned folder.

## Phone

A relay request reads the host's capabilities for this family only. A phone may start an install or update whose plan is
runnable and needs no sudo. It may not start a login, and input to a setup session answers 409 (read-only). A sign-in
session started at the computer is invisible to a phone: the listing omits it, and its output (the OAuth link, the
device code) and resize answer 409. On the setup routes and `POST /providers/:provider/update`, a phone reads install
and update logs only, with absolute binary paths cut to the program name (`withoutHostPaths`) in the listing, started or
joined session bodies, and update refusals, and with no sign-in line (matching how `/workspace/agent-profiles` withholds
host paths from phones). On the first-run agent step, a phone stays on `SignInToAgent` because `interactive` is false.
Recorded as pending owner ratification in AGENTS.md.

**Waiting for tasks** happens in the open sheet: it says "Keep this open", and closing it mid-wait cancels the update with
a toast that says so.

## Not here

- Background or automatic updates (the "update centre" variant). The vendors that auto-update already do it.
- Holding new runs while an update swaps the binary.
- Verifying the remaining installers. Each moves from copy-only to runnable by changing its `trust`, with the doc it
  was checked against cited in the PR.
