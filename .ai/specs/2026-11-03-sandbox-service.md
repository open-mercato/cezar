# Sandbox service — run a task in a microsandbox or Daytona sandbox

Status: proposed · 2026-11-03 · FR #1925

## 📝 TLDR

**Who needs it:** anyone whose task needs a clean machine. Today every cezar task runs in a git worktree **on the host**, so it shares the host's Docker containers, databases, global toolchains and caches. A task that has to prove something works on a fresh machine cannot be trusted there.

**Proposal (future behavior):**
- A **Sandbox service** with provider **accounts** (local [microsandbox](https://github.com/superradcompany/microsandbox) microVMs, and [Daytona](https://www.daytona.io) cloud sandboxes).
- User-defined **sandbox types** (image, vCPU, memory, disk, network, lifetime, setup script).
- A **per-task picker** in the composer. The agent CLI and the workflow's check steps then run inside a fresh sandbox that has the task's worktree attached.

**Default:** "This computer", so nothing changes until a user picks a sandbox type.

## Resolved assumptions (autonomous defaults)

Written by `om-auto-write-spec` without a human in the loop. Each row is reversible. Rows marked ⚠ gate the merge.

| # | Question | Applied default | Why |
|---|---|---|---|
| Q1 | Does the whole agent run inside the sandbox, or does it stay on the host with only its tools proxied in? | **The whole agent CLI runs inside the sandbox.** cezar keeps parsing its stdout on the host. | Both providers publish first-party recipes for exactly this (microsandbox `docs/how-to/agents/claude-code.mdx`; Daytona's Claude Code guide). Proxying tools would need a per-backend tool shim for 10 runners. ⚠ NEEDS HUMAN CONFIRMATION |
| Q2 | How do agent credentials reach the sandbox? | **Only the selected account's API credential, injected per run.** On microsandbox it uses `secretEnv` (host-scoped substitution, so the real key never enters the VM). On Daytona it is an env var. A host agent config dir (`~/.claude`, `~/.codex`) is **never** mounted. | Mounting a whole agent home would hand the VM every session, project history and OAuth refresh token. A subscription (OAuth-only) login therefore works only once that backend gets a token path (see Edge cases). ⚠ NEEDS HUMAN CONFIRMATION |
| Q3 | Default-on, or behind a `CEZ_*` opt-in flag? | **The surface is available by default; nothing runs or is contacted until the user acts.** `msb` discovery is a local `PATH` probe. Daytona is contacted only after an account is added. A sandbox boots only for a task where one was explicitly picked. `CEZ_SANDBOXES=0` hides the whole feature. | Same shape as dispatch and automations: the per-task pick is the opt-in. AGENTS.md § Zero config still requires an owner-ratified exception for any default-on surface that can incur cost. ⚠ NEEDS HUMAN CONFIRMATION |
| Q4 | One spec or two (accounts and types vs. per-task selection; microsandbox vs. Daytona)? | **One spec, shipped in phases.** microsandbox ships first, Daytona second. | Accounts without selection deliver nothing. Daytona reuses the whole seam, so it goes in a later phase rather than a separate spec. |
| Q5 | Are sandbox types per workspace or per project? | **Per workspace** (`~/.cezar/sandboxes.json`), plus a per-project **default type** selection. | Mirrors agent accounts (`selections[repoRoot]`). |
| Q6 | Sandbox lifetime? | **One sandbox per run.** It is created when the run starts and **stopped, not deleted,** when the run parks or reaches review. Continue restarts it. It is **deleted** when the run lands or is archived, or when its worktree is pruned. | Continue must find the installed toolchain again, and a stopped sandbox costs (almost) nothing. |
| Q7 | Preview and port forwarding into the sandbox? | **Deferred** (non-goal for v1). | Overlaps #1877 (proxied Preview). It belongs in a follow-up once both exist. |

## 📝 Problem Statement

Motivating run: an Open Mercato task said *"test all the ways to instantiate and set up Open Mercato described in the README, create a report, and fix warnings and errors at root cause"*. The host already had the project's database and services running in Docker. A setup path that silently reused the host's Postgres passed on the host and would fail on a new contributor's laptop. The user had to tell the agent by hand to install and drive microsandbox inside its own task. That made the agent's job harder, and the run's evidence could not be reproduced.

The same need comes up for:
- "does the README work on a clean Ubuntu?" style QA;
- reproducing user-reported install bugs;
- running untrusted PR code;
- heavy builds that should not compete with the cockpit for host RAM (see `Resources`).

## 📝 Proposed Solution

```mermaid
flowchart LR
  C[Composer: sandbox pill<br/><i>new</i>] -->|POST /runs sandbox.typeId| M[RunManager.execute<br/><i>existing</i>]
  M --> W[worktree on host<br/><i>existing</i>]
  M --> S[SandboxService.acquire<br/><i>new</i>]
  S -->|msb SDK| MS[(microsandbox VM)]
  S -->|@daytonaio/sdk| DT[(Daytona sandbox)]
  M --> RF[createRunner + sandbox exec hook<br/><i>new in runner-factory</i>]
  RF -->|exec stream stdout/stderr| MS
  RF --> DT
  W <-->|bind mount / sync| MS
  W <-->|bundle up · patch down| DT
```

**Takeaway:** the worktree stays the source of truth on the host. Review, diff, landing and PRs keep working untouched, and only *where the processes execute* changes.

- **microsandbox (local).** The worktree directory is **bind-mounted** read-write at `/workspace`. Agent edits land directly in the host worktree, so the existing diff, review and lease machinery sees them live.
- **Daytona (cloud).**
  - At start, cezar uploads a `git bundle` of the worktree branch plus any uncommitted state, then checks it out at `/workspace`.
  - At every turn end and at stop, it pulls back `git diff --binary <start>..` plus the new commits as a bundle and applies them to the host worktree.
  - The host worktree is read-only to cezar while a Daytona turn runs, using the existing agent lease.

**Alternatives rejected:**
- *Docker containers.* They share the host kernel and the user's Docker daemon, which is exactly the contamination we are escaping.
- *Proxying only tools* (Bash/Edit) into the VM. That needs per-backend shims, and Codex, OpenCode and Cursor don't honor `allowedTools` (#430).
- *Running cezar itself in the sandbox.* That loses the cockpit and multi-task scheduling.

**Market check:**
- microsandbox's own agent recipes and Daytona's Claude Code guide both run the agent CLI inside the VM and stream its output. That is the model adopted here.
- Both providers converge on host-side secret substitution: `secretEnv` in microsandbox, `secrets` in Daytona. We use it wherever the provider has it, instead of exporting raw keys.

## 📝 Architecture

| Piece | Where | New / existing |
|---|---|---|
| Store: accounts, types, per-project selection | `packages/cezar/src/workspace/sandboxes.ts`, file `cezarHomeDir()/sandboxes.json` | new, cloned from `workspace/agent-accounts.ts` (loose stored schema, per-entry salvage, `mergeWrite…` atomic 0600, never cached) |
| API keys | `sealManaged('sandbox', accountId, key)` / `openManaged` (`workspace/secrets.ts:143`) | existing primitive, same as tracker connections |
| Provider seam | `packages/cezar/src/sandbox/provider.ts` defines the `SandboxProvider` interface: `detect()`, `test(account)`, `create(type, ctx)`, `start`, `stop`, `remove`, `exec(cmd, args, {cwd, env, stdin}) → ChildProcess-like`, `syncIn`, `syncOut`, `stats()` | new |
| Providers | `sandbox/microsandbox.ts` (the `microsandbox` npm SDK, an **optional** dependency, falling back to the `msb` CLI), `sandbox/daytona.ts` (`@daytonaio/sdk`, optional) | new. A missing package or binary means `detect()` reports `{available:false, reason}` and the provider is shown as unavailable, never a boot failure |
| Service | `sandbox/service.ts`: acquire, release, a sweep that deletes orphan `cez-*` sandboxes at boot (mirrors worktree pruning) | new |
| Spawn hook | `core/runner-factory.ts` `createRunner(backend, {sandbox})`. `guardWorkingDirectory` already wraps every `startSession`/`run` and sees `spec.cwd`. A `SandboxExec` passed in `AgentRunSpec` replaces `nodeSpawn` in `disclaimedCommand` callers | existing seam, extended |
| Check steps | `workflows/run.ts` `runCheckStep` (~9549) uses the same `SandboxExec` when the run has a sandbox | existing, extended |
| Agent bootstrap | `sandbox/bootstrap.ts` installs git and the run's agent CLI pinned to the **host-detected version** (`backend-detect.ts`) the first time a type is used, then snapshots the image (`msb snap` / Daytona `createSnapshot`) keyed by `(type, runner, version)` | new |
| Capability | `capabilities().sandboxes` in `server/capabilities.ts` plus `/api/v1/health`; off when `CEZ_SANDBOXES=0` or in remote mode | new flag |

**Runner coverage in v1:**
- **Covered:** the stdio CLIs that go through `disclaimedCommand`: claude, pi, cursor, kimi, antigravity, and Codex app-server over stdio.
- **Not covered yet:** the ACP runners (gemini, copilot, junie), which spawn through their own transport, and OpenCode's local HTTP server. These are **disabled in the picker with a reason** until their transport takes a `SandboxExec`. A separate Phase 4 covers them.

## 📝 Data Model

`~/.cezar/sandboxes.json` (own file, never a key in `config.json`, same reasoning as agent accounts):

```jsonc
{
  "version": 1,
  "accounts": [
    // microsandbox "local" is DISCOVERED and never stored (like the default agent account)
    { "id": "acme-eu", "provider": "daytona", "label": "Acme work org",
      "apiUrl": "https://app.daytona.io/api", "target": "eu", "organizationId": null, "addedAt": "…" }
  ],
  "types": [
    { "id": "ubuntu-16g", "label": "Ubuntu · 4 vCPU · 16 GB", "account": "local-microsandbox",
      "image": "ubuntu:24.04", "cpus": 4, "memoryMiB": 16384, "diskGiB": 40,
      "network": { "mode": "public" },               // none | agent-api | public | allow-list(+domains/cidrs)
      "idleStopMinutes": 30, "maxLifetimeMinutes": 480,
      "setupScript": "apt-get update && …", "env": { "NODE_ENV": "development" },
      "secrets": ["DATABASE_URL"] },                 // workspace secret names, resolved like check-step secrets
    { "id": "cloud-large-eu", "account": "acme-eu", "snapshot": "daytona-large",
      "cpus": 4, "memoryMiB": 8192, "diskGiB": 10, "autoStopMinutes": 15, "autoArchiveMinutes": 1440 }
  ],
  "selections": { "/path/to/open-mercato": "ubuntu-16g" }   // per-project default type
}
```

**Validation and provider fields:**
- Fields are validated per provider. Fields a provider lacks are rejected, never silently dropped.
- microsandbox: `image` (OCI), `cpus`, `memoryMiB`, `diskGiB` (`--root-disk`), `network` (mapped to `NetworkPolicy`), `idleStopMinutes` (`idleTimeout`), `maxLifetimeMinutes` (`maxDuration`).
- Daytona: `image` **xor** `snapshot`. Resources apply only to image-based creates. `autoStop`/`autoArchive` map to the SDK intervals. `network` maps to `networkBlockAll`/`networkAllowList`/`domainAllowList`. `autoDeleteInterval` is not exposed; cezar owns deletion (Q6).

**RunRecord gains an optional `sandbox`** (old files still parse):
`{ typeId, provider, accountId, sandboxId, state: 'creating'|'running'|'stopped'|'removed'|'failed', resources: {cpus, memoryMiB, diskGiB, image}, error? }`
The resources are a **snapshot** taken at launch, so editing the type later does not rewrite history.

**Sensitive data:**
- API keys live only in the sealed vault and are never echoed back, only shown as `••••last4`.
- `sandboxes.json` holds no secrets.
- `.ai/cezar/` gains nothing new beyond the RunRecord field, so there is no `ensureDataGitignore` change.

## 📝 API Contracts

All schemas go in `packages/contract/src/sandboxes.ts` (zod, types inferred). The routes are **workspace-level** (single mount, like `/workspace/agent-profiles`), chained into one family builder and validated with the middleware trio. Every mutating route returns **409** unless `capabilities().sandboxes && localHandoff`. That matches the agent-config write gate: a sandbox can run arbitrary commands with the user's credentials.

| Route | Body → Response |
|---|---|
| `GET /api/v1/workspace/sandboxes` | → `{ providers: [{id, available, version?, reason?}], accounts: [...redacted], types: [...], selections }` (no network: status comes from the last `test`) |
| `POST /api/v1/workspace/sandboxes/accounts` | `{provider:'daytona', label, apiKey, apiUrl?, target?, organizationId?}` → account |
| `PATCH` / `DELETE /api/v1/workspace/sandboxes/accounts/:id` | Deleting is refused (409) while a type references the account |
| `POST /api/v1/workspace/sandboxes/accounts/:id/test` | → `{ ok, organization?, error? }` (one cheap authenticated call) |
| `POST` / `PATCH` / `DELETE /api/v1/workspace/sandboxes/types[/:id]` | Type CRUD |
| `POST /api/v1/workspace/sandboxes/types/:id/boot-test` | Boots, runs `uname -a && git --version`, removes, → `{ ok, bootMs, log }` |
| `PUT /api/v1/workspace/sandboxes/selection` | `{ repoRoot, typeId | null }` |
| `POST /api/v1/p/:projectId/runs` (existing) | Gains `sandbox?: { typeId: string } \| null`. Absent means the project selection; `null` means "This computer", explicitly (same tri-state as `agentProfile`) |
| `POST /api/v1/p/:projectId/runs/:id/sandbox/stop` | Stops the run's sandbox without failing the run |

Every new route is added to the BACKWARD_COMPATIBILITY.md §2 inventory. `contract-parity` tests cover both directions.

## 📝 UI/UX

**Current state** (captured from a dry-run cockpit):

| Today | |
|---|---|
| ![Agent accounts](assets/sandbox-service/current-01-agent-accounts.png) | ![Composer](assets/sandbox-service/current-02-composer.png) |

**Proposed** (illustrative static mockups, not an accepted prototype; the HTML sources sit beside them):

1. **Settings → Sandboxes** (global section, registered after *Agent accounts* in `routes/settings/registry.tsx`).
   - Accounts list: the discovered microsandbox row, plus Daytona rows with a status pill and a **Test** button.
   - Sandbox types list, showing a resource summary line and a "default for &lt;project&gt;" badge.
   - ![Settings › Sandboxes](assets/sandbox-service/mockup-01-settings-sandboxes.png)
2. **Add account dialog.** Two provider cards. Daytona asks for name, API key, region, an optional org ID and the API URL. **Test connection** must succeed before **Add account** is enabled.
   - ![Add account](assets/sandbox-service/mockup-02-add-account.png)
3. **Sandbox type editor.**
   - It shows only the fields the chosen account's provider supports. Sliders are capped by the provider's limits: host cores and RAM for microsandbox, and the org limit reported by a failed create for Daytona (we do not hard-code tier limits).
   - Network is a segmented control.
   - There is a setup script, plus env and workspace-secret pickers.
   - **Boot a test sandbox** runs the boot-test route.
   - ![Type editor](assets/sandbox-service/mockup-03-preset-editor.png)
4. **Composer pill** (`PickerPill`, in the HOW group next to `WorktreeToggle`).
   - Its options are *This computer* plus the types grouped by account. A billed provider is tagged `billed`.
   - The heading subtitle changes to "Runs in a fresh … VM".
   - Picking a sandbox forces **Worktree on**: the worktree toggle locks, with a hint.
   - Unsupported runners disable the sandbox options with a reason.
   - ![Composer picker](assets/sandbox-service/mockup-04-composer-picker.png)
5. **Run header chip and popover** (`run-header.tsx` `MetaRow`).
   - The chip shows provider · type · live state.
   - The popover shows the sandbox id, image plus agent version, resources, workspace mapping, live usage (`msb metrics` / Daytona is omitted), and the stop policy, with **Open shell** / **Stop sandbox** / **Logs**.
   - Sandbox lifecycle lines are emitted into the event feed as `system` UiEvents.
   - ![Run header](assets/sandbox-service/mockup-05-run-header.png)

Automations and `cez task create` gain the same `sandbox` field (`--sandbox <typeId|none>`). A dispatched child inherits its parent's sandbox type unless overridden.

**Accessibility:** the picker reuses `PickerPill`'s radio-menu semantics. Status pills always pair the color with text.

## 📝 Edge Cases & Failure Scenarios

| Scenario | What the user sees |
|---|---|
| `msb` missing, or unsupported host (Intel Mac, Linux without `/dev/kvm`) | The microsandbox row reads "Unavailable: needs Apple Silicon, or Linux with KVM", with the install hint. Its types are disabled in the picker. Nothing else changes. |
| Daytona key revoked or 401 | The account pill shows "Key rejected (401)". A run launched against it fails at `creating` with the one-line error "Daytona rejected the API key for ‘Acme work org’". The worktree is kept. |
| Requested resources exceed the org or host limit | Provisioning fails before the agent starts. The provider's message is surfaced verbatim and trimmed (e.g. Daytona's per-sandbox 4 vCPU/8 GiB default cap). The run ends `failed`, with **Retry on this computer** offered. |
| The image lacks Node/npm for the agent CLI | Bootstrap installs a static Node into `/opt/cez-node`. If that fails, the error names the image and suggests `node:24-bookworm` |
| Subscription-only agent login (Claude Pro/Max OAuth, ChatGPT Codex login), no API key | cezar passes a long-lived token when the backend has one (`CLAUDE_CODE_OAUTH_TOKEN`). Otherwise the picker disables sandboxes for that account with "needs an API key or token login". Host home dirs are never mounted (Q2). |
| The cezar process dies mid-run | At boot the sweep lists `cez-*` sandboxes. Those whose run is `running` are reattached by the existing restart recovery (microsandbox `Sandbox.get`, Daytona `get`). Orphans are stopped, then removed after 24 h. |
| The run is cancelled | The exec is killed and the sandbox is stopped, as with any cancel. |
| Network `none` | The agent cannot reach its model API. The editor offers *Agent API only*, an allow-list derived from the runner (e.g. `api.anthropic.com`) plus the git remote host. |
| Daytona sync conflict (the host worktree changed during a turn) | Impossible by construction: the agent lease blocks host edits. If the patch fails to apply anyway, the run parks with the patch saved to `.ai/cezar/tmp/<id>/sandbox.patch` and a visible error. |
| The user deletes a type in use | Running runs keep their snapshot. The picker drops the type, and a project selection pointing at it falls back to "This computer" with a toast. |

## 📝 Risks & Impact Review

- **Contract and state:** the `RunRecord.sandbox`, `createRunInput.sandbox` and `capabilities.sandboxes` fields are all optional and additive. `sandboxes.json` is a new file, so deleting it resets to zero-config.
- **Security:** a sandbox narrows host exposure but widens credential handling.
  - Writes are gated to the local cockpit.
  - Keys are sealed, and host-scoped secret substitution is used where available.
  - No home-dir mounts.
  - `--net agent-api` is offered as the hardening default for untrusted code.
- **Cost:** Daytona bills by usage.
  - Mitigations: the `billed` tag, auto-stop on park, delete on land/archive, and the boot sweep.
  - cezar does **not** show Daytona spend in v1 (no verified balance API).
- **Rollback:** `CEZ_SANDBOXES=0` hides everything. Runs that already have `sandbox` keep rendering the chip read-only.
- **Dependencies:** `microsandbox` and `@daytonaio/sdk` are **optional** dependencies, loaded with dynamic `import()`. The published tarball must install and boot without them (`test:package`).
- **Upstream:** the Daytona OSS repo was archived in 2026-06 and its SDK now lives in `daytona/clients`. Pin a version range and wrap it behind the provider seam.

## 📋 Phasing

1. **Phase 1: store, settings, microsandbox detection.** You can configure accounts and types, and Boot test works. Tasks are unaffected.
2. **Phase 2: run a task in a microsandbox.** Picker, spawn hook, check steps, header chip, lifecycle, recovery sweep.
3. **Phase 3: Daytona provider.** Account and test, type fields, bundle/patch sync, `billed` UX.
4. **Phase 4: remaining runners and surfaces.** ACP and OpenCode transports, automations, `cez task create --sandbox`, dispatch inheritance.

## 📋 Implementation Plan

**Phase 1**
1. `packages/contract/src/sandboxes.ts`: account, type, listing and selection schemas. Re-export from the api-client.
2. `workspace/sandboxes.ts` store, plus `sandboxesPath()` in `paths.ts`, with unit tests: salvage, atomic write, an absent file means defaults.
3. `sandbox/provider.ts` interface and `sandbox/microsandbox.ts` `detect()`/`test()`, honoring `CEZ_DRY_RUN` (mock provider) and the `CEZ_SANDBOXES` flag. Update `.env.example` and the `docs/reference.md` env table.
4. Workspace routes (list, accounts, types, selection) in one chained family. Parity, typed-bodies and route-inventory tests.
5. Settings → Sandboxes section, add-account dialog and type editor, with component tests (absent provider, 409 when not local).
6. `boot-test` route plus the button, end to end against the dry-run mock.

**Phase 2**
7. `createRunInput.sandbox` and `RunRecord.sandbox`, with the tri-state resolution helper (mirrors `selectProfile`).
8. `sandbox/service.ts` acquire/release plus the boot sweep. Lifecycle tied to run states (Q6), with a unit test for each transition.
9. A `SandboxExec` in `AgentRunSpec`, consumed by `disclaimedCommand` callers and `runCheckStep`. Populate it in **both** `execute` and `runContinuation` through one helper, with a regression test on Continue (AGENTS.md § construction sites).
10. `sandbox/bootstrap.ts`: agent CLI install pinned to the host version, plus a snapshot cache.
11. Composer pill, worktree lock, run-header chip and popover, and `system` events. Unit tests, plus one e2e smoke in dry-run.

**Phase 3**
12. `sandbox/daytona.ts`: create/start/stop/delete, session exec with streamed logs, `git bundle` sync-in and patch sync-out, with golden-fixture tests over recorded SDK responses.
13. Daytona account dialog fields, the `billed` tag and error mapping.

**Phase 4**
14. A `SandboxExec` for the ACP transports and the OpenCode server (port forwarding through the provider).
15. The `sandbox` field in automations, `cez task create --sandbox`, and dispatch inheritance.

## 🔍 Review notes

- Scope cohesion: one capability (choose where a task executes). Daytona is phased, not split, because it adds no new surface beyond a second provider class.
- Canonical mechanisms reused: the agent-accounts store pattern, `sealManaged`, `PickerPill`, the chained route families, `capabilities()`, and restart recovery.
- Not verified: microsandbox Windows support was not exercised, and Daytona per-second pricing and live tier limits were not confirmed. Mockups are illustrative statics, not behavior.
