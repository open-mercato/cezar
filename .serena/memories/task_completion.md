# Task Completion
Before any commit or PR, run in this order:
1. `npm run typecheck`
2. `npm test`
3. `npm run test:unit`
4. `npm run build`
5. `npm run test:package`

- `npm run test:package` requires the completed build.
- UI smoke is separate: `npm run test:e2e`. Exit 0 with `TEST_E2E_STATUS=skipped` is explicitly not a pass.
- For narrowly scoped uncommitted work, validation should remain proportional, but the full ordered gate is mandatory before commit/PR.
