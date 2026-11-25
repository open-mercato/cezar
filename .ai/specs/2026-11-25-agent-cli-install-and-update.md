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
  | Claude Code | native script, npm, brew cask (docs); `claude update` | — |
  | Codex | npm install and `@latest` upgrade (shipped) | brew cask install and upgrade |
  | OpenCode | `npm i -g opencode-ai@1`, `opencode upgrade` (shipped) | brew |
  | Cursor | install script, `agent update` (shipped) | — |
  | Copilot | npm install and `@latest` upgrade (shipped) | — |
  | Antigravity | `agy update` (shipped) | install: docs link only |
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
- **Versions.** The installed version comes from `--version` (health), cached 15 s and cleared when an install or
  update session ends, so the sheet reads the new version before it says "updated". `minVersion` is the recipe's, raised by any
  "X or newer is required" an agent error states at runtime (`noteAgentErrorVersion`, in memory). The latest version
  comes from npm (`/<pkg>/latest`, or the newest stable within `npmMajor`), only on `GET /providers/setup?latest=1`,
  cached for 6 h (30 min after a failure). `CEZ_AGENT_VERSION_CHECK=0` turns it off. Chips: below the minimum is
  "X required", behind npm is "X available".

## `GET /api/v1/providers/setup`

The state lists every agent, even when setup is unavailable, so a hosted cockpit can still copy commands. Each entry
adds `install` and `update` plans (`{command, runnable, method, sudo}`), `docsUrl`, `copyOnlyReason`, `installed`,
`version`, `method`, `minVersion`, `latestVersion`, `versionState`, `autoUpdates` and `activeRuns`. The available
variant adds `interactive`. `installCommand` keeps its meaning: what cezar would run, or null. `POST /sessions` accepts
`action: 'update'` and `force`.

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
device code) and resize answer 409. A phone reads install and update logs only. Recorded
as pending owner ratification in AGENTS.md.

## Not here

- Background or automatic updates (the "update centre" variant). The vendors that auto-update already do it.
- Holding new runs while an update swaps the binary.
- Verifying the remaining installers. Each moves from copy-only to runnable by changing its `trust`, with the doc it
  was checked against cited in the PR.
