# Checkpoint 4 — Phase 6: per-agent regrouping (steps 6.1–6.5)

- **Steps covered:** 6.1..6.5 (`4210235..68bf4b3` — spec, descriptor table, section rework, MCP fold-in, docs)
- **Touched areas:** `web/app/src/routes/settings/` (agent-config-section, registry, deleted mcp-section, tests), `.ai/specs/`, README, AGENTS.md. No server/API change.

| Check | Result |
|---|---|
| `npm run typecheck` (server + web) | pass |
| `npm test` (vitest) | pass — 1987 tests |
| `npm run test:unit` | pass — 4 |
| `npm run build` + `check:pack` | pass — 223 files packed |
| `npm run test:package` | pass |
| Focused: `vitest run web/app/src/routes/settings web/app/src/routes.test.tsx` | pass — 73 tests (8 section tests incl. selector/switch/shared-files/userMcp, 5 descriptor tests) |

UI browser verification: deferred to the PR-level `om-auto-verify-pr-ui` pass that follows this checkpoint (dev env boots via `.ai/scripts/`); unit/component coverage above exercises the new selector, pane-swap, shared-file membership and read-only behaviors in jsdom.
