import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { RunnerRegisterRequestSchema, type RunnerRegisterResponse } from '@cezar/core';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { hashRunnerToken, invalidateRunnerAuth } from '../_auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/runner/register — join-token runner registration, the only way
 * a runner row comes into existence (migration 20260706075137).
 *
 * `Authorization: Bearer <join-token>` where the join token was minted by a
 * workspace member in Settings → Runners. Body: `RunnerRegisterRequest`.
 * The resulting runner is owned by the token's creator — job routing then
 * sends that user's requested jobs to their runners only.
 *
 * Registration is idempotent per (workspace, owner, name): re-registering
 * re-keys the existing row (the previous runner token stops working) instead
 * of piling up duplicates, so a recreated container converges on one row.
 *
 * The join token can only create/re-key runner rows — it can never claim
 * jobs (which carry GitHub tokens); only the returned per-runner bearer can.
 */
export async function POST(req: Request) {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return NextResponse.json({ error: 'missing join token' }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const { data: joinToken, error: jtErr } = await admin
    .from('runner_join_tokens')
    .select('id, workspace_id, created_by, created_by_login, revoked_at')
    .eq('token_hash', hashRunnerToken(match[1]))
    .maybeSingle();
  if (jtErr) return NextResponse.json({ error: 'auth lookup failed' }, { status: 500 });
  if (!joinToken || joinToken.revoked_at) {
    return NextResponse.json({ error: 'unknown or revoked join token' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const parsed = RunnerRegisterRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `invalid register request: ${parsed.error.message}` },
      { status: 400 },
    );
  }
  const { name, kind, backends } = parsed.data;

  const token = randomBytes(32).toString('hex');
  const tokenHash = hashRunnerToken(token);

  // Re-key the existing (workspace, owner, name) row if there is one; the
  // partial unique index runners_workspace_owner_name_uniq guarantees at
  // most one. Grab the old hash first so its cached auth entry dies with it.
  const { data: existing, error: exErr } = await admin
    .from('runners')
    .select('id, token_hash')
    .eq('workspace_id', joinToken.workspace_id)
    .eq('owner_user_id', joinToken.created_by)
    .eq('name', name)
    .maybeSingle();
  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });

  let runnerId: string;
  if (existing) {
    const { error } = await admin
      .from('runners')
      .update({
        kind,
        backends,
        token_hash: tokenHash,
        owner_login: joinToken.created_by_login,
        join_token_id: joinToken.id,
        status: 'offline',
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (existing.token_hash) invalidateRunnerAuth(existing.token_hash);
    runnerId = existing.id;
  } else {
    const { data: inserted, error } = await admin
      .from('runners')
      .insert({
        workspace_id: joinToken.workspace_id,
        name,
        kind,
        backends,
        models: [],
        token_hash: tokenHash,
        status: 'offline',
        owner_user_id: joinToken.created_by,
        owner_login: joinToken.created_by_login,
        join_token_id: joinToken.id,
      })
      .select('id')
      .single();
    if (error?.code === '23505') {
      // Two daemons raced the same (workspace, owner, name) — one row won the
      // unique index. This register's token was never returned to anyone, so
      // just tell the caller to retry (it will hit the re-key branch).
      return NextResponse.json(
        { error: 'registration raced a duplicate — retry' },
        { status: 409 },
      );
    }
    if (error || !inserted) {
      return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 });
    }
    runnerId = inserted.id;
  }

  const response: RunnerRegisterResponse = {
    runnerId,
    token,
    workspaceId: joinToken.workspace_id,
    ownerLogin: joinToken.created_by_login,
    reRegistered: Boolean(existing),
  };
  return NextResponse.json(response);
}
