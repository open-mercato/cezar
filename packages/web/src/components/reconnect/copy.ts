import type { LoginFailureReason, LoginMethod, ProviderId } from '@open-mercato/cezar-api-client'

import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'

/** Wording and per-agent facts the reconnect card needs (spec 2026-11-18-inline-account-reconnect,
 *  design page `.html`). Server knowledge stays on the server: the method and URL come from the
 *  session; these only pick words and the agents' own brand mark. */

export const agentName = (provider: ProviderId): string => PROVIDER_LABELS[provider]

/** Per-agent sign-in traits, one row per runner so a new runner must decide its own.
 *  `terminal`: no headless login, the card hands off to a terminal and watches it.
 *  `key`: stores a pasted API key itself (decision 4), the only ones offered a key field.
 *  `mono`/`ring`: the brand mark, as the design draws it; its colour is `--runner-mark-<id>`. */
const RUNNER_TRAITS: Record<ProviderId, { terminal?: true; key?: true; mono: string; ring?: true }> = {
  claude: { mono: 'C' },
  codex: { key: true, mono: 'X', ring: true },
  cursor: { mono: 'Cu' },
  copilot: { mono: 'Co' },
  opencode: { key: true, mono: 'O' },
  kimi: { mono: 'K', ring: true },
  pi: { terminal: true, mono: 'π' },
  gemini: { terminal: true, mono: 'G' },
  antigravity: { terminal: true, mono: 'A' },
  junie: { terminal: true, mono: 'J' },
  omp: { terminal: true, mono: 'Ω' },
}

const runnersWith = (trait: 'terminal' | 'key'): ReadonlySet<ProviderId> =>
  new Set((Object.keys(RUNNER_TRAITS) as ProviderId[]).filter((id) => RUNNER_TRAITS[id][trait]))

export const TERMINAL_ONLY = runnersWith('terminal')
export const KEY_CAPABLE = runnersWith('key')

/** The agents' brand marks: monogram, an optional light ring, and the theme-stable colour token. */
export function runnerMark(provider: ProviderId): { mono: string; color: string; ring: boolean } {
  const { mono, ring } = RUNNER_TRAITS[provider]
  return { mono, color: `var(--runner-mark-${provider})`, ring: ring === true }
}

/** The host of a sign-in URL, for "We opened claude.ai" and "Open github.com ↗". */
export function urlHost(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/** A fixed reason, never vendor output. */
export function failureCopy(reason: LoginFailureReason | undefined, method: LoginMethod | undefined, provider: ProviderId, account: string): string {
  const name = agentName(provider)
  switch (reason) {
    case 'expired':
      return method === 'paste' ? 'That code expired. Codes are single-use and expire after a few minutes.' : 'The code expired before it was approved.'
    case 'rejected':
      if (method === 'key') return 'The key was rejected by the provider.'
      if (method === 'paste') return 'That code was not accepted. Codes are single-use and expire after a few minutes.'
      return `${name} did not accept the sign-in.`
    case 'account-mismatch':
      return `Signed in as another account than ${account} used, so cezar kept the work paused rather than continue on someone else's plan.`
    case 'exited':
      return method === 'browser' ? 'The sign-in ended before you approved access.' : `${name} stopped the sign-in before it finished.`
    case 'not-installed':
      return `${name} is not installed on the computer running cezar.`
    case 'timeout':
      return method === 'terminal'
        ? 'No sign-in was detected yet. Finish it in the terminal, then check again.'
        : `${name} did not confirm the sign-in within 15 minutes.`
    case 'unavailable':
      return `${name} can't sign in from here. Run its sign-in on the computer running cezar.`
    default:
      return 'The sign-in did not finish.'
  }
}

/**
 * The last-resort command for More options, until the server hands one over (`session.command`).
 * Named accounts only where the design spells the folder variable; elsewhere Settings is the way.
 */
export function fallbackCommand(provider: ProviderId, configDir: string | undefined, isDefault: boolean): string | undefined {
  const plain: Record<ProviderId, string> = {
    claude: 'claude auth login', codex: 'codex login', cursor: 'agent login', copilot: 'copilot login',
    opencode: 'opencode auth login', kimi: 'kimi login', pi: 'pi /login', gemini: 'gemini', antigravity: 'agy', junie: 'junie', omp: 'omp',
  }
  if (isDefault) return plain[provider]
  if (!configDir) return undefined
  if (provider === 'claude') return `CLAUDE_CONFIG_DIR=${configDir} claude auth login`
  if (provider === 'codex') return `CODEX_HOME=${configDir} codex login`
  return undefined
}
