import { z } from 'zod';
import type { Runner } from './health.ts';

/**
 * A provider-discovered reasoning level for a single agent turn.
 *
 * This deliberately stays free-form: the Codex App Server advertises the values each model
 * supports, and Cezar must preserve future values without releasing a new contract package.
 */
export const reasoningEffortSchema = z.string().trim().min(1).max(64);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/** Runners with a native per-session effort control: Codex `turn/start.effort`, Claude `--effort` (#808). */
export const REASONING_EFFORT_RUNNERS = ['codex', 'claude'] as const satisfies readonly Runner[];

export function runnerSupportsReasoningEffort(runner: string): boolean {
  return (REASONING_EFFORT_RUNNERS as readonly string[]).includes(runner);
}
