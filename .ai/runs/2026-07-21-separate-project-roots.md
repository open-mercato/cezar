# Separate browse and checkout roots

## Goal

Give Add project browsing and GitHub checkout independent workspace roots, with zero-config defaults supplied by the environment and recursive directory creation when either setting is saved or checkout starts.

## Scope

- Add an optional `browseRoot` workspace setting beside the existing checkout `projectsDir` setting.
- Default `browseRoot` to `CEZ_BROWSE_ROOT` or `~/`, and `projectsDir` to `CEZ_PROJECTS_DIR` or `~/cezar/projects`.
- Use `browseRoot` for filesystem browsing in local and hosted modes while keeping `projectsDir` exclusively for clones.
- Expose and edit both values in Global settings → Projects.
- Validate and recursively create either configured root on save; retain checkout-time recursive creation.
- Update API types, documentation, `.env.example`, and regression coverage.

## Non-goals

- No migration is required: both workspace fields remain optional and old config files keep loading.
- No changes to project registry identity, checkout naming, or GitHub authentication.
- No automatic relocation of existing projects or checkouts.

## Source doc

`.ai/specs/2026-07-20-multi-project-workspace.md`

Related implementation: PR #569.

## Implementation Plan

### Phase 1: Workspace root contracts

1. Add environment-backed browse and checkout defaults to the tolerant workspace schema.
2. Route filesystem browsing through `browseRoot` and validate/create both roots through the workspace API.
3. Add server and workspace regression tests for defaults, overrides, isolation, and recursive creation.

### Phase 2: Cockpit and documentation

1. Expose both roots through API types and Global Projects settings with independent save flows.
2. Add UI regression coverage for independent browse-root and checkout-root edits.
3. Document the environment variables, defaults, and two-root behavior in `.env.example`, README, and the workspace spec.

## Risks

- Environment defaults must be read dynamically so tests and embedded callers can set `CEZ_*` values after module import.
- Existing persisted `projectsDir` values must remain authoritative and readable without migration.
- Hosted browsing must remain confined; it moves from the checkout root to the explicitly configured browse root, never to an unrestricted caller path.

## Progress

PR: #572

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

Review fix-forward: merged the latest `main` and resolved the browse-root conflicts — 36656d1.

### Phase 1: Workspace root contracts

- [x] 1.1 Add environment-backed workspace root defaults — 5db245d
- [x] 1.2 Route and validate independent roots with recursive creation — 5db245d
- [x] 1.3 Add backend regression coverage — 5db245d

### Phase 2: Cockpit and documentation

- [x] 2.1 Expose independent settings in API and UI — 41102ba
- [x] 2.2 Add cockpit regression coverage — 41102ba
- [x] 2.3 Document environment and zero-config behavior — 41102ba
