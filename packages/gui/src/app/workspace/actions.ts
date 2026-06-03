'use server';

import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/auth';
import { setActiveWorkspace } from '@/lib/workspace';
import { redirect } from 'next/navigation';

export async function switchWorkspace(workspaceId: string) {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');

  const supabase = createSupabaseAdminClient();
  const { data: member } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member) throw new Error('Not a member of this workspace');

  await setActiveWorkspace(workspaceId);
  redirect('/dashboard');
}
