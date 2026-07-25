# Checkpoint 1 — Phase 1 (backend foundation)

Covers Steps 1.1–1.5 (`aae2f81`..`a9fa0a1`).

Touched areas: `src/agent-config/*` (new module), `src/paths.ts` (new), `src/server/server.ts` (3 additive routes), `package.json` (+`smol-toml`).

## Checks

| Check | Result |
|-------|--------|
| `npm run typecheck` (server + web) | ✅ pass |
| `npm test` (vitest — server + cockpit) | ✅ 118 files, 1959 tests pass |
| `npm run test:unit` (node:test) | ✅ 4 pass |
| New unit tests: catalog (9), paths (4), validate (8), files (10), agent-config-api (9) | ✅ 40 new tests pass |

Build (`npm run build`) and package (`npm run test:package`) are deferred to the final gate — no change to build inputs beyond a runtime dep, and the fast gate already covers the new code.

## Security property verified

The load-bearing invariant — `PUT /api/agent-config/:id` 409s in hosted mode (`CEZ_REMOTE=1`) for a **repo-local** id, not only a user-scope one — is asserted by `src/server/agent-config-api.test.ts` ("hosted mode: EVERY write 409s — including a repo-local settings file"). This is the regression guard for the hooks-based RCE hole the spec's by-mode gate closes.

## UI verification

None applicable — Phase 1 is backend only. Editor + Settings UI arrive in Phases 2–3; browser/e2e checks fire at their checkpoints.
