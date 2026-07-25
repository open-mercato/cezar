# Checkpoint 1 — Phase 1 detection and API

**Steps:** 1.1–1.3
**SHA range:** `5946e06..b111a8a`
**Touched areas:** update detection service, workspace-level cached/check APIs, web API contracts

## Checks

- ✅ `npm run typecheck`
- ✅ `npx vitest run src/skills-update.test.ts src/server/skills-update-api.test.ts` — 15 tests passed
- ✅ `git diff --check`
- ⏭️ Focused browser/integration verification skipped: this checkpoint exposes backend/API contracts only and does not change a user-facing surface.

## Notes

- The service fails closed for unknown provenance and unavailable tooling.
- Browser input is limited to a validated project id; executable names, arguments, sources, and paths are not accepted.
- Operation serialization and dead-process lock recovery were retained as explicit Step 1.3 hardening.

