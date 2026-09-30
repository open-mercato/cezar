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

/** An uncaught cockpit error. Bounds match the worker's own limits; the client truncates. */
export const telemetryErrorInputSchema = z.object({
  type: z.string().max(128),
  message: z.string().max(2048),
  stack: z.string().max(16_384).optional(),
  handler: z.string().max(64).optional(),
});
export type TelemetryErrorInput = z.infer<typeof telemetryErrorInputSchema>;
