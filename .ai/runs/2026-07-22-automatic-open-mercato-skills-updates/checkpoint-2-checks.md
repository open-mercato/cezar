# Checkpoint 2 — Phase 2 preference and mutation

**Steps:** 2.1–2.3
**SHA range:** `65759ef..28df27b`
**Touched areas:** workspace config/API, update execution and scheduling, apply route, documentation

## Checks

- ✅ `npm run typecheck`
- ✅ `npx vitest run src/skills-update.test.ts src/server/skills-update-api.test.ts src/server/workspace-api.test.ts src/workspace/config.test.ts` — 62 tests passed
- ✅ `git diff --check`
- ⏭️ Focused browser/integration verification skipped: this checkpoint adds backend/config contracts and web client hooks but no rendered UI.

## Notes

- Stored preference absence remains meaningful; effective precedence is explicit value, then valid environment value, then enabled default.
- Update execution passes only proven, explicit Open Mercato skill names and reports partial scope outcomes.
- Manual apply validates a project id only and maps contention to a 409 with safe state.

