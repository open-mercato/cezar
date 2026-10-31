# AI Gateways implementation

Date: 2026-10-28
Branch: feat/ai-gateways-impl
Source doc: .ai/specs/2026-10-28-app-spec-ai-gateways.md
Spec PR: #1730 (design-only; this run does not commit that document)
Engine: om-auto-create-pr (steps: 15, --loop: no)

## Goal

An operator can configure AI gateways once, pick a per-agent default, and start tasks on that connection, and a sandbox can apply the same configuration from a JSON file or stdin. The gateway list starts empty. Nothing selects another account when the chosen gateway is missing, disabled, or unreadable.

## Scope

- Contract, workspace store, secret vault slots, and HTTP routes for gateway records.
- General Settings → AI Gateways, plus Default AI gateway on each agent.
- Task resolution and launch checks for new tasks, continue, recovery, dispatch, naming, and terminal.
- CLI group `ai-gateways`, including `apply --file` for a path or stdin.
- Docs and the backward-compatibility inventory for the new routes.

## Non-goals

- An inference proxy, failover, cost routing, or a new secret vault.
- A `llm-providers` command, route, or request alias. The reference branch is evidence, not a tree to copy.
- Assigning agent defaults from `apply`, deleting gateways omitted from a document, or calling a provider during apply.
- A new `CEZ_*` variable, a default model, or native-login migration.
- Landing commits on `feat/ai-gateways` (#1730).

## Assumptions

- Dispatching this implementation is the authorization to build the behavior in the spec, including the operating rules the spec marks as proposed: seed stays off, ON means available rather than selected, native remains the unset default, tasks can override, there is no silent fallback, bindings stay stable, and disable does not kill a running process.
- `agentDefaults` in workspace config stays the existing runner/model default. Gateway choices use a new optional field so the two cannot overwrite each other.
- Cursor stays native-only. Claude requires Anthropic Messages. Codex requires OpenAI Responses. Other supported runners pick one documented protocol and the task pins it.
- There is no default gateway. A fresh workspace lists no providers. An untouched copy of the former disabled keyless OpenRouter row is removed on the next list; a row with a key or any changed field stays. Catalog filtering drops a model only when it explicitly declares no tool support.

## Risks

- `mergeWriteWorkspaceConfig` gains a cross-process lock. Boot on a read-only home must still degrade; only explicit gateway writes report the lock error.
- Secret and metadata live in different files. A failed key write leaves a pending record that launch and catalog reads reject until the operator saves the key again or removes the gateway.
- Launch paths are numerous. A check that only covers the composer would still let a headless start bypass the resolver.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Gateway contract and shared persistence

- [x] 1.1 Add AI gateway Zod contract (record, auth, responses, apply manifest/result, command spelling helpers) — 84396db5cdeb2a1f320de8b28c1c715b818a0dd4
- [x] 1.2 Persist gateways in workspace config with one-time OpenRouter seed and SecretStore keys — 0c5a206b6c485788d2121c87b579f4bf2ff6bcf4
- [x] 1.3 Add cross-process workspace-file lock and gateway coordinator — 9abe5d8be24e0696cd06da3c3778f209b3eab576
- [x] 1.4 Add pendingWrite checkpoint, secret barrier, and coherent snapshots on every mutation — 5bc966ee30ae05a40c0888cb61842d57e4f85c2c
- [x] 1.5 Add chained HTTP routes for list/create/update/enable/remove with contract parity — 05f264969f438a9a8f075972a9864e70f70c696e

### Phase 2: Settings UI

- [x] 2.1 Add General Settings → AI Gateways list with ON/OFF, add, edit, remove — 9db10f9b3aafd61dc99268afe1d097572745f1f0
- [x] 2.2 Cover editor edge states: blank key preserve, pending repair, errors, keyboard — 9db10f9b3aafd61dc99268afe1d097572745f1f0

### Phase 3: Defaults and task binding

- [x] 3.1 Add per-runner default gateway choice and the shared resolver — 2bccc428251a0eb0f9780bf6d7c91b7e93368c8d
- [ ] 3.2 Persist resolved bindings and reject unsafe launches before any agent process
- [ ] 3.3 Show Default AI gateway in agent settings and the New Task / Continue choices
- [ ] 3.4 Keep continue, recovery, dispatch, naming and terminal on the saved binding

### Phase 4: CLI apply

- [ ] 4.1 Add `ai-gateways` list/add/update/remove without an `llm-providers` alias
- [ ] 4.2 Apply a validated JSON document sequentially with partial-progress retry
- [ ] 4.3 Accept `--file` from a path or stdin and document the command

### Phase 5: Release checks

- [ ] 5.1 Point generated handoffs at `ai-gateways` and record the HTTP surface in BACKWARD_COMPATIBILITY.md
