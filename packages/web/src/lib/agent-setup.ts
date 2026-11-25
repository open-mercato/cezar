import type { AgentSetupEntry, AgentSetupProvider, AgentSetupState, ProviderStatus, ProviderStatusResponse } from '@open-mercato/cezar-api-client'

import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'

/** What the first-run page's agent list shows (spec 2026-10-26-first-run-onboarding, "Set up an agent here"). */

export interface AgentSetupListRow extends AgentSetupEntry {
  label: string
  description: string
  /** `missing` = not installed; `signed-out` = installed, and its status is not `connected`. */
  state: 'missing' | 'signed-out'
}

/** The first-run page offers the agents it always has (spec 2026-10-26); Settings → Agents shows them all. */
const DESCRIPTIONS: Partial<Record<AgentSetupProvider, string>> = {
  claude: 'Anthropic’s coding agent. Uses your Claude account.',
  codex: 'OpenAI’s coding agent. Uses your ChatGPT account.',
  opencode: 'Open-source agent. Works with many model providers.',
  cursor: 'Cursor’s agent, without the editor. Uses your Cursor account.',
  copilot: 'GitHub’s coding agent. Uses your Copilot plan.',
}

/** Agents that are not ready and not switched off, the installed ones first: they are one step away. */
export function agentSetupListRows(setup: Extract<AgentSetupState, { available: true }>, status: ProviderStatusResponse | undefined): AgentSetupListRow[] {
  const byProvider = new Map((status?.providers ?? []).map((row) => [row.provider, row]))
  const rows = setup.agents.flatMap((agent): AgentSetupListRow[] => {
    const row = byProvider.get(agent.provider)
    const description = DESCRIPTIONS[agent.provider]
    if (description === undefined || row?.status === 'connected' || row?.enabled === false) return []
    const state = row === undefined || row.status === 'not-installed' ? 'missing' : 'signed-out'
    return [{ ...agent, label: PROVIDER_LABELS[agent.provider], description, state }]
  })
  return [...rows.filter((row) => row.state === 'signed-out'), ...rows.filter((row) => row.state === 'missing')]
}

// eslint-disable-next-line no-control-regex
const TERMINAL_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]/g
const WEB_URL = /https?:\/\/[^\s"'<>\u0007\u001B]+/g

/** The sign-in page a login printed, for people whose browser did not open by itself. Loopback
 *  addresses are the CLI's own callback, never a page to visit. */
export function signInUrl(output: string): string | null {
  const urls = output.replace(TERMINAL_SEQUENCE, ' ').match(WEB_URL) ?? []
  for (const candidate of urls.reverse()) {
    const url = safeUrl(candidate.replace(/[.,;:)\]]+$/, ''))
    if (url && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.href
  }
  return null
}

function safeUrl(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

/** What an agent row offers (spec 2026-11-25-agent-cli-install-and-update): one button that opens
 *  the setup sheet, or nothing when the agent is ready and current. */
export type AgentRowAction = 'install' | 'how-to-install' | 'sign-in' | 'update'

export function agentRowAction(entry: AgentSetupEntry | undefined, status: ProviderStatus | undefined): AgentRowAction | null {
  if (status?.enabled === false) return null
  const missing = status ? status.status === 'not-installed' : entry?.installed === false
  if (missing) return entry?.install.runnable ? 'install' : 'how-to-install'
  if (entry && (entry.versionState === 'update-required' || entry.versionState === 'update-available') && entry.update) return 'update'
  if (status?.status === 'disconnected' || status?.status === 'unknown') return 'sign-in'
  return null
}

export const AGENT_ROW_ACTION_LABEL: Record<AgentRowAction, string> = {
  install: 'Install',
  'how-to-install': 'How to install',
  'sign-in': 'Sign in',
  update: 'Update',
}

/** The version chip beside an installed agent; null when there is nothing worth saying. */
export function agentVersionChip(entry: AgentSetupEntry | undefined): { label: string; tone: 'danger' | 'warn' | 'ok' } | null {
  if (!entry?.installed) return null
  if (entry.versionState === 'update-required') return { label: `${entry.minVersion} required`, tone: 'danger' }
  if (entry.versionState === 'update-available') return { label: `${entry.latestVersion} available`, tone: 'warn' }
  if (entry.versionState === 'current' && entry.latestVersion) return { label: 'up to date', tone: 'ok' }
  return null
}

const METHOD_LABEL: Record<NonNullable<AgentSetupEntry['method']>, string> = {
  native: 'the native installer',
  npm: 'npm',
  brew: 'Homebrew',
  script: 'the vendor install script',
}

export const installMethodLabel = (method: AgentSetupEntry['method']): string | null => (method ? METHOD_LABEL[method] : null)
