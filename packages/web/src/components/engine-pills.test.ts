import { describe, expect, it } from 'vitest'

import type { Runner } from '@open-mercato/cezar-api-client'

import { engineBody, type ResolvedEngine } from './engine-pills'

/**
 * `engineBody` (#401) is the one place the create-run body rules live for the Inbox and the
 * GitHub tab. The rules are small; the reason they are worth pinning is the third case below —
 * the composer's `runnerCount > 1` rule gets it wrong, and this is the difference.
 */

const resolved = (over: Partial<ResolvedEngine> = {}): ResolvedEngine => ({
  runner: 'claude',
  model: '',
  runners: ['claude'],
  defaultRunner: 'claude',
  ...over,
})

describe('engineBody', () => {
  it("auto ('') stays implicit rather than shipping an empty model", () => {
    expect(engineBody(resolved({ model: '' })).model).toBeUndefined()
  })

  it('a pinned model is sent', () => {
    expect(engineBody(resolved({ model: 'opus' })).model).toBe('opus')
  })

  it('omits the runner when it is already what the server would choose', () => {
    const body = engineBody(resolved({ runner: 'claude', defaultRunner: 'claude' }))
    expect(body.runner).toBeUndefined()
  })

  it('sends the runner when it differs from the default — a real pick', () => {
    const body = engineBody(
      resolved({ runner: 'codex', defaultRunner: 'claude', runners: ['claude', 'codex'] }),
    )
    expect(body.runner).toBe('codex')
  })

  /**
   * The case the composer's count rule gets wrong (#401 review). The host prefers codex, but
   * the `codex --version` probe failed — a shell-out under a timeout, so a loaded machine is
   * enough. Health reports one usable backend, so `runnerCount` is 1 and the count rule would
   * omit the runner; the server would then resolve the omitted field straight back to codex and
   * hand it a claude model. Comparing against the default sends `claude` and settles it.
   */
  it('sends the runner when the host default is unavailable, even with one backend left', () => {
    const body = engineBody(
      resolved({ runner: 'claude', defaultRunner: 'codex', runners: ['claude'], model: 'opus' }),
    )
    expect(body.runner).toBe('claude')
    expect(body.model).toBe('opus')
  })

  it('collapses to the composer on a healthy single-backend host — nothing sent', () => {
    const body = engineBody(
      resolved({ runner: 'claude', defaultRunner: 'claude', runners: ['claude'], model: '' }),
    )
    expect(body).toEqual({ runner: undefined, model: undefined })
  })

  it.each<Runner>(['claude', 'codex', 'opencode'])(
    'is symmetric for %s as the host default',
    (runner) => {
      expect(engineBody(resolved({ runner, defaultRunner: runner })).runner).toBeUndefined()
    },
  )
})
