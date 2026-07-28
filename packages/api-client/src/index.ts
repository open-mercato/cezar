/**
 * `@open-mercato/cezar-api-client` — the one boundary between the cezar service and anything
 * that talks to it.
 *
 * Everything reachable from this barrel is Node-free by construction: no `node:*` import, no
 * `@types/node` in the package tsconfig, no dependency on the server's module graph beyond
 * `import type`. That is what lets the same package be bundled into the browser cockpit
 * (`packages/web`) and imported by the Node service (`packages/cezar`) without dragging either
 * runtime into the other — an invariant that used to be a comment on a hand-copied file and is
 * now structural.
 *
 * Contents:
 *   - `client.ts` — `createCezarClient<AppType>()`, the typed client over the versioned
 *     `/api/v1` surface. Types come from the server's own handlers; nothing is declared twice.
 *   - `dto/*` — the response and domain shapes of the families that are NOT chained yet, still
 *     hand-maintained and still guarded against the server's own types by
 *     `packages/cezar/src/server/api-types.test.ts`. This is the part designed to disappear:
 *     as each family is chained, its shapes are inferred and the declarations here are deleted.
 *   - `protocol/*` — the agent event vocabulary the server emits over SSE and the cockpit
 *     renders (a frozen surface, BACKWARD_COMPATIBILITY.md §2).
 *   - `utils/*` — pure helpers both sides need, notably the `/api` ↔ `/api/p/:projectId`
 *     scope prefixing.
 */

export * from './client.ts'
export * from './dto/types.ts'
export * from './protocol/ui-events.ts'
export * from './protocol/tool-display.ts'
export * from './utils/project-scope.ts'
