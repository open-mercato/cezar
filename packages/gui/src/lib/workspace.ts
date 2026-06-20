import { cache } from 'react';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from './supabase/server';
import type { Database, WorkspaceRole } from './supabase/types';

const WORKSPACE_COOKIE = 'cezar_workspace_id';

export interface ActiveWorkspace {
  id: string;
  slug: string;
  name: string;
  repoOwner: string;
  repoName: string;
  role: WorkspaceRole;
}

export interface WorkspaceListItem {
  id: string;
  slug: string;
  name: string;
  repoOwner: string;
  repoName: string;
  role: WorkspaceRole;
}

export const getActiveWorkspace = cache(async (): Promise<ActiveWorkspace | null> => {
  const cookieStore = await cookies();
  const stored = cookieStore.get(WORKSPACE_COOKIE)?.value;
  const supabase = await createSupabaseServerClient();

  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(id, slug, name, repo_owner, repo_name)')
    .order('joined_at', { ascending: true });

  if (!memberships || memberships.length === 0) return null;

  type MemberRow = (typeof memberships)[number];
  const match = stored
    ? memberships.find((m: MemberRow) => (m.workspaces as any)?.id === stored)
    : undefined;
  const chosen = match ?? memberships[0];
  const ws = chosen.workspaces as any;
  if (!ws) return null;

  return {
    id: ws.id,
    slug: ws.slug,
    name: ws.name,
    repoOwner: ws.repo_owner,
    repoName: ws.repo_name,
    role: chosen.role,
  };
});

export const listWorkspaces = cache(async (): Promise<WorkspaceListItem[]> => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(id, slug, name, repo_owner, repo_name)')
    .order('joined_at', { ascending: true });

  if (!data) return [];

  return data
    .map((m) => {
      const ws = m.workspaces as any;
      if (!ws) return null;
      return {
        id: ws.id,
        slug: ws.slug,
        name: ws.name,
        repoOwner: ws.repo_owner,
        repoName: ws.repo_name,
        role: m.role,
      };
    })
    .filter((w): w is WorkspaceListItem => w !== null);
});

export async function setActiveWorkspace(workspaceId: string) {
  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
}
