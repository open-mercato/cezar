import { z } from 'zod';

/**
 * SSE frame payloads — the only shapes in this contract that are NOT derived from a route.
 *
 * They are delivered over `text/event-stream` (`GET /api/v1/runs/:id/events`, `/api/v1/events`,
 * `/api/v1/workspace/events`), which Hono types as a string body, so `InferResponseType` sees a
 * stream of text and never the frame inside it. That makes the route-parity check in
 * `contract-parity*.test.ts` inapplicable here — but it is no reason to hand-write the TYPE.
 * These are zod like everything else, and `api-types.test.ts` still pins `RunEvent` against the
 * server's own declaration, which is the closest thing to a route that exists for it.
 */

/**
 * One line of a run transcript.
 *
 * Open by design: `type` is a plain string and unknown keys pass through, because the event
 * vocabulary is an APPEND-ONLY on-disk format (BACKWARD_COMPATIBILITY.md §7) that old NDJSON
 * recordings must keep replaying forever. Closing this schema would make a recording written by
 * a newer cezar unreadable by an older one — the opposite of what the format promises.
 */
export const runEventSchema = z.looseObject({
  seq: z.number(),
  ts: z.string(),
  stepId: z.string().optional(),
  type: z.string(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

/** Fixed protocol-level item count for one progressive transcript page. */
export const RUN_HISTORY_PAGE_ITEMS = 100;

export const runIdParamSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
});
export type RunIdParam = z.infer<typeof runIdParamSchema>;

/** Opaque, short-lived cursor returned by the history API. */
export const runHistoryCursorSchema = z.string().min(1).max(2_048);
export type RunHistoryCursor = z.infer<typeof runHistoryCursorSchema>;

/** Query accepted by the reverse-paged history endpoint. */
export const runHistoryQuerySchema = z.object({
  cursor: runHistoryCursorSchema.optional(),
});
export type RunHistoryQuery = z.infer<typeof runHistoryQuerySchema>;

/** Additive resume controls for the existing per-run SSE endpoint. */
export const runEventsQuerySchema = z.object({
  cursor: runHistoryCursorSchema.optional(),
  afterSeq: z.coerce.number().int().nonnegative().optional(),
});
export type RunEventsQuery = z.infer<typeof runEventsQuerySchema>;

/**
 * Persisted history retains the append-only event vocabulary. The required envelope stays
 * strict; additive payload keys remain open for newer protocol events, matching `RunEvent`.
 * `z.any()` is deliberate here: Hono recursively rewrites `unknown` to its JSON union in a
 * response type, making the schema wider than the route even though every value came from
 * `JSON.parse`; `any` is stable on both sides while the required keys remain exact.
 */
export const runHistoryEventSchema = z.object({
  seq: z.number(),
  ts: z.string(),
  stepId: z.string().optional(),
  type: z.string(),
}).catchall(z.any());
export type RunHistoryEvent = z.infer<typeof runHistoryEventSchema>;

export const runHistoryPageSchema = z.object({
  events: z.array(runHistoryEventSchema),
  itemCount: z.number().int().min(0).max(RUN_HISTORY_PAGE_ITEMS),
  olderCursor: runHistoryCursorSchema.optional(),
  newerCursor: runHistoryCursorSchema.optional(),
  liveCursor: runHistoryCursorSchema,
  asOfSeq: z.number().int().nonnegative(),
  hasOlder: z.boolean(),
});
export type RunHistoryPage = z.infer<typeof runHistoryPageSchema>;

export const runHistoryContextSchema = z.object({
  contextEvents: z.array(runHistoryEventSchema),
  asOfSeq: z.number().int().nonnegative(),
});
export type RunHistoryContext = z.infer<typeof runHistoryContextSchema>;

/**
 * One `checkout-progress` workspace frame (multi-project spec, step 4.3).
 *
 * `cloning` carries a single line of `git clone` output; `done` and `error` are terminal. The
 * clone dialog renders `error` VERBATIM — a clone fails for reasons (auth, network, a mistyped
 * repo) that only the server can name.
 */
export const checkoutProgressEventSchema = z.object({
  checkoutId: z.string().optional(),
  name: z.string(),
  phase: z.enum(['cloning', 'done', 'error']),
  line: z.string().optional(),
  error: z.string().optional(),
});
export type CheckoutProgressEvent = z.infer<typeof checkoutProgressEventSchema>;
