import { z } from 'zod';

/**
 * `GET /api/v1/star-count` — cezar's own GitHub star count, for the cockpit's ⭐ ask.
 *
 * Shaped like `server/github.ts`'s reads rather than like a number: `available: false` is the
 * ordinary answer, not an error. It is what offline, a rate-limited IP and `CEZ_NO_BANNER=1`
 * all produce, and the cockpit renders no chip at all for it — never an empty one, never a
 * spinner that outlives the request.
 *
 * `url` is unconditional. The ⭐ button must know where it points even when nobody can say how
 * many stars are on the other end.
 */
export const starCountSchema = z.object({
  available: z.boolean(),
  count: z.number().int().nonnegative().optional(),
  url: z.string(),
});
export type StarCountPayload = z.infer<typeof starCountSchema>;
