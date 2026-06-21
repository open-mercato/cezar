import { GitHubApiError } from '@cezar/core';
import type { SyncErrorKind } from '@/lib/supabase/types';

// ─────────────────────────────────────────────────────────────────────
// §3: Stale & actionable states — classify a caught sync error into a
// `SyncErrorKind` so the indicator can show a recovery CTA instead of a raw
// message. Core now throws a `GitHubApiError` carrying the precise `kind`
// (auth / permission / primary- & secondary-rate-limit / not-found), so we map
// that directly; the `.status` and message fallbacks cover any un-normalized
// error that bubbles up (`GitHubAppService#getInstallationToken` etc.).
// ─────────────────────────────────────────────────────────────────────
export function classifySyncError(err: unknown): SyncErrorKind {
  // Precise path: core's classified GitHub error.
  if (err instanceof GitHubApiError) {
    switch (err.kind) {
      case 'auth':
      // A permission gap (App lacks Issues/PRs write) is recovered the same
      // way as auth — reconnect / re-accept the install — so route it to 'auth'.
      case 'permission':
        return 'auth';
      case 'primary-rate-limit':
      case 'secondary-rate-limit':
        return 'rate_limit';
      case 'not-found':
        return 'not_found';
      default:
        return 'unknown';
    }
  }

  // Raw Octokit errors carry a numeric `.status`; map it when present.
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (status === 401) return 'auth';
    if (status === 403 || status === 429) return 'rate_limit';
    if (status === 404) return 'not_found';
  }

  const message = err instanceof Error ? err.message : String(err ?? '');

  // 401 → invalid/revoked token; App-uninstalled is also an auth-recovery case.
  if (
    message.includes('Invalid GitHub token') ||
    message.includes('Invalid or expired GitHub token') ||
    message.includes('permission missing') ||
    message.includes('GitHub App is not installed')
  ) {
    return 'auth';
  }
  // Rate limits (new precise messages + the legacy combined one).
  if (
    message.includes('rate limit exceeded or access forbidden') ||
    message.includes('secondary (anti-burst) rate limit') ||
    message.includes('API rate limit exhausted')
  ) {
    return 'rate_limit';
  }
  // 404 → "… not found or is inaccessible." (legacy: "not found or inaccessible")
  if (
    message.includes('not found or inaccessible') ||
    message.includes('not found or is inaccessible')
  ) {
    return 'not_found';
  }
  return 'unknown';
}
