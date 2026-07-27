import { describe, expect, it } from 'vitest'

import type { ProviderStatusResponse } from '@open-mercato/cezar-api-client'
import {
  mergeProviderAuthDismissals,
  providerAuthDismissals,
  visibleProviderAuthIncidents,
} from './provider-auth-alert'

const STATUS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-1' },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

const NEW_STATUS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-2' },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

describe('visibleProviderAuthIncidents', () => {
  it('lists every undismissed incident in catalog order even when Codex is connected', () => {
    const status: ProviderStatusResponse = {
      providers: [
        { provider: 'opencode', status: 'disconnected', enabled: true, authFailureId: 'open-1' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-1' },
      ],
    }

    expect(visibleProviderAuthIncidents(status, {})).toEqual([
      { provider: 'claude', label: 'Claude Code', authFailureId: 'claude-1' },
      { provider: 'opencode', label: 'OpenCode', authFailureId: 'open-1' },
    ])
  })

  it('hides only the matching incident and resurfaces a different id', () => {
    expect(visibleProviderAuthIncidents(STATUS, { claude: 'claude-1' })).toEqual([])
    expect(visibleProviderAuthIncidents(NEW_STATUS, { claude: 'claude-1' })).toEqual([
      { provider: 'claude', label: 'Claude Code', authFailureId: 'claude-2' },
    ])
  })

  it('ignores stale dismissal ids for a current incident', () => {
    expect(visibleProviderAuthIncidents(STATUS, { claude: 'stale-id' })).toEqual([
      { provider: 'claude', label: 'Claude Code', authFailureId: 'claude-1' },
    ])
  })
})

describe('providerAuthDismissals', () => {
  it('keeps only valid known-provider ids from malformed stored maps', () => {
    expect(providerAuthDismissals({
      claude: 'claude-1',
      codex: '',
      opencode: 'a'.repeat(129),
      future: 'future-1',
    })).toEqual({ claude: 'claude-1' })
    expect(providerAuthDismissals(null)).toEqual({})
    expect(providerAuthDismissals(['claude-1'])).toEqual({})
  })
})

describe('mergeProviderAuthDismissals', () => {
  it('preserves existing dismissals and records every dismissed incident', () => {
    expect(mergeProviderAuthDismissals(
      { codex: 'codex-1' },
      [
        { provider: 'claude', label: 'Claude Code', authFailureId: 'claude-1' },
        { provider: 'opencode', label: 'OpenCode', authFailureId: 'open-1' },
      ],
    )).toEqual({
      claude: 'claude-1',
      codex: 'codex-1',
      opencode: 'open-1',
    })
  })
})
