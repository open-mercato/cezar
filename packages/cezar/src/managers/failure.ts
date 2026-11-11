import { agentBackendName, classifyAgentFailure } from '../core/agent-failure-class.ts';

/**
 * Why a manager turn failed, read from the agent's own error (spec 2026-10-31-managers § Turns).
 * The CLI's exit line ("claude CLI exited with code 1") says nothing a user can act on; the cause
 * it printed first does, and it decides whether one retry can help.
 */
export type ManagerFailureKind =
  | 'auth'
  | 'billing'
  | 'usage-limit'
  | 'session'
  | 'network'
  | 'busy'
  | 'missing-cli'
  | 'unknown';

const NETWORK_RE = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH)\b|can'?t reach the api|fetch failed|socket hang up|network (?:error|is unreachable)/i;
/** A transcript the CLI cannot reopen, or one another process holds. */
const SESSION_RE = /no conversation found|session (?:id )?(?:\S+ )?(?:is )?(?:already )?(?:in use|locked)|session not found/i;
const MISSING_CLI_RE = /\bspawn \S+ ENOENT\b|command not found|is not installed|not found on PATH/i;
/** The bare exit line a CLI leaves when it printed its reason elsewhere (or nowhere). */
const EXIT_LINE_RE = /^\S+ CLI exited with code -?\d+(?: \([^)]*\))?(?:\s+—\s+)?/;

/** Longest reply still read as the CLI's error echo rather than an answer. */
const ECHO_MAX = 500;

/** The error, unless it is a bare exit line and the short reply names a known cause (the CLI's echo). */
export function failureCause(error: string, text: string): string {
  const echo = text.trim();
  const bare = EXIT_LINE_RE.test(error.trim()) && error.trim().replace(EXIT_LINE_RE, '') === '';
  return bare && echo && echo.length <= ECHO_MAX && classifyManagerFailure(echo) !== 'unknown' ? echo : error;
}

export function classifyManagerFailure(cause: string): ManagerFailureKind {
  switch (classifyAgentFailure(cause)) {
    case 'auth':
      return 'auth';
    case 'billing':
      return 'billing';
    case 'usage_limit':
      return 'usage-limit';
    // A watch resumes one transcript forever; past the context window only a fresh one answers.
    case 'context_too_large':
      return 'session';
    case 'transient':
      return 'busy';
    default:
      break;
  }
  if (SESSION_RE.test(cause)) return 'session';
  if (MISSING_CLI_RE.test(cause)) return 'missing-cli';
  if (NETWORK_RE.test(cause)) return 'network';
  return 'unknown';
}

/**
 * How one retry may help: `fresh` drops the resumed transcript, `again` repeats the same call after
 * a pause, `none` would only fail the same way (the user has to act first).
 */
export function retryPlan(kind: ManagerFailureKind, resumed: boolean): 'fresh' | 'again' | 'none' {
  switch (kind) {
    case 'session':
      return resumed ? 'fresh' : 'none';
    // Nothing says the transcript is fine: a fresh one is the safer second try.
    case 'unknown':
      return resumed ? 'fresh' : 'again';
    case 'network':
    case 'busy':
      return 'again';
    default:
      return 'none';
  }
}

/** One plain line saying what happened and what to do. Never the CLI's exit line. */
export function managerFailureMessage(
  kind: ManagerFailureKind,
  cause: string,
  runner: string | undefined,
  resetAt?: Date,
): string {
  const name = agentBackendName(runner) ?? 'The agent';
  switch (kind) {
    case 'auth':
      return `Sign in to ${name} again: run its login in a terminal, or reconnect the account in Settings → Agent accounts.`;
    case 'billing':
      return `The ${name} account is out of credit. Top it up, or pick another account in this manager's settings.`;
    case 'usage-limit':
      return resetAt
        ? `Usage limit reached until ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(resetAt)}.`
        : 'Usage limit reached. Try again once it resets.';
    case 'session':
      return `${name} could not continue this conversation. Try again; the next turn starts a fresh one.`;
    case 'network':
      return `Can't reach ${name}'s servers. Check this computer's internet connection.`;
    case 'busy':
      return `${name}'s servers are busy. Try again in a minute.`;
    case 'missing-cli':
      return `${name} could not be started. Check that it is installed and runs in a terminal.`;
    default: {
      const detail = cause.trim().replace(EXIT_LINE_RE, '').trim();
      return detail
        ? `${name} stopped before answering: ${detail}`
        : `${name} stopped before answering. Try again; if it keeps happening, check that it runs in a terminal.`;
    }
  }
}
