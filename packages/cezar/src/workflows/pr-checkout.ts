import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghEnv } from '../core/gh-env.ts';
import { parseRemote, resolveTaskRemotes } from '../git-remotes.ts';
import { isSafeGitRef } from '../git-refs.ts';
import { isGithubHost } from '../github-hosts.ts';

/**
 * The `github.pr-checkout` node: put the PR's head into the task worktree and its metadata and
 * diff into the run's artifacts BEFORE any agent runs, so a read-only reviewer only reads files
 * (the 5700 review: every reviewer's `git fetch` and `gh pr diff > file` was refused).
 */

export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
}

/** The first GitHub pull-request URL in `text`. */
export function parsePrUrl(text: string): PrRef | undefined {
  for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g)) {
    const [url, host = '', owner = '', repo = '', n = ''] = m;
    if (!isGithubHost(host.toLowerCase())) continue;
    return { host: host.toLowerCase(), owner, repo: repo.replace(/\.git$/i, ''), number: Number(n), url };
  }
  return undefined;
}

type Exec = (file: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const exec: Exec = (file, args, { cwd, timeoutMs, env }) => new Promise((done) => {
  execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } },
    (err, stdout, stderr) => done({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') }));
});

export interface PrCheckoutInput {
  cwd: string;
  artifactsDir: string;
  pr: PrRef;
  /** False for a task running in the repository's own working tree: that tree is the user's, never reset. */
  ownWorktree: boolean;
  /** The task's base branch, for a local diff when `gh` cannot give one. */
  baseBranch?: string;
  /** No `gh` call (CEZ_DRY_RUN=1): metadata and diff come from git alone. */
  offline?: boolean;
  exec?: Exec;
}

export interface PrCheckoutResult {
  /** The PR head is what the worktree now holds. */
  checkedOut: boolean;
  head: string;
  diffPath: string;
  metaPath: string;
  /** One line per thing that did not work; empty on full success. */
  problems: string[];
}

/** The remote that IS the PR's repository, else the task's PR-target remote. */
async function prRemote(cwd: string, pr: PrRef, run: Exec): Promise<string | null> {
  const git = async (args: string[]) => run('git', args, { cwd, timeoutMs: 10_000 });
  const res = await git(['config', '--get-regexp', '^remote\\..*\\.url$']);
  for (const line of res.ok ? res.stdout.split('\n') : []) {
    const m = /^remote\.(.+)\.url (.*)$/.exec(line.trim());
    const parsed = m ? parseRemote(m[2] ?? '') : null;
    if (m && parsed && isSafeGitRef(m[1]!) && parsed.host === pr.host
      && parsed.owner.toLowerCase() === pr.owner.toLowerCase() && parsed.repo.toLowerCase() === pr.repo.toLowerCase()) return m[1]!;
  }
  return (await resolveTaskRemotes(git)).base;
}

export async function checkoutPr(input: PrCheckoutInput): Promise<PrCheckoutResult> {
  const run = input.exec ?? exec;
  const { cwd, pr } = input;
  const git = (args: string[], timeoutMs = 30_000) => run('git', args, { cwd, timeoutMs });
  const problems: string[] = [];
  const lastLine = (s: string) => s.trim().split('\n').pop()?.slice(0, 300) ?? '';
  let head = '';
  let checkedOut = false;

  let meta: Record<string, unknown> = { number: pr.number, url: pr.url, repository: `${pr.owner}/${pr.repo}` };
  let diff: string | undefined;
  if (!input.offline) {
    const repo = pr.host === 'github.com' ? `${pr.owner}/${pr.repo}` : `${pr.host}/${pr.owner}/${pr.repo}`;
    const gh = (args: string[]) => run('gh', args, { cwd, timeoutMs: 60_000, env: ghEnv() });
    const view = await gh(['pr', 'view', String(pr.number), '--repo', repo, '--json',
      'number,title,body,author,state,isDraft,baseRefName,headRefName,headRefOid,url,labels,files,commits']);
    if (view.ok) {
      try { meta = { ...meta, ...(JSON.parse(view.stdout) as Record<string, unknown>) }; } catch { problems.push('gh pr view returned unreadable JSON'); }
    } else problems.push(`gh pr view failed — ${lastLine(view.stderr)}`);
    const d = await gh(['pr', 'diff', String(pr.number), '--repo', repo]);
    if (d.ok) diff = d.stdout;
    else problems.push(`gh pr diff failed — ${lastLine(d.stderr)}`);
  }
  const ghHead = typeof meta.headRefOid === 'string' ? meta.headRefOid : '';

  const remote = await prRemote(cwd, pr, run);
  if (!remote) problems.push('this repository has no git remote to fetch the PR from');
  else {
    const fetched = await git(['fetch', '--no-tags', '--quiet', remote, `+refs/pull/${pr.number}/head`], 120_000);
    if (!fetched.ok) problems.push(`git fetch ${remote} pull/${pr.number}/head failed — ${lastLine(fetched.stderr)}`);
    else head = (await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).stdout.trim();
  }
  // The fallback remote may hold a different repository's PR with the same number.
  if (head && ghHead && head !== ghHead) {
    problems.push(`${remote} pull/${pr.number}/head is ${head.slice(0, 12)}, not the PR's head ${ghHead.slice(0, 12)}; nothing was checked out`);
    head = '';
  }
  if (head) meta.headRefOid = head;

  if (head && !input.ownWorktree) problems.push('the task runs in the repository working tree, which is never reset; the PR head was fetched but not checked out');
  else if (head) {
    const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
    if (!dirty.ok || dirty.stdout.trim()) problems.push('the worktree has uncommitted changes; the PR head was not checked out');
    else {
      // The task branch moves to the PR head, so the Changes tab and the reviewers see the PR itself.
      const reset = await git(['reset', '--hard', '--quiet', head]);
      if (reset.ok) checkedOut = true;
      else problems.push(`could not check out ${head.slice(0, 12)} — ${lastLine(reset.stderr)}`);
    }
  }

  if (diff === undefined && head) {
    // gh is unavailable: the PR's own commits against the base branch, from git alone.
    const baseName = typeof meta.baseRefName === 'string' ? meta.baseRefName : input.baseBranch;
    const candidates = baseName ? [...(remote ? [`${remote}/${baseName}`] : []), baseName] : [];
    for (const base of candidates) {
      const mb = await git(['merge-base', base, head]);
      if (!mb.ok) continue;
      const local = await git(['diff', '--no-color', '--no-ext-diff', mb.stdout.trim(), head], 60_000);
      if (local.ok) { diff = local.stdout; break; }
    }
  }

  mkdirSync(input.artifactsDir, { recursive: true });
  const metaPath = join(input.artifactsDir, `pr-${pr.number}.json`);
  writeFileSync(metaPath, `${JSON.stringify({ ...meta, checkedOut }, null, 2)}\n`);
  let diffPath = '';
  if (diff !== undefined) {
    diffPath = join(input.artifactsDir, `pr-${pr.number}.diff`);
    writeFileSync(diffPath, diff);
  } else problems.push('no diff could be saved');
  return { checkedOut, head, diffPath, metaPath, problems };
}
