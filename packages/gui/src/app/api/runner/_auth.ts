import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/supabase/types';

export type RunnerRow = Database['public']['Tables']['runners']['Row'];

/**
 * Hash a raw runner token for storage/lookup. SHA-256 hex — the Settings →
 * Runners UI (Phase 4b) hashes the same way before storing `token_hash`.
 * (Bearer tokens are already high-entropy random strings, so a plain hash is
 * sufficient here — no salt/KDF needed.)
 */
export function hashRunnerToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Authenticates a runner request by its `Authorization: Bearer <token>` header.
 * On success returns `{ runner, admin }` (an authorized service-role client).
 * On failure returns a 401 `NextResponse` — callers must check `instanceof`.
 *
 * Token-hash → runner row is cached in-process (`RUNNER_AUTH_TTL_MS`). A
 * runner heartbeats every ~10s and posts events sub-second; without the cache
 * every request paid for an extra `SELECT runners` round-trip.
 */
const RUNNER_AUTH_TTL_MS = 30_000;
const runnerAuthCache = new Map<string, { runner: RunnerRow; expiresAt: number }>();

export async function authRunner(
  req: Request,
): Promise<
  { runner: RunnerRow; admin: ReturnType<typeof createSupabaseAdminClient> } | NextResponse
> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return NextResponse.json({ error: 'missing bearer token' }, { status: 401 });
  const tokenHash = hashRunnerToken(match[1]);

  const admin = createSupabaseAdminClient();

  const cached = runnerAuthCache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) {
    return { runner: cached.runner, admin };
  }

  const { data: runner, error } = await admin
    .from('runners')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'auth lookup failed' }, { status: 500 });
  if (!runner) {
    runnerAuthCache.delete(tokenHash);
    return NextResponse.json({ error: 'unknown runner token' }, { status: 401 });
  }
  runnerAuthCache.set(tokenHash, { runner, expiresAt: Date.now() + RUNNER_AUTH_TTL_MS });
  return { runner, admin };
}

/** Drop a cached runner row (e.g. after revoking its token). */
export function invalidateRunnerAuth(tokenHash: string): void {
  runnerAuthCache.delete(tokenHash);
}

/** True if `runner` may act on rows scoped to `workspaceId` (managed runners — null
 * `workspace_id` — may act on any; workspace-scoped runners only their own). */
export function runnerScopesWorkspace(
  runner: RunnerRow,
  workspaceId: string | null | undefined,
): boolean {
  if (runner.workspace_id == null) return true;
  return runner.workspace_id === workspaceId;
}
