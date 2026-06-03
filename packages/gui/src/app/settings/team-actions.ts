'use server';

import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { revalidatePath } from 'next/cache';
import type { WorkspaceRole } from '@/lib/supabase/types';

export interface TeamActionState {
  ok?: boolean;
  error?: string;
}

export async function inviteMember(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace || workspace.role !== 'admin') return { error: 'Admin access required' };

  const email = (formData.get('email') as string)?.trim();
  const role = (formData.get('role') as WorkspaceRole) ?? 'actor';
  if (!email) return { error: 'Email is required' };

  const supabase = createSupabaseAdminClient();

  const { data: users } = await supabase.auth.admin.listUsers();
  const target = users?.users.find((u) => u.email === email);
  if (!target) return { error: `No user found with email "${email}" — they must sign in first` };

  const { error } = await supabase
    .from('workspace_members')
    .insert({ workspace_id: workspace.id, user_id: target.id, role });

  if (error) {
    if (error.code === '23505') return { error: 'User is already a member' };
    return { error: error.message };
  }

  revalidatePath('/settings');
  return { ok: true };
}

export async function changeMemberRole(
  userId: string,
  role: WorkspaceRole,
): Promise<TeamActionState> {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace || workspace.role !== 'admin') return { error: 'Admin access required' };
  if (userId === user.id) return { error: 'Cannot change your own role' };

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('workspace_members')
    .update({ role })
    .eq('workspace_id', workspace.id)
    .eq('user_id', userId);

  if (error) return { error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}

export async function removeMember(userId: string): Promise<TeamActionState> {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace || workspace.role !== 'admin') return { error: 'Admin access required' };
  if (userId === user.id) return { error: 'Cannot remove yourself' };

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspace.id)
    .eq('user_id', userId);

  if (error) return { error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}
