import { describe, expect, it } from 'vitest'

import type { AgentConfigFile } from '@open-mercato/cezar-api-client'
import { AGENT_DESCRIPTORS, descriptorFor } from './agent-descriptors'

/** The descriptor table driving Settings → Agent config (spec 2026-07-17-agent-config-by-agent). */

function fileOf(over: Partial<AgentConfigFile> & Pick<AgentConfigFile, 'id'>): AgentConfigFile {
  return {
    label: over.id,
    runners: ['claude'],
    kind: 'settings',
    scope: 'project',
    format: 'json',
    tracked: 'tracked',
    seeded: false,
    holdsMcp: false,
    private: false,
    precedence: 'p',
    docsUrl: 'https://example.com',
    path: `/repo/${over.id}`,
    exists: true,
    size: 1,
    version: 'v1',
    writable: true,
    ...over,
  }
}

describe('AGENT_DESCRIPTORS', () => {
  it('has one entry per config-owning runner; Cursor has settings+mcp and Pi has settings+memory', () => {
    expect(AGENT_DESCRIPTORS.map((d) => d.id)).toEqual(['claude', 'codex', 'copilot', 'opencode', 'cursor', 'pi'])
    for (const d of AGENT_DESCRIPTORS.filter((d) => d.id !== 'cursor' && d.id !== 'pi')) {
      expect(d.groups.map((g) => g.id)).toEqual(['settings', 'mcp', 'memory'])
      expect(d.groups.find((g) => g.id === 'mcp')?.note).toBeTruthy()
    }
    expect(descriptorFor('cursor').groups.map((g) => g.id)).toEqual(['settings', 'mcp'])
    expect(descriptorFor('pi').groups.map((g) => g.id)).toEqual(['settings', 'memory'])
  })

  it('membership uses runners[] inclusion — shared files belong to every reader', () => {
    const shared = fileOf({ id: 'project.agents', runners: ['codex', 'opencode', 'copilot'], kind: 'memory', format: 'markdown' })
    expect(descriptorFor('codex').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(true)
    expect(descriptorFor('opencode').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(true)
    expect(descriptorFor('copilot').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(true)
    expect(descriptorFor('claude').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(false)
  })

  it('holdsMcp promotes a file into the MCP group without leaving its own kind', () => {
    const codexConfig = fileOf({ id: 'codex.project.config', runners: ['codex'], kind: 'settings', holdsMcp: true })
    const codex = descriptorFor('codex')
    expect(codex.groups.find((g) => g.id === 'settings')!.files(codexConfig)).toBe(true)
    expect(codex.groups.find((g) => g.id === 'mcp')!.files(codexConfig)).toBe(true)
    expect(codex.groups.find((g) => g.id === 'memory')!.files(codexConfig)).toBe(false)
  })

  it('a dedicated mcp-kind file lands in the MCP group only', () => {
    const mcpJson = fileOf({ id: 'claude.project.mcp', kind: 'mcp', holdsMcp: true })
    const claude = descriptorFor('claude')
    expect(claude.groups.find((g) => g.id === 'mcp')!.files(mcpJson)).toBe(true)
    expect(claude.groups.find((g) => g.id === 'settings')!.files(mcpJson)).toBe(false)
  })

  it('descriptorFor throws on an unknown agent id', () => {
    expect(() => descriptorFor('unknown' as never)).toThrow(/no agent descriptor/)
  })
})
