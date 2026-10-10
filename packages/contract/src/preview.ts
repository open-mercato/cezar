import { z } from 'zod';

/**
 * `POST /api/v1/preview/design-proxy` — Design Mode for the workspace Browser column (spec
 * `.ai/specs/2026-10-09-design-mode.md`).
 *
 * A framed dev server is cross-origin to the cockpit, so the cockpit cannot see which element
 * the user points at. The server answers with a second loopback origin that re-serves the same
 * app with a small picker script injected; the Browser column frames THAT, and the picker
 * reports the clicked element back over `postMessage`.
 *
 * `target` is an ORIGIN, never a page: the proxy mirrors a whole dev server, and the column
 * appends the path itself. `parentOrigin` is the cockpit's own origin — the one window the
 * picker will talk to and listen to. Both must be loopback; the route refuses anything else.
 */
export const designProxyRequestSchema = z.object({
  target: z.string().min(1).max(2048),
  parentOrigin: z.string().min(1).max(512),
});
export type DesignProxyRequest = z.infer<typeof designProxyRequestSchema>;

/** `origin` has no trailing slash and no path, so `origin + pathname` is a loadable address. */
export const designProxyResponseSchema = z.object({
  origin: z.string(),
});
export type DesignProxyResponse = z.infer<typeof designProxyResponseSchema>;
