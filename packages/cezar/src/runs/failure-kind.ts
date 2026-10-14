import { isClaudeMissingSessionError } from '../core/claude-cli-runner.ts';
import { isCopilotAuthFailure } from '../core/copilot-ui-mapper.ts';
import { isRuntimeProviderAuthFailure } from '../core/provider-auth.ts';
import { parseUsageLimit } from '../core/usage-limit.ts';

/** `task_failed`'s closed set (#1438): the label never carries the error text itself. */
export type FailureKind = 'missing_session' | 'usage_limit' | 'auth' | 'timeout' | 'other';

/** A runner killed at its timeout, or a session closed for inactivity (`run.ts`). */
const TIMEOUT_RE = /\btimed out after \d+m and was killed\b|\bclosed after (?:\d+m of )?inactivity\b/i;

export function failureKind(error: string | undefined, autoResumeAt?: string): FailureKind {
  const message = error ?? '';
  if (isClaudeMissingSessionError(message)) return 'missing_session';
  if (autoResumeAt !== undefined || parseUsageLimit(message) !== null) return 'usage_limit';
  if (isRuntimeProviderAuthFailure(message) || isCopilotAuthFailure(message)) return 'auth';
  if (TIMEOUT_RE.test(message)) return 'timeout';
  return 'other';
}

export function taskFailedLabel(runner: string | undefined, kind: FailureKind): string {
  return `${runner ?? 'unknown'}:${kind}`;
}
