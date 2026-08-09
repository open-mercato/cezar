import { z } from 'zod';

/**
 * A provider-discovered reasoning level for a single agent turn.
 *
 * This deliberately stays free-form: the Codex App Server advertises the values each model
 * supports, and Cezar must preserve future values without releasing a new contract package.
 */
export const reasoningEffortSchema = z.string().trim().min(1).max(64);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
