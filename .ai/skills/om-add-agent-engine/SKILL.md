---
name: om-add-agent-engine
description: Add a new coding-agent engine (runner/backend/provider) to cezar at full parity with Claude Code, Codex, OpenCode, Junie, Copilot, Cursor, pi and Antigravity — runner class, UI mapper, live-captured golden fixtures, parity row, detection and auth probe, model catalog and native default model, Settings → Agent config files, Open-in/resume, web surfaces, docs, opt-in live smoke test. Use when asked to "add support for <agent> CLI", "add a new runner/engine/backend/provider", or to bring a partial runner up to the other providers' level.
---

# Add a new agent engine to cezar

A new engine is **one runner class behind the seam** plus its mapper, fixtures and parity
row — and then every user-facing surface the other runners already have. The normative
checklist is `AGENT_PROTOCOL.md` §9 (read it first, together with §3 `UiEvent`, §6 parity
and §7 fixtures). This skill is the *working order* and the gaps that checklist does not
catch on its own. Worked examples: `pi` (#387), `copilot` (#582, ACP), `antigravity`
(#1506, own stream-json) — when unsure how a surface looks, copy the closest one.

Below, `<id>` is the runner id (lowercase `[a-z]+`, e.g. `antigravity`) and `<bin>` the
CLI executable (e.g. `agy`).

## 0. Learn the real CLI before writing code

Never design against docs or assumptions alone (PR #443's root cause was an assumed wire
shape). With the CLI installed and signed in:

- `<bin> --help` and every subcommand's `--help`: non-interactive/print mode, streaming
  output format, stdin input format (prefer stdin — Windows caps argv at ~32K), resume flag,
  `--model`/effort flags, the "approve everything" mode, model listing, MCP management.
- Capture **real** transcripts of: a plain text turn, a turn with tool calls (one failing),
  a subagent/delegation turn if supported, a resumed session, an unknown `--model`, a
  signed-out run. Note what `usage` means (per turn or cumulative?).
- Find where it keeps settings, MCP servers, global and project instructions, and which
  settings key stores the `/model` choice (and whether `--model` accepts that value).
  The binary's embedded docs (`grep -a` over the executable) are a legitimate primary source.
- **Never print credential files or `mcp list`-style output into the transcript** — MCP
  configs routinely carry tokens. Inspect key names and file paths only; redact fixtures.

Record findings in `packages/cezar/src/core/__fixtures__/<id>/README.md` (CLI version,
date, commands used, redactions).

## 1. Core runner (packages/cezar/src/core)

1. `RUNNER_IDS` in `agent-runner.ts` — one line; then let `npm run typecheck` list every
   `Record<RunnerId, …>` that must grow (model strategies, labels, profile env vars, …).
2. `<id>-runner.ts` implementing `AgentRunner`/`AgentSession`: persistent process per
   session where the CLI allows it, `sendMessage`/`end`/`interrupt`/`pid`/`result`,
   `prependSystemPrompt` when there is no system-prompt channel, `resolve<Id>Bin()` honouring
   `CEZ_<ID>_BIN` (document it in `.env.example`), kill grace, timeout, a stop cezar asked
   for is never a failure (Windows exits 1 on kill — use the flag).
3. Auth failures: word them so `isRuntimeProviderAuthFailure()` (`provider-auth.ts`)
   classifies them — test that explicitly; it drives the "sign in" card.
4. Images / private MCP the CLI cannot take degrade to a `note`, never a failed run.
   Add the id to `PRIVATE_MCP_RUNNERS` only once a launch-time channel actually works.
5. `runner-factory.ts` case; `UiBackend` in `ui-events.ts` **and** the mirror in
   `packages/api-client/src/protocol/ui-events.ts`.
6. `<id>-ui-mapper.ts`: full v2 stream alongside v1, immutable state, never throws on bad
   lines; per-turn usage (sum step usage if the CLI reports cumulative totals, or a resume
   re-counts history); turn-level error results surface their own message.
7. Fixtures `__fixtures__/<id>/*.ndjson` + `*.expected.json` from the captures; mapper test
   replays them exactly as the runner drives the mapper; add `<id>` to `BACKENDS` in
   `ui-parity.test.ts`; exclusions only with a cited reason.
8. `scripts/mock-<id>.mjs` for `CEZ_DRY_RUN`, mirroring the real wire.

## 2. Detection, auth, models

- `backend-detect.ts` probe (never fails boot), `provider-auth.ts` status probe — prefer a
  cheap command that only succeeds signed in (e.g. `<bin> models`) — and
  `server/provider-action-gate.ts`, `providers-api.test.ts` (`CONNECTED_OUTPUT`,
  `DISCONNECTED_OUTPUT`, `providerForExecutable`).
- `<id>-model-catalog.ts` (parse the CLI's model list, bounded), `runner-model-catalog.ts`,
  `model-presets.ts`, `BACKEND_MODEL_MAP` in `model-identity.ts` — a bare id with no default
  provider must fail loud, never be dropped silently.
- `agent-config/model-settings/<id>.ts` + registration in `agent-config/models.ts`. It only
  returns a value when the catalog entry has **both** `modelKey` and `modelPriority` — write
  a `models.test.ts` case so this cannot silently return `{}`.

## 3. Settings → Agent config, profiles, accounts

- `agent-config/catalog.ts`: one entry per settings / MCP / memory file with the vendor's
  precedence quoted verbatim and a `docsUrl`; add `<id>` to the shared `project.agents`
  (`AGENTS.md`) entry if the CLI reads it. `AgentHomePaths` + `paths.ts agentHomePaths()`.
  Update `catalog.test.ts` (AGENTS.md readers, `holdsMcp` list, resolved paths).
- `workspace/agent-profiles.ts`, `core/agent-profiles.ts` (`PROFILE_ENV_VAR`),
  `workspace/agent-accounts.ts`, `agent-config/account-identity.ts`, `workspace/config.ts`,
  `contract/src/{agent-profiles,health,workspace}.ts`.

## 4. Server + web surfaces

- `server/open-in-app.ts` CLI target (`icon: '<id>'`) **and** `web/src/components/open-in-menu.tsx`
  `OPEN_IN_ICONS` — the icon map is a partial record, so typecheck will not catch it.
- `resumeCommand()` in `server/server.ts` (+ `server/resume-command.test.ts`) and the provider wiring next to it.
- Web: `routes/settings/agent-descriptors.ts` (+ test — also not typecheck-enforced),
  `settings/accounts-section.tsx`, `settings/provider-settings.tsx`, `lib/provider-auth-alert.ts`,
  `lib/provider-status.ts`, `routes/new-task-form.ts`, `routes/automations/editor-draft.ts`
  `isRunner`, `routes/task-thread/{thread-state.ts,thread-items.tsx,active-provider.ts,run-actions.ts}`,
  `components/tools-menu.tsx`, `api/queries.ts`.

**Parity sweep — run it before calling the work done.** Hand-written runner lists hide from
typecheck. List files that name the closest existing runner but not the new one:

```bash
for f in $(git grep -l -i copilot -- 'packages/*/src/**' docs '*.md' ':!**/dist/**' ':!**/__fixtures__/**' ':!.ai/**' ':!CHANGELOG.md'); do
  grep -qi '<id>' "$f" || echo "$(grep -ci copilot "$f") $f"
done | sort -rn
```

Every hit is either a gap to fill or a deliberate absence you can justify (e.g. the
copilot-only runner/mapper files themselves).

## 5. Docs

`README.md` provider list and install line, `docs/reference.md` (`CEZ_<ID>_BIN`),
`AGENT_PROTOCOL.md` §1 wire line + §4 mapping paragraph, `.env.example`,
`BACKWARD_COMPATIBILITY.md` if any persisted enum widened (keep it additive).

## 6. Validate

1. `npm run typecheck` — green.
2. Targeted: `npx vitest run packages/cezar/src/core/<id>-* packages/cezar/src/agent-config packages/cezar/src/server/providers-api.test.ts packages/cezar/src/core/ui-parity.test.ts packages/web/src/routes/settings`.
3. Opt-in live smoke `core/<id>-runner.smoke.test.ts` gated on `<ID>_REAL_SMOKE=1` (copy
   `antigravity-runner.smoke.test.ts`): one turn with usage and clean end, resume answers a
   follow-up, a tool call goes running → completed. Run it with a cheap model.
4. Full `npm test`. On Windows, `main` itself fails many files (EPERM temp cleanup, POSIX
   path assertions) — compare failing files against a `main` baseline, or run on Linux/WSL
   with Node LTS (≥ 22.12; Linux may need `npm i --no-save @rolldown/binding-linux-x64-gnu@<ver>`).
   Report only failures the branch introduces.
5. End to end: start the cockpit from the branch on a free port (`npm run dev -- -p 4322`),
   confirm the engine shows **connected** in Settings, run one task with it, Continue it, and
   open "Open in <CLI>".

## 7. Ship

One PR for the engine (`feat: <Name> CLI (<bin>) runner`), validation evidence in the body
(commands + results, live-smoke outcome, honest list of what is not supported and why).
Credit any earlier community draft and link it from both sides.
