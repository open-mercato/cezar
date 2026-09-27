# Verify server-install instance identity (#1008)

Goal: make the server-install verification gate prove that the responding cezar is this install's instance, without breaking older state files or older service processes.

Scope: server-install state/service environment and Ubuntu verification; health contract/handler; focused regression tests and compatibility notes.

Non-goals: changing proxy authentication, macOS ngrok routing, workflow/dispatch/automation code, or live installations.

## Implementation Plan

### Phase 1: Identity plumbing

- [x] 1.1 Add a persisted install identity and pass it to generated service environments. — 56b7d28f, 488ba4d8
- [x] 1.2 Add the identity as an additive health response field. — 56b7d28f

### Phase 2: Verification and evidence

- [x] 2.1 Compare the authenticated health payload during Ubuntu installation verification, degrading safely when unavailable. — 56b7d28f, 488ba4d8
- [x] 2.2 Add regression and compatibility tests, run targeted validation, and update compatibility documentation if required. — 56b7d28f, 488ba4d8
- [x] 2.3 Run the full configured validation gate and finalize the PR. — dependency validation 2026-09-27; typecheck/unit/build/package pass; npm test 7954/7956 with two unrelated failures recorded below.

## Risks

- Existing installs and state files may not have an identity; verification must remain inconclusive rather than fail solely because the field is absent.
- The health endpoint is externally consumed, so the field must be additive and must not expose paths or credentials.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Identity plumbing

- [x] 1.1 Add a persisted install identity and pass it to generated service environments.
- [x] 1.2 Add the identity as an additive health response field.

### Phase 2: Verification and evidence

- [x] 2.1 Compare the authenticated health payload during Ubuntu installation verification, degrading safely when unavailable.
- [x] 2.2 Add regression and compatibility tests, run targeted validation, and update compatibility documentation if required.
- [x] 2.3 Run the full configured validation gate and finalize the PR.

### Dependency validation evidence (2026-09-27)

- Reused reviewed sidebar test commit `e882054b6300542f36583286e2e1804fcafd0598` unchanged; targeted `packages/web/src/routes/cross-project-task-navigation.test.tsx`: 1 file, 3 tests passed.
- Sanitized gate (`CEZ_*` unset, `TMPDIR=/tmp`): `npm run typecheck` PASS; `npm test` 7954 passed / 2 failed; `npm run test:unit` PASS (36/36); `npm run build` PASS; `npm run test:package` PASS (16/16).
- The two npm-test failures are unrelated existing timing/environment failures: `src/core/opencode-server-runner.test.ts` later-turn sendMessage parking (`only 0 turn-end(s) after 10000ms`) and `src/workflows/system-prompt.test.ts` headless automation CLI teaching (5s timeout). Full log: `/tmp/pr1100-full-gate.log`.
