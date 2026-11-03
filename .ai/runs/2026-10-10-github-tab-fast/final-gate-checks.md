# Final gate — GitHub tab under one second

**Timestamp:** 2026-10-10T20:34:00Z

## Required validation commands

- PASS — `npm run typecheck` (all contract, client, server, and web typechecks)
- PARTIAL — `npm test`: 530 files passed, 10 files failed with 13 environment/base regressions outside the GitHub surface. The two changed GitHub suites pass independently.
- PASS — `npm run test:unit` (42/42)
- PASS — `npm run build` (server, web, package check)
- PASS — `npm run test:package` (17/17)

## Focused feature evidence

- PASS — `npm test -- --run packages/cezar/src/server/forge/github.test.ts packages/cezar/src/server/contract-parity.github.test.ts packages/web/src/routes/github/github.test.tsx` (333/333)
- PASS — `npm test -- --run packages/web/src/api/queries.test.tsx packages/web/src/routes/github/github.test.tsx` (189/189)
- PASS — UI route verification under jsdom; browser screenshot skipped because no `.ai/qa/test-env.json` or browser-provider descriptor is available.
- PASS — design-system/style review by inspection; no new design-system violations identified.

## Integration limitation

The `om-integration-tests` companion workflow cannot attach to a configured live browser environment in this worktree, so no browser screenshot artifact is attached. This is recorded rather than treated as a product failure.

## Known unrelated failures

The full test run's failures are existing environment/base-branch issues: tests that assume a temporary directory is outside the repository, an automation timing expectation, a missing mocked `startVariants`, and task-environment variable expectations. None exercises the changed GitHub list/detail path.
