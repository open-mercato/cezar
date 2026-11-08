/**
 * The HTTP side of `cez mcp` (#1109): a typed client for a running cockpit's `/api/v1`.
 *
 * `hc<AppType>` straight from `hono/client` rather than `createCezarClient` — `packages/cezar` must
 * not import the private api-client at runtime (AGENTS.md), and the wrapper is five lines of this.
 * `AppType` is a type-only import, so nothing from `server.ts` is loaded by `cez mcp`.
 */
import { hc } from 'hono/client';
import type { ClientResponse } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';
import type { AppType } from '../server/app-type.ts';

export type CezarFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CezarApiOptions {
  baseUrl: string;
  fetch: CezarFetch;
  /** Extra headers on every request — e.g. the Basic/Cloudflare Access header a hosted cockpit's proxy wants. */
  headers?: Record<string, string>;
}

export type CezarClient = ReturnType<typeof hc<AppType>>;

export function createApiClient(options: CezarApiOptions): CezarClient {
  return hc<AppType>(options.baseUrl, {
    fetch: options.fetch,
    ...(options.headers ? { headers: options.headers } : {}),
  });
}

/** A non-2xx answer from the cockpit, carrying the route's own one-line `{error}` when it sent one. */
export class CezarApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CezarApiError';
  }
}

/** The 2xx JSON member of a typed response union (same rule as the api-client's `Ok`, which this
 *  package may not import). */
export type Ok<R> = R extends ClientResponse<infer T, infer S, 'json'> ? (S extends SuccessStatusCode ? T : never) : never;

/** Read a JSON body, turning a non-2xx into a `CezarApiError` with the server's reason. */
export async function readJson<R extends ClientResponse<unknown, number, string>>(res: R): Promise<Ok<R>> {
  if (res.ok) return (await res.json()) as Ok<R>;
  let reason = `${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body === 'object' && typeof body.error === 'string') reason = `${res.status}: ${body.error}`;
  } catch {
    // not JSON — keep the status line
  }
  throw new CezarApiError(res.status, reason);
}

const ownDeadlines = new WeakSet<AbortSignal>();

/** A timeout signal the resolver's default request deadline must not shorten (`GET /models` may
 *  wait on a vendor CLI past it). Any other signal is combined with that deadline. */
export function longDeadline(ms: number): AbortSignal {
  const signal = AbortSignal.timeout(ms);
  ownDeadlines.add(signal);
  return signal;
}

export function hasOwnDeadline(signal: AbortSignal): boolean {
  return ownDeadlines.has(signal);
}

/** `fetch` could not reach the cockpit at all (refused, reset, DNS) — as opposed to an HTTP answer
 *  or our own abort. Undici reports every one of those as `TypeError('fetch failed')`. */
export function isConnectionError(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'fetch failed';
}
