import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  DigestMode,
  SyncCounts,
  SyncErrorKind,
  SyncPhase,
  SyncStatusState,
} from '@/lib/supabase/types';
import { classifySyncError } from './classify-sync-error';

// ─────────────────────────────────────────────────────────────────────
// Shared workspace-sync core — the four-phase "pull from GitHub" pipeline
// (fetch issues → digest → fetch comments → refresh PRs), factored out of
// the Inbox `syncAndDigest` server action so BOTH that action AND a future
// cron/job worker can run the exact same sync, writing progress into the
// `sync_status` table.
//
// This is a plain server-side lib (NOT a `'use server'` file), so it can
// export constants + helpers in addition to async functions.
// ─────────────────────────────────────────────────────────────────────

/** A `syncing` row older than this is treated as stale (e.g. the container
 *  restarted mid-sync) and may be overwritten by a fresh sync. */
export const STALE_SYNC_MS = 10 * 60 * 1000;

export async function writeSyncStatus(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  patch: {
    status: SyncStatusState;
    phase?: SyncPhase | null;
    message?: string | null;
    counts?: SyncCounts;
    error?: string | null;
    /** Classification of the failure (migration 0041), written alongside
     *  status='error' so the indicator can show a recovery CTA. */
    error_kind?: SyncErrorKind | null;
    /** Flags the first full import (migration 0040) so the indicator shows a
     *  determinate progress bar. Threaded from `runSyncPhases` once phase 1
     *  has computed `fullSync`. */
    initial?: boolean;
    started_at?: string | null;
    finished_at?: string | null;
  },
): Promise<void> {
  const { error } = await supabase
    .from('sync_status')
    .upsert({ workspace_id: workspaceId, ...patch }, { onConflict: 'workspace_id' });
  if (error) console.warn('[sync] sync_status write failed:', error.message);
}

export interface BuildSyncContextArgs {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  token: string;
}

/** The AI-digest cadence policy (spec §5), read from the workspace row in
 *  `buildSyncContext` and threaded into `runSyncPhases` to gate phase 2. */
export interface DigestPolicy {
  mode: DigestMode;
  intervalMinutes: number;
  /** When the digest phase last actually ran (ISO), or null. The auto-mode
   *  cadence gate compares this against `intervalMinutes`. */
  lastDigestedAt: string | null;
}

export interface SyncContext {
  store: Awaited<ReturnType<(typeof import('@cezar/core'))['IssueStore']['fromPort']>>;
  github: InstanceType<(typeof import('@cezar/core'))['GitHubService']>;
  config: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
  /** Digest cadence + last-run marker for this workspace. */
  digestPolicy: DigestPolicy;
}

/** Build the store / config / github trio used to run a workspace sync.
 *  Tolerates an empty store (newly-connected workspace) by seeding an empty
 *  one. Throws on config-load failure — callers handle. */
export async function buildSyncContext({
  supabase,
  workspaceId,
  repoOwner,
  repoName,
  token,
}: BuildSyncContextArgs): Promise<SyncContext> {
  const core = await import('@cezar/core');

  const adapter = new SupabaseStoreAdapter(supabase, workspaceId);

  // The store may be empty for a newly-connected workspace; tolerate that
  // by seeding an empty store rather than failing the sync.
  let store: Awaited<ReturnType<typeof core.IssueStore.fromPort>>;
  try {
    store = await core.IssueStore.fromPort(adapter);
  } catch {
    store = await core.IssueStore.fromPort({
      async load() {
        return {
          meta: {
            owner: repoOwner,
            repo: repoName,
            lastSyncedAt: null,
            fullSyncedAt: null,
            totalFetched: 0,
            version: 1 as const,
            orgMembers: [],
            orgMembersFetchedAt: null,
          },
          issues: [],
        };
      },
      async save(data) {
        await adapter.save(data);
      },
    });
  }

  const config = await loadWorkspaceConfig(workspaceId, supabase, {
    githubToken: token,
    repoOwner,
    repoName,
  });

  const github = new core.GitHubService(config);

  // Read the digest cadence + last-run marker (migration 0042) so phase 2 can
  // gate on it. One small indexed select; tolerate a missing row / pre-migration
  // workspace by defaulting to the SQL defaults (auto / 60 / never-digested).
  const { data: ws } = await supabase
    .from('workspaces')
    .select('digest_mode, digest_interval_minutes, last_digested_at')
    .eq('id', workspaceId)
    .maybeSingle();
  const digestPolicy: DigestPolicy = {
    mode: ws?.digest_mode ?? 'auto',
    intervalMinutes: ws?.digest_interval_minutes ?? 60,
    lastDigestedAt: ws?.last_digested_at ?? null,
  };

  return { store, github, config, digestPolicy };
}

export interface RunSyncPhasesArgs {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  store: Awaited<ReturnType<(typeof import('@cezar/core'))['IssueStore']['fromPort']>>;
  github: InstanceType<(typeof import('@cezar/core'))['GitHubService']>;
  config: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
  /** Digest cadence policy (spec §5). Phase 2 runs only when this allows it;
   *  defaults to always-on (auto / 0-interval) when omitted, preserving the
   *  pre-§5 behavior for any caller that doesn't thread it. */
  digestPolicy?: DigestPolicy;
  /** Force the digest phase to run regardless of mode/cadence — used by the
   *  on-demand "Generate digests now" action. The initial import forces digests
   *  on its own (see `shouldRunDigests`), so this is for explicit user intent. */
  forceDigests?: boolean;
}

/** Decide whether phase 2 (digests) should run this sync, per spec §5:
 *   - `off`    → never.
 *   - initial  → ALWAYS (a new workspace must not be empty), any mode but off.
 *   - forced   → always (on-demand "Generate digests now"), any mode but off.
 *   - `manual` → only when initial/forced (handled above) — i.e. not on cron.
 *   - `auto`   → only when last_digested_at is null or older than the interval.
 */
export function shouldRunDigests(
  policy: DigestPolicy | undefined,
  opts: { initial: boolean; force: boolean },
): boolean {
  const mode = policy?.mode ?? 'auto';
  if (mode === 'off') return false;
  if (opts.initial || opts.force) return true;
  if (mode === 'manual') return false;
  // auto: cadence gate.
  const last = policy?.lastDigestedAt;
  if (!last) return true;
  const intervalMs = Math.max(15, policy?.intervalMinutes ?? 60) * 60 * 1000;
  return Date.now() - new Date(last).getTime() >= intervalMs;
}

/** The four serial sync phases, each writing its progress into `sync_status`.
 *  Phase 1 is fatal-on-error; phases 2–4 are best-effort (warn + continue)
 *  so a digest/comment/PR hiccup still produces a usable sync. */
export async function runSyncPhases({
  supabase,
  workspaceId,
  store,
  github,
  config,
  digestPolicy,
  forceDigests = false,
}: RunSyncPhasesArgs): Promise<void> {
  const { LLMService } = await import('@cezar/core');
  const counts: SyncCounts = {};
  // Whether this run is the workspace's first full (all-states) import. Set in
  // phase 1 and threaded into every `sync_status` write from there on, so the
  // indicator can switch to a determinate "Importing" bar.
  let initial = false;
  // Mirror of `initial` (the first all-states import) used to guard the §4
  // delta computation — on a full backfill every PR/issue would count as "new".
  let fullSync = false;

  // ── 1. Fetch issues ──
  // Do a full (all-states, incl. closed) fetch until a complete sync has
  // succeeded, then switch to incremental `since` fetches. The full fetch
  // backfills closed issues — and corrects issues closed upstream — for stores
  // first synced by the older open-only path, and bootstraps new workspaces.
  try {
    const meta = store.getMeta();
    fullSync = !meta.fullSyncedAt || !meta.lastSyncedAt;
    initial = fullSync;
    const issues = fullSync
      ? await github.fetchAllIssues(true)
      : await github.fetchIssuesSince(meta.lastSyncedAt as string, true);
    counts.issuesFetched = issues.length;
    counts.issuesCreated = 0;
    counts.issuesUpdated = 0;
    // Per-run open↔closed deltas (spec §4) — only on incremental syncs; the
    // initial import marks everything as "new" so close/reopen tallies are noise.
    if (!fullSync) {
      counts.issuesClosed = 0;
      counts.issuesReopened = 0;
    }
    for (const issue of issues) {
      const r = store.upsertIssue(issue);
      if (r.action === 'created') counts.issuesCreated += 1;
      if (r.action === 'updated') counts.issuesUpdated += 1;
      // `upsertIssue` reports `stateChanged`; pair it with the incoming state to
      // get the direction. Cheap — no extra read, the diff is already done here.
      if (!fullSync && r.stateChanged) {
        if (issue.state === 'closed') counts.issuesClosed! += 1;
        else counts.issuesReopened! += 1;
      }
    }
    const nowIso = new Date().toISOString();
    store.updateMeta({
      lastSyncedAt: nowIso,
      totalFetched: issues.length,
      // Mark the store complete once the first all-states fetch lands, so
      // later syncs go incremental.
      ...(fullSync ? { fullSyncedAt: nowIso } : {}),
    });
    await store.save();
  } catch (err) {
    await writeSyncStatus(supabase, workspaceId, {
      status: 'error',
      phase: null,
      counts,
      initial,
      error: `Issue fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      error_kind: classifySyncError(err),
      finished_at: new Date().toISOString(),
    });
    return;
  }

  // ── 2. Generate digests for OPEN issues that don't have one yet ──
  // Scoped to open issues: a full backfill can pull in hundreds of historical
  // closed issues, and digesting those would be a large, low-value LLM spend.
  //
  // Digests are the only LLM cost in a sync (spec §5), so they run on their own
  // cadence — gated by `digestPolicy`. The initial import always digests (so a
  // new workspace isn't empty); `forceDigests` is the on-demand override. When
  // the gate says "skip", phases 3/4 still run, so metadata stays fresh for free.
  const runDigests = shouldRunDigests(digestPolicy, { initial, force: forceDigests });
  try {
    const needDigest = runDigests ? store.getIssues({ state: 'open', hasDigest: false }) : [];
    if (needDigest.length > 0) {
      // Seed the denominator BEFORE the LLM call so the first-import bar has a
      // total to measure against; the bar advances as `onProgress` fires.
      counts.digestsTotal = needDigest.length;
      counts.digestsCreated = 0;
      await writeSyncStatus(supabase, workspaceId, {
        status: 'syncing',
        phase: 'digests',
        message: `Digesting 0/${needDigest.length}…`,
        counts,
        initial,
      });
      const service = new LLMService(config);
      const issueData = needDigest.map((i) => ({ number: i.number, title: i.title, body: i.body }));
      // Wire the (previously-unused) per-batch progress callback to a throttled
      // Realtime write — once per batch, never per-issue — so the import bar
      // advances live without spamming `sync_status`.
      const results = await service.generateDigests(
        issueData,
        config.sync.digestBatchSize,
        (completed, total) => {
          counts.digestsCreated = completed;
          counts.digestsTotal = total;
          void writeSyncStatus(supabase, workspaceId, {
            status: 'syncing',
            phase: 'digests',
            message: `Digesting ${completed}/${total}…`,
            counts,
            initial,
          });
        },
      );
      for (const [number, digest] of results) {
        store.setDigest(number, digest);
      }
      counts.digestsCreated = results.size;
      await store.save();
    }
    // Stamp the cadence marker whenever the digest phase actually ran (even if
    // it found nothing to digest) so the auto-mode gate advances. Skipped only
    // when the gate suppressed the phase entirely. Best-effort — a marker write
    // failing shouldn't fail the sync.
    if (runDigests) {
      const { error: stampErr } = await supabase
        .from('workspaces')
        .update({ last_digested_at: new Date().toISOString() })
        .eq('id', workspaceId);
      if (stampErr) console.warn('[sync] last_digested_at write failed:', stampErr.message);
    }
  } catch (err) {
    // Digest failure shouldn't abort the whole sync — comments + PR pull are
    // still useful, and the user can retry to fill in the rest.
    console.warn('[sync] digest pass failed:', err);
  }

  // ── 3. Fetch comments for open issues that need them ──
  try {
    const needComments = store
      .getIssues({ state: 'open' })
      .filter((i) => !i.commentsFetchedAt && i.commentCount > 0);
    if (needComments.length > 0) {
      await writeSyncStatus(supabase, workspaceId, {
        status: 'syncing',
        phase: 'comments',
        message: `Fetching comments for ${needComments.length} issue${needComments.length === 1 ? '' : 's'}…`,
        counts,
        initial,
      });
      const commentMap = await github.fetchCommentsForIssues(needComments.map((i) => i.number));
      for (const [num, comments] of commentMap) {
        store.setComments(num, comments);
      }
      counts.commentsFetched = commentMap.size;
      await store.save();
    }
  } catch (err) {
    console.warn('[sync] comments pass failed:', err);
  }

  // ── 4. Refresh PRs (all states) into the pull_requests table ──
  try {
    await writeSyncStatus(supabase, workspaceId, {
      status: 'syncing',
      phase: 'prs',
      message: 'Refreshing pull requests…',
      counts,
      initial,
    });
    // All states, newest-activity first, so PRs closed/merged upstream get
    // their state corrected; cap the walk so a repo with thousands of historical
    // PRs doesn't bloat this background pass.
    const prs = await github.listPullRequests(500);
    if (prs.length > 0) {
      // Per-run PR deltas (spec §4) — diff the incoming set against the stored
      // `(number, state)` BEFORE the upsert overwrites it. One indexed select
      // (bounded by the 500-cap window). Skipped on the initial import, where
      // every PR would register as "new". `RawPullRequest` carries no merge
      // signal today, so merges fold into `prsClosed` and `prsMerged` is left
      // unset (see report).
      if (!fullSync) {
        const numbers = prs.map((p) => p.number);
        const { data: priorRows, error: priorErr } = await supabase
          .from('pull_requests')
          .select('number, state')
          .eq('workspace_id', workspaceId)
          .in('number', numbers);
        if (!priorErr) {
          const priorState = new Map<number, 'open' | 'closed'>(
            (priorRows ?? []).map((r) => [r.number, r.state]),
          );
          let created = 0;
          let closed = 0;
          let reopened = 0;
          for (const p of prs) {
            const prev = priorState.get(p.number);
            if (prev === undefined) {
              created += 1;
            } else if (prev === 'open' && p.state === 'closed') {
              closed += 1; // includes merges — no merge flag available
            } else if (prev === 'closed' && p.state === 'open') {
              reopened += 1;
            }
          }
          counts.prsCreated = created;
          counts.prsClosed = closed;
          counts.prsReopened = reopened;
        }
      }
      const rows = prs.map((p) => ({
        workspace_id: workspaceId,
        number: p.number,
        title: p.title,
        body: p.body,
        state: p.state,
        draft: p.draft,
        labels: p.labels,
        author: p.author,
        html_url: p.htmlUrl,
        head_sha: p.headSha,
        head_ref: p.headRef,
        base_ref: p.baseRef,
        pr_created_at: p.createdAt,
        pr_updated_at: p.updatedAt,
      }));
      const { error } = await supabase
        .from('pull_requests')
        .upsert(rows, { onConflict: 'workspace_id,number' });
      if (!error) counts.prsUpdated = prs.length;
    }
  } catch (err) {
    console.warn('[sync] PR sync failed:', err);
  }

  // ── Done. ──
  await writeSyncStatus(supabase, workspaceId, {
    status: 'done',
    phase: null,
    message: summarize(counts),
    counts,
    initial,
    error: null,
    error_kind: null,
    finished_at: new Date().toISOString(),
  });
}

function summarize(counts: SyncCounts): string {
  const bits: string[] = [];
  if (counts.issuesFetched) {
    bits.push(
      `${counts.issuesFetched} issue${counts.issuesFetched === 1 ? '' : 's'} (${counts.issuesCreated ?? 0} new · ${counts.issuesUpdated ?? 0} updated)`,
    );
  }
  if (counts.digestsCreated) bits.push(`${counts.digestsCreated} digested`);
  if (counts.commentsFetched) bits.push(`${counts.commentsFetched} commented`);
  if (counts.prsUpdated) bits.push(`${counts.prsUpdated} PR${counts.prsUpdated === 1 ? '' : 's'}`);
  return bits.length > 0 ? `Synced: ${bits.join(' · ')}` : 'Already up to date';
}
