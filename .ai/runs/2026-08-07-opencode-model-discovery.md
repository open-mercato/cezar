# Execution plan — OpenCode model discovery (issue #794)

Source doc: `.ai/specs/2026-07-21-codex-latest-model-discovery.md` (the Codex half of this
feature; its Q1 default deliberately deferred OpenCode — #794 is the follow-up that lifts it).

## Goal

Stop advertising stale hard-coded OpenCode model presets: discover the models from the host's
own OpenCode installation, exactly the way Codex models are already discovered, so the picker
shows what `opencode models` shows and never a model the configured provider does not have.

## Scope

- **Backend.** A new OpenCode adapter for the existing `RunnerModelCatalog` service, and the
  `/api/models` route widened from `runner=codex` to `runner=codex|opencode`.
- **Shared guard.** `KNOWN_PRESETS_BY_RUNNER.opencode` currently lists four stale ids; with
  discovery in place OpenCode has no static presets to guard.
- **Cockpit.** The model catalog query becomes runner-scoped (it is hard-wired to
  `?runner=codex` today), the OpenCode picker drops its four stale entries in favour of
  `auto` + discovered models, and the "cached / unavailable" status line names the right runner.
- **Docs.** README/`.env.example` touch-ups for whatever the new discovery path exposes.

### Non-goals

- Claude model discovery (no host-local authoritative catalog for it — unchanged presets).
- Persisting a catalog on disk, or any new user-authored configuration (zero-config rule).
- Changing how a picked model is sent, resolved, or validated at run time beyond the guard list.
- Reasoning-effort, provider auth, or OpenCode provider setup.

## Implementation Plan

### Phase 1 — Host-local OpenCode discovery

Mirror `src/core/codex-model-catalog.ts`: a single adapter module, boundary-validated, bounded,
and failing loudly enough for `RunnerModelCatalog` to degrade to `unavailable`/stale-cache.
Discovery shells the host CLI's own `opencode models` listing (the exact command the issue
reports as authoritative) rather than mirroring vendor catalog knowledge.

- 1.1 Add `src/core/opencode-model-catalog.ts` (`discoverOpencodeModels`) with unit tests:
  `provider/model` parsing, label/description derivation, ANSI/blank/garbage-line rejection,
  dedupe, size cap, timeout, non-zero exit, and empty output.
- 1.2 Register the adapter in `createApp` and widen the `/api/models` query schema to
  `codex | opencode`, keeping the 400 for every other runner; update `models-api.test.ts`.

### Phase 2 — Cross-runner preset guard

- 2.1 Empty `KNOWN_PRESETS_BY_RUNNER.opencode` (stale ids must not survive as a guard list) and
  cover the resulting `modelConflictsWithRunner` behaviour in the existing test.

### Phase 3 — Cockpit picker

- 3.1 Make the catalog query runner-scoped: `getRunnerModels(runner)` +
  `useRunnerModels(runner, enabled)`, one cache entry per runner.
- 3.2 Replace `MODELS_BY_RUNNER.opencode`'s stale entries with `auto` only, and teach
  `modelsForRunner` / `modelCatalogStatus` that discovery covers both Codex and OpenCode.
- 3.3 Update every call site (new-task, engine pills, follow-up engine, Settings → Agents,
  where the per-runner defaults need a catalog per runner) plus their tests.

### Phase 4 — Docs and gate

- 4.1 Document the OpenCode discovery path (README runner/env notes, `.env.example` if a new
  `CEZ_*` var is introduced).
- 4.2 Run the full validation gate: `npm run typecheck`, `npm test`, `npm run test:unit`,
  `npm run build`, `npm run test:package`.

## Risks

- **OpenCode CLI output format.** `opencode models` prints one `provider/model` per line today;
  a future format change would break parsing. Mitigated the same way Codex is: strict parsing,
  reject anything unrecognizable, and let `RunnerModelCatalog` degrade to `auto` + last-known
  cache. `auto` is always selectable, so a failed discovery never blocks a run.
- **Spawn cost.** One short-lived child per 5-minute cache window, coalesced across concurrent
  requests by the existing service — same profile as Codex discovery.
- **Custom/pinned ids.** Users who pinned one of the four removed presets keep it: custom ids
  are appended to the picker and the guard fails open on unknown ids.

## Progress

PR: #799

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Host-local OpenCode discovery

- [x] 1.1 Add the `discoverOpencodeModels` adapter with unit tests — 9e64421b
- [x] 1.2 Wire the adapter into `createApp` and widen the `/api/models` runner query — 2157bbc9

### Phase 2: Cross-runner preset guard

- [x] 2.1 Drop the stale OpenCode entries from `KNOWN_PRESETS_BY_RUNNER` — 9749d074

### Phase 3: Cockpit picker

- [x] 3.1 Make the model-catalog client/query runner-scoped — fba9d95a
- [x] 3.2 Reduce the OpenCode presets to `auto` and make the helpers discovery-aware — fba9d95a
- [x] 3.3 Update the picker call sites and their tests — fba9d95a

### Phase 4: Docs and gate

- [x] 4.1 Document the OpenCode discovery path — 41ff0910
- [x] 4.2 Run the full validation gate — (green: typecheck, test 5432, test:unit 36, build, test:package 12)
