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

/**
 * `POST /api/v1/preview/gateway` — a task's app, reachable from a HOSTED cockpit (spec
 * `.ai/specs/2026-10-10-preview-gateway.md`).
 *
 * On a hosted cockpit `http://localhost:3000` means the viewer's machine, not the host the task
 * runs on. Where the operator named a pool of ports (`CEZ_PREVIEW_PORTS`), the server re-serves
 * the app on one of them — its own origin, never the cockpit's — and the Browser column frames
 * that instead.
 *
 * `target` is an ORIGIN, as for the design proxy. `parentOrigin` is the cockpit as the viewer's
 * browser reaches it: the gateway is answered at the same scheme and hostname on its own port.
 */
export const previewGatewayRequestSchema = z.object({
  target: z.string().min(1).max(2048),
  parentOrigin: z.string().min(1).max(512),
});
export type PreviewGatewayRequest = z.infer<typeof previewGatewayRequestSchema>;

/**
 * `origin` has no trailing slash and no path. The gateway answers 401 to a browser that holds
 * neither its cookie nor a ticket, so the FIRST load of a page carries `ticket` in the query
 * parameter named by `ticketParam`; the gateway spends it, sets the cookie and redirects to the
 * same address without it. A ticket opens one page load and expires within a minute — ask again
 * before every load, never store one.
 */
export const previewGatewayResponseSchema = z.object({
  origin: z.string(),
  ticket: z.string(),
  ticketParam: z.string(),
});
export type PreviewGatewayResponse = z.infer<typeof previewGatewayResponseSchema>;
