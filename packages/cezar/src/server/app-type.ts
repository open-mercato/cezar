import type { createApp } from './server.ts';

/**
 * The service's HTTP contract, as a type.
 *
 * This is the whole boundary between the cezar service and a typed consumer: Hono infers an
 * app's endpoint table from the app's *type*, and `hc<AppType>` turns that table into a client
 * whose paths, request bodies and response shapes are checked at compile time. No hand-written
 * mirror, no schema to author twice — the routes ARE the contract.
 *
 * Only routes registered through a **chained** builder appear here — a loose `api.get(…)`
 * statement discards its return value and with it the accumulated route type. Every family in
 * `server.ts` is now chained and mounted into the versioned table, so this type covers the whole
 * `/api/v1` surface; `versioned-surface.test.ts` fails on any route that escapes it. A new route
 * added as a link in its family's chain widens this type automatically — nothing here needs
 * updating, and nothing here should be hand-written.
 *
 * Type-only by construction: importing this module pulls in no runtime code (`import type`
 * disappears at build), which is what lets a browser bundle consume it without dragging
 * `node:*` in.
 */
export type AppType = ReturnType<typeof createApp>;
