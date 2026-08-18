import { hc } from 'hono/client'
import type { Hono } from 'hono'
import type { ClientResponse } from 'hono/client'
import type { SuccessStatusCode } from 'hono/utils/http-status'

import { createCezarRunsDomain, type CezarRunsDomain } from './domains/runs.ts'
import {
  createCezarProjectEventDomain,
  type CezarEventDomain,
  type CezarEventSourceFactory,
  type CezarProjectEventDomain,
} from './subscriptions/run-events.ts'
import { projectApiPath, resolveCezarUrl } from './utils/urls.ts'

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
  /** Resolve a bearer token for every request, so refreshed credentials are used immediately. */
  auth?: {
    getToken: () => string | undefined | Promise<string | undefined>
  }
  /** Extra headers merged into every request (after the auth header, so they can override). */
  headers?: Record<string, string>
  /** Browser credential policy. Defaults to `'same-origin'`. */
  credentials?: RequestCredentials
  /** Custom fetch — for tests (dispatch straight into a Hono app) or a wrapped transport. */
  fetch?: typeof globalThis.fetch
  /** Custom EventSource factory. The browser global is resolved lazily when omitted. */
  eventSource?: CezarEventSourceFactory
}

export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the request failed before receiving an HTTP response. */
    readonly status: number,
    readonly path: string,
    message: string,
    readonly body?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ApiError'
  }
}

export type CezarClient<TApp extends Hono<any, any, any> = Hono<any, any, any>> = ReturnType<
  typeof hc<TApp>
> & {
  readonly identity: string
  readonly baseUrl: string
  readonly rpc: ReturnType<typeof hc<TApp>>
  readonly events: CezarEventDomain
  forProject(projectId?: string | null): CezarProjectClient
}

export interface CezarProjectClient {
  readonly projectId: string | null
  readonly runs: CezarRunsDomain
  readonly events: CezarProjectEventDomain
  resolveUrl(url: string): string
}

type UntypedCezarClient = Record<string, any> & {
  readonly identity: string
  readonly baseUrl: string
  readonly rpc: Record<string, any>
  readonly events: CezarEventDomain
  forProject(projectId?: string | null): CezarProjectClient
}

let nextClientIdentity = 0

type JsonSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}

function errorMessage(status: number, statusText: string, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error
  }
  return `${status} ${statusText || 'request failed'}`
}

function createClientTransport(options: CezarClientOptions) {
  const baseUrl = options.baseUrl?.replace(/\/+$/, '') ?? ''
  const fetcher = options.fetch ?? globalThis.fetch
  const credentials = options.credentials ?? 'same-origin'

  return {
    baseUrl,
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
      const token = (await options.auth?.getToken()) ?? options.token
      if (token) headers.set('Authorization', `Bearer ${token}`)
      for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)

      try {
        return await fetcher(input, { ...init, credentials: init?.credentials ?? credentials, headers })
      } catch (cause) {
        if (
          typeof cause === 'object'
          && cause !== null
          && 'name' in cause
          && cause.name === 'AbortError'
        ) {
          throw cause
        }
        // Native Fetch uses TypeError for a request that cannot produce an HTTP response.
        // Preserve other thrown values: a custom fetch implementation may have a programming bug.
        if (!(cause instanceof TypeError)) throw cause
        const path = input instanceof Request ? input.url : String(input)
        throw new ApiError(0, path, `cannot reach the cezar server (${path})`, undefined, { cause })
      }
    },
  }
}

class CezarClientCore<TApp extends Hono<any, any, any>> {
  readonly identity = `cezar-client-${++nextClientIdentity}`
  readonly baseUrl: string
  readonly rpc: ReturnType<typeof hc<TApp>>
  readonly events: CezarEventDomain

  constructor(
    private readonly transport: ReturnType<typeof createClientTransport>,
    private readonly eventSource?: CezarEventSourceFactory,
  ) {
    this.baseUrl = transport.baseUrl
    this.rpc = hc<TApp>(transport.baseUrl, { fetch: transport.fetch })
    this.events = {
      forProject: (projectId = null) => this.createProjectEvents(projectId ?? null),
    }
  }

  private async requestJson<T>(
    schema: JsonSchema<T>,
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const response = await this.transport.fetch(`${this.baseUrl}${path}`, init)
    let body: unknown
    let isJson = true
    try {
      body = await response.json()
    } catch {
      isJson = false
    }

    if (!response.ok) {
      throw new ApiError(response.status, path, errorMessage(response.status, response.statusText, body), body)
    }
    if (!isJson) {
      throw new ApiError(response.status, path, `the cezar server answered ${path} with a non-JSON body`)
    }

    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(response.status, path, `the cezar server answered ${path} with an unexpected body`, body)
    }
    return parsed.data
  }

  forProject(projectId: string | null = null): CezarProjectClient {
    const normalizedProjectId = projectId ?? null
    return {
      projectId: normalizedProjectId,
      runs: createCezarRunsDomain(normalizedProjectId, this.requestJson.bind(this)),
      events: this.createProjectEvents(normalizedProjectId),
      resolveUrl: (url) => this.resolveProjectUrl(normalizedProjectId, url),
    }
  }

  private createProjectEvents(projectId: string | null): CezarProjectEventDomain {
    return createCezarProjectEventDomain(this.baseUrl, projectId, this.eventSource)
  }

  private resolveProjectUrl(projectId: string | null, url: string): string {
    const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(url)
    const parsed = new URL(url, 'http://cezar.invalid')
    const legacyPrefix = parsed.pathname.startsWith('/api/v1/')
      ? '/api/v1'
      : parsed.pathname.startsWith('/api/')
        ? '/api'
        : null
    if (legacyPrefix === null) return url

    const suffix = parsed.pathname.slice(legacyPrefix.length)
    const path = suffix.startsWith('/p/')
      ? `/api/v1${suffix}${parsed.search}${parsed.hash}`
      : `${projectApiPath(projectId, suffix as `/${string}`)}${parsed.search}${parsed.hash}`
    return absolute ? `${parsed.origin}${path}` : resolveCezarUrl(this.baseUrl, path)
  }
}

/**
 * Build a typed client for a cezar service.
 *
 * `T` is the service's `AppType`. It is left unconstrained so that a JS consumer, or a
 * consumer that does not want the server package installed, still gets a working (untyped)
 * client instead of a type error.
 */
export function createCezarClient(options?: CezarClientOptions): UntypedCezarClient
export function createCezarClient<T extends Hono<any, any, any>>(
  options?: CezarClientOptions,
): CezarClient<T>
export function createCezarClient<
  // The three `any`s are Hono's own constraint on `hc` (Env, Schema, BasePath) — narrowing
  // them here would reject perfectly good app types. `Hono` as the default is the untyped
  // fallback: `createCezarClient()` with no type argument still returns a working client.
  T extends Hono<any, any, any> = Hono<any, any, any>,
>(options: CezarClientOptions = {}): CezarClient<T> | UntypedCezarClient {
  const transport = createClientTransport(options)
  const client = new CezarClientCore<T>(transport, options.eventSource)
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      return Reflect.get(target.rpc as object, property)
    },
  }) as unknown as CezarClient<T>
}

/**
 * The 200 member of a typed response union — the shape a caller actually receives.
 *
 * `hc` types a call as the union of everything the handler can answer, error branches included:
 * a route that answers `{runner, models}` or `{error}` infers both. That is honest about the
 * wire, but a caller that treats a non-2xx as a thrown error (as cezar's client does) only ever
 * holds the success shape, and forcing it to narrow a union it can never see would be noise.
 *
 * Selecting the success branch is what makes an inferred type a drop-in replacement for the
 * hand-written DTO it retires.
 *
 * EVERY 2xx, not just 200: a handler answering `c.json(x, 201)` — `POST /runs`, `/workflows`,
 * `/runs/:id/pr`, `/todos/:id/start` — has no 200 branch at all, so keying on 200 inferred
 * `never`. That stayed invisible while a hand-written DTO still annotated the call site (`never`
 * is assignable to anything) and would have surfaced as a broken caller at the exact moment
 * those DTOs were deleted.
 */
export type Ok<R> = R extends ClientResponse<infer T, infer S, 'json'>
  ? S extends SuccessStatusCode
    ? T
    : never
  : never

/**
 * `Ok<R>`, but loud when there is no JSON branch at all.
 *
 * A route can answer more than one format on one path — `/repo/commit/:sha` serves a structured
 * payload or a raw blob, `/runs/:id/files` a listing or image bytes — so `hc` infers a union of
 * `'json'` and `'text'`/`'body'` members and `Ok` correctly picks the JSON one. But for a route
 * that is text-only, `Ok` is `never`, and `never` is assignable to EVERY declared return type: a
 * caller would compile and then fail at runtime, with the type system having said nothing.
 *
 * Substituting a branded object makes that case a readable compile error instead. It is why
 * `unwrap` can accept mixed-format routes without becoming a hole for single-format ones.
 */
export type OkJson<R> = [Ok<R>] extends [never]
  ? { readonly __error: 'this route has no JSON response; read it as text instead' }
  : Ok<R>
