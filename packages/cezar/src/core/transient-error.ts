import { isRuntimeProviderAuthFailure } from './provider-auth.ts';
import { isUsageLimitMessage } from './usage-limit.ts';

/** The prefixes `run.ts` puts in front of the agent's own error text. */
const RUN_ERROR_PREFIX_RE = /^(?:continue failed: |step "[^"]*" failed: )/;
/** Run errors cezar wrote about itself — restart bookkeeping, its own crash, git — never retried. */
const NON_AGENT_RE = /^(?:interrupted — |continue crashed: |worktree creation failed: )/;

/** Claude Code's refresh lock is held by another process on the same config dir (204c5e03). Checked
 *  before the auth exclusion: it says "oauth token", but the account is fine. */
const REFRESH_RACE_RE = /\banother claude code process is (?:currently )?refreshing\b/i;

/** "Try again in a moment" from the vendor or the network (spec 2026-10-24-agent-cli-error-cooperation
 *  § Transient): 529 overloaded (76aa46a9), a 5xx, a stalled stream (9dd88886), a model at capacity
 *  (a1c2fcc2), a dropped connection. */
const TRANSIENT_PATTERNS = [
  /\bAPI Error:\s*5\d\d\b/i,
  /\boverloaded_error\b/i,
  /\b529\b.{0,40}\boverloaded\b|\boverloaded\b.{0,40}\b529\b/i,
  /\bserver[- ]side (?:issue|error)\b/i,
  /\b50[0234]\b.{0,20}\b(?:internal server error|bad gateway|service unavailable|gateway time-?out)\b/i,
  /\bno response from (?:the )?api\b/i,
  /\bat capacity\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT)\b/,
] as const;

/** A failure that never gets better by waiting: money, an account, a plan. */
const NEVER_RETRY_RE = /\b(?:credit balance|billing|quota|upgrade (?:your|to) (?:plan|pro))\b/i;

/**
 * Is this run error one that a delayed, unattended retry can fix? Deliberately narrow: a false
 * positive costs a wasted agent turn, a false negative only the Continue the user had before.
 */
export function isTransientAgentError(error: string | undefined): boolean {
  if (!error || NON_AGENT_RE.test(error)) return false;
  const message = error.replace(RUN_ERROR_PREFIX_RE, '');
  if (isUsageLimitMessage(message) || NEVER_RETRY_RE.test(message)) return false;
  if (REFRESH_RACE_RE.test(message)) return true;
  if (isRuntimeProviderAuthFailure(message)) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}
