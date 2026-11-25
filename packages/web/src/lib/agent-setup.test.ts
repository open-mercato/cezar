import { describe, expect, it } from 'vitest'

import type { AgentSetupEntry, AgentSetupProvider } from '@open-mercato/cezar-api-client'

import { agentRowAction, agentSetupListRows, agentVersionChip, signInUrl } from '@/lib/agent-setup'

const agent = (provider: AgentSetupProvider, over: Partial<AgentSetupEntry> = {}): AgentSetupEntry => ({
  provider,
  installCommand: `install ${provider}`,
  installHint: 'hint',
  loginCommand: `login ${provider}`,
  install: { command: `install ${provider}`, runnable: true, method: 'npm', sudo: false },
  update: null,
  docsUrl: 'https://example.com/docs',
  copyOnlyReason: null,
  installed: false,
  version: null,
  method: null,
  minVersion: null,
  latestVersion: null,
  versionState: 'unknown',
  autoUpdates: null,
  activeRuns: 0,
  ...over,
})
const setup = { available: true as const, interactive: true, session: null, agents: [agent('claude'), agent('codex'), agent('copilot')] }

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

describe('agentSetupListRows on the first-run page', () => {
  it('keeps to the agents first-run has always offered', () => {
    const wide = { ...setup, agents: [...setup.agents, agent('gemini'), agent('omp')] }
    expect(agentSetupListRows(wide, undefined).map((row) => row.provider)).toEqual(['claude', 'codex', 'copilot'])
  })
})

describe('agentRowAction (spec 2026-11-25-agent-cli-install-and-update)', () => {
  const update = { command: 'brew upgrade claude-code', runnable: true, method: 'brew' as const, sudo: false }

  it('offers Install only for a command cezar runs, How to install otherwise', () => {
    expect(agentRowAction(agent('codex'), { provider: 'codex', status: 'not-installed' })).toBe('install')
    expect(agentRowAction(agent('omp', { install: { command: 'brew install can1357/tap/omp', runnable: false, method: 'brew', sudo: false } }), { provider: 'omp', status: 'not-installed' })).toBe('how-to-install')
  })

  it('offers Update for an outdated install, Sign in for a signed-out one, nothing when ready', () => {
    const installed = { installed: true, version: '2.0.14', update }
    expect(agentRowAction(agent('claude', { ...installed, versionState: 'update-required', minVersion: '2.1.0' }), { provider: 'claude', status: 'connected' })).toBe('update')
    expect(agentRowAction(agent('claude', { ...installed, versionState: 'current' }), { provider: 'claude', status: 'disconnected' })).toBe('sign-in')
    expect(agentRowAction(agent('claude', { ...installed, versionState: 'current' }), { provider: 'claude', status: 'connected' })).toBeNull()
    expect(agentRowAction(agent('claude'), { provider: 'claude', status: 'not-installed', enabled: false })).toBeNull()
  })
})

describe('agentVersionChip', () => {
  it('says required, available or up to date', () => {
    expect(agentVersionChip(agent('opencode', { installed: true, versionState: 'update-required', minVersion: '1.18.0' }))).toEqual({ label: '1.18.0 required', tone: 'danger' })
    expect(agentVersionChip(agent('claude', { installed: true, versionState: 'update-available', latestVersion: '2.1.3' }))).toEqual({ label: '2.1.3 available', tone: 'warn' })
    expect(agentVersionChip(agent('codex', { installed: true, versionState: 'current', latestVersion: '0.64.0' }))).toEqual({ label: 'up to date', tone: 'ok' })
    expect(agentVersionChip(agent('codex'))).toBeNull()
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
    expect(signInUrl('javascript:void(0) file:///etc/passwd')).toBeNull()
  })
})
