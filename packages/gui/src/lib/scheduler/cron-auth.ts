import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/**
 * Shared auth guard for the `/api/cron/*` routes. Fails closed: if
 * `CRON_SECRET` is unset (or empty) the route refuses all callers with a 503,
 * so a misconfigured self-hosted `.env` can't turn the cron surface into an
 * unauthenticated lever (mint GitHub tokens, fan out to every workspace, write
 * to Supabase). Mirrors the webhook receiver's 503-until-configured intent.
 *
 * Returns a `NextResponse` to short-circuit the handler, or `null` when the
 * request is authorized and the handler should proceed.
 */
export function requireCronSecret(req: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 });
  }
  const auth = req.headers.get('authorization') ?? '';
  const a = Buffer.from(auth);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
