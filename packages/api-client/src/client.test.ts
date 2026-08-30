import { afterEach, describe, expect, it, vi } from 'vitest'
import { runnerSchema } from '@open-mercato/cezar-contract'

import { ApiError, createCezarClient } from './client.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createCezarClient', () => {
  it('keeps API error response context', () => {
    const error = new ApiError(409, '/api/v1/runs', 'run is active', { error: 'run is active' })

    expect(error).toMatchObject({
      name: 'ApiError',
      status: 409,
      path: '/api/v1/runs',
      message: 'run is active',
      body: { error: 'run is active' },
    })
  })

  it('keeps base URL, credentials, auth, and identity on the raw client instance', async () => {
    const seen: Request[] = []
    let tokenVersion = 0
    const client = createCezarClient({
      baseUrl: 'https://cezar.example.test/root/',
      credentials: 'include',
      auth: { getToken: async () => `fresh-token-${++tokenVersion}` },
      fetch: async (input, init) => {
        seen.push(new Request(input, init))
        return Response.json([])
      },
    })
    const other = createCezarClient({ baseUrl: 'https://other.example.test' })

    await client.api.v1.runs.$get()
    await client.rpc.api.v1.runs.$get()

    expect(client.baseUrl).toBe('https://cezar.example.test/root')
    expect(client.identity).not.toBe(other.identity)
    expect(seen[0]?.url).toBe('https://cezar.example.test/root/api/v1/runs')
    expect(seen[0]?.credentials).toBe('include')
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer fresh-token-1')
    expect(seen[1]?.headers.get('authorization')).toBe('Bearer fresh-token-2')
  })

  it('derives a stable identity from the normalized authority and credential mode', () => {
    const first = createCezarClient({
      baseUrl: 'https://cezar.example.test/root/',
      credentials: 'include',
    })
    const reconstructed = createCezarClient({
      baseUrl: 'https://cezar.example.test/root',
      credentials: 'include',
    })
    const sameAuthorityDifferentCredentials = createCezarClient({
      baseUrl: 'https://cezar.example.test/root',
      credentials: 'omit',
    })
    const explicitlyIsolated = createCezarClient({
      baseUrl: 'https://cezar.example.test/root',
      credentials: 'include',
      identity: 'sandbox-b',
    })

    expect(reconstructed.identity).toBe(first.identity)
    expect(sameAuthorityDifferentCredentials.identity).not.toBe(first.identity)
    expect(explicitlyIsolated.identity).toBe('sandbox-b')
  })

  it('preserves a protocol-relative authority while projecting a legacy project URL', () => {
    const project = createCezarClient({ baseUrl: 'https://cezar.example.test/root' })
      .forProject('project-a')

    expect(project.resolveUrl('//assets.example.test/api/runs/run-a/images/1')).toBe(
      '//assets.example.test/api/v1/p/project-a/runs/run-a/images/1',
    )
  })

  it('normalizes non-2xx JSON responses through its private schema request path', async () => {
    const client = createCezarClient({
      baseUrl: 'https://cezar.example.test',
      fetch: async () => Response.json({ error: 'not allowed' }, { status: 403 }),
    }) as unknown as {
      requestJson: (schema: typeof runnerSchema, path: string, init?: RequestInit) => Promise<string>
    }

    await expect(client.requestJson(runnerSchema, '/api/v1/runs')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      path: '/api/v1/runs',
      message: 'not allowed',
      body: { error: 'not allowed' },
    })
  })

  it('normalizes malformed successful responses through its private schema request path', async () => {
    const client = createCezarClient({
      baseUrl: 'https://cezar.example.test',
      fetch: async () => Response.json({ runner: 'not-a-runner' }),
    }) as unknown as {
      requestJson: (schema: typeof runnerSchema, path: string, init?: RequestInit) => Promise<string>
    }

    await expect(client.requestJson(runnerSchema, '/api/v1/runs')).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
      path: '/api/v1/runs',
      body: { runner: 'not-a-runner' },
    })
  })

  it('marks a default native fetch rejection as a status-zero network failure', async () => {
    const networkCause = new TypeError('Failed to fetch')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(networkCause)))
    const networkClient = createCezarClient({ baseUrl: 'https://cezar.example.test' })

    const networkError = await networkClient.api.v1.runs.$get().catch((error: unknown) => error)
    expect(networkError).toMatchObject({
      name: 'ApiError',
      status: 0,
      path: 'https://cezar.example.test/api/v1/runs',
      cause: networkCause,
    })
  })

  it('preserves aborts and programming TypeErrors from an injected fetch', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const abortedClient = createCezarClient({
      baseUrl: 'https://cezar.example.test',
      fetch: async () => Promise.reject(abort),
    })
    await expect(abortedClient.api.v1.runs.$get()).rejects.toBe(abort)

    const programmingError = new TypeError('custom fetch implementation failed')
    const brokenClient = createCezarClient({
      baseUrl: 'https://cezar.example.test',
      fetch: async () => Promise.reject(programmingError),
    })
    await expect(brokenClient.api.v1.runs.$get()).rejects.toBe(programmingError)
  })
})
