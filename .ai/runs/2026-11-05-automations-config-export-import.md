# Execution plan — export and import automations and the cezar configuration

Issue: #1942
Source doc: `.ai/specs/2026-11-04-automations-and-config-export-import.md` (design-only spec PR #1943)

## Goal

Ship the spec's two phases: a versioned automations file (export / preview / import, all paused,
fresh ids, no runtime state) on the Automations page and in `cez automation export|import`, and a
configuration bundle in global Settings → Transfer that carries the portable workspace and
per-project configuration with no secret values, tracker credentials or machine paths.

## Scope

- `packages/contract/src/transfer.ts` — file formats, preview/import request and response schemas.
- `packages/cezar/src/automations/validate-input.ts` — create-route checks moved out of `server.ts`.
- `packages/cezar/src/transfer/` — `automations-file.ts`, `config-bundle.ts`, `import-engine` helpers.
- `AutomationStore.importMany`.
- Routes chained into the automations family and a workspace-level transfer family; BC §1/§2.
- CLI `cez automation export|import`.
- Cockpit: Automations page Export/Import dialog; Settings → Transfer section.

## Non-goals

Run history, NDJSON logs, worktrees, artifacts, attachments; live sync; network transfer; secret
values (names only); tracker connections; agent accounts, fallback chains, webhooks,
workflows/skills (travel through git); telemetry consent, `cezarId`, update channel; a whole-config
CLI.

## Implementation Plan

### Phase 1 — automations file

1. Contract schemas (`transfer.ts`) with strict envelope and a version gate.
2. Extract create-route checks into `automations/validate-input.ts`.
3. `transfer/automations-file.ts`: export builder + planner with `planDigest`.
4. `AutomationStore.importMany` (one lease, one persist, paused, fresh ids, replace resets state).
5. Routes `GET /automations/export`, `POST /automations/import/preview`, `POST /automations/import`; BC §2; parity tests.
6. CLI `export` / `import [--apply] [--on-conflict]`; BC §1; CLI tests.
7. Cockpit Export / Import on the Automations page; component tests; docs page.

### Phase 2 — configuration bundle

8. Allowlists for workspace and project config with an every-key-classified test; remote normalizer.
9. `transfer/config-bundle.ts` builder with reminders (names only) and a secrets-exclusion test.
10. Bundle planner: project matching by remote, mapping, key diffs, embedded automation rows.
11. Bundle apply: pre-images, per-project writes, workspace last, restore on failure, `localHandoff` gate.
12. Workspace routes (export / preview / import), parity + BC §2.
13. Settings → Transfer section, component tests, docs page.

## Risks

- `server.ts` validation move — covered by the existing automations route tests.
- Command-bearing rows (`task.steps[].command`, `requiredChecks`) — refused when not local, need
  explicit acknowledgement locally, sections unticked by default.
- Cross-file apply failure — pre-image restore; reported when a restore itself fails.

## Deviations from the spec

- Export does not yet run the credential-redaction patterns over free-text fields to warn per
  field (spec § Data Model, "Sensitive data"); no secret-store value can reach a file either way.
  Follow-up.
- `landing` is excluded from the project allowlist alongside the spec's exclusions: auto-landing
  is a grant made on the machine that pushes.
- A resolution may say `create` (not in the spec) so a non-colliding row can carry
  `acceptCommands`.
- Restore on a failed bundle apply puts back `config.json`, `ui-state.json`, `automations.json`,
  `automation-state.json` and `~/.cezar/config.json` byte for byte; the workspace
  `config.json.bak` snapshot is not rolled back.
- Skills repo entries are exported credential-free (`user:token@` stripped) and local/`file:`
  repos are dropped (review finding).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Automations file

- [x] 1.1 Contract schemas for the automations file — b83dcef7e
- [x] 1.2 Extract create-route checks into validate-input — cf99aa89b
- [x] 1.3 Automations file export builder and planner — 117410e28
- [x] 1.4 AutomationStore.importMany — 117410e28
- [x] 1.5 Automations export/preview/import routes — 044e49259
- [x] 1.6 CLI export and import verbs — 61e177f91
- [x] 1.7 Automations page Export and Import UI — 5bc829f9c, 41dbd3b80

### Phase 2: Configuration bundle

- [x] 2.1 Config allowlists and remote normalizer — be4c9c57d
- [x] 2.2 Config bundle builder with reminders — be4c9c57d
- [x] 2.3 Bundle planner — be4c9c57d
- [x] 2.4 Bundle apply with restore — be4c9c57d
- [x] 2.5 Workspace config-bundle routes — a2b07490c
- [x] 2.6 Settings Transfer section — 42bbd65a1, 57946f0a9
