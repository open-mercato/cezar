/**
 * Reasoning effort on the runner seam (user feedback 2026-07-24): one neutral
 * four-tier scale, mapped per backend to its own dial. Pure vocabulary +
 * mappings — no runner coupling, so both runners and the harness driver share
 * one tested source of truth.
 *
 * Per backend:
 *  - claude — the CLI reads a thinking-token budget from `MAX_THINKING_TOKENS`;
 *    the tiers map to budgets (max stays under the 64k cap).
 *  - codex — the app-server takes a reasoning-effort level on its thread
 *    overrides; `max` maps to codex's own top tier `xhigh`.
 *  - opencode — no documented per-session channel in version 1; the spec field
 *    is deliberately ignored there (never guessed).
 */

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];

/** Claude thinking-token budget for a tier, or null when unset (backend default). */
export function thinkingBudgetFor(effort: ReasoningEffort | undefined): number | null {
  if (effort === undefined) return null;
  return { low: 4096, medium: 16384, high: 32768, max: 63999 }[effort];
}

/** Codex reasoning-effort level for a tier, or null when unset. */
export function codexReasoningEffortOf(
  effort: ReasoningEffort | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | null {
  if (effort === undefined) return null;
  return effort === 'max' ? 'xhigh' : effort;
}
