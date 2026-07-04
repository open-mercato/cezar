import { Octokit } from '@octokit/rest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../config/config.model.js';
import { contentHash } from '../utils/hash.js';

const execFileAsync = promisify(execFile);

export interface RawIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  contentHash: string;
  commentCount: number;
  reactions: number;
  assignees: string[];
}

export interface TimelineCrossReference {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  merged: boolean;
}

export interface RawPullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  labels: string[];
  author: string;
  htmlUrl: string;
  headSha: string | null;
  headRef: string | null;
  baseRef: string | null;
  referencedIssues: number[];
  createdAt: string;
  updatedAt: string;
}

// Pulls issue numbers referenced in PR titles/bodies. Catches the common
// closing-keyword forms (closes/fixes/resolves #N, GH-N, owner/repo#N) plus
// bare #N mentions — Phase 1 link-based matching treats any reference as a
// signal, so precision here is less important than recall.
export function extractReferencedIssues(text: string): number[] {
  if (!text) return [];
  const refs = new Set<number>();
  // Two passes — bare `GH-123` and `[owner/repo]#123` / `#123`.
  const bareGh = /(?<![A-Za-z0-9_])GH-(\d+)\b/gi;
  const hash = /(?<![A-Za-z0-9_])(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = bareGh.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) refs.add(n);
  }
  while ((m = hash.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) refs.add(n);
  }
  return [...refs].sort((a, b) => a - b);
}

export interface CheckRunSummary {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: string | null;
  htmlUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type CiOverall = 'pending' | 'success' | 'failure' | 'neutral' | 'unknown';

export interface CiSummary {
  overall: CiOverall;
  total: number;
  failedChecks: CheckRunSummary[];
}

// Pure aggregator — exported so it can be unit-tested with fixtures and
// reused by the follow-up autofix flow in later phases.
export function summarizeCi(checks: CheckRunSummary[]): CiSummary {
  if (checks.length === 0) return { overall: 'unknown', total: 0, failedChecks: [] };

  const FAIL = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
  const PASS = new Set(['success']);
  const NEUTRAL = new Set(['neutral', 'skipped', 'stale']);

  const failedChecks = checks.filter((c) => c.conclusion != null && FAIL.has(c.conclusion));
  const anyPending = checks.some((c) => c.status !== 'completed');

  let overall: CiOverall;
  if (failedChecks.length > 0) overall = 'failure';
  else if (anyPending) overall = 'pending';
  else if (checks.every((c) => c.conclusion != null && PASS.has(c.conclusion))) overall = 'success';
  else if (
    checks.every(
      (c) => c.conclusion != null && (PASS.has(c.conclusion) || NEUTRAL.has(c.conclusion)),
    )
  )
    overall = 'neutral';
  else overall = 'unknown';

  return { overall, total: checks.length, failedChecks };
}

export class GitHubService {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private token: string;

  constructor(config: Config) {
    if (!config.github.token) {
      throw new Error('Invalid GitHub token. Check GITHUB_TOKEN env var.');
    }
    this.octokit = new Octokit({ auth: config.github.token });
    this.owner = config.github.owner;
    this.repo = config.github.repo;
    this.token = config.github.token;
  }

  async fetchAllIssues(includeClosed = false, maxItems?: number): Promise<RawIssue[]> {
    const state = includeClosed ? 'all' : 'open';
    try {
      if (maxItems != null) {
        const collected: RawIssue[] = [];
        const iterator = this.octokit.paginate.iterator(this.octokit.rest.issues.listForRepo, {
          owner: this.owner,
          repo: this.repo,
          state,
          per_page: 100,
          sort: 'created',
          direction: 'asc',
        });
        for await (const { data } of iterator) {
          for (const i of data) {
            if (i.pull_request) continue; // exclude PRs
            collected.push(this.mapIssue(i));
            if (collected.length >= maxItems) return collected;
          }
        }
        return collected;
      }

      const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
        owner: this.owner,
        repo: this.repo,
        state,
        per_page: 100,
        sort: 'created',
        direction: 'asc',
      });

      return issues
        .filter((i) => !i.pull_request) // exclude PRs
        .map((i) => this.mapIssue(i));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async fetchIssuesSince(since: string, _includeClosed = false): Promise<RawIssue[]> {
    // Always fetch all states for incremental sync — we need to detect
    // issues that were closed since the last sync to update local state.
    const state = 'all' as const;
    try {
      const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
        owner: this.owner,
        repo: this.repo,
        state,
        since,
        per_page: 100,
        sort: 'updated',
        direction: 'asc',
      });

      return issues.filter((i) => !i.pull_request).map((i) => this.mapIssue(i));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Lists pull requests for the repo, newest-activity first, across *all*
   * states (open + closed/merged). Fetching `state: 'all'` sorted by `updated`
   * descending is what lets the periodic sync self-heal: closing or merging a
   * PR bumps its `updated_at`, so every PR that recently changed state surfaces
   * near the top and gets re-upserted with its current state — without it,
   * a PR synced while open and later closed upstream stays `open` in the store
   * forever (the webhook covers live transitions; this is the backfill +
   * missed-delivery safety net). `maxItems` caps the walk so a repo with
   * thousands of historical PRs can't blow the request budget.
   */
  async listPullRequests(maxItems?: number): Promise<RawPullRequest[]> {
    const mapPr = (
      p: Awaited<ReturnType<Octokit['rest']['pulls']['list']>>['data'][number],
    ): RawPullRequest => ({
      number: p.number,
      title: p.title,
      body: p.body ?? '',
      state: p.state === 'closed' ? 'closed' : 'open',
      draft: p.draft ?? false,
      labels: Array.isArray(p.labels)
        ? p.labels
            .map((l) => (typeof l === 'string' ? l : (l?.name ?? null)))
            .filter((n): n is string => typeof n === 'string' && n.length > 0)
        : [],
      author: p.user?.login ?? 'unknown',
      htmlUrl: p.html_url,
      headSha: p.head?.sha ?? null,
      headRef: p.head?.ref ?? null,
      baseRef: p.base?.ref ?? null,
      referencedIssues: extractReferencedIssues(`${p.title}\n${p.body ?? ''}`),
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    });

    try {
      if (maxItems != null) {
        const collected: RawPullRequest[] = [];
        const iterator = this.octokit.paginate.iterator(this.octokit.rest.pulls.list, {
          owner: this.owner,
          repo: this.repo,
          state: 'all',
          sort: 'updated',
          direction: 'desc',
          per_page: 100,
        });
        for await (const { data } of iterator) {
          for (const p of data) {
            collected.push(mapPr(p));
            if (collected.length >= maxItems) return collected;
          }
        }
        return collected;
      }

      const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, {
        owner: this.owner,
        repo: this.repo,
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
      });
      return prs.map(mapPr);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    // Common case is one request: `addLabels` succeeds when the repo label
    // exists. Only when GitHub rejects a missing repo label (404/422) do we
    // create it and retry — this drops the unconditional getLabel probe that
    // used to make every add 2-3 requests (which itself worsened rate limits).
    // The closure throws the RAW error so `withWriteRetry` can classify it
    // (retry-after / rate-limit headers intact) and retry secondary limits.
    await this.withWriteRetry(`addLabel #${issueNumber}`, async () => {
      try {
        await this.octokit.rest.issues.addLabels({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          labels: [label],
        });
      } catch (error) {
        const status = errorStatus(error);
        if (status !== 404 && status !== 422) throw error; // rate-limit/permission → withWriteRetry
        // Repo label missing — create it once (with our color), then add.
        // createLabel may 422 if a concurrent attempt already created it — ok.
        try {
          await this.octokit.rest.issues.createLabel({
            owner: this.owner,
            repo: this.repo,
            name: label,
            color: 'e4e669',
            description: 'Managed by cezar',
          });
        } catch (createErr) {
          if (errorStatus(createErr) !== 422) throw createErr;
        }
        await this.octokit.rest.issues.addLabels({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          labels: [label],
        });
      }
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    await this.withWriteRetry(`removeLabel #${issueNumber}`, async () => {
      try {
        await this.octokit.rest.issues.removeLabel({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          name: label,
        });
      } catch (error) {
        // Ignore 404 — label wasn't on the issue. Everything else (incl. rate
        // limits) propagates raw to withWriteRetry for classification/retry.
        if (errorStatus(error) === 404) return;
        throw error;
      }
    });
  }

  async setLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.withWriteRetry(`setLabels #${issueNumber}`, () =>
      this.octokit.rest.issues
        .setLabels({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          labels,
        })
        .then(() => undefined),
    );
  }

  async addComment(issueNumber: number, body: string): Promise<number> {
    return this.withWriteRetry(`addComment #${issueNumber}`, async () => {
      const resp = await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body,
      });
      return resp.data.id;
    });
  }

  /** Edit an existing issue/PR comment in place — the "living comment" per run (docs §3.6). */
  async updateComment(commentId: number, body: string): Promise<void> {
    try {
      await this.octokit.rest.issues.updateComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: commentId,
        body,
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async closeIssue(
    issueNumber: number,
    reason: 'completed' | 'not_planned' = 'completed',
  ): Promise<void> {
    try {
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        state: 'closed',
        state_reason: reason,
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async fetchOrgMembers(org: string): Promise<string[]> {
    const members = new Set<string>();

    // Try org members endpoint first (requires org:read scope)
    try {
      const orgMembers = await this.octokit.paginate(this.octokit.rest.orgs.listMembers, {
        org,
        per_page: 100,
      });
      for (const m of orgMembers) {
        if (m.login) members.add(m.login);
      }
      if (members.size > 0) return [...members];
    } catch {
      // Token may not have org scope — fall through to collaborators
    }

    // Fallback: repo collaborators (works with most repo-level tokens)
    try {
      const collaborators = await this.octokit.paginate(this.octokit.rest.repos.listCollaborators, {
        owner: this.owner,
        repo: this.repo,
        per_page: 100,
      });
      for (const c of collaborators) {
        if (c.login) members.add(c.login);
      }
    } catch (error) {
      this.handleError(error);
      throw error;
    }

    return [...members];
  }

  async fetchRepoLabels(): Promise<string[]> {
    try {
      const labels = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
        owner: this.owner,
        repo: this.repo,
        per_page: 100,
      });
      return labels.map((l) => l.name);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async createIssue(
    title: string,
    body: string,
    labels?: string[],
  ): Promise<{ number: number; htmlUrl: string }> {
    try {
      const response = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        labels: labels ?? [],
      });
      return {
        number: response.data.number,
        htmlUrl: response.data.html_url,
      };
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async addAssignees(issueNumber: number, assignees: string[]): Promise<void> {
    try {
      await this.octokit.rest.issues.addAssignees({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        assignees,
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async fetchCommentsForIssues(
    issueNumbers: number[],
    onProgress?: (done: number, total: number) => void,
    onError?: (issueNumber: number, error: unknown) => void,
  ): Promise<Map<number, Array<{ author: string; body: string; createdAt: string }>>> {
    const result = new Map<number, Array<{ author: string; body: string; createdAt: string }>>();
    for (const [idx, num] of issueNumbers.entries()) {
      try {
        const comments = await this.getIssueComments(num);
        result.set(num, comments);
      } catch (error) {
        // Auth / rate-limit failures aren't per-issue glitches: they'll hit
        // every remaining issue identically and the caller needs to back off
        // or fix scopes rather than persist a partial map with commentsFetchedAt
        // left null. Re-throw those; only swallow genuinely per-issue failures.
        if (isAuthOrRateLimitError(error)) throw error;
        // Surface the per-issue failure to the caller if it wants to know;
        // otherwise skip this issue and carry on.
        onError?.(num, error);
      }
      onProgress?.(idx + 1, issueNumbers.length);
    }
    return result;
  }

  async getIssueComments(
    issueNumber: number,
  ): Promise<Array<{ author: string; body: string; createdAt: string }>> {
    try {
      const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      });
      return comments.map((c) => ({
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.created_at,
      }));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Like `getIssueComments` but returns the GitHub-assigned `id` for each
   * comment. Needed by sticky-marker upserts (find the marker → edit it in
   * place via `updateComment(id, body)`) — kept separate from the existing
   * shape to avoid disturbing every call site that already destructures the
   * narrower tuple.
   */
  async listIssueCommentsWithIds(
    issueNumber: number,
  ): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>> {
    try {
      const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      });
      return comments.map((c) => ({
        id: c.id,
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.created_at,
      }));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async getIssueWithComments(issueNumber: number): Promise<{
    issue: {
      number: number;
      title: string;
      body: string;
      state: 'open' | 'closed';
      labels: string[];
      author: string;
      htmlUrl: string;
      createdAt: string;
      updatedAt: string;
    };
    comments: Array<{ author: string; body: string; createdAt: string }>;
  }> {
    try {
      const [issueResp, comments] = await Promise.all([
        this.octokit.rest.issues.get({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
        }),
        this.getIssueComments(issueNumber),
      ]);

      const raw = issueResp.data;
      return {
        issue: {
          number: raw.number,
          title: raw.title,
          body: raw.body ?? '',
          state: raw.state === 'closed' ? 'closed' : 'open',
          labels: raw.labels
            .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
            .filter(Boolean),
          author: raw.user?.login ?? 'unknown',
          htmlUrl: raw.html_url,
          createdAt: raw.created_at,
          updatedAt: raw.updated_at,
        },
        comments,
      };
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async getBaseBranchSha(branch: string): Promise<string> {
    try {
      const response = await this.octokit.rest.repos.getBranch({
        owner: this.owner,
        repo: this.repo,
        branch,
      });
      return response.data.commit.sha;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async createRemoteBranch(branch: string, fromSha: string): Promise<void> {
    try {
      await this.octokit.rest.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${branch}`,
        sha: fromSha,
      });
    } catch (error) {
      // 422 = ref already exists; treat as no-op so re-runs are idempotent
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        (error as { status: number }).status === 422
      ) {
        return;
      }
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Command-time git config args that authenticate HTTPS operations against
   * GitHub via an `http.extraheader` Authorization header. Preferred over
   * baking the token into a remote URL — the secret then never lands in
   * `.git/config` on disk (see `@cezar/runner`'s `repo-clone.ts`).
   */
  gitAuthArgs(): string[] {
    const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`;
    return ['-c', `http.extraheader=${authHeader}`];
  }

  async pushBranch(branch: string, localRepoPath: string, remote = 'origin'): Promise<void> {
    try {
      await execFileAsync(
        'git',
        [...this.gitAuthArgs(), 'push', '--set-upstream', remote, branch],
        {
          cwd: localRepoPath,
        },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`git push ${remote} ${branch} failed: ${msg}`);
    }
  }

  async createPullRequest(opts: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
    labels?: string[];
  }): Promise<{ url: string; number: number }> {
    try {
      const response = await this.octokit.rest.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
        draft: opts.draft ?? true,
      });

      const prNumber = response.data.number;

      if (opts.labels && opts.labels.length > 0) {
        await this.octokit.rest.issues
          .addLabels({
            owner: this.owner,
            repo: this.repo,
            issue_number: prNumber,
            labels: opts.labels,
          })
          .catch((err: unknown) => {
            // Label attach is best-effort; don't fail the PR opening on a missing
            // label — but log it so a scope/typo problem isn't completely silent.
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(`[github] failed to attach labels to PR #${prNumber}: ${reason}`);
          });
      }

      return {
        url: response.data.html_url,
        number: prNumber,
      };
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async listCheckRunsForSha(sha: string): Promise<CheckRunSummary[]> {
    try {
      const runs = await this.octokit.paginate(this.octokit.rest.checks.listForRef, {
        owner: this.owner,
        repo: this.repo,
        ref: sha,
        per_page: 100,
      });
      return runs.map((r) => ({
        name: r.name,
        status: r.status as CheckRunSummary['status'],
        conclusion: r.conclusion,
        htmlUrl: r.html_url ?? null,
        startedAt: r.started_at ?? null,
        completedAt: r.completed_at ?? null,
      }));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async getCiStatus(sha: string): Promise<CiSummary> {
    const checks = await this.listCheckRunsForSha(sha);
    return summarizeCi(checks);
  }

  async getPullRequestDiff(prNumber: number): Promise<string> {
    try {
      const response = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        mediaType: { format: 'diff' },
      });
      // With format: 'diff', response.data is returned as a raw string.
      return response.data as unknown as string;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async listPullRequestFiles(prNumber: number): Promise<string[]> {
    try {
      const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
      });
      return files.map((f) => f.filename);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async downloadJobLogs(jobId: number): Promise<string> {
    // Octokit follows the 302 redirect automatically and returns the log text.
    try {
      const response = await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        job_id: jobId,
      });
      return typeof response.data === 'string' ? response.data : String(response.data ?? '');
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async reRunFailedJobs(runId: number): Promise<void> {
    try {
      await this.octokit.rest.actions.reRunWorkflowFailedJobs({
        owner: this.owner,
        repo: this.repo,
        run_id: runId,
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async getIssueTimeline(issueNumber: number): Promise<TimelineCrossReference[]> {
    try {
      const events = await this.octokit.paginate(this.octokit.rest.issues.listEventsForTimeline, {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      });

      const crossRefs: TimelineCrossReference[] = [];
      for (const event of events) {
        const e = event as Record<string, unknown>;
        if (e.event !== 'cross-referenced') continue;

        const source = e.source as Record<string, unknown> | undefined;
        if (!source) continue;

        const issue = source.issue as Record<string, unknown> | undefined;
        if (!issue) continue;

        const pr = issue.pull_request as Record<string, unknown> | undefined;
        if (!pr) continue; // not a PR reference

        const merged = pr.merged_at != null;
        if (!merged) continue; // only include merged PRs

        crossRefs.push({
          prNumber: issue.number as number,
          prTitle: issue.title as string,
          prUrl: issue.html_url as string,
          merged,
        });
      }

      return crossRefs;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  private mapIssue(i: Record<string, unknown>): RawIssue {
    const issue = i as {
      number: number;
      title: string;
      body: string | null;
      state: string;
      labels: Array<{ name?: string } | string>;
      user: { login: string } | null;
      assignees?: Array<{ login: string }>;
      created_at: string;
      updated_at: string;
      html_url: string;
      comments: number;
      reactions?: { total_count: number };
    };

    const title = issue.title;
    const body = issue.body ?? '';

    return {
      number: issue.number,
      title,
      body,
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      author: issue.user?.login ?? 'unknown',
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      htmlUrl: issue.html_url,
      contentHash: contentHash(title, body),
      commentCount: issue.comments ?? 0,
      reactions: issue.reactions?.total_count ?? 0,
      assignees: issue.assignees?.map((a) => a.login) ?? [],
    };
  }

  private handleError(error: unknown): void {
    // Only translate the structured Octokit/HTTP errors (those with a numeric
    // `status`). The classifier distinguishes a genuine permission denial from
    // a primary/secondary rate limit — historically all of these collapsed into
    // one misleading "rate limit exceeded or access forbidden" message, which
    // made a transient anti-burst limit look like a missing App permission.
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status: number }).status;
      if (status === 401 || status === 403 || status === 404 || status === 429) {
        throw toGitHubApiError(error, classifyGitHubError(error), {
          owner: this.owner,
          repo: this.repo,
        });
      }
    }
  }

  /**
   * Run a mutating GitHub call, retrying ONLY GitHub's secondary (anti-burst)
   * rate limit — which is transient and clears within seconds — honoring the
   * server's `Retry-After` when present, else exponential backoff (capped). A
   * genuine permission denial, auth failure, primary-budget exhaustion, or any
   * other error fails fast: retrying those just wastes a job's time. On final
   * failure throws a {@link GitHubApiError} carrying the real cause so the
   * effect audit can say *why* instead of "apply manually".
   */
  private async withWriteRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const classified = classifyGitHubError(error);
        if (classified.kind === 'secondary-rate-limit' && attempt < MAX_ATTEMPTS) {
          const waitMs = Math.min(60_000, classified.retryAfterMs ?? 1000 * 2 ** (attempt - 1));
          console.warn(
            `[github] secondary rate limit on ${label} (attempt ${attempt}/${MAX_ATTEMPTS}); ` +
              `retrying in ${Math.round(waitMs / 1000)}s ` +
              `[remaining=${classified.rateLimitRemaining ?? '?'} retry-after=${classified.retryAfterMs != null ? Math.round(classified.retryAfterMs / 1000) + 's' : 'n/a'}]`,
          );
          await delay(waitMs);
          continue;
        }
        if (classified.kind === 'primary-rate-limit') {
          console.warn(
            `[github] primary rate limit on ${label} ` +
              `[remaining=${classified.rateLimitRemaining ?? '?'} resets-in=${classified.retryAfterMs != null ? Math.round(classified.retryAfterMs / 1000) + 's' : 'n/a'}]`,
          );
        }
        throw toGitHubApiError(error, classified, { owner: this.owner, repo: this.repo });
      }
    }
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Extract the numeric HTTP status off a raw Octokit/HTTP error, if present. */
function errorStatus(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'status' in error
    ? (error as { status: number }).status
    : undefined;
}

/** Distinct failure modes that a 401/403/404/429 from GitHub can actually mean. */
export type GitHubErrorKind =
  | 'auth'
  | 'permission'
  | 'primary-rate-limit'
  | 'secondary-rate-limit'
  | 'not-found'
  | 'other';

export interface ClassifiedGitHubError {
  kind: GitHubErrorKind;
  status?: number;
  /** ms to wait before retrying — from `Retry-After` (secondary) or `x-ratelimit-reset` (primary). */
  retryAfterMs?: number;
  /** `x-ratelimit-remaining` header, when present. */
  rateLimitRemaining?: string;
  /** The raw message GitHub returned (e.g. "Resource not accessible by integration"). */
  message: string;
}

/** A GitHub failure with the real cause preserved (status + classified kind). */
export class GitHubApiError extends Error {
  readonly status?: number;
  readonly kind: GitHubErrorKind;
  readonly retryAfterMs?: number;
  constructor(message: string, classified: ClassifiedGitHubError) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = classified.status;
    this.kind = classified.kind;
    this.retryAfterMs = classified.retryAfterMs;
  }
}

function headerValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  return v == null ? undefined : String(v);
}

/**
 * Classify a raw Octokit error into the cause GitHub actually signaled.
 *
 * The key distinctions, all of which arrive as HTTP 403 (or 429):
 *   - secondary rate limit → message contains "secondary rate limit", or a
 *     `Retry-After` header is present while budget remains. Transient; retry.
 *   - primary rate limit    → `x-ratelimit-remaining: 0` (resets on the hour).
 *   - permission            → a 403 with no rate-limit signal, typically
 *     "Resource not accessible by integration" (the App lacks the permission).
 */
export function classifyGitHubError(error: unknown): ClassifiedGitHubError {
  if (!error || typeof error !== 'object') {
    return { kind: 'other', message: String(error) };
  }
  const e = error as {
    status?: number;
    message?: string;
    response?: { headers?: Record<string, unknown>; data?: { message?: string } };
  };
  const status = e.status;
  const headers = e.response?.headers;
  const apiMessage = e.response?.data?.message ?? e.message ?? '';
  const lower = apiMessage.toLowerCase();
  const remaining = headerValue(headers, 'x-ratelimit-remaining');

  const retryAfterRaw = headerValue(headers, 'retry-after');
  const retryAfterMs =
    retryAfterRaw != null && Number.isFinite(Number(retryAfterRaw))
      ? Number(retryAfterRaw) * 1000
      : undefined;
  const resetRaw = headerValue(headers, 'x-ratelimit-reset');
  const resetMs =
    resetRaw != null && Number.isFinite(Number(resetRaw))
      ? Math.max(0, Number(resetRaw) * 1000 - Date.now())
      : undefined;

  if (status === 401)
    return { kind: 'auth', status, message: apiMessage, rateLimitRemaining: remaining };

  if (status === 403 || status === 429) {
    // Secondary (anti-burst) limit: explicit message, or a Retry-After while
    // the primary budget is NOT exhausted.
    if (lower.includes('secondary rate limit') || (retryAfterMs != null && remaining !== '0')) {
      return {
        kind: 'secondary-rate-limit',
        status,
        retryAfterMs,
        rateLimitRemaining: remaining,
        message: apiMessage,
      };
    }
    // Primary budget exhausted.
    if (remaining === '0' || (lower.includes('rate limit') && remaining !== undefined)) {
      return {
        kind: 'primary-rate-limit',
        status,
        retryAfterMs: resetMs,
        rateLimitRemaining: remaining,
        message: apiMessage,
      };
    }
    if (lower.includes('rate limit')) {
      return {
        kind: 'primary-rate-limit',
        status,
        retryAfterMs: resetMs,
        rateLimitRemaining: remaining,
        message: apiMessage,
      };
    }
    // A 403 with no rate-limit signal is a real permission denial.
    return { kind: 'permission', status, message: apiMessage, rateLimitRemaining: remaining };
  }

  if (status === 404) return { kind: 'not-found', status, message: apiMessage };
  return { kind: 'other', status, message: apiMessage };
}

/** Build a human-readable {@link GitHubApiError} from a classified error. */
export function toGitHubApiError(
  error: unknown,
  classified: ClassifiedGitHubError,
  repo?: { owner: string; repo: string },
): GitHubApiError {
  const detail = classified.message ? ` (${classified.message})` : '';
  const slug = repo ? `${repo.owner}/${repo.repo}` : 'the repo';
  let message: string;
  switch (classified.kind) {
    case 'auth':
      message = 'Invalid or expired GitHub token — re-authenticate (or reinstall the GitHub App).';
      break;
    case 'permission': {
      // Distinguish the two real causes of a write 403, because the fix differs:
      //   - GitHub App token ("Resource not accessible by integration"): the App
      //     installation lacks the permission — grant it and re-accept.
      //   - User OAuth token / PAT: the *account* Cezar is acting as lacks the
      //     repo role. Crucially, on GitHub a user with read access can COMMENT
      //     but needs the Triage (or Write/Maintain/Admin) role to add/remove
      //     LABELS — so "comment worked but labeling 403'd" is expected here and
      //     is NOT a rate limit. Installing the GitHub App fixes it regardless of
      //     who connected the workspace.
      const isApp = /integration/i.test(classified.message);
      message = isApp
        ? `GitHub denied this action (403): the GitHub App installation lacks permission${detail}. ` +
          `Grant "Issues: Read & write" (and "Pull requests: Read & write" for PRs) on ${slug} and re-accept the install.`
        : `GitHub denied this action (403): the connected GitHub account lacks the repo role for it${detail}. ` +
          `Commenting only needs read access, but adding/removing labels needs the Triage (or Write) role on ${slug} — ` +
          `install the Cezar GitHub App (recommended), or give that account Triage+ access.`;
      break;
    }
    case 'secondary-rate-limit':
      message =
        `GitHub secondary (anti-burst) rate limit hit${detail} — exhausted in-run retries. ` +
        `This is transient (not a permission problem); re-run the action shortly.`;
      break;
    case 'primary-rate-limit': {
      const resets =
        classified.retryAfterMs != null
          ? ` (resets in ~${Math.round(classified.retryAfterMs / 1000)}s)`
          : '';
      message = `GitHub API rate limit exhausted${resets}${detail}.`;
      break;
    }
    case 'not-found':
      message = `'${slug}' or the target resource was not found or is inaccessible${detail}.`;
      break;
    default:
      message = error instanceof Error ? error.message : String(error);
  }
  return new GitHubApiError(message, classified);
}

// Auth (401) and access/rate-limit (403) failures are not transient per-item
// glitches — they apply to the whole token and will recur on every subsequent
// request. Callers that loop over many resources need to bail out rather than
// silently dropping every item. Matches both the raw Octokit error shape
// (`.status`) and the normalized Error messages thrown by `handleError`.
export function isAuthOrRateLimitError(error: unknown): boolean {
  // GitHubApiError carries the classified kind directly.
  if (error instanceof GitHubApiError) {
    return (
      error.kind === 'auth' ||
      error.kind === 'permission' ||
      error.kind === 'primary-rate-limit' ||
      error.kind === 'secondary-rate-limit'
    );
  }
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (status === 401 || status === 403 || status === 429) return true;
  }
  if (error instanceof Error) {
    return (
      error.message.includes('Invalid GitHub token') ||
      error.message.includes('rate limit exceeded or access forbidden')
    );
  }
  return false;
}

// Pure helper for CI attribution. GitHub Actions check-run html_urls follow
// /{owner}/{repo}/actions/runs/{runId}/job/{jobId} (with optional #step:...
// suffix). Checks from non-Actions providers return null — the attribution
// worker should degrade gracefully when logs aren't available.
export function parseCheckRunUrl(
  url: string | null | undefined,
): { runId: number; jobId: number } | null {
  if (!url) return null;
  const m = url.match(/\/actions\/runs\/(\d+)\/jobs?\/(\d+)/);
  if (!m) return null;
  const runId = Number(m[1]);
  const jobId = Number(m[2]);
  if (!Number.isFinite(runId) || !Number.isFinite(jobId)) return null;
  return { runId, jobId };
}
