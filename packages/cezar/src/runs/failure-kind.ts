import { classifyAgentFailure } from '../core/agent-failure-class.ts';
import { isClaudeMissingSessionError } from '../core/claude-cli-runner.ts';

/** `task_failed`'s closed set (#1438): the label never carries the error text itself. */
export type FailureKind =
  | 'missing_session' | 'usage_limit' | 'auth' | 'billing' | 'context_too_large' | 'disk_full' | 'transient' | 'timeout' | 'other';

/** The prefixes `run.ts` puts in front of the agent's own error; line-anchored auth patterns need it bare. */
const RUN_ERROR_PREFIX_RE = /^(?:continue failed: |step "[^"]*" failed: )/;
/** Restart bookkeeping (`recover()`), not an agent failure — most of these runs resume at once. */
const INTERRUPTED_RE = /^interrupted — /;
/** A runner or ACP request killed at its timeout, or a session closed for inactivity (`run.ts`). */
const TIMEOUT_RE = /\btimed out after [\d.]+\s?(?:h|m|s)\b|\bclosed after (?:\d+m of )?inactivity\b/i;

/** The kind of a run's failure, or undefined when the transition is not one worth counting. */
export function failureKind(error: string | undefined): FailureKind | undefined {
  const message = (error ?? '').replace(RUN_ERROR_PREFIX_RE, '');
  if (INTERRUPTED_RE.test(message)) return undefined;
  if (isClaudeMissingSessionError(message)) return 'missing_session';
  const failure = classifyAgentFailure(message);
  if (failure !== 'other') return failure;
  if (TIMEOUT_RE.test(message)) return 'timeout';
  return 'other';
}

export function taskFailedLabel(runner: string | undefined, kind: FailureKind): string {
  return `${runner ?? 'unknown'}:${kind}`;
}
