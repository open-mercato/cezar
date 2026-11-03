# Checkpoint 1 — Phase 1 server and contract foundation

**Steps:** 1.1–1.4
**Commits:** `26bf35c9`..`bb75ed0f`
**Touched areas:** contract schemas, forge list/detail fetch, GitHub route query validation, compatibility docs, forge tests.

## Checks

- PASS — `npm run typecheck:contract`
- PASS — `npm test -- --run packages/cezar/src/server/forge/github.test.ts` (200 tests)
- PASS — `git diff --check`
- BLOCKED/BASELINE — `npm run typecheck:server` reaches unrelated current-`origin/main` contract/build drift (`repoTreeSchema`, branding, pending-ask fields, Gemini runner types); the new GitHub source introduced no remaining TypeScript diagnostic in that run.
- SKIP — browser/UI verification; Phase 1 only changed server contracts and forge code, with UI work scheduled for Phase 2.

No browser artifacts were produced for this server-only checkpoint.
