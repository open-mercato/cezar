import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Returns the latest label-analysis row for the active workspace plus the
 * count of accepted workspace_labels (so the /settings/labels tab can poll
 * without two round trips). Membership is enforced by RLS via the active
 * workspace's role check — admin not required for read.
 */
export async function GET(): Promise<NextResponse> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return NextResponse.json({ error: 'no active workspace' }, { status: 400 });

  const supabase = createSupabaseAdminClient();
  const { data: analyses } = await supabase
    .from('workspace_label_analyses')
    .select(
      'id, status, started_at, finished_at, result, error, inputs_summary, created_at, updated_at',
    )
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(1);

  const { count } = await supabase
    .from('workspace_labels')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspace.id);

  return NextResponse.json({
    analysis: analyses?.[0] ?? null,
    acceptedLabelCount: count ?? 0,
  });
}
