# Checkpoint 1 — Steps 1.1..1.5

**When:** 2026-07-20T12:47:00Z
**Steps covered:** 1.1 (`edf42f6`) … 1.5 (`757b66e`)
**Touched areas:** `src/paths.ts`, `src/workspace/{config,projects,migrations}.ts` (+tests), `src/index.ts` boot wiring, `test/e2e/package-cli.test.ts`, `.ai/scripts/test-env-up.sh`, `.gitignore`

## Checks

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | PASS (server + web) |
| Unit tests (touched areas) | `npx vitest run src/workspace/ src/paths.test.ts` | PASS — 48/48 (4 files) |
| Build + pack sanity | `npm run build` | PASS — check:pack ok, 287 files, 73 under web/dist |
| Package e2e (real CLI boot) | `npm run test:package` | PASS — 8/8, incl. new assertions: boot migrates workspace (`schemaVersion ≥ 1`) and registers the fixture repo under the pinned `CEZ_HOME` |

## UI verification

Skipped — no Step in this window touched UI (server/CLI/workspace modules only). Cockpit phases begin at Phase 3.

## Notes

- PLAN.md Commit cells for 1.1–1.5 reconciled to the pushed SHAs in this checkpoint commit (the per-step amend flow records a lag-by-one SHA; reconciled here).
- `CEZ_HOME` is now pinned in both the package-e2e harness and `.ai/scripts/test-env-up.sh`, so no test path touches the developer's real `~/.cezar`.
- No artifacts produced (no browser session this window) — no `checkpoint-1-artifacts/`.
