# Execution plan — CEZ_SINGLE_PROJECT mode

Source spec: `.ai/specs/2026-07-21-cez-single-project.md`

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Add the server and client single-project capability | done | 9c133b4 |
| 1 | 1.2 | Pin project listings to explicit boot identity | done | 7ccf390 |
| 2 | 2.1 | Refuse project-management HTTP surfaces before side effects | done | d7c9e6e |
| 2 | 2.2 | Refuse project CLI mutations in single-project mode | done | d9c694e |
| 3 | 3.1 | Hide the add-project menu under the capability | done | 91b0cf4 |
| 3 | 3.2 | Hide the global Projects settings section and route | done | 841567c |
| 3 | 3.3 | Prove one-project sidebar and composer collapse behavior | done | f97804e |
| 4 | 4.1 | Document the environment and compatibility contracts | done | cb05b7d |
| 4 | 4.2 | Add real-browser single-project workspace coverage | done | 7599a3f |
| 4 | 4.3 | Run and record the full repository validation gate | done | this commit |

## Goal

Ship `CEZ_SINGLE_PROJECT=1` as a strict, default-off capability that exposes only the launch project and disables every project add, checkout, browse, remove, and UI affordance without deleting registry state.

## Scope

- Capability resolution and health/client types.
- Boot-id-aware registry presentation.
- Server and CLI mutation refusal before side effects.
- Cockpit navigation/settings capability gating.
- Unit, API, UI, E2E, documentation, and compatibility coverage.

## Non-goals

- No config-file or runtime UI toggle.
- No registry deletion, migration, or URL grammar changes.
- No changes to boot registration or project-context routing.

## Risks

- Default multi-project behavior is protected and must remain unchanged.
- Checkout must be refused before clone/network/filesystem effects.
- Hidden registry rows must remain recoverable by unsetting the flag.

## External References

- VS Code multi-root/workspace docs: adopted the explicit single-folder versus multi-root presentation model; rejected saved workspace files.
- VS Code Workspace Trust docs: adopted defense at the capability boundary; no trust-prompt system added.
- Docker Compose profiles docs: adopted strict env opt-in semantics; no generalized profiles feature added.

## Implementation Plan

### Phase 1 — Capability and pinned reads

#### Step 1.1 — Add the server and client single-project capability

- Extend `src/server/capabilities.ts` and `web/app/src/api/types.ts` with strict `CEZ_SINGLE_PROJECT === '1'` resolution.
- Update capability and route-parity environment tests.

#### Step 1.2 — Pin project listings to explicit boot identity

- Add an explicit selector to `listProjects()` and thread boot identity from server and CLI callers.
- Test pinned reads, unchanged default reads, non-pruning, and boot registration.

### Phase 2 — Enforce mutations and CLI

#### Step 2.1 — Refuse project-management HTTP surfaces before side effects

- Gate project add, checkout, delete, and filesystem browse with stable `409 {error}` responses.
- Assert clone and registry side effects are not invoked; preserve default responses.

#### Step 2.2 — Refuse project CLI mutations in single-project mode

- Gate `projects add/remove`, update usage text, and preserve list/boot behavior.
- Add exit-code and no-mutation regression tests.

### Phase 3 — Remove multi-project UI

#### Step 3.1 — Hide the add-project menu under the capability

- Thread the health capability through `AppShellContainer` and omit `AddProjectMenu` when active.
- Add component regression tests.

#### Step 3.2 — Hide the global Projects settings section and route

- Make settings-section visibility capability-aware across navigation and route generation.
- Add registry/router tests and preserve every section by default.

#### Step 3.3 — Prove one-project sidebar and composer collapse behavior

- Add regression tests showing the pinned registry naturally yields flat sidebar navigation and no New Task project picker.

### Phase 4 — Docs and end-to-end verification

#### Step 4.1 — Document the environment and compatibility contracts

- Update `.env.example`, the README env table, and `BACKWARD_COMPATIBILITY.md` with strict activation, default compatibility, and non-destructive rollback.

#### Step 4.2 — Add real-browser single-project workspace coverage

- Extend the E2E registry fixture and project-groups scenario to seed two rows under `CEZ_SINGLE_PROJECT=1` and verify constrained UI surfaces.

#### Step 4.3 — Run and record the full repository validation gate

- Run configured validation commands in order, the full E2E suite, and the style/compatibility pass; record results in the final gate artifacts.
