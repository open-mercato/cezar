/**
 * Shared abuse guards for the LLM-backed `simulate` routes
 * (`/api/actions/[name]/simulate`, `/api/skills/[name]/simulate`).
 *
 * Both routes accept an arbitrary system prompt from a logged-in workspace
 * member and stream an Anthropic completion back. Without bounds a curious or
 * compromised member can script the endpoint to grind through the shared
 * `ANTHROPIC_API_KEY` budget. These helpers add:
 *   - a per-user sliding-window rate limit (in-memory, best-effort), and
 *   - a hard length cap on the user-supplied prompt.
 */

/** Max bytes for a user-supplied system prompt before we reject the request. */
export const MAX_PROMPT_BYTES = 64 * 1024; // 64 KiB

/** Sliding-window size for the rate limiter. */
const WINDOW_MS = 60_000;
/** Max simulations allowed per user within the window. */
const MAX_PER_WINDOW = 10;

// Best-effort in-memory limiter. Per-instance only (resets on redeploy / is not
// shared across serverless instances), which is acceptable for a cost-abuse
// guard on a logged-in-only feature — it caps the worst case per instance.
const hits = new Map<string, number[]>();

/**
 * Records a hit for `key` and returns whether the caller is within the limit.
 * When over the limit, `retryAfterSec` is the seconds until the oldest hit in
 * the window expires.
 */
export function checkRateLimit(key: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

  if (recent.length >= MAX_PER_WINDOW) {
    const retryAfterSec = Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
    hits.set(key, recent);
    return { ok: false, retryAfterSec };
  }

  recent.push(now);
  hits.set(key, recent);
  return { ok: true, retryAfterSec: 0 };
}

/** True when the prompt exceeds {@link MAX_PROMPT_BYTES}. */
export function isPromptTooLarge(prompt: string): boolean {
  // Byte length, not character length — multibyte chars must count fully.
  return Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES;
}
