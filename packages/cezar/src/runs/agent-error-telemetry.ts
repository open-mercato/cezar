import { isOutdatedBackendError } from '../core/agent-errors.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
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

/** An agent's error text without the user's data it may quote: quoted values, emails, URLs and
 *  slash-bearing tokens (paths, branches, `owner/repo`). Unlike the toast scrubber the text after
 *  `: ` stays — in a vendor's message that is usually the part worth reading. */
export function scrubAgentErrorMessage(message: string, backend: string): string {
  return message
    .slice(0, MAX_SCRUB_INPUT)
    .replace(PREFIX_RE, '')
    .replace(new RegExp(`^${backend}: `, 'i'), '')
    .replace(/“[^”]*”|‘[^’]*’|"[^"]*"|`[^`]*`|(?<!\w)'[^'\n]+'(?!\w)/g, '<value>')
    // A URL runs to the next whitespace — its query may carry `,` `;` or brackets (linear: nothing follows `\S+`).
    .replace(/\bhttps?:\/\/\S+/gi, '<url>')
    .replace(TOKEN_RE, maskToken)
    .trim()
    .slice(0, 300);
}

/** Every agent error the thread shows in red (`error`, `session.error`) is one error report, so
 *  each distinct message becomes its own group — the v1 and v2 twins of one failure share a
 *  message and are throttled into one report. */
export function reportAgentError(
  backend: string | undefined,
  event: { type: string; message: string; fatal?: unknown },
): void {
  // Without consent there is nothing to send, so skip the masking work on the event path too.
  if (!telemetryEnabled() || INTERRUPTED_RE.test(event.message)) return;
  const id = (RUNNER_IDS as readonly string[]).includes(backend ?? '') ? backend! : 'unknown';
  const masked = scrubAgentErrorMessage(event.message, id);
  if (masked === '') return;
  const error = new Error(`${id}: ${masked}`);
  error.name = 'AgentError';
  // No stack: it would be cezar's own frames, and the panel then groups by the message.
  error.stack = undefined;
  reportError(error, {
    'agent.backend': id,
    'agent.event': event.type,
    ...(typeof event.fatal === 'boolean' ? { 'agent.fatal': event.fatal } : {}),
    'agent.outdated': isOutdatedBackendError(event.message),
  });
}
