# Agent install and sign-in inside the first-run onboarding

Source doc: .ai/specs/2026-10-26-first-run-onboarding.md

## Goal

Someone with no working agent finishes setup without leaving cezar: detection first, then pick
an agent from a list, cezar installs it and signs them in, in a terminal on the onboarding page.

## Scope

- Server: a catalog of install recipes, and workspace-level routes that run one server-chosen
  install or login command in a PTY.
- Cockpit: the first-run agent page lists agents and embeds the terminal.
- Fallback: hosted cockpit, terminal off, single-project mode or no PTY keep today's page
  (external terminal, commands to copy).

## Non-goals

- A command or a path from the request. A request names a provider and an action, nothing else.
- Installing pi or Junie (no install recipe this repo can vouch for).
- Named agent accounts: setup signs in the default account. Settings → Agents keeps those.
- New telemetry events: the existing login events are reused.
- `cezar init` and the server installer.

## Implementation Plan

### Phase 1: Server

1. Install recipes: npm when its global prefix is writable, the vendor's script otherwise, `sudo npm` last.
2. Contract schemas and the chained route family, gated on local handoff and the terminal policy.
3. Route and recipe tests.

### Phase 2: Cockpit

1. API client and hooks.
2. The setup list and embedded terminal on the first-run page.
3. Component tests, including the fallback and every exit from the terminal state.

### Phase 3: Docs and verification

1. Spec, BACKWARD_COMPATIBILITY and user docs.
2. A real install and sign-in walk against a sandboxed server, with screenshots.

## Risks

- A repo's `.npmrc` could redirect an install: commands run in the home folder, never the project.
- An install can land outside the PATH cezar sees: the page says so instead of waiting forever.

## Progress

PR: #1890

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server

- [x] 1.1 Install recipes — d0f215bb7
- [x] 1.2 Contract schemas and routes — d0f215bb7
- [x] 1.3 Route and recipe tests — d0f215bb7

### Phase 2: Cockpit

- [x] 2.1 API client and hooks — 8966c313d
- [x] 2.2 Setup list and embedded terminal — 8966c313d
- [x] 2.3 Component tests — 8966c313d

### Phase 3: Docs and verification

- [x] 3.1 Spec, BACKWARD_COMPATIBILITY and user docs — 36f17a798
- [x] 3.2 Real install and sign-in walk with screenshots — 8966c313d
