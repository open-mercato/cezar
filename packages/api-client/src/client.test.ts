import { describe, expect, it } from 'vitest'

import { ApiError, createCezarClient } from './client.ts'

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
    const client = createCezarClient({
      baseUrl: 'https://cezar.example.test/root/',
      credentials: 'include',
      auth: { getToken: async () => 'fresh-token' },
      fetch: async (input, init) => {
        seen.push(new Request(input, init))
        return Response.json([])
      },
    })
    const other = createCezarClient({ baseUrl: 'https://other.example.test' })

    await client.rpc.api.v1.runs.$get()

    expect(client.baseUrl).toBe('https://cezar.example.test/root')
    expect(client.identity).not.toBe(other.identity)
    expect(seen[0]?.url).toBe('https://cezar.example.test/root/api/v1/runs')
    expect(seen[0]?.credentials).toBe('include')
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer fresh-token')
  })
})
