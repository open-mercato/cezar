import { z } from 'zod';

/**
 * Anonymous cockpit telemetry (`/api/v1/telemetry/*`). The telemetry worker sends no CORS
 * headers, so the browser reports through the local server, which forwards only when telemetry
 * is on (opt-out, `CEZ_TELEMETRY=0`). Both routes answer `204` with no body.
 */

/** The closed set of cockpit pages that are counted: `/dashboard`, the global `/tasks` (All
 *  tasks), and any settings page. Forwarded as `<page>_view`. */
export const telemetryPageSchema = z.enum(['dashboard', 'tasks', 'settings']);
export type TelemetryPage = z.infer<typeof telemetryPageSchema>;

export const telemetryPageInputSchema = z.object({ page: telemetryPageSchema });
export type TelemetryPageInput = z.infer<typeof telemetryPageInputSchema>;

/** One flat wide-event field: the worker keeps strings ≤1024, numbers, booleans and null. */
export const telemetryContextValueSchema = z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]);

/**
 * An uncaught cockpit error, reported as ONE wide event (https://loggingsucks.com/): everything
 * known about the page, the session and the build rides in `context` as flat dotted keys
 * (`page.route`, `build.entry`, `client.engine`…), so a report answers "what happened to this
 * user" without a second search. The server relay adds its own half (server build, uptime,
 * whether the page's bundle is still the one being served) before forwarding. Bounds match the
 * worker's own limits; the client truncates.
 */
export const telemetryErrorInputSchema = z.object({
  type: z.string().max(128),
  message: z.string().max(2048),
  stack: z.string().max(16_384).optional(),
  handler: z.string().max(64).optional(),
  /** Stable machine-readable code, e.g. `chunk_load_failed`. */
  code: z.string().max(128).optional(),
  /** Custom grouping key, for errors whose stack/message differ per engine. */
  fingerprint: z.string().max(128).optional(),
  context: z
    .record(z.string().max(64), telemetryContextValueSchema)
    .refine((ctx) => Object.keys(ctx).length <= 32, { message: 'at most 32 context keys' })
    .optional(),
});
export type TelemetryErrorInput = z.infer<typeof telemetryErrorInputSchema>;
