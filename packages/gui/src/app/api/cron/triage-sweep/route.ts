import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { runTriageSweep } from '@/lib/scheduler/run-triage-sweep';
import { requireCronSecret } from '@/lib/scheduler/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Phase 5 poll fallback (docs §3.7). Thin auth shim around `runTriageSweep` —
// same logic is also called by the in-process scheduler in self-hosted Node
// deployments (see `lib/scheduler/in-process-scheduler.ts`).
export async function GET(req: Request) {
  const unauthorized = requireCronSecret(req);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const result = await runTriageSweep(supabase);
  if (result.error) return NextResponse.json(result, { status: 500 });
  return NextResponse.json(result);
}
