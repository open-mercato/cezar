/**
 * Agent-error hints (spec `2026-10-24-agent-cli-error-cooperation.md`, improvement 4): sorts a
 * failed run's agent error text into the few classes whose fix is a different runner, model or
 * account — or that need saying plainly. Pure and Node-free so the cockpit can derive the card
 * from the persisted error event; `null` means "no hint", and the generic Continue stays the answer.
 */

export const AGENT_ERROR_HINT_KINDS = [
  'model_unavailable',
  'quota_no_reset',
  'billing',
  'conversation_too_large',
  'disk_full',
  'account_policy',
] as const

export type AgentErrorHintKind = (typeof AGENT_ERROR_HINT_KINDS)[number]

export interface AgentErrorHint {
  kind: AgentErrorHintKind
  /** `account_policy` only: the vendor wants a human to verify identity, not a different login. */
  identityVerification?: boolean
}

// Ordered: the first match wins. Each is anchored on the vendor's own wording (telemetry groups
// 8e1173b1, a1c2fcc2, 5432183c, 7d0a1d6d, 13023969, 9cdcedc3, 75ae746c, c65a5ac5).
const DISK_FULL_RE = /\bENOSPC\b|\bno space left on device\b/i
const TOO_LARGE_RE = /\brequest too large \(max \d+\s?[KMG]B\)/i
const BILLING_RE = /\bcredit balance is too low\b/i
const POLICY_RE = /\bhas disabled claude subscription access\b/i
const IDENTITY_RE = /\bidentity verification is required\b/i
// A limit with no reset instant: an upgrade pitch instead of a time ("Get Cursor Pro for more").
const QUOTA_NO_RESET_RE = /\b(?:you['’]?ve|you have) (?:hit|reached) your usage limit\b(?=[\s\S]*\b(?:get|upgrade to) \w+ (?:pro|plus|max|ultra)\b)/i
const MODEL_UNAVAILABLE_RE = /\bissue with the selected model\b|\bmodel (?:is )?at capacity\b/i

export function classifyAgentErrorHint(message: string): AgentErrorHint | null {
  if (message === '') return null
  if (DISK_FULL_RE.test(message)) return { kind: 'disk_full' }
  if (TOO_LARGE_RE.test(message)) return { kind: 'conversation_too_large' }
  if (BILLING_RE.test(message)) return { kind: 'billing' }
  if (POLICY_RE.test(message)) return { kind: 'account_policy' }
  if (IDENTITY_RE.test(message)) return { kind: 'account_policy', identityVerification: true }
  if (QUOTA_NO_RESET_RE.test(message)) return { kind: 'quota_no_reset' }
  if (MODEL_UNAVAILABLE_RE.test(message)) return { kind: 'model_unavailable' }
  return null
}
