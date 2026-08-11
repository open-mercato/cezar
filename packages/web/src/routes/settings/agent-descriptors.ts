import type { AgentConfigFile, Runner } from '@open-mercato/cezar-api-client'

/**
 * Per-agent descriptor driving the Settings → Agent config pane (spec
 * 2026-07-17-agent-config-by-agent, amending #404): the UI is grouped by AGENT —
 * selector first, then that agent's settings, MCP and memory together — not by
 * purpose across agents. One descriptor entry per agent, keyed by the same
 * `Runner` id the rest of the codebase uses (the BACKEND_MODEL_MAP precedent from
 * #405: one table entry per agent, extension by design). A new agent is one entry
 * here plus its catalog files — no layout or route work.
 *
 * `pi` (#387) is deliberately absent, not forgotten: nothing in `src/agent-config`'s
 * catalog names a pi-owned config file yet, so a pi entry would render three empty
 * groups. It gets a descriptor together with its catalog files. The tab list only
 * ever offers ids from this table, so `descriptorFor` cannot be reached with `pi`.
 *
 * Group membership derives from the flat `/api/agent-config` listing: a file
 * belongs to an agent when `runners` INCLUDES it (not `runners[0]` — the shared
 * `AGENTS.md` entry is read by Codex AND OpenCode and must show under both), and
 * `holdsMcp` promotes a file into the MCP group as well as its own kind — for
 * Codex/OpenCode the main config genuinely is where MCP servers live.
 */

export interface AgentGroup {
  id: 'settings' | 'mcp' | 'memory'
  label: string
  /** Group-level caveat — e.g. where this agent keeps its MCP servers. */
  note?: string
  files: (f: AgentConfigFile) => boolean
}

export interface AgentDescriptor {
  id: Runner
  label: string
  /** Pane-level caveat shown under the agent's heading. */
  note?: string
  groups: AgentGroup[]
}

const EDITOR_PLUS_COMMIT =
  'An editor-plus-commit: a saved change reaches a run after you commit it to the base branch.'

function ownedBy(agent: Runner) {
  return (f: AgentConfigFile) => f.runners.includes(agent)
}

function group(
  agent: Runner,
  id: AgentGroup['id'],
  label: string,
  note?: string,
): AgentGroup {
  const owned = ownedBy(agent)
  // `holdsMcp` files appear in the MCP group AND their own kind group — both
  // occurrences open the same editor; hiding either would misstate the file.
  const member =
    id === 'mcp'
      ? (f: AgentConfigFile) => owned(f) && (f.holdsMcp === true || f.kind === 'mcp')
      : (f: AgentConfigFile) => owned(f) && f.kind === id
  return { id, label, note, files: member }
}

export const AGENT_DESCRIPTORS: AgentDescriptor[] = [
  {
    id: 'claude',
    label: 'Claude',
    groups: [
      group('claude', 'settings', 'Settings'),
      group(
        'claude',
        'mcp',
        'MCP',
        'A dedicated .mcp.json (key: mcpServers), shared via version control.',
      ),
      group('claude', 'memory', 'Memory & instructions'),
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    note: EDITOR_PLUS_COMMIT,
    groups: [
      group('codex', 'settings', 'Settings'),
      group(
        'codex',
        'mcp',
        'MCP',
        'Inside config.toml under [mcp_servers.<id>] — the same file as Codex’s settings.',
      ),
      group('codex', 'memory', 'Memory & instructions'),
    ],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    note: EDITOR_PLUS_COMMIT,
    groups: [
      group('opencode', 'settings', 'Settings'),
      group(
        'opencode',
        'mcp',
        'MCP',
        'Under the "mcp" key in opencode.json — the same file as OpenCode’s settings.',
      ),
      group('opencode', 'memory', 'Memory & instructions'),
    ],
  },
]

export function descriptorFor(agent: Runner): AgentDescriptor {
  const found = AGENT_DESCRIPTORS.find((d) => d.id === agent)
  if (!found) throw new Error(`no agent descriptor for ${agent}`)
  return found
}
