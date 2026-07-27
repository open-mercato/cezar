import type { createApp } from './server.js';

/**
 * The service's HTTP contract, as a type.
 *
 * This is the whole boundary between the cezar service and a typed consumer: Hono infers an
 * app's endpoint table from the app's *type*, and `hc<AppType>` turns that table into a client
 * whose paths, request bodies and response shapes are checked at compile time. No hand-written
 * mirror, no schema to author twice — the routes ARE the contract.
 *
 * Only routes registered through a **chained** builder appear here. `server.ts` still registers
 * most families as loose statements (whose return value, and with it the accumulated route
 * type, is discarded), so this type currently covers the chained families mounted under
 * `/api/v1` — health, agent-config and workflows. Each family that gets chained widens this
 * type automatically; nothing here needs updating.
 *
 * Type-only by construction: importing this module pulls in no runtime code (`import type`
 * disappears at build), which is what lets a browser bundle consume it without dragging
 * `node:*` in.
 */
export type AppType = ReturnType<typeof createApp>;
