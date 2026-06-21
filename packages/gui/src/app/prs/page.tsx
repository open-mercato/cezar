import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import { fetchRecentActionRuns } from '@/lib/action-runs-loader';
import { PageContainer } from '@/components/ui/page-container';
import { PrsView, type PrRow } from './prs-view';

/**
 * Upper bound on PR rows shipped to the client. `PrsView` does its own
 * filtering, sorting, and 10/25/50/100 pagination over this set, plus the
 * TOTAL/OPEN/DRAFT/RUNNING stat counts — all of which need the rows in hand —
 * so we cap rather than `.range()`-paginate (which would scope those features
 * to a single page). Newest PRs win the cap via the `number desc` order.
 * Mirrors the capped-listing convention in `cockpit/page.tsx`.
 */
const PR_FETCH_CAP = 500;

export default async function PrsPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
    return (
      <PageContainer>
        <header className="mb-6">
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-on-surface sm:text-[24px]">
            Pull requests
          </h1>
        </header>
        <EmptyState title="No workspace connected" body="Create a workspace first." />
      </PageContainer>
    );
  }

  const supabase = createSupabaseAdminClient();

  let rows: PrRow[] = [];
  let fetchedAt: string | null = null;
  let loadError: string | null = null;

  try {
    const [{ data: prRows, error: prErr }, actionRunsByPr] = await Promise.all([
      supabase
        .from('pull_requests')
        .select(
          'number, title, state, draft, labels, author, html_url, head_ref, base_ref, pr_created_at, pr_updated_at, updated_at',
        )
        .eq('workspace_id', workspace.id)
        .order('number', { ascending: false })
        .limit(PR_FETCH_CAP),
      fetchRecentActionRuns(workspace.id, 'pr'),
    ]);
    if (prErr) throw new Error(prErr.message);

    rows = (prRows ?? []).map((p) => ({
      number: p.number,
      title: p.title,
      htmlUrl: p.html_url,
      state: (p.state === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
      draft: !!p.draft,
      labels: p.labels ?? [],
      author: p.author,
      headRef: p.head_ref,
      baseRef: p.base_ref,
      prUpdatedAt: p.pr_updated_at,
      actionRuns: actionRunsByPr.get(p.number) ?? [],
    }));

    // Most recent upstream PR update is a reasonable "last refreshed" stamp.
    fetchedAt = rows.reduce<string | null>((acc, r) => {
      if (!r.prUpdatedAt) return acc;
      if (!acc || r.prUpdatedAt > acc) return r.prUpdatedAt;
      return acc;
    }, null);
  } catch (err) {
    loadError = (err as Error).message;
  }

  if (loadError) {
    return (
      <PageContainer>
        <header className="mb-6">
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-on-surface sm:text-[24px]">
            Pull requests
          </h1>
        </header>
        <EmptyState title="Load failed" body={loadError} tone="danger" />
      </PageContainer>
    );
  }

  return (
    <PrsView
      rows={rows}
      repoLabel={`${workspace.repoOwner}/${workspace.repoName}`}
      fetchedAt={fetchedAt}
      readOnly={workspace.role !== 'admin'}
    />
  );
}

function EmptyState({
  title,
  body,
  tone = 'muted',
}: {
  title: string;
  body: string;
  tone?: 'muted' | 'danger';
}) {
  return (
    <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low p-8 text-center">
      <div className={tone === 'danger' ? 'text-error' : 'text-on-surface'}>{title}</div>
      <div className="mt-2 text-sm text-on-surface-variant">{body}</div>
    </div>
  );
}
