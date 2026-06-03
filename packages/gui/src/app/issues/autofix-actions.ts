'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';

/**
 * Server action wired to the issues page "Fix" button. Enqueues a single
 * `autofix` job for the issue; the `/api/cron/dispatch` cron (or a self-hosted
 * runner) picks it up. Returns the new `workflow_runs.id` so the UI can deep
 * link to /cockpit/[runId], but the run row doesn't exist yet — it's created
 * once the job is claimed. We redirect to /cockpit instead and let the user
 * see it appear via Realtime.
 */
export async function startAutofix(issueNumber: number): Promise<void> {
  const workspace = await getActiveWorkspace();
  if (!workspace) throw new Error('no active workspace');

  const supabase = createSupabaseAdminClient();

  // Dedupe — don't double-enqueue if there's already one in flight. The
  // SELECT below is a fast path for the common (no in-flight job) case, but
  // it's racy on its own: two concurrent clicks both see zero rows. The
  // authoritative guard is the `jobs_autofix_inflight_unique` partial unique
  // index (migration 0029), which lets the database reject the second insert
  // with 23505 — caught below and treated as a benign no-op.
  const { data: open } = await supabase
    .from('jobs')
    .select('id')
    .eq('workspace_id', workspace.id)
    .eq('kind', 'autofix')
    .eq('issue_number', issueNumber)
    .in('status', ['queued', 'claimed', 'running'])
    .limit(1);
  if (!open || open.length === 0) {
    const { error } = await supabase.from('jobs').insert({
      workspace_id: workspace.id,
      repo: `${workspace.repoOwner}/${workspace.repoName}`,
      kind: 'autofix',
      issue_number: issueNumber,
      pr_number: null,
      priority: 10,
      status: 'queued',
      max_attempts: 1,
      payload: { trigger: 'manual' },
    });
    // 23505 = unique_violation: another concurrent request already enqueued
    // an in-flight autofix for this issue. That's exactly the outcome we want
    // (one job, not two), so swallow it instead of surfacing an error.
    if (error && error.code !== '23505') {
      throw new Error(`enqueue failed: ${error.message}`);
    }
  }

  revalidatePath('/issues');
  redirect('/cockpit');
}
