import type { AgentSetupEntry, AgentSetupProvider, AgentSetupState, AgentVersionState, ProviderStatus, ProviderStatusResponse } from '@open-mercato/cezar-api-client'

import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'

/** What the first-run page's agent list shows (spec 2026-10-26-first-run-onboarding, "Set up an agent here"). */

export interface AgentSetupListRow extends AgentSetupEntry {
  /** The install cezar runs here; null when it would not, and then `install.command` is to copy. */
  installCommand: string | null
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
export function agentSetupListRows(setup: AgentSetupState, status: ProviderStatusResponse | undefined): AgentSetupListRow[] {
  const byProvider = new Map((status?.providers ?? []).map((row) => [row.provider, row]))
  const rows = setup.agents.flatMap((agent): AgentSetupListRow[] => {
    const row = byProvider.get(agent.provider)
    const description = DESCRIPTIONS[agent.provider]
    if (description === undefined || row?.status === 'connected' || row?.enabled === false) return []
    const state = row === undefined || row.status === 'not-installed' ? 'missing' : 'signed-out'
    return [{ ...agent, installCommand: agent.install.runnable ? agent.install.command : null, label: PROVIDER_LABELS[agent.provider], description, state }]
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
  const state = entry ? entryVersionState(entry) : 'unknown'
  if (entry && (state === 'update-required' || state === 'update-available') && entry.update) return 'update'
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
  const state = entryVersionState(entry)
  if (state === 'update-required') return { label: `${entry.minVersion} required`, tone: 'danger' }
  if (state === 'update-available') return { label: `${entry.latestVersion} available`, tone: 'warn' }
  if (state === 'current' && entry.latestVersion) return { label: 'up to date', tone: 'ok' }
  return null
}

const METHOD_LABEL: Record<NonNullable<AgentSetupEntry['method']>, string> = {
  native: 'the native installer',
  npm: 'npm',
  brew: 'Homebrew',
  script: 'the vendor install script',
}

export const installMethodLabel = (method: AgentSetupEntry['method']): string | null => (method ? METHOD_LABEL[method] : null)

const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** -1, 0 or 1 by semver precedence (a release beats its prereleases); null when either is not semver. */
export function compareSemver(a: string, b: string): number | null {
  const x = RELEASE.exec(a.trim())
  const y = RELEASE.exec(b.trim())
  if (!x || !y) return null
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i])
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (!x[4] && !y[4]) return 0
  if (!x[4]) return 1
  if (!y[4]) return -1
  return x[4] === y[4] ? 0 : x[4] > y[4] ? 1 : -1
}

/** Below the minimum is `update-required`; behind the newest release, `update-available`. The
 *  server sends the three versions, not this verdict: the typed API is at its size limit (#2474). */
export function entryVersionState(entry: Pick<AgentSetupEntry, 'installed' | 'version' | 'minVersion' | 'latestVersion'>): AgentVersionState {
  const { version, minVersion, latestVersion } = entry
  if (!entry.installed || !version || compareSemver(version, version) === null) return 'unknown'
  const belowMinimum = minVersion ? compareSemver(version, minVersion) : null
  if (belowMinimum !== null && belowMinimum < 0) return 'update-required'
  const behind = latestVersion ? compareSemver(latestVersion, version) : null
  if (behind !== null) return behind > 0 ? 'update-available' : 'current'
  return minVersion ? 'current' : 'unknown'
}
