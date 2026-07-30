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
