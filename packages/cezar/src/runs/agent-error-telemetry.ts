import { classifyAgentFailure } from '../core/agent-failure-class.ts';
import { isOutdatedBackendError, unwrapJsonErrorEnvelope } from '../core/agent-errors.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { parseUsageLimit } from '../core/usage-limit.ts';
import { reportError, telemetryEnabled } from '../telemetry.ts';

/** The prefixes `run.ts` and the runners put in front of the agent's own text. */
const PREFIX_RE = /^(?:continue failed: |step "[^"]*" failed: )/;
/** Restart bookkeeping (`recover()`), not something the agent said. */
const INTERRUPTED_RE = /^interrupted — /;

/** Masking cost is linear only on bounded input — stderr tails and result text arrive unbounded. */
const MAX_SCRUB_INPUT = 2_048;
const TOKEN_RE = /[^\s()[\]{}<>,;]+/g;

/** One whitespace/bracket-delimited token, classified without backtracking regexes. */
function maskToken(token: string): string {
  const at = token.indexOf('@');
  if (at > 0 && token.indexOf('.', at + 2) !== -1) return '<email>';
  if (token.includes('/') || token.includes('\\')) return '<path>';
  return token;
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
// Bounded on both sides by non-digits so `127.0.0.1:3000` is not read as the clock `1:30`.
const CLOCK =
  '(?<![\\d.])\\d{1,2}(?::\\d{2}){1,2}(?!\\d)(?:\\s*[ap]\\.?m\\.?)?|(?<![\\d.])\\d{1,2}\\s*[ap]\\.?m\\.?(?!\\w)';
/** A reset instant — `3:10pm (UTC)`, `Oct 24, 9am (Europe/Warsaw)`, ISO, the `|<epoch>` marker —
 *  with the zone it names: one per window and per user, so it split one limit into many groups. */
const INSTANT_RE = new RegExp(
  `\\b\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?` +
    `|\\b(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:at\\s+)?)?(?:${CLOCK})(?:\\s*\\([^()\\n]{1,64}\\))?`,
  'gi',
);
const EPOCH_MARKER_RE = /\|\s*\d{9,16}\b/g;
const DELAY_RE = /\b\d{1,7}(\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b)/gi;

/** An agent's error text without the user's data it may quote: quoted values, emails, URLs and
 *  slash-bearing tokens (paths, branches, `owner/repo`), and without the instants and delays that
 *  vary per occurrence. Unlike the toast scrubber the text after `: ` stays — in a vendor's message
 *  that is usually the part worth reading. */
export function scrubAgentErrorMessage(message: string, backend: string): string {
  // A JSON envelope's keys are quoted strings the masker would turn into `{<value>:<value>…}`
  // (36b68a95, eb4b12dc): read it as `<type>: <message>` first.
  return unwrapJsonErrorEnvelope(message)
    .slice(0, MAX_SCRUB_INPUT)
    .replace(PREFIX_RE, '')
    .replace(new RegExp(`^${backend}: `, 'i'), '')
    .replace(INSTANT_RE, '<time>')
    .replace(EPOCH_MARKER_RE, '|<time>')
    .replace(DELAY_RE, '<n>$1')
    .replace(/“[^”]*”|‘[^’]*’|"[^"]*"|`[^`]*`|(?<!\w)'[^'\n]+'(?!\w)/g, '<value>')
    // A URL runs to the next whitespace — its query may carry `,` `;` or brackets (linear: nothing follows `\S+`).
    .replace(/\bhttps?:\/\/\S+/gi, '<url>')
    .replace(TOKEN_RE, maskToken)
    .trim()
    .slice(0, 300);
}

/** Every agent error the thread shows in red (`error`, `session.error`) is one error report, so
 *  each distinct message becomes its own group — the v1 and v2 twins of one failure share a
 *  message and are throttled into one report. Not a bug, so never reported: account and
 *  conversation state (`task_failed`'s kind counts it, the thread explains it), and a transient
 *  failure until the run engine gives up retrying it (`transientOutcome`). */
export function reportAgentError(
  backend: string | undefined,
  event: { type: string; message: string; fatal?: unknown },
  opts: { transientOutcome?: 'not_retried' | 'retries_exhausted' | 'resume_refused' } = {},
): void {
  // Without consent there is nothing to send, so skip the masking work on the event path too.
  if (!telemetryEnabled() || INTERRUPTED_RE.test(event.message)) return;
  const failure = classifyAgentFailure(event.message);
  if (failure === 'auth' || failure === 'billing' || failure === 'context_too_large' || failure === 'disk_full') return;
  // A limit auto-resume can schedule is the account's state (#1438); one it cannot read a reset
  // from still lands in ONE coded group — each phrasing there is a parser gap to close.
  const unparsedLimit = failure === 'usage_limit' && parseUsageLimit(event.message) === null;
  if (failure === 'usage_limit' && !unparsedLimit) return;
  if (failure === 'transient' && opts.transientOutcome === undefined) return;
  const id = (RUNNER_IDS as readonly string[]).includes(backend ?? '') ? backend! : 'unknown';
  const masked = scrubAgentErrorMessage(event.message, id);
  if (masked === '') return;
  const error = new Error(`${id}: ${masked}`);
  error.name = 'AgentError';
  // No stack: it would be cezar's own frames, and the panel then groups by the message.
  error.stack = undefined;
  reportError(
    error,
    {
      'agent.backend': id,
      'agent.event': event.type,
      ...(typeof event.fatal === 'boolean' ? { 'agent.fatal': event.fatal } : {}),
      'agent.outdated': isOutdatedBackendError(event.message),
      ...(opts.transientOutcome ? { 'agent.transient': opts.transientOutcome } : {}),
    },
    unparsedLimit ? { code: 'usage_limit_unparsed' } : {},
  );
}
