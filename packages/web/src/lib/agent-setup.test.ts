import { describe, expect, it } from 'vitest'

import { agentSetupListRows, signInUrl } from '@/lib/agent-setup'

const agent = (provider: 'claude' | 'codex' | 'copilot') => ({ provider, installCommand: `install ${provider}`, installHint: 'hint', loginCommand: `login ${provider}` })
const setup = { available: true as const, session: null, agents: [agent('claude'), agent('codex'), agent('copilot')] }

describe('agentSetupListRows', () => {
  it('leaves out the connected and the switched off, with installed agents first', () => {
    const rows = agentSetupListRows(setup, {
      providers: [
        { provider: 'claude', status: 'not-installed' },
        { provider: 'codex', status: 'disconnected' },
        { provider: 'copilot', status: 'not-installed', enabled: false },
      ],
    })
    expect(rows.map((row) => [row.provider, row.state])).toEqual([['codex', 'signed-out'], ['claude', 'missing']])
  })

  it('treats an inconclusive status as installed: its login is what can say what is wrong', () => {
    const rows = agentSetupListRows(setup, { providers: [{ provider: 'claude', status: 'unknown' }] })
    expect(rows.find((row) => row.provider === 'claude')?.state).toBe('signed-out')
  })

  it('offers an install when the status has no row yet', () => {
    expect(agentSetupListRows(setup, undefined).every((row) => row.state === 'missing')).toBe(true)
  })
})

describe('signInUrl', () => {
  it('finds the last page a login printed, through colours and hyperlinks', () => {
    expect(signInUrl('\u001B[1mOpen\u001B[0m https://a.example/one and\r\n\u001B[4mhttps://claude.ai/oauth?code=x&state=y\u001B[0m.\r\n')).toBe('https://claude.ai/oauth?code=x&state=y')
    expect(signInUrl('\u001B]8;;https://a.example/link\u0007text\u001B]8;;\u0007')).toBeNull()
  })

  it('skips the CLI\'s own callback address', () => {
    expect(signInUrl('https://auth.openai.com/authorize?x=1\nlistening on http://localhost:1455/callback')).toBe('https://auth.openai.com/authorize?x=1')
  })

  it('answers null with no address, and for anything that is not a web address', () => {
    expect(signInUrl('')).toBeNull()
    expect(signInUrl('Press Enter to continue')).toBeNull()
    expect(signInUrl('javascript:alert(1) file:///etc/passwd')).toBeNull()
  })
})
