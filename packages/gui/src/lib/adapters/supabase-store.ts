import type { SupabaseClient } from '@supabase/supabase-js';
import type { StorePort, Store, StoredIssue } from '@cezar/core';
import type { Database } from '../supabase/types';

type WorkspaceRow = Database['public']['Tables']['workspaces']['Row'];
type IssueRow = Database['public']['Tables']['issues']['Row'];

/**
 * Translates CEZAR's in-memory Store to/from Supabase.
 *
 * load()  — materializes the full store for a single workspace.
 * save()  — upserts the workspace meta + each issue.
 *
 * Phase 0: read path only. Writes stubbed so the adapter contract compiles
 * and the Issues page can render data.
 */
export class SupabaseStoreAdapter implements StorePort {
  constructor(
    private readonly supabase: SupabaseClient<Database>,
    private readonly workspaceId: string,
  ) {}

  async load(): Promise<Store> {
    const [{ data: ws, error: wsErr }, { data: issues, error: issuesErr }] = await Promise.all([
      this.supabase.from('workspaces').select('*').eq('id', this.workspaceId).single(),
      this.supabase
        .from('issues')
        .select('*')
        .eq('workspace_id', this.workspaceId)
        .order('number', { ascending: false }),
    ]);

    if (wsErr) throw new Error(`Workspace load failed: ${wsErr.message}`);
    if (issuesErr) throw new Error(`Issues load failed: ${issuesErr.message}`);
    if (!ws) throw new Error(`Workspace ${this.workspaceId} not found`);

    const store: Store = {
      meta: metaFromWorkspace(ws),
      issues: (issues ?? []).map(rowToIssue),
    };

    const { StoreSchema } = await import('@cezar/core');
    return StoreSchema.parse(store);
  }

  async save(store: Store): Promise<void> {
    const { error: wsErr } = await this.supabase
      .from('workspaces')
      .update({
        meta: {
          lastSyncedAt: store.meta.lastSyncedAt,
          fullSyncedAt: store.meta.fullSyncedAt,
          totalFetched: store.meta.totalFetched,
          version: store.meta.version,
          orgMembers: store.meta.orgMembers,
          orgMembersFetchedAt: store.meta.orgMembersFetchedAt,
        },
      })
      .eq('id', this.workspaceId);
    if (wsErr) throw new Error(`Workspace save failed: ${wsErr.message}`);

    if (store.issues.length === 0) return;

    const rows = store.issues.map((issue) => issueToRow(issue, this.workspaceId));
    const { error } = await this.supabase
      .from('issues')
      .upsert(rows, { onConflict: 'workspace_id,number' });
    if (error) throw new Error(`Issues save failed: ${error.message}`);
  }
}

function metaFromWorkspace(ws: WorkspaceRow): Store['meta'] {
  const raw = (ws.meta ?? {}) as Partial<Store['meta']>;
  return {
    owner: ws.repo_owner,
    repo: ws.repo_name,
    lastSyncedAt: raw.lastSyncedAt ?? null,
    fullSyncedAt: raw.fullSyncedAt ?? null,
    totalFetched: raw.totalFetched ?? 0,
    version: 1,
    orgMembers: raw.orgMembers ?? [],
    orgMembersFetchedAt: raw.orgMembersFetchedAt ?? null,
  };
}

function rowToIssue(row: IssueRow): StoredIssue {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    labels: row.labels,
    assignees: row.assignees,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    htmlUrl: row.html_url,
    contentHash: row.content_hash,
    commentCount: row.comment_count,
    reactions: row.reactions,
    comments: (row.comments ?? []) as StoredIssue['comments'],
    commentsFetchedAt: row.comments_fetched_at,
    digest: row.digest as StoredIssue['digest'],
    analysis: (row.analysis ?? {}) as StoredIssue['analysis'],
  };
}

function issueToRow(
  issue: StoredIssue,
  workspaceId: string,
): Database['public']['Tables']['issues']['Insert'] {
  return {
    workspace_id: workspaceId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    assignees: issue.assignees,
    author: issue.author,
    html_url: issue.htmlUrl,
    content_hash: issue.contentHash,
    comment_count: issue.commentCount,
    reactions: issue.reactions,
    comments: issue.comments,
    comments_fetched_at: issue.commentsFetchedAt,
    digest: issue.digest,
    analysis: issue.analysis,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}
