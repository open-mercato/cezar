import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { runDispatch } from '@/lib/scheduler/run-dispatch';
import { requireCronSecret } from '@/lib/scheduler/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Phase 3c dispatcher (docs §3.7). The route is a thin auth shim around
// `runDispatch` so the same logic can be driven by either an HTTP cron
// (Vercel `vercel.json` schedules) or the in-process scheduler used in
// self-hosted Node deployments (see `lib/scheduler/in-process-scheduler.ts`).
export async function GET(req: Request) {
  const unauthorized = requireCronSecret(req);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const result = await runDispatch(supabase);
  if (result.error) return NextResponse.json(result, { status: 500 });
  return NextResponse.json(result);
}
