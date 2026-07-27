// Anthropic bills cache-read input at ~10% of standard input cost and cache
// creation at ~125%. Weighting raw counts by these keeps the token number
// shown in the cockpit roughly proportional to dollar cost.
export const CACHE_READ_WEIGHT = 0.1;
export const CACHE_CREATION_WEIGHT = 1.25;

/** A loosely-typed usage record as emitted by the claude CLI stream. */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Collapse a raw usage record into a single cost-weighted token count. */
export function costWeightedTokens(usage: RawUsage | undefined | null): number {
  if (!usage) return 0;
  return Math.round(
    (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) * CACHE_CREATION_WEIGHT +
      (usage.cache_read_input_tokens ?? 0) * CACHE_READ_WEIGHT,
  );
}
