import { describe, expect, it } from 'vitest'

import type { ProviderStatusResponse } from '@/api/types'
import {
  applyProviderStatusRow,
  connectedRunners,
  parseProviderStatusRow,
  parseProviderStatusResponse,
  providerStatusFor,
} from './provider-status'

const CONNECTED: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected' },
    { provider: 'codex', status: 'connected' },
    { provider: 'opencode', status: 'connected' },
  ],
}

describe('provider-status SSE rows', () => {
  it('parses one coarse provider-status SSE row', () => {
    expect(parseProviderStatusRow({
      provider: 'claude',
      status: 'disconnected',
      hint: 'Reconnect, then check again.',
    })).toEqual({
      provider: 'claude',
      status: 'disconnected',
      hint: 'Reconnect, then check again.',
    })
  })

  it.each([
    null,
    { provider: 'future', status: 'disconnected' },
    { provider: 'claude', status: 'future' },
    { provider: 'claude', status: 'disconnected', hint: 1 },
  ])('rejects malformed provider-status SSE rows: %#', (value) => {
    expect(parseProviderStatusRow(value)).toBeNull()
  })

  it('replaces one row immutably without inventing a missing cache', () => {
    expect(applyProviderStatusRow(undefined, {
      provider: 'claude',
      status: 'disconnected',
    })).toBeUndefined()

    expect(applyProviderStatusRow(CONNECTED, {
      provider: 'claude',
      status: 'disconnected',
    })).toEqual({
      providers: [
        { provider: 'claude', status: 'disconnected' },
        CONNECTED.providers[1],
        CONNECTED.providers[2],
      ],
    })
  })
})

describe('parseProviderStatusResponse', () => {
  it('normalizes valid rows to canonical order and public fields only', () => {
    expect(
      parseProviderStatusResponse({
        ignored: 'private top-level value',
        providers: [
          { provider: 'opencode', status: 'unknown', hint: 'Try again.', raw: 'private' },
          { provider: 'claude', status: 'connected', account: 'private@example.test' },
          { provider: 'codex', status: 'disconnected' },
        ],
      }),
    ).toEqual({
      providers: [
        { provider: 'claude', status: 'connected' },
        { provider: 'codex', status: 'disconnected' },
        { provider: 'opencode', status: 'unknown', hint: 'Try again.' },
      ],
    })
  })

  it.each([
    ['an empty object', {}],
    ['a null providers value', { providers: null }],
    ['a null row', { providers: [null] }],
    [
      'an unknown provider',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'connected' },
          { provider: 'future', status: 'connected' },
        ],
      },
    ],
    [
      'an unknown state',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'ready' },
          { provider: 'opencode', status: 'connected' },
        ],
      },
    ],
    [
      'a duplicate provider',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'claude', status: 'disconnected' },
          { provider: 'opencode', status: 'connected' },
        ],
      },
    ],
    [
      'a missing provider',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'connected' },
        ],
      },
    ],
    [
      'a non-string hint',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'connected', hint: { raw: 'private' } },
          { provider: 'opencode', status: 'connected' },
        ],
      },
    ],
  ])('rejects %s', (_case, value) => {
    expect(() => parseProviderStatusResponse(value)).toThrow('Invalid provider status response')
  })
})

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

  it('degrades a malformed successful response to no verified providers', () => {
    expect(connectedRunners({} as ProviderStatusResponse)).toEqual([])
    expect(connectedRunners({ providers: [null] } as unknown as ProviderStatusResponse)).toEqual([])
    expect(connectedRunners({
      providers: [{ provider: 'claude', status: 'connected' }],
    })).toEqual([])
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
      providers: [
        { provider: 'claude', status: 'connected' },
        codex,
        { provider: 'opencode', status: 'not-installed' },
      ],
    }

    expect(providerStatusFor(status, 'codex')).toEqual(codex)
  })

  it('returns undefined while data is unavailable', () => {
    expect(providerStatusFor(undefined, 'claude')).toBeUndefined()
    expect(
      providerStatusFor({ providers: [null] } as unknown as ProviderStatusResponse, 'claude'),
    ).toBeUndefined()
    expect(providerStatusFor({
      providers: [{ provider: 'claude', status: 'connected' }],
    }, 'claude')).toBeUndefined()
  })
})
