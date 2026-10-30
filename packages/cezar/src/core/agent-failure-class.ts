/**
 * Why an agent CLI's terminal error happened, when the reason is not a bug in the agent or in
 * cezar: the provider was briefly unavailable (`transient`), or the account / conversation is in
 * a state only the user can change. The run engine retries the first and explains the rest; the
 * telemetry reporter keeps both out of the AgentError groups (fingerprints in the fixtures).
 *
 * Narrow by design: a false `transient` buys a retry against a provider that will refuse again,
 * so every transient pattern names a phrasing an agent CLI really prints for a passing outage.
 */

import { isDiskFullError } from '../disk-space.ts';
import { isCopilotAuthFailure } from './copilot-ui-mapper.ts';
import { isRuntimeProviderAuthFailure } from './provider-auth.ts';
import { isUsageLimitMessage } from './usage-limit.ts';

export type AgentFailureClass = 'transient' | 'auth' | 'billing' | 'usage_limit' | 'context_too_large' | 'disk_full' | 'other';

/** The prefixes `run.ts` puts in front of the agent's own error. */
const RUN_ERROR_PREFIX_RE = /^(?:continue failed: |step "[^"]*" failed: )/;

/** Claude Code losing the OAuth refresh race to another of its processes on the same login (204c5e03)
 *  — cezar's own parallelism causes it, and the CLI itself says to retry in a minute. */
const OAUTH_REFRESH_RACE_RE = /\banother claude code process is refreshing\b/i;

const BILLING_RES = [
  /\bcredit balance is too low\b/i, // claude (7d0a1d6d)
  /\binsufficient[_\s]quota\b/i, // OpenAI-backed codex/opencode
  /\bexceeded your current quota\b/i,
] as const;

const CONTEXT_TOO_LARGE_RES = [
  /\brequest too large \(max \d+\s?mb\)/i, // claude (13023969)
  /\bprompt is too long\b/i, // claude
  /\bcontext_length_exceeded\b/i, // OpenAI-backed codex/opencode
  /\bexceeds the context window\b/i,
] as const;

const TRANSIENT_RES = [
  /\b529\b[^\n]{0,20}\boverloaded\b/i, // claude (76aa46a9)
  /\boverloaded_error\b/i,
  /\b(?:provider|server|api|model) is (?:currently )?overloaded\b/i, // opencode retry status
  /\bno response from api\b/i, // claude (9dd88886)
  /\bmodel is (?:currently )?at capacity\b/i, // codex (a1c2fcc2)
  /\bworkspace routing discovery failed\b/i, // codex remote compact (5919c71a)
  /\bstream disconnected before completion\b/i, // codex
  /\bapi error:\s*(?:500|502|503|504)\b(?!\s*auth_unavailable)/i, // claude's upstream 5xx
] as const;

/** Classify an agent's terminal error text. Never throws; `other` for anything not recognised. */
export function classifyAgentFailure(error: string | undefined): AgentFailureClass {
  const message = (error ?? '').replace(RUN_ERROR_PREFIX_RE, '');
  if (message === '') return 'other';
  // The host, not the provider: a full disk (9cdcedc3) — retrying would only fail again.
  if (isDiskFullError(message)) return 'disk_full';
  // Before auth: "Failed to refresh OAuth token" reads like a dead login and is not one.
  if (OAUTH_REFRESH_RACE_RE.test(message)) return 'transient';
  // Before usage_limit: "out of credits" is in its phrase set, but a top-up is not a reset window.
  if (BILLING_RES.some((re) => re.test(message))) return 'billing';
  if (isUsageLimitMessage(message)) return 'usage_limit';
  if (CONTEXT_TOO_LARGE_RES.some((re) => re.test(message))) return 'context_too_large';
  if (isRuntimeProviderAuthFailure(message) || isCopilotAuthFailure(message)) return 'auth';
  if (TRANSIENT_RES.some((re) => re.test(message))) return 'transient';
  return 'other';
}

/** Automatic retries of a transient failure per streak (a completed turn ends the streak). */
export const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = [30_000, 120_000] as const;
/** The CLI's own advice for the refresh race: "retry in a minute". */
const OAUTH_REFRESH_RACE_MIN_MS = 60_000;

/** Runs that lose the race together would retry in lockstep and lose it again without a spread. */
const OAUTH_REFRESH_RACE_JITTER_MS = 45_000;
/** The race gets one more retry than other transient failures: it is cezar's own parallelism. */
const OAUTH_REFRESH_RACE_MAX_RETRIES = 3;

/** The wait before retry `attempt` (1-based) of a transient failure; `random` is injectable for tests. */
export function transientRetryDelayMs(attempt: number, error: string | undefined, random: () => number = Math.random): number {
  const base = TRANSIENT_BACKOFF_MS[Math.min(Math.max(attempt, 1), TRANSIENT_BACKOFF_MS.length) - 1]!;
  if (!OAUTH_REFRESH_RACE_RE.test(error ?? '')) return base;
  return Math.max(base, OAUTH_REFRESH_RACE_MIN_MS) + Math.floor(random() * OAUTH_REFRESH_RACE_JITTER_MS);
}

/** How many automatic retries one streak of this transient failure earns. */
export function transientRetryCap(error: string | undefined): number {
  return OAUTH_REFRESH_RACE_RE.test(error ?? '') ? OAUTH_REFRESH_RACE_MAX_RETRIES : MAX_TRANSIENT_RETRIES;
}

/** Whether the failure is the OAuth refresh race — its exhaustion message names the cause. */
export function isOauthRefreshRace(error: string | undefined): boolean {
  return OAUTH_REFRESH_RACE_RE.test(error ?? '');
}

const BACKEND_NAMES: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', copilot: 'Copilot',
};

/**
 * What the user can do about an account- or conversation-state failure, or undefined when the
 * class has nothing to add (a transient failure, a bug, a usage limit whose reset the provider named —
 * the auto-resume lines already speak for that one).
 */
export function accountStateHint(
  failure: AgentFailureClass,
  backend: string | undefined,
  opts: { resetKnown?: boolean } = {},
): string | undefined {
  const name = BACKEND_NAMES[backend ?? ''];
  switch (failure) {
    case 'auth':
      return `${name ?? 'The agent'} is not signed in or its login expired — sign in again (Settings → Agent accounts, or the agent's own login command in a terminal), then Continue this task`;
    case 'billing':
      return `the ${name ?? 'agent'} account has run out of credit — top up its balance or switch this task to another account, then Continue`;
    case 'usage_limit':
      return opts.resetKnown
        ? undefined
        : `the ${name ?? 'agent'} account reached its usage limit and did not say when it resets — Continue once the limit lifts, or switch this task to another account`;
    case 'context_too_large':
      return `this conversation grew past what ${name ?? 'the agent'} accepts in one request (accumulated images and attachments count) — start a new task from this one's handoff instead of continuing it`;
    default:
      return undefined;
  }
}
