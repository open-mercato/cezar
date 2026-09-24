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
 *   - `@open-mercato/cezar-contract` — re-exported wholesale, so a consumer needs one import for
 *     both the client and the request/response schemas it speaks. The hand-written `dto/*` mirror
 *     this barrel used to carry is gone: every shape is inferred from a zod schema now, and
 *     `packages/cezar/src/server/contract-parity.*.test.ts` checks each schema against the route
 *     it describes in both directions.
 *   - `protocol/*` — the agent event vocabulary the server emits over SSE and the cockpit
 *     renders (a frozen surface, BACKWARD_COMPATIBILITY.md §2).
 *   - `utils/*` — pure helpers both sides need, notably the version prefixing and the
 *     `/api/v1` ↔ `/api/v1/p/:projectId` scope prefixing.
 */

export * from './client.ts'
export * from '@open-mercato/cezar-contract'
export * from './protocol/ui-events.ts'
export * from './protocol/tool-display.ts'
export * from './utils/project-scope.ts'
