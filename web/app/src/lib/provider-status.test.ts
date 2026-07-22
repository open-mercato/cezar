import { describe, expect, it } from 'vitest'

import type { ProviderStatusResponse } from '@/api/types'
import { connectedRunners, providerStatusFor } from './provider-status'

describe('connectedRunners', () => {
  it('returns only connected providers in canonical order', () => {
    const status: ProviderStatusResponse = {
      providers: [
        { provider: 'opencode', status: 'connected' },
        { provider: 'claude', status: 'connected' },
        { provider: 'codex', status: 'connected' },
      ],
    }

    expect(connectedRunners(status)).toEqual(['claude', 'codex', 'opencode'])
  })

  it('returns [] for undefined/pending status', () => {
    expect(connectedRunners(undefined)).toEqual([])
  })

  it('does not fall back to claude when none is connected', () => {
    expect(connectedRunners({ providers: [] })).toEqual([])
  })

  it('excludes disconnected, not-installed, and unknown rows', () => {
    const status: ProviderStatusResponse = {
      providers: [
        { provider: 'claude', status: 'disconnected' },
        { provider: 'codex', status: 'not-installed' },
        { provider: 'opencode', status: 'unknown' },
      ],
    }

    expect(connectedRunners(status)).toEqual([])
  })
})

describe('providerStatusFor', () => {
  it('returns the matching provider row', () => {
    const codex = { provider: 'codex', status: 'disconnected', hint: 'Run codex login.' } as const
    const status: ProviderStatusResponse = {
      providers: [{ provider: 'claude', status: 'connected' }, codex],
    }

    expect(providerStatusFor(status, 'codex')).toEqual(codex)
  })

  it('returns undefined while data is unavailable', () => {
    expect(providerStatusFor(undefined, 'claude')).toBeUndefined()
  })
})
