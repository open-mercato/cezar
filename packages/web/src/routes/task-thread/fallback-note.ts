import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'

/**
 * A note saying cezar's own small model call — the task's title or the auto-land commit
 * message — failed and a fallback was used. The task itself is fine; the row only explains.
 */
export interface FallbackNote {
  kind: 'title' | 'commit-message'
  runner?: string
  reason: string
}

/** The old note texts, so notes recorded before the `fallback` field still render the row. */
const LEGACY_PREFIXES: ReadonlyArray<[string, FallbackNote['kind']]> = [
  ['model naming unavailable — ', 'title'],
  ['commit message named from the files — ', 'commit-message'],
]

export function parseFallbackNote(field: unknown, text: string): FallbackNote | undefined {
  if (field && typeof field === 'object') {
    const { kind, runner, reason } = field as Record<string, unknown>
    if ((kind === 'title' || kind === 'commit-message') && typeof reason === 'string') {
      return { kind, reason, ...(typeof runner === 'string' && runner ? { runner } : {}) }
    }
  }
  for (const [prefix, kind] of LEGACY_PREFIXES) {
    if (text.startsWith(prefix)) {
      const reason = text.slice(prefix.length)
      const runner = /^([a-z][a-z0-9-]*): tool-policy/.exec(reason)?.[1] ?? /^no cheap model known for (\S+)$/.exec(reason)?.[1]
      return { kind, reason, ...(runner ? { runner } : {}) }
    }
  }
  return undefined
}

export type FallbackSettingsLink = { label: string; to: string; scope: 'global' | 'project' }

export interface FallbackCopy {
  headline: string
  /** Plain-language why; undefined when only the raw reason can say it. */
  explanation?: string
  hint?: string
  link?: FallbackSettingsLink
}

const ACCOUNTS_LINK: FallbackSettingsLink = { label: 'Agent accounts', to: '/settings/global/accounts', scope: 'global' }
const AGENTS_LINK: FallbackSettingsLink = { label: 'Agents', to: '/settings/agents', scope: 'project' }

export function runnerDisplayName(runner: string | undefined): string | undefined {
  if (!runner) return undefined
  return (PROVIDER_LABELS as Record<string, string>)[runner] ?? runner
}

export function describeFallback(note: FallbackNote): FallbackCopy {
  const headline = note.kind === 'title'
    ? 'Couldn’t name this task automatically — used a fallback title'
    : 'Couldn’t write the commit message — used a list of changed files'
  const reason = note.reason.trim()

  if (reason === 'model naming is off') {
    return { headline, explanation: 'Automatic naming is turned off on this machine (CEZ_AUTONAME=0).' }
  }
  if (reason === 'nothing staged') {
    return { headline, explanation: 'There were no staged changes to describe.' }
  }
  if (reason.startsWith('no cheap model known for ')) {
    return {
      headline,
      explanation: 'cezar knows no small, cheap model for it, so it skipped the call.',
      hint: 'Pick another default agent in Settings →',
      link: AGENTS_LINK,
    }
  }
  if (/tool-policy enforcement unavailable/.test(reason)) {
    if (/startup (verification timed out|could not be verified)/.test(reason)) {
      return {
        headline,
        explanation: 'It didn’t start in time for this short call.',
        hint: 'Check its account and model provider in Settings →',
        link: ACCOUNTS_LINK,
      }
    }
    return {
      headline,
      explanation: 'It can’t run this short call with its tools locked down.',
      hint: 'Claude Code or Pi can — pick one as the default agent in Settings →',
      link: AGENTS_LINK,
    }
  }
  if (reason === 'empty answer' || reason === 'no answer') {
    return { headline, explanation: 'It returned an empty answer.', hint: 'This is usually temporary.' }
  }
  if (reason.startsWith('unusable answer')) {
    return { headline, explanation: 'Its answer couldn’t be used.', hint: 'This is usually temporary.' }
  }
  return {
    headline,
    hint: 'If this keeps happening, check its account in Settings →',
    link: ACCOUNTS_LINK,
  }
}
