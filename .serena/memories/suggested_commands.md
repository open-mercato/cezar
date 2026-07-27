# Suggested Commands
- Dev cockpit: `npm run dev`; offline mocked agents: `CEZ_DRY_RUN=1 npm run dev`.
- Server only: `npm run dev:server`; web only: `npm run dev:web`.
- Typecheck: `npm run typecheck`.
- Fast tests: `npm test`, then `npm run test:unit`.
- Build/package gate: `npm run build`; package E2E (requires build): `npm run test:package`.
- Real browser smoke: `npm run test:e2e`; stop reusable test env with `.ai/scripts/test-env-down.sh`.
- Repository search: prefer `rg` / `rg --files`.
