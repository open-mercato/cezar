import { afterEach, describe, expect, it } from 'vitest'

import { noteFailedRequest, recentFailedRequest, resetFailedRequest } from './failed-request'

afterEach(() => resetFailedRequest())

describe('recentFailedRequest', () => {
  it('keeps the pathname only and forgets a failure that is too old to explain a toast', () => {
    noteFailedRequest('http://127.0.0.1:4000/api/v1/runs/abc/messages?secret=1', 'post', 409)
    const now = Date.now()
    expect(recentFailedRequest(3000, now)).toMatchObject({ method: 'POST', path: '/api/v1/runs/abc/messages', status: 409 })
    expect(recentFailedRequest(3000, now + 3001)).toBeNull()
  })

  it('names the agent of a provider or account call, from the path or the JSON body', () => {
    noteFailedRequest('/api/v1/providers/connect', 'post', 409, JSON.stringify({ provider: 'claude', profileId: 'work' }))
    expect(recentFailedRequest()).toMatchObject({ provider: 'claude' })
    noteFailedRequest('/api/v1/providers/codex/enabled', 'put', 500, JSON.stringify({ enabled: true }))
    expect(recentFailedRequest()).toMatchObject({ provider: 'codex' })
  })

  it('names no agent outside those routes, or when the value is not one', () => {
    noteFailedRequest('/api/v1/p/x/runs', 'post', 409, JSON.stringify({ provider: 'claude' }))
    expect(recentFailedRequest()).not.toHaveProperty('provider')
    noteFailedRequest('/api/v1/providers/connect', 'post', 409, JSON.stringify({ provider: 'me@example.com' }))
    expect(recentFailedRequest()).not.toHaveProperty('provider')
  })

  it('answers null before anything failed', () => {
    expect(recentFailedRequest()).toBeNull()
  })
})
