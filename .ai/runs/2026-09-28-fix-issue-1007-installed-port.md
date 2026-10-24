# Fix issue #1007: keep installed service on its assigned port

Landing note: this branch intentionally depends on the reviewed API-origin
startup changes from PR #1124. Land #1124 before #1128 (or land them together
in that order); the integrated startup path preserves host-aware probing for
interactive launches and strict configured-port behavior for CEZ_REMOTE=1.

## Goal

Make an installed service fail when its configured port is occupied instead of silently moving away from the proxy upstream, while preserving interactive auto-increment.

## Scope

- `packages/cezar/src/index.ts` startup port selection.
- A focused startup-port helper and regression tests.

## Non-goals

- No changes under `packages/cezar/src/server-install/`; existing units already carry the `CEZ_REMOTE=1` signal.
- No new environment variable, systemd rendering change, or proxy configuration change.
- No API-origin changes from the separate issue #1000 work.

## Implementation Plan

### Phase 1: Implement and prove behavior

- [x] 1.1 Extract strict-versus-interactive port selection and add occupied-port regression coverage.
- [x] 1.2 Wire `CEZ_REMOTE=1` into startup while preserving interactive fallback.

### Phase 2: Validate and publish

- [x] 2.1 Run targeted red-before-fix/green tests and the configured validation gate. — 0bd528c6
- [ ] 2.2 Run the authoritative review pass and finalize the PR.

## Risks

Strict mode intentionally leaves the real HTTP bind as the authority, so a race after selection still produces the operating system bind error rather than drift. Interactive launches retain the existing bounded fallback.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Implement and prove behavior

- [x] 1.1 Extract strict-versus-interactive port selection and add occupied-port regression coverage. — 4b2a6b84
- [x] 1.2 Wire `CEZ_REMOTE=1` into startup while preserving interactive fallback. — 4b2a6b84

### Phase 2: Validate and publish

- [x] 2.1 Run targeted red-before-fix/green tests and the configured validation gate. — 0bd528c6
- [ ] 2.2 Run the authoritative review pass and finalize the PR.

### Evidence

- Red proof: removing the strict early return made the installed-mode regression fail (`expected 45625, received 45626`).
- Green proof: `npm exec vitest run packages/cezar/src/startup-port.test.ts` passed 2 tests, including an actual occupied-port bind returning `EADDRINUSE`.
- Full gate: `npm run typecheck`, `npm test` (490 files / 8,292 tests), `npm run test:unit` (36), `npm run build`, and `npm run test:package` (17) all passed after `npm ci`.
