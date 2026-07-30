import { Buffer } from 'node:buffer';

/**
 * Harness phases deliberately use fresh sessions, but a fresh session can
 * still be overfilled by one giant task/review packet. Keep enough room for a
 * useful model response and fail before buying a model invocation when the
 * complete serialized prompt is too large.
 */
export const HARNESS_CONTEXT_BUDGET_BYTES = 200_000;
export const HARNESS_OUTPUT_RESERVE_BYTES = 20_000;
export const HARNESS_PROMPT_BUDGET_BYTES =
  HARNESS_CONTEXT_BUDGET_BYTES - HARNESS_OUTPUT_RESERVE_BYTES;

export const HARNESS_RESULT_LIMITS = {
  shortText: 500,
  text: 4_000,
  summary: 20_000,
  path: 1_000,
  paths: 200,
  findings: 50,
  questions: 50,
} as const;

export function promptBytes(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8');
}

export function promptBudgetError(
  prompt: string,
  budgetBytes = HARNESS_PROMPT_BUDGET_BYTES,
): string | null {
  const bytes = promptBytes(prompt);
  return bytes <= budgetBytes
    ? null
    : `phase prompt is ${bytes} bytes, exceeding the ${budgetBytes}-byte input budget ` +
        `(${HARNESS_OUTPUT_RESERVE_BYTES} bytes are reserved for model output); move large context to an artifact and retry`;
}

/** Bounded rendering for durable/user-authored context from an older ledger.
 * The full value remains in the ledger; only the model-facing excerpt is
 * shortened, with an explicit marker instead of silent loss. */
export function promptExcerpt(value: string, maxChars = 20_000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n… [model-facing excerpt truncated; full text is preserved in the harness ledger]`;
}
