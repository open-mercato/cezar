import type { HarnessEffort } from '@open-mercato/cezar-contract';

// Translate the harness's neutral scale before the shared runner seam (spec 2026-07-23).
// Ordinary runs send native Codex levels and never acquire Claude thinking overrides here.

/** Claude thinking-token budget for a tier, or null when unset (backend default). */
export function thinkingBudgetFor(effort: HarnessEffort | undefined): number | null {
  if (effort === undefined) return null;
  return { low: 4096, medium: 16384, high: 32768, max: 63999 }[effort];
}

/** Codex reasoning-effort level for a tier, or null when unset. */
export function codexReasoningEffortOf(
  effort: HarnessEffort | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | null {
  if (effort === undefined) return null;
  return effort === 'max' ? 'xhigh' : effort;
}
