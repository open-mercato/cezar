# Checkpoint 2 — Steps 1.6..1.7 (Phase 1 close)

**When:** 2026-07-20T13:12:00Z
**Steps covered:** 1.6 (`941e7a7`) … 1.7 (`8d881f3`)
**Touched areas:** `src/server/server.ts` (`GET /api/projects`, additive health fields), `src/index.ts` (bootProjectId plumbing), `src/server/projects-api.test.ts`, `BACKWARD_COMPATIBILITY.md` (§2 route inventory + new §9 workspace state files/migrations contract)

## Checks

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | PASS |
| Unit tests (touched) | `npx vitest run src/server/projects-api.test.ts src/workspace/` | PASS — 48/48 |
| Full vitest suite (phase close) | `env -u CEZ_REMOTE npm test` | PASS — 2843/2843 (171 files) |

## UI verification

Skipped — no UI touched (server + docs only). Phase 3 begins cockpit work.

## Notes

- The dev shell exports `CEZ_REMOTE=1` (session runs under a remote cockpit); full-suite runs use `env -u CEZ_REMOTE` to match CI. One pre-existing test (`request-validation.test.ts` open-in 400) fails only with ambient `CEZ_REMOTE=1`, on base `main` too — not caused by this branch.
- Health regression test asserts `projects[].root` never appears in the payload (#431).
- Phase 1 complete: an upgraded user boots with identical behavior; registry + health additions are invisible until a second project exists.
