import type { z } from 'zod';

// Anthropic bills cache-read input at ~10% of standard input cost and cache
// creation at ~125%. Weighting raw token counts by these multipliers keeps
// budget accounting roughly proportional to dollar cost rather than raw token
// volume. Shared by every runner that surfaces a usage breakdown.
export const CACHE_READ_WEIGHT = 0.1;
export const CACHE_CREATION_WEIGHT = 1.25;

/** A loosely-typed usage record as emitted by the various agent backends. */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Collapse a raw usage record into a single cost-weighted token count. Returns
 * 0 when no usage is present so callers can treat "no telemetry" as "no delta".
 */
export function costWeightedTokens(usage: RawUsage | undefined | null): number {
  if (!usage) return 0;
  return Math.round(
    (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) * CACHE_CREATION_WEIGHT +
      (usage.cache_read_input_tokens ?? 0) * CACHE_READ_WEIGHT,
  );
}

/**
 * Best-effort structured-output extraction. Tries the whole string (after
 * stripping a ```json fence), then walks the text for balanced top-level
 * `{...}` blocks and validates each against the schema, returning the first
 * that parses. Returns null when nothing validates — the caller decides how to
 * recover (retry, prose fallback, hard fail).
 */
export function parseStructured<T>(raw: string, schema: z.ZodSchema<T>): T | null {
  const cleaned = raw
    .replace(/^```(?:json|javascript|js|jsonl)?\s*\n?/im, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
  try {
    return schema.parse(JSON.parse(cleaned));
  } catch {
    for (const candidate of extractJsonObjectCandidates(raw)) {
      try {
        return schema.parse(JSON.parse(candidate));
      } catch {
        continue;
      }
    }
    return null;
  }
}

function extractJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}
