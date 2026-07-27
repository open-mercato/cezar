import type { Hono } from 'hono';

/**
 * `app.request()` with the `Host` header that every real client sends.
 *
 * The `/api/*` request-origin guard (#426) rejects a request with no `Host`,
 * because at that trust boundary "absent" must mean "unproven", not "probably
 * local" — see `isLoopbackHostHeader`. Production never produces a Host-less
 * request (HTTP/1.1 requires the header and Node's parser enforces it), but
 * Hono's in-process test harness builds a bare `Request` that carries none, so
 * suites exercising the API have to supply it explicitly.
 *
 * Tests that assert on the guard itself should call `app.request()` directly —
 * they need to control (or omit) `Host` themselves.
 */
export async function apiRequest(app: Hono, input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('host')) headers.set('host', '127.0.0.1:4321');
  return app.request(input, { ...init, headers });
}
