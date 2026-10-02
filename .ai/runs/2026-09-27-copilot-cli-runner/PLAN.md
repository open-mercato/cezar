# Execution plan — GitHub Copilot CLI coding-agent runner (`copilot`)

**Slug:** `copilot-cli-runner` · **Branch:** `feat/copilot-cli-runner` · **Base:** `main`
**Subject issue:** [#582](https://github.com/open-mercato/cezar/issues/582)
**Source spec:** `.ai/specs/2026-09-19-runner-seam-native-backends.md` — **Phase 3 only**
**Engine:** `om-auto-create-pr-loop` (steps: 26, `--loop`: no — routed by the step threshold)

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids and `Exec` cells are immutable once the plan is committed — per-Step commits touch only `Status` and `Commit`.

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 1 | 1.1 | Port the shared ACP client from PR #1049 | inline | done | e70442da |
| 1 | 1.2 | Port the shared ACP→v2 mapper from PR #1049 | inline | done | 95769bb6 |
| 2 | 2.1 | Record the verified Copilot ACP surface and frame vocabulary | inline | done | PENDING21 |
| 2 | 2.2 | Add the `copilot` mapper dialect | inline | done | 75f013ae |
| 2 | 2.3 | Add golden `__fixtures__/copilot/` transcripts for every parity row | inline | done | b907902f |
| 2 | 2.4 | Add `copilot-ui-mapper.test.ts` replay and robustness tests | inline | done | b907902f |
| 3 | 3.1 | Add `copilot-acp-runner.ts` (session lifecycle over `copilot --acp`) | inline | done | ba7ac220 |
| 3 | 3.2 | Add `scripts/mock-copilot-acp.mjs` and wire `CEZ_DRY_RUN` | inline | done | ba7ac220 |
| 3 | 3.3 | Add runner tests: follow-up, cancel, resume, permission auto-answer, teardown | inline | done | ba7ac220 |
| 3 | 3.4 | Add the opt-in real-CLI smoke test, skipped without Copilot entitlement | inline | done | 6fb75404 |
| 4 | 4.1 | Widen the runner union: `RUNNER_IDS`, `UiBackend` ×2, contract schemas, factory | inline | done | f7cff6ae |
| 4 | 4.2 | Add `probeCopilot()` and `CEZ_COPILOT_BIN` (+ `.env.example`, `docs/reference.md`) | inline | done | f7cff6ae |
| 4 | 4.3 | Add the provider-auth descriptor, action gate and server-install step | inline | done | f7cff6ae |
| 4 | 4.4 | Add the credential allowlist and agent-profile entries | inline | done | f7cff6ae |
| 4 | 4.5 | Add the model seam: identity map, presets, model-settings strategy, catalog | inline | done | f7cff6ae |
| 4 | 4.6 | Add the `agent-config/catalog.ts` config-file entries | inline | done | 4e370d54 |
| 4 | 4.7 | Widen the per-runner zod records across contract, config and server bodies | inline | done | f7cff6ae |
| 4 | 4.8 | Add `resumeCommand()` and open-in-app support | inline | done | f7cff6ae |
| 5 | 5.1 | Cockpit: provider status, auth alert, tools menu, open-in menu | inline | done | f7cff6ae |
| 5 | 5.2 | Cockpit: Settings → Agents descriptor, accounts and provider settings rows | inline | done | 4e370d54 |
| 5 | 5.3 | Cockpit: composer, thread and automations runner mirrors | inline | done | f7cff6ae |
| 5 | 5.4 | Pin `runnerDiscoversModels('copilot') === false` and the free-text picker | inline | done | 4e370d54 |
| 5 | 5.5 | Update the e2e runner mirrors and add the dry-run smoke | inline | done | f7cff6ae |
| 6 | 6.1 | Add `copilot` to `ui-parity.test.ts` `BACKENDS` | inline | done | 78a13a44 |
| 6 | 6.2 | Document the runner in `AGENT_PROTOCOL.md` and `BACKWARD_COMPATIBILITY.md` | inline | done | 2b3ce11a |
| 6 | 6.3 | Add the CHANGELOG entry and the README backends row | inline | done | 2b3ce11a |
| 6 | 6.4-review-fix | Derive the Settings accounts tabs from the shared runner order | inline | done | cce1f2a6 |

## Goal

Make GitHub Copilot CLI a first-class cezar coding-agent runner (`copilot`), driven over its
Agent Client Protocol server, so a task can be launched, followed up, cancelled and resumed on
Copilot exactly as it can on `claude`, `codex`, `opencode` and `pi`.

## Scope

- A new `copilot` runner id, additive everywhere the runner union is enumerated.
- A shared, vendor-neutral ACP transport plus a generic ACP→v2 mapper (spec Steps 2.2–2.3,
  carried by this phase because Phase 2 has not merged — see § Sequencing).
- A `copilot` dialect, golden fixtures for every `ui-parity.test.ts` capability row, and a
  `scripts/mock-copilot-acp.mjs` so `CEZ_DRY_RUN=1` stays fully offline.
- Detection, provider auth, credentials, model settings, resume, open-in-app, and the cockpit
  rows the Settings page needs in order not to throw.

## Non-goals

- **Spec Phase 0** (deriving every runner enumeration from one tuple in `packages/contract`).
  It has not landed; this run hand-tracks the seam sites instead. Adding the tuple here would
  collide with Phase 0's own PR.
- **Spec Phase 1** (codex declared providers) and **Phase 2** (the `gemini` runner itself).
- Permission modes. Per spec Q15 the runner ships **`auto` only** — Copilot starts with
  `--allow-all-tools`, and any `session/request_permission` that still arrives is auto-answered
  and noted. The permission card from `.ai/specs/2026-07-17-permission-modes` is not built.
- Agent accounts for `copilot`: `PROFILE_ENV_VAR.copilot = null` (spec Q14), even though
  `COPILOT_HOME` looks like a candidate — being wrong there bills the wrong account.
- Copilot's BYOK `COPILOT_PROVIDER_*` family, `--fleet` mode, remote sessions, MCP config, and
  `modelDiscoveryRunnerSchema` (Copilot deliberately stays out, like `pi`).

## Sequencing — why this run carries the ACP layer

- Spec **Phase 0** (`packages/contract/src/runners.ts`) has **not** landed on `main`; the seam
  sites below are hand-tracked rather than typecheck-enforced.
- Spec **Phase 2** (`gemini` + the shared ACP layer, #581) is **open draft PR #1049**
  (`feat/issue-581-gemini-cli-runner`, @aleksanderw1992) and has **not** merged.
- Spec § Phasing: *"the layer is written once, by whichever of Phase 2 and Phase 3 lands first"*.
  So Phase 3 carries Steps 2.2–2.3 — but it does **not** fork a second, different client.
  `core/acp-client.ts` and `core/acp-ui-mapper.ts` are taken from PR #1049 **verbatim** so the
  eventual merge is an identical-file resolution. Whichever of #1049 and this PR lands second
  drops its copy.

## Verified Copilot facts (2026-09-27, `@github/copilot` 1.0.88)

Spec Step 3.1, settled against the real binary before planning. These **correct** the spec:

1. **`copilot --acp`** — there is no `--stdio` flag. The spec's `copilot --acp --stdio` is wrong;
   the `--stdio` it cites is an unrelated `typescript-language-server` example in the package
   README.
2. `initialize` really answers `protocolVersion: 1` with
   `agentCapabilities.loadSession: true`, `promptCapabilities.image: true`,
   `embeddedContext: true`, `sessionCapabilities: {close:{}, list:{}}`,
   `agentInfo: {name:"Copilot", version:"1.0.88"}`, and one auth method `copilot-login`.
3. Unauthenticated `session/new` answers `{"code":-32000,"message":"Authentication required"}` —
   that is the frame that becomes `provider-auth-required`.
4. Token precedence `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` is confirmed by
   `copilot help environment`. `COPILOT_HOME`, `COPILOT_MODEL`, `COPILOT_ALLOW_ALL`,
   `COPILOT_AUTO_UPDATE`, `COPILOT_OFFLINE` and `GH_HOST` / `COPILOT_GH_HOST` all exist.
5. Tool filters are start-time flags: `--allow-all-tools`, `--allow-tool`, `--deny-tool`,
   `--available-tools`, `--excluded-tools`, `--add-dir`, `--no-ask-user`, `--secret-env-vars`.
   The **flag** is used rather than `COPILOT_ALLOW_ALL=true`, because that exact value *also*
   trusts the working directory and loads its skills, plugins, MCP servers and shell hooks.
6. Also relevant: `--model`, `--session-id` (sets the UUID of a *new* session), `-C <dir>`,
   `--no-auto-update`, `--log-dir`, `--usage-output-file`, `--disable-builtin-mcps`.
7. `copilot login` is the login command.

## Risks

- **No authenticated Copilot transcript could be captured.** The host `gh` token carries no
  Copilot entitlement, so the live streaming frames (`session/update` kinds and any usage
  `_meta`) are derived from the ACP schema (agentclientprotocol.com, `PROTOCOL_VERSION = 1`) and
  from strings in the installed `@github/copilot-linux-x64` binary — the same offline method the
  source spec used for codex — rather than from a recorded session. Every fixture header cites
  its source. Mitigation: the opt-in real-CLI smoke test (Step 3.4) is the gate that proves the
  mapping against a live account; it is skipped without entitlement.
- ~~**Usage reporting may be absent.**~~ **Resolved in Step 2.1**: the `session/prompt` result
  carries a top-level `usage` object, so `usage.updated` needs no substitute. See
  `copilot-acp-notes.md` § Token usage.
- **Merge conflict with PR #1049** on the two shared ACP files. Bounded by taking them verbatim.
- **Protected surfaces** (`BACKWARD_COMPATIBILITY.md` §2, §3, §7) are touched. Everything is
  additive: no runner id is renamed, `claude-cli` stays parseable, and v1 `AgentEvent` emission
  keeps flowing alongside v2.
- **`createRunner`'s `default` falls through to Claude**, and the cockpit's `descriptorFor()`
  *throws* on an unknown runner — so Steps 4.1 and 5.2 are correctness, not polish.

## External references

- `--skill-url`: none passed.
- Agent Client Protocol, `PROTOCOL_VERSION = 1` — https://agentclientprotocol.com
- GitHub Copilot CLI ACP server reference — https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
- PR [#1049](https://github.com/open-mercato/cezar/pull/1049) — origin of `acp-client.ts` / `acp-ui-mapper.ts`.

## Implementation Plan

### Phase 1 — The shared ACP layer (spec Steps 2.2–2.3, carried)

**1.1 Port the shared ACP client from PR #1049**
Take `packages/cezar/src/core/acp-client.ts` and its test verbatim from `pr-1049`. Vendor-neutral
JSON-RPC 2.0 over NDJSON on a child's stdio: request ids, timeouts, inbound notifications and
inbound requests, an `onFrame` tap in wire order, never throwing on wire content.

**1.2 Port the shared ACP→v2 mapper from PR #1049**
Take `packages/cezar/src/core/acp-ui-mapper.ts` and its test verbatim. Generic `session/update`
→ `UiEvent` translation with explicit immutable state, parameterized by a per-vendor dialect.

### Phase 2 — The `copilot` dialect and its fixtures

**2.1 Record the verified Copilot ACP surface and frame vocabulary**
`copilot-acp-notes.md` in the run folder: the handshake, the auth-error frame, the flag and env
inventory, and the `session/update` kinds, frame shapes, `stopReason` set, usage location,
sub-agent `_meta` key and tool-name→kind table read out of the CLI's own bundle, each with the
command or code site that produced it. It is the source the golden fixtures cite.

**2.2 Add the `copilot` mapper dialect**
`packages/cezar/src/core/copilot-ui-mapper.ts` — `usageFromPromptResult`, `planFromToolCall`,
`toolNameOf` and the session-start shape, over the shared mapper.

**2.3 Add golden `__fixtures__/copilot/` transcripts for every parity row**
`.ndjson` + `.expected.json` pairs covering plan updates, tool `running`/`completed`/`failed`,
reasoning, structured diffs, sub-agent task items and nesting (with the documented substitute if
Copilot attributes no parent), usage, and `turn.completed` with a `stopReason`; plus a `README.md`
citing the upstream source of every frame shape.

**2.4 Add `copilot-ui-mapper.test.ts` replay and robustness tests**
Replay each fixture exactly as the runner drives the mapper, round-trip through JSON, and assert
`toStrictEqual`. Malformed NDJSON and unknown update kinds must produce no events and never throw.

### Phase 3 — The runner

**3.1 Add `copilot-acp-runner.ts`**
`AgentRunner` / `AgentSession` over `copilot --acp` in `spec.cwd`: `initialize`, `session/new`
(or `session/load` on resume), `session/prompt` per turn, images as ACP content blocks,
`spec.model` → `--model`, `spec.additionalDirectories` → `--add-dir`, `--allow-all-tools`,
`--no-auto-update`, the SIGTERM→SIGKILL watchdog, and `-32000 Authentication required` →
`provider-auth-required`.

**3.2 Add `scripts/mock-copilot-acp.mjs` and wire `CEZ_DRY_RUN`**
A scripted ACP peer modelled on `mock-pi-rpc.mjs`, so a dry run is fully offline.

**3.3 Add runner tests**
Follow-ups as further `session/prompt` calls, `session/cancel`, respawn + `session/load`, the
`auto` permission answer to an inbound `session/request_permission` (with a `note`), the run
timeout, and that cezar's own teardown signal is not reported as an agent failure.

**3.4 Add the opt-in real-CLI smoke test**
Skipped unless a Copilot-entitled token is present; the gate that confirms the mapping against a
live account.

### Phase 4 — The service seam

**4.1** `RUNNER_IDS` (`core/agent-runner.ts`), `UiBackend` in `core/ui-events.ts` **and** its
mirror `packages/api-client/src/protocol/ui-events.ts`, `runnerSchema` + `backendCheckSchema`
(`packages/contract/src/health.ts`), and the `createRunner` case.
**4.2** `probeCopilot()` + the `BackendCheck` name union (`core/backend-detect.ts`),
`CEZ_COPILOT_BIN`, `.env.example` and the `docs/reference.md` env table.
**4.3** The `core/provider-auth.ts` descriptor (`connected` on a token or a stored login; login
command `copilot login`), `server/provider-action-gate.ts`, and the server-install agent-CLI gate.
**4.4** `BACKEND_ALLOW_PREFIXES.copilot = ['COPILOT_']` (`core/agent-env.ts`) and the
`core/agent-profiles.ts` entries (`PROFILE_ENV_VAR.copilot = null`).
**4.5** `BACKEND_MODEL_MAP.copilot` (`core/model-identity.ts`), `KNOWN_PRESETS_BY_RUNNER.copilot`
(`core/model-presets.ts`), `agent-config/model-settings/copilot.ts`, `agent-config/models.ts`,
and the `core/runner-model-catalog.ts` label.
**4.6** `agent-config/catalog.ts` entries for Copilot's own config files.
**4.7** The per-runner zod records: `packages/contract/src/workspace.ts`,
`packages/contract/src/agent-profiles.ts`, `packages/cezar/src/config.ts`,
`workspace/config.ts`, `workspace/agent-accounts.ts` and the `server.ts` bodies.
**4.8** `resumeCommand()` → `copilot --resume <id>` and `server/open-in-app.ts`.

### Phase 5 — The cockpit

**5.1** `web/src/lib/provider-status.ts`, `lib/provider-auth-alert.ts`,
`components/tools-menu.tsx`, `components/open-in-menu.tsx`.
**5.2** `routes/settings/agent-descriptors.ts` (which **throws** on an unknown runner),
`accounts-section.tsx`, `provider-settings.tsx`.
**5.3** `routes/new-task-form.ts`, `task-thread/thread-state.ts`, `task-thread/active-provider.ts`,
`task-thread/thread-items.tsx`, `routes/automations/editor-draft.ts`.
**5.4** A web unit test pinning `runnerDiscoversModels('copilot') === false` and that the picker
offers free text plus `KNOWN_PRESETS_BY_RUNNER.copilot` with no `/models` request.
**5.5** `e2e/tools-menu.e2e.ts`, `e2e/settings-agents.e2e.ts` and a dry-run e2e smoke.

### Phase 6 — Parity and documentation

**6.1** `copilot` in `BACKENDS` (`core/ui-parity.test.ts`); every capability row green.
**6.2** `AGENT_PROTOCOL.md` §4 gains an ACP column and §9 the `copilot` note;
`BACKWARD_COMPATIBILITY.md` records the additive widening of §2, §3 and §7.
**6.3** `CHANGELOG.md` entry and the README backends row.

## Deviation from 1:1 Step↔commit — the union widening

Steps 4.1–4.5, 4.7, 4.8, 5.1, 5.3 and 5.5 landed in **one** commit rather than ten. Widening
`RUNNER_IDS` is not decomposable: `Record<RunnerId, …>` / `Record<ProviderId, …>` tables
(`BACKEND_MODEL_MAP`, `KNOWN_PRESETS_BY_RUNNER`, `BACKEND_ALLOW_PREFIXES`, `PROFILE_ENV_VAR`,
the model-settings registry, the cockpit's label and preset maps) are compile errors the moment
the tuple grows, and the contract-parity guard is a compile error until `backend-detect.ts` and
`contract/src/health.ts` agree. Splitting them would have meant a chain of commits that do not
typecheck, which is worse for bisecting than one commit that does. The Steps left standing are
the ones the type system does NOT force: the config catalog (4.6), the Settings → Agents
descriptor (5.2) and the model-discovery pin (5.4).

Steps 3.1–3.3 share one commit for the same reason: the runner cannot be tested without the
mock, and a mock with no test asserts nothing. Steps 2.3 and 2.4 also share one commit: an `.expected.json` with no replay test asserts nothing,
so the fixtures and `copilot-ui-mapper.test.ts` are one reviewable unit.

Three fixes were folded in because the widening would otherwise have EXTENDED a defect:
`createRunner` now refuses `copilot` instead of falling through to Claude;
`runner-model-catalog`'s `unavailableReason` became a label table, so `copilot` (and `pi`, which
was already wrong) no longer reports an OpenCode outage; and the provider-probe counts in three
test files are derived from `PROVIDER_IDS` instead of the literal `4`, so runner #6 does not
repeat this churn.

## Deviation from the plan — no CHANGELOG entry

Step 6.3 planned a CHANGELOG line. The repository does not work that way: `CHANGELOG.md` is
written at release time by `om-auto-update-changelog` from the PRs merged since the last release,
and **no** recent feature or fix PR touches it (`da9013f5`, `232df09f`, `497f2974`, `69929469`,
`85985202` — all zero). Adding one here would conflict with the release draft rather than help it.
The README backends row, which is the part of 6.3 that is this PR's to write, is done.

## Execution note

Every Step is `inline`: this session's harness instructions forbid dispatching subagents unless
the user asks, and the Steps share one seam and one mapper design, which is precisely the
tightly-coupled shape executor dispatch is documented not to help.
