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

  const failedChecks = checks.filter(c => c.conclusion != null && FAIL.has(c.conclusion));
  const anyPending = checks.some(c => c.status !== 'completed');

  let overall: CiOverall;
  if (failedChecks.length > 0) overall = 'failure';
  else if (anyPending) overall = 'pending';
  else if (checks.every(c => c.conclusion != null && PASS.has(c.conclusion))) overall = 'success';
  else if (checks.every(c => c.conclusion != null && (PASS.has(c.conclusion) || NEUTRAL.has(c.conclusion)))) overall = 'neutral';
  else overall = 'unknown';

  return { overall, total: checks.length, failedChecks };
}

export class GitHubService {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(config: Config) {
    if (!config.github.token) {
      throw new Error('Invalid GitHub token. Check GITHUB_TOKEN env var.');
    }
    this.octokit = new Octokit({ auth: config.github.token });
    this.owner = config.github.owner;
    this.repo = config.github.repo;
  }

  async fetchAllIssues(includeClosed = false): Promise<RawIssue[]> {
    const state = includeClosed ? 'all' : 'open';
    try {
      const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
        owner: this.owner,
        repo: this.repo,
        state,
        per_page: 100,
        sort: 'created',
        direction: 'asc',
      });

      return issues
        .filter(i => !i.pull_request) // exclude PRs
        .map(i => this.mapIssue(i));
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

      return issues
        .filter(i => !i.pull_request)
        .map(i => this.mapIssue(i));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async listOpenPullRequests(): Promise<RawPullRequest[]> {
    try {
      const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, {
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: 100,
      });
      return prs.map(p => ({
        number: p.number,
        title: p.title,
        body: p.body ?? '',
        state: p.state === 'closed' ? 'closed' : 'open',
        draft: p.draft ?? false,
        labels: Array.isArray(p.labels)
          ? p.labels
              .map((l) => (typeof l === 'string' ? l : l?.name ?? null))
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
      }));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    try {
      // Ensure label exists
      try {
        await this.octokit.rest.issues.getLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
        });
      } catch {
        await this.octokit.rest.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
          color: 'e4e669',
          description: 'Managed by cezar',
        });
      }

      await this.octokit.rest.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels: [label],
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (error) {
      // Ignore 404 — label wasn't on the issue
      if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404) {
        return;
      }
      this.handleError(error);
      throw error;
    }
  }

  async setLabels(issueNumber: number, labels: string[]): Promise<void> {
    try {
      await this.octokit.rest.issues.setLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels,
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async addComment(issueNumber: number, body: string): Promise<number> {
    try {
      const resp = await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body,
      });
      return resp.data.id;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
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

  async closeIssue(issueNumber: number, reason: 'completed' | 'not_planned' = 'completed'): Promise<void> {
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
      return labels.map(l => l.name);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async createIssue(title: string, body: string, labels?: string[]): Promise<{ number: number; htmlUrl: string }> {
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
  ): Promise<Map<number, Array<{ author: string; body: string; createdAt: string }>>> {
    const result = new Map<number, Array<{ author: string; body: string; createdAt: string }>>();
    for (const [idx, num] of issueNumbers.entries()) {
      try {
        const comments = await this.getIssueComments(num);
        result.set(num, comments);
      } catch {
        // Skip issues where comment fetch fails
      }
      onProgress?.(idx + 1, issueNumbers.length);
    }
    return result;
  }

  async getIssueComments(issueNumber: number): Promise<Array<{ author: string; body: string; createdAt: string }>> {
    try {
      const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      });
      return comments.map(c => ({
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
      return comments.map(c => ({
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
          labels: raw.labels.map(l => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
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
      if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 422) {
        return;
      }
      this.handleError(error);
      throw error;
    }
  }

  async pushBranch(branch: string, localRepoPath: string, remote = 'origin'): Promise<void> {
    try {
      await execFileAsync('git', ['push', '--set-upstream', remote, branch], {
        cwd: localRepoPath,
      });
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
        await this.octokit.rest.issues.addLabels({
          owner: this.owner,
          repo: this.repo,
          issue_number: prNumber,
          labels: opts.labels,
        }).catch(() => {
          // Label attach is best-effort; don't fail the PR opening on a missing label
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
      return runs.map(r => ({
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
      return files.map(f => f.filename);
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
      labels: issue.labels.map(l => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
      author: issue.user?.login ?? 'unknown',
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      htmlUrl: issue.html_url,
      contentHash: contentHash(title, body),
      commentCount: issue.comments ?? 0,
      reactions: issue.reactions?.total_count ?? 0,
      assignees: issue.assignees?.map(a => a.login) ?? [],
    };
  }

  private handleError(error: unknown): void {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status: number }).status;
      if (status === 401) {
        throw new Error('Invalid GitHub token. Check GITHUB_TOKEN env var.');
      }
      if (status === 403) {
        throw new Error('GitHub API rate limit exceeded or access forbidden.');
      }
      if (status === 404) {
        throw new Error(`Repo '${this.owner}/${this.repo}' not found or inaccessible.`);
      }
    }
  }
}

// Pure helper for CI attribution. GitHub Actions check-run html_urls follow
// /{owner}/{repo}/actions/runs/{runId}/job/{jobId} (with optional #step:...
// suffix). Checks from non-Actions providers return null — the attribution
// worker should degrade gracefully when logs aren't available.
export function parseCheckRunUrl(url: string | null | undefined): { runId: number; jobId: number } | null {
  if (!url) return null;
  const m = url.match(/\/actions\/runs\/(\d+)\/jobs?\/(\d+)/);
  if (!m) return null;
  const runId = Number(m[1]);
  const jobId = Number(m[2]);
  if (!Number.isFinite(runId) || !Number.isFinite(jobId)) return null;
  return { runId, jobId };
}
