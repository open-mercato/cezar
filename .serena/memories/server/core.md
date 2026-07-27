# Server and CLI
- CLI entry: `src/index.ts`; no CLI framework. `serve` is default; headless `run` treats review as terminal success; `init` never overwrites.
- Hono server/API: `src/server/server.ts`; binds loopback only. Scoped project routes are mounted once and aliased under legacy unprefixed and `/api/p/:projectId/` paths; route parity tests enforce identical behavior.
- Workspace registry: `src/paths.ts`, `src/workspace/*`; always derive home through `cezarHomeDir()`. Config schemas use optional fields with catches/passthrough and per-entry salvage; writes use atomic `mergeWriteWorkspaceConfig`.
- Runs store: `src/runs/store.ts`; atomic/debounced JSON index plus append-only NDJSON event files; queued prompt folding at dequeue is read-only.
- Agent runners: read `AGENT_PROTOCOL.md`, then `src/core/agent-runner.ts` and runner factory/implementations.
- Workflows: `src/workflows/types.ts`, `load.ts`, `run.ts`; agent step XOR check step, and retries target earlier steps only.
