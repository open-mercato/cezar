# Checkpoint 1 — Steps 1.1..3.1

- SHA range: `9c133b4..91b0cf4`
- Touched areas: capability types, registry presentation, server project-management routes, projects CLI, app shell.

## Checks

- ✅ `npm run typecheck`
- ⚠️ Initial combined Vitest run inherited `CEZ_REMOTE=1` from the executor environment, causing four expected-local checkout cases to return hosted-mode `400`; classified as environment contamination.
- ✅ `env -u CEZ_REMOTE npx vitest run src/server/capabilities.test.ts src/server/projects-api.test.ts src/server/checkout.test.ts src/server/fs-browse.test.ts src/workspace/projects.test.ts src/workspace/projects-cli.test.ts web/app/src/components/app-shell.test.tsx web/app/src/components/app-shell-container.test.tsx` — 8 files, 260 tests passed.
- ✅ `env -u CEZ_REMOTE CEZ_SINGLE_PROJECT=1 sh .ai/scripts/test-env-up.sh --force` — production build booted and health reported `singleProject: true`.
- ✅ `agent-browser` live shell smoke — after health resolution, interactive snapshot contained no Add project control.

## Artifacts

- `checkpoint-1-artifacts/browser-session.log`
- `checkpoint-1-artifacts/screenshot-single-project-shell.png`
