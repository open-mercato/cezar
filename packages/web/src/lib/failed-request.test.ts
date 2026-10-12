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

  it('answers null before anything failed', () => {
    expect(recentFailedRequest()).toBeNull()
  })
})
