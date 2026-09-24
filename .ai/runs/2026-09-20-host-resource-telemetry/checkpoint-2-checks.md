# Checkpoint 2 — cockpit complete (Steps 2.1–2.4), UI verified

**Fired:** 2026-09-20T00:55:00Z · spec completion · branch `feat/host-resource-telemetry`

## Targeted validation at the checkpoint

| Command | Result |
|---------|--------|
| `host-usage.test.ts` (contract + sampler, 11) | ✅ pass |
| `host-topic.test.ts` (4) | ✅ pass |
| `workspace-api.test.ts`, `route-parity.test.ts`, `bc-route-inventory.test.ts` | ✅ pass |
| `api/host-usage.test.tsx` (5), `machine-card.test.tsx` (3), `resources-section.test.tsx` (10) | ✅ pass |
| `design-guardian.test.ts` (8) | ✅ pass |
| `npm run typecheck` | ✅ pass |

The full gate (see `final-gate-checks.md`) doubles as this checkpoint's completion gate; the two
files that fail in `src/routes/settings/` (`appearance`, `settings` shell) fail identically on
untouched `origin/main` (Node v26 localStorage/jsdom), verified before this change landed.

## Browser / UI evidence

The `om-auto-qa-pr` pass drives Settings → Resources in a real browser against the production
build and posts the screenshots + pass/fail report to PR #1036 (`📸 UI verification` comment):
the Machine card live state (CPU value + bar + sparkline, memory bar, load row, freshness line,
host-level caveat) and the narrow viewport.
