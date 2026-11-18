import type { LoginFailureReason, LoginMethod, ProviderId } from '@open-mercato/cezar-api-client'

import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'

/** Wording and per-agent facts the reconnect card needs (spec 2026-11-18-inline-account-reconnect,
 *  design page `.html`). Server knowledge stays on the server: the method and URL come from the
 *  session; these only pick words and the agents' own brand mark. */

export const agentName = (provider: ProviderId): string => PROVIDER_LABELS[provider]

/** How each agent's sign-in reaches the card: `tab` opens a web page locally, `terminal` has no
 *  headless login (the card hands off to a terminal and watches it), `inline` is relayed in place. */
const SIGN_IN: Record<ProviderId, 'tab' | 'terminal' | 'inline'> = {
  claude: 'tab', codex: 'tab', cursor: 'tab', copilot: 'tab', kimi: 'tab',
  opencode: 'inline',
  pi: 'terminal', gemini: 'terminal', antigravity: 'terminal', junie: 'terminal', omp: 'terminal',
}

export const TERMINAL_ONLY = { has: (provider: ProviderId): boolean => SIGN_IN[provider] === 'terminal' }

/** Agents that store a pasted API key themselves (decision 4): the only ones offered a key field. */
export const KEY_CAPABLE: ReadonlySet<ProviderId> = new Set(['codex', 'opencode'])

/** Agents whose local sign-in opens a web page: the card opens the tab inside the click so no popup
 *  blocker stands between it and the URL that arrives a moment later. */
export const OPENS_A_TAB = { has: (provider: ProviderId): boolean => SIGN_IN[provider] === 'tab' }

/** The agents' brand marks, as the design draws them; colours are `--color-runner-*` tokens. */
export const RUNNER_MARK: Record<ProviderId, { mono: string; tile: string; ring?: boolean }> = {
  claude: { mono: 'C', tile: 'bg-runner-claude' },
  codex: { mono: 'X', tile: 'bg-runner-codex', ring: true },
  cursor: { mono: 'Cu', tile: 'bg-runner-cursor' },
  copilot: { mono: 'Co', tile: 'bg-runner-copilot' },
  opencode: { mono: 'O', tile: 'bg-runner-opencode' },
  kimi: { mono: 'K', tile: 'bg-runner-kimi', ring: true },
  pi: { mono: 'π', tile: 'bg-runner-pi' },
  gemini: { mono: 'G', tile: 'bg-runner-gemini' },
  antigravity: { mono: 'A', tile: 'bg-runner-antigravity' },
  junie: { mono: 'J', tile: 'bg-runner-junie' },
  omp: { mono: 'Ω', tile: 'bg-runner-omp' },
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
