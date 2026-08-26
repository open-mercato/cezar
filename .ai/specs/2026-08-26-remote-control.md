# Remote Control — launch Claude's Remote Control from the cockpit

**Date:** 2026-08-26 · **Task:** b4f4dd69 · **Status:** implemented

## Goal

Parity with `/remote-control` in interactive Claude Code (the command the user types in
VS Code): one click in the cockpit connects this project to claude.ai, so sessions in the
repo can be driven from claude.ai/code or the Claude mobile app.

## What the CLI actually supports (probed on claude CLI 2.1.233)

- `claude --remote-control` is **silently ignored in headless stream-json mode** — the mode
  every cezar task runs in (`buildClaudeArgs`). A debug-file run shows no connection attempt.
  So a cezar task's own session cannot be RC-attached, and `claude remote-control
  --session-id <id>` reattaches only sessions Remote Control itself recorded — not cezar's
  pinned run sessions. A per-task "Remote Control" button is therefore not implementable
  today; this feature is **project-level** instead.
- `claude remote-control` (the subcommand) is a persistent server that needs no TTY: it asks
  `Enable Remote Control? (y/n)` on stdin, then prints the
  `https://claude.ai/code?environment=env_…` link and runs until killed. cezar answers the
  prompt with `y\n`, parses the link out of the (ANSI-laden) output, and manages the process.
- **Workspace trust**: the subcommand refuses in a directory where interactive `claude` has
  never accepted the trust dialog (`Error: Workspace not trusted …`). cezar must not accept
  trust on the user's behalf — the CLI's message is surfaced verbatim, plus a hint.

## Design

One `claude remote-control` child per project, owned by `RemoteControlService`
(`src/server/remote-control.ts`, keyed by realpath'd project root so the boot mount and the
`/p/:projectId` aliases share one process and answer byte-identically).

- **Spawn mode**: `--spawn worktree --no-create-session-in-dir` when the root is a git repo —
  the house doctrine says agents never run in the protected checkout (see the
  `POST /open-in` refusal for `cli:<runner>` targets); sessions spawned from the phone get
  isolated worktrees. Non-git projects fall back to the CLI's `same-dir` default.
- **Account env**: the project's current claude profile (`handoffEnv('claude', undefined)`),
  same resolution as the terminal handoff.
- **Lifecycle**: `start()` resolves when the claude.ai link appears (state `running`), the
  process exits early (state `error`, last output line as the reason), or a 20 s timeout
  kills it. `stop()` is SIGINT with a SIGKILL escalation. A `process.on('exit')` hook kills
  the child on cezar shutdown; project removal disposes the project's instance. An
  unexpected exit while `running` → state `error`.
- **Zero-config**: no new `CEZ_*` var. The feature does nothing until the user clicks Start —
  the click is the opt-in; this matches the flag doctrine's intent (no *automatic* network
  exposure). Hosted mode is gated by `localHandoff` exactly like the other local-machine
  affordances: status reports `available: false`, mutations 409.
- **Dry run**: `CEZ_DRY_RUN=1` fakes a `running` server with a placeholder URL — the cockpit
  can be exercised offline, same doctrine as the faked draft-PR URL.

## API (project-scoped, both mounts)

- `GET /api/v1/remote-control` → `RemoteControlStatus`
- `POST /api/v1/remote-control/start` → same shape (409 in hosted mode)
- `POST /api/v1/remote-control/stop` → same shape (409 in hosted mode)

`RemoteControlStatus` (`packages/contract/src/remote-control.ts`):
`{ available, reason?, state: stopped|starting|running|error, url?, startedAt?, error? }` —
optional keys spread conditionally, per the contract's JSON.stringify rule.

## UI

Settings → (project scope) → **Remote Control**: status dot, the claude.ai link when
running, Start/Stop, the CLI's error text (trust included) when it refuses. Hidden in
hosted mode like every `localHandoff` affordance. No polling: `start` answers with the
final state, so the section renders what the mutation returned; a later crash surfaces on
the next status fetch (window-focus refetch).

## Future work

- Per-task Remote Control, if/when the claude CLI honors `--remote-control` in stream-json
  mode or exposes reattach for externally recorded sessions.
- A `--spawn`/capacity knob if a real need appears (deliberately not shipped: never trade a
  working default for a knob).
