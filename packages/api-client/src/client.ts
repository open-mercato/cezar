import { hc } from 'hono/client'
import type { Hono } from 'hono'
import type { ClientRequestOptions } from 'hono/client'

/**
 * The typed HTTP client for a cezar service.
 *
 * `hc` reuses the SERVER's own route types, so the contract is the code: a wrong path, a wrong
 * request body or a misread response shape is a compile error, and nothing has to be mirrored
 * by hand. The app type comes from the service package
 * (`import type { AppType } from '@open-mercato/cezar/app-type'`) and is supplied by the
 * caller rather than imported here on purpose — this package must stay installable, and
 * usable at runtime, without the server package present:
 *
 * ```ts
 * import type { AppType } from '@open-mercato/cezar/app-type'
 * const cez = createCezarClient<AppType>({ baseUrl: 'http://127.0.0.1:4321' })
 * const res = await cez.api.v1['agent-config'].$get()
 * ```
 *
 * Only the versioned surface (`/api/v1/*`) is typed. The legacy `/api/*` paths stay frozen for
 * the bookmarklets and scripts that already call them (BACKWARD_COMPATIBILITY.md §2) and are
 * deliberately not part of what a new consumer is invited to build on.
 */
export interface CezarClientOptions {
  /**
   * Where the service lives — `https://cezar.example.com`, or a path prefix behind a proxy.
   *
   * Defaults to `''` (same origin), which is the cockpit's own case: the service serves the
   * bundle and owns `/api/*` under the same authority, so a root-relative request is correct
   * and needs no configuration.
   */
  baseUrl?: string
  /**
   * Bearer token, attached as `Authorization: Bearer <token>` when set.
   *
   * Unset is the normal local case: a loopback cockpit has no auth to satisfy. It is the
   * opt-in remote-access mode that issues tokens.
   */
  token?: string
  /** Extra headers merged into every request (after the auth header, so they can override). */
  headers?: Record<string, string>
  /** Custom fetch — for tests (dispatch straight into a Hono app) or a wrapped transport. */
  fetch?: ClientRequestOptions['fetch']
}

/**
 * Build a typed client for a cezar service.
 *
 * `T` is the service's `AppType`. It is left unconstrained so that a JS consumer, or a
 * consumer that does not want the server package installed, still gets a working (untyped)
 * client instead of a type error.
 */
export function createCezarClient<
  // The three `any`s are Hono's own constraint on `hc` (Env, Schema, BasePath) — narrowing
  // them here would reject perfectly good app types. `Hono` as the default is the untyped
  // fallback: `createCezarClient()` with no type argument still returns a working client.
  T extends Hono<any, any, any> = Hono,
>(options: CezarClientOptions = {}): ReturnType<typeof hc<T>> {
  const { baseUrl = '', token, headers, fetch } = options
  return hc<T>(baseUrl, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(fetch ? { fetch } : {}),
  })
}
