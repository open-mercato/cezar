# CEZ_SINGLE_PROJECT mode

## TLDR

Add an opt-in `CEZ_SINGLE_PROJECT=1` boot mode that exposes only the launch project and refuses every add, checkout, browse, or remove path. The default multi-project workspace remains byte-for-byte compatible, while users who prefer one project per server regain a deliberately constrained cockpit without deleting registry state.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why | Confirm? |
|---|---|---|---|---|
| Q1 | Should project listing be pinned by changing the workspace API globally or by passing the boot project into the read path? | Pass the boot project explicitly into `listProjects`; do not read environment or process state in the workspace module. | This preserves testability and keeps boot identity at the server/CLI boundary. | ok |
| Q2 | Should folder browsing remain available for unrelated future uses in single-project mode? | Refuse `GET /api/fs/browse` while the mode is active. | Today it is the add-project picker surface; refusing it minimizes exposed local-filesystem capability and matches the issue scope. | ok |
| Q3 | Should the mode modify or prune extra projects already stored in the registry? | No; filter them only at read time and restore them when the flag is unset. | Non-destructive behavior is the most reversible choice and preserves the workspace registry contract. | ok |

## Problem Statement

The multi-project workspace makes one cezar server discover and operate across a user's registered repositories. Some users intentionally run one server per repository and need a hard capability boundary that prevents accidentally exposing or adding another project while preserving cezar's zero-config boot behavior.

## Proposed Solution

Introduce one strict, default-off environment flag and thread its resolved capability through the existing registry, API, CLI, and cockpit boundaries. Boot registration remains intact; all narrowing happens at callers and read presentation.

Alternatives rejected:

- A workspace config key would violate the zero-config rule by creating a user-authored setting for a boot topology choice.
- Filtering inside `registerProject()` or `shouldRegisterProject()` would suppress the launch project's self-healing registration.
- Deleting hidden registry rows would make the mode destructive and would prevent a clean rollback by unsetting the flag.

## Architecture

`resolveCapabilities(process.env, bindHost)` remains the canonical env parser and gains `singleProject: env.CEZ_SINGLE_PROJECT === '1'`. The value is returned by `/api/health`, mirrored in the client type, and used as the single UI capability signal.

The server already owns boot identity through `resolveBootProject()`. It passes the resolved boot project to the workspace read path when single-project mode is active; `listProjects()` accepts an optional boot-project selector and probes only that matching registry row. `registerProject()` and `shouldRegisterProject()` remain unchanged so launch registration still creates or refreshes the boot row. Stored extra rows are never mutated.

Write-side enforcement sits at existing chokepoints:

- `registerFolder()` refuses both local registration and post-clone registration before filesystem or registry mutation.
- `POST /api/projects/checkout` refuses before starting a clone, so the server never incurs network or disk work that cannot be registered.
- `DELETE /api/projects/:projectId` refuses before context disposal or registry mutation.
- `GET /api/fs/browse` refuses before resolving or reading a requested path.
- `cezar projects add/remove` refuse before validating paths or touching the registry; `list` uses the same pinned read behavior when invoked from a server launch context, while standalone CLI listing remains a registry inspection unless the flag and launch root are available.

The cockpit derives `singleProject` once in `AppShellContainer` and passes it to presentation boundaries. The add-project menu is absent, and the static settings registry becomes capability-aware so the global Projects section is absent from navigation and routing. Existing `projects.length > 1` gates naturally collapse project groups and the new-task project picker after the registry response is pinned. URL grammar does not change: `/p/<boot>/*`, `/p/default/*`, and legacy flat redirects remain intact; hidden project ids resolve as unknown.

## Data Model

No persisted schema changes. `~/.cezar/config.json` retains every existing project row byte-for-byte. `CEZ_SINGLE_PROJECT` is process input only and is never written to workspace or per-repository state.

The public health capability grows additively:

```ts
interface Capabilities {
  localHandoff: boolean
  followups: boolean
  singleProject: boolean
}
```

Default is `false`; only the exact string `"1"` enables it.

## API Contracts

With the flag unset, every existing route and payload remains unchanged.

With `CEZ_SINGLE_PROJECT=1`:

| Surface | Contract |
|---|---|
| `GET /api/health` | `capabilities.singleProject === true`; `projects` contains only the boot project. |
| `GET /api/projects` | `200` with exactly the boot registry entry, its existing `bootProject`, and unchanged `projectsDir`. Extra stored rows are omitted. |
| `POST /api/projects` | `409 { "error": "single-project mode is enabled; adding projects is disabled" }`. |
| `POST /api/projects/checkout` | The same `409` before clone work begins. |
| `DELETE /api/projects/:projectId` | `409 { "error": "single-project mode is enabled; removing projects is disabled" }`. |
| `GET /api/fs/browse` | `409 { "error": "single-project mode is enabled; folder browsing is disabled" }`. |

All mutating routes keep their zod boundary validation convention. The capability gate should run after request-origin protection but before filesystem, network, context, or registry work. No route is removed, no new route is added, and project-scoped route parity is unchanged.

CLI contract:

- `cezar projects add …` and `cezar projects remove …` print a concise single-project refusal to stderr and return exit code `1`.
- Usage text mentions that these mutations are unavailable under `CEZ_SINGLE_PROJECT=1`.
- Boot registration still runs before serving, and listing presents the launch project only when the mode supplies boot identity.

## UI/UX

This mode intentionally removes choices instead of adding a settings control:

- The sidebar has no Add project button or menu.
- Global Settings has no Projects navigation item or route entry.
- With the pinned one-row registry, the sidebar uses its existing flat single-project navigation and New Task omits its project picker.
- Direct navigation to a hidden project renders the existing unknown-project state; direct mutation requests receive the server's `409` response.
- No runtime toggle exists. Operators set the env flag before boot and restart, consistent with other `CEZ_*` capability flags.

Accessibility is preserved because controls are not rendered rather than visually disabled. Existing keyboard order therefore closes over the remaining controls without dead focus targets.

Illustrative proposed-state mockup: [single-project shell](assets/cez-single-project/mockup-01-single-project-shell.png). Current-state references: [sidebar](assets/cez-single-project/current-01-sidebar.png) and [Projects settings](assets/cez-single-project/current-02-projects-settings.png).

## Edge Cases & Failure Scenarios

| Scenario | Behavior |
|---|---|
| Registry contains many projects before enabling the flag | Only the boot row is returned; no row is deleted or rewritten. |
| Flag is later unset | All stored projects immediately reappear on the next boot/request. |
| Boot row is absent because the home is read-only or registration degraded | Health and projects list degrade to the existing empty/default behavior; boot context still serves the launch directory. The mode never makes registry existence required. |
| `CEZ_SINGLE_PROJECT` is `true`, `yes`, or any value other than `1` | Mode remains off. |
| Checkout request arrives while mode is active | Refused before `gh`, network, progress events, or target-directory creation. |
| Existing hidden project has running work in another process | Its stored row and files are untouched; this process does not instantiate or expose it. |
| Deep link targets a hidden project | Existing route gate returns/renders unknown project; no special redirect leaks its identity. |
| API client ignores the capability | Server-side `409` remains authoritative. |

## Risks & Impact Review

- **Protected API surfaces:** `/api/health`, `/api/projects`, `/api/projects/checkout`, `/api/fs/browse`, project removal, and the registry contract are explicitly protected by `BACKWARD_COMPATIBILITY.md`. The mode is additive and opt-in; default behavior needs regression assertions, not only flag-on tests.
- **Boot identity coupling:** filtering by root spelling risks symlink mismatch. Resolve the already allocated boot project id and filter by id, reusing the server's canonical boot-identity helper.
- **Partial gating:** hiding UI without refusing endpoints would not be a capability boundary. Every write/browse entry point is tested independently.
- **Checkout side effects:** gating only in `registerFolder()` would clone before refusing. The checkout route needs an early guard in addition to the shared registration chokepoint.
- **Rollback:** unset the flag and restart. No migration, cleanup, or registry repair is required.
- **Documentation:** adding the env var must update `.env.example` in the same commit and the README environment table because `.env.example` is the repository's env contract.

## Research — market anchors

- VS Code treats a single opened folder as a workspace and only creates a multi-root workspace through explicit add/open-multiple gestures. That supports cezar's choice to make the one-root presentation genuinely omit multi-root affordances instead of leaving misleading disabled controls: https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces
- VS Code Workspace Trust re-evaluates trust when another folder is added. Cezar's stricter opt-in mode prevents the analogous exposure expansion entirely at the server boundary, rather than relying on UI intent: https://code.visualstudio.com/docs/editing/workspaces/workspace-trust
- Docker Compose profiles use an explicit environment/CLI opt-in while leaving the default model intact. The useful precedent is strict activation with no persisted migration, not Compose's broader profile feature set: https://docs.docker.com/compose/how-tos/profiles/

What cezar deliberately skips: per-project toggles, runtime switching, a second registry, or a saved workspace file. One env bit narrows existing behavior and is reversible by restart.

## Phasing

- **Phase 1 — Capability and pinned reads.** Add the env capability, type mirror, and boot-id-aware project listing while preserving boot registration.
- **Phase 2 — Enforce mutations and CLI.** Refuse all HTTP, browse, checkout, add, and remove entry points before side effects.
- **Phase 3 — Remove multi-project UI.** Hide project creation/settings surfaces and prove existing one-row collapse behavior.
- **Phase 4 — Compatibility docs and end-to-end verification.** Document the env contract and verify the real cockpit under a seeded multi-project registry.

## Implementation Plan

### Phase 1 — Capability and pinned reads

1.1 Extend `src/server/capabilities.ts` and `web/app/src/api/types.ts` with `singleProject`; document strict `CEZ_SINGLE_PROJECT === '1'` resolution. Add flag-on, flag-off, and non-`1` unit cases in `src/server/capabilities.test.ts`; add `CEZ_SINGLE_PROJECT` to route-parity env save/restore. *Verification:* server/client API type exactness and capability tests pass.

1.2 Change `listProjects()` to accept an optional boot project id (or an equally explicit selector) and probe only the matching row. Thread the selector from `resolveBootProject()` into health and `GET /api/projects`; do not change registration functions. Add workspace tests proving pinned reads, no pruning, and successful boot registration. *Verification:* default calls list all rows; flagged server calls list one.

### Phase 2 — Enforce mutations and CLI

2.1 Add a shared server refusal helper/message and gate `registerFolder()`, checkout before clone, project deletion, and filesystem browse before side effects. Add `src/server/projects-api.test.ts` cases for all four `409`s plus one-row listing with seeded extras; assert the checkout double was not called and default-mode responses remain unchanged. *Verification:* API tests and route parity pass.

2.2 Gate `addCommand()` and `removeCommand()` using the strict env predicate or injected env for tests; update `USAGE`. Keep list/boot registration behavior coherent with Phase 1. Add CLI tests for refusal, exit code, no registry mutation, and unchanged default operation. *Verification:* `src/workspace/projects-cli.test.ts` passes.

### Phase 3 — Remove multi-project UI

3.1 Read `health.data?.capabilities.singleProject` in `AppShellContainer`, pass it to `AppShell`, and omit `AddProjectMenu` when true. Add an app-shell regression test that the menu is absent while normal navigation remains. *Verification:* component unit tests pass in both modes.

3.2 Make `visibleSettingsSections(scope, capabilities?)` or its owning registry capability-aware and hide the global `projects` section in single-project mode across side navigation and route generation. Preserve all sections by default. Add settings registry/router tests. *Verification:* no unreachable Projects link or route is rendered under the capability.

3.3 Add regression coverage that a pinned one-project response keeps the existing flat sidebar and removes the New Task project pill without bespoke gates. *Verification:* app-shell/new-task tests pass.

### Phase 4 — Compatibility docs and end-to-end verification

4.1 Add `CEZ_SINGLE_PROJECT` to `.env.example` near the workspace registry notes and to the README env table. Add a dated `BACKWARD_COMPATIBILITY.md` entry in the #471 style: what intentionally narrows under the flag, what remains unchanged by default, and why no deprecation alias is needed. *Verification:* documentation names the exact strict value and non-destructive rollback.

4.2 Extend `web/app/e2e/project-groups.e2e.ts` and its workspace-registry seeding helper: boot with `CEZ_SINGLE_PROJECT=1` and two stored projects, then prove flat navigation, no Add project control, no Projects settings pane, and no project picker. Capture screenshots as QA evidence. *Verification:* `npm run test:e2e` reports `TEST_E2E_STATUS=passed`; skipped is recorded as not verified.

4.3 Run the full repository gate in order: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`, followed by the UI smoke suite. Confirm `.env.example`, README, server and client capability types, and API behavior changed together. *Verification:* every command passes and default behavior remains covered.
