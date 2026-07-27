# Conventions
- Zero-config is load-bearing: discover or default capabilities; absent dependencies/read-only state must degrade quietly to a smaller cockpit.
- Exposure/cost-widening features are opt-in behind `CEZ_*`, off by default. Any env-var addition/rename/removal/default change must update `.env.example` and the README env table when user-facing.
- Validate external/file/HTTP boundaries with Zod. New persisted `RunRecord` fields remain optional; corrupt state degrades rather than crashing.
- HTTP mutating routes use `safeParse` and `{ error }` with 400/404/409. Never weaken the global origin guard or widen CORS beyond `/api/health`.
- Backend-specific types stop at the `AgentRunner` seam; read `AGENT_PROTOCOL.md` before runner changes.
- Git helpers normally degrade instead of throwing; task worktrees use `.ai/cezar/worktrees/<runId>` and `cez/<id8>`.
- Preserve byte-exact agent config files; vendor path/precedence knowledge belongs only in `src/agent-config/catalog.ts`.
- Avoid hand-editing generated bundled skills under `vendor/skills/`.
