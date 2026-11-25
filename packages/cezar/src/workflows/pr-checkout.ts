import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghEnv } from '../core/gh-env.ts';
import { parseRemote } from '../git-remotes.ts';
import { isSafeGitRef } from '../git-refs.ts';
import { isGithubHost } from '../github-hosts.ts';

/**
 * The `github.pr-checkout` node: export the PR's head into its own folder beside the task —
 * never into the task's worktree or branch — and save its metadata and diff there, before any
 * agent runs. The task tree stays the base: its Changes, its merge/push/PR gate and the agents'
 * own settings are untouched, and the PR's untrusted files are only ever read.
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

export type Exec = (file: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const exec: Exec = (file, args, { cwd, timeoutMs, env }) => new Promise((done) => {
  execFile(file, args, {
    cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    // Unattended: an HTTPS or SSH credential prompt fails instead of hanging.
    env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GH_PROMPT_DISABLED: '1' },
  }, (err, stdout, stderr) => done({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr || err?.message || '') }));
});

export interface PrCheckoutInput {
  /** A checkout of the repository, for git: only objects and FETCH_HEAD change; its files never do. */
  cwd: string;
  /** This run's PR folder (`prCheckoutDir`): emptied, then filled with `tree/`, the diff and metadata. */
  dir: string;
  /** Where the user sees copies of the diff and metadata (the run's artifacts). Agents read `dir`'s. */
  copyTo?: string;
  pr: PrRef;
  /** The task's base branch, when GitHub cannot name the PR's. */
  baseBranch?: string;
  /** CEZ_DRY_RUN=1: no network — nothing is fetched or exported. */
  offline?: boolean;
  exec?: Exec;
}

export interface PrCheckoutResult {
  /** The PR head was exported to `tree`. */
  checkedOut: boolean;
  head: string;
  tree: string;
  diffPath: string;
  metaPath: string;
  /** One line per thing that did not work or is not verified; empty on full success. */
  problems: string[];
}

/** The remote whose URL IS the PR's repository; undefined when none is (then the URL is fetched). */
export async function prRemote(cwd: string, pr: PrRef, run: Exec = exec): Promise<string | undefined> {
  const res = await run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd, timeoutMs: 10_000 });
  for (const line of res.ok ? res.stdout.split('\n') : []) {
    const m = /^remote\.(.+)\.url (.*)$/.exec(line.trim());
    const parsed = m ? parseRemote(m[2] ?? '') : null;
    if (m && parsed && isSafeGitRef(m[1]!) && parsed.host.toLowerCase() === pr.host
      && parsed.owner.toLowerCase() === pr.owner.toLowerCase() && parsed.repo.toLowerCase() === pr.repo.toLowerCase()) return m[1]!;
  }
  return undefined;
}

const lastLine = (s: string) => s.trim().split('\n').pop()?.slice(0, 300) ?? '';

export async function checkoutPr(input: PrCheckoutInput): Promise<PrCheckoutResult> {
  const run = input.exec ?? exec;
  const { cwd, pr, dir } = input;
  const git = (args: string[], timeoutMs = 30_000, env?: NodeJS.ProcessEnv) => run('git', args, { cwd, timeoutMs, ...(env ? { env } : {}) });
  const problems: string[] = [];
  const tree = join(dir, 'tree');
  let head = '';
  let checkedOut = false;
  // A re-run (a new push to the PR) starts from nothing: the old head is not this run's work.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  let meta: Record<string, unknown> = { number: pr.number, url: pr.url, repository: `${pr.owner}/${pr.repo}` };
  let diff: string | undefined;
  let diffBase = 'github';
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
  // No remote of this repository is the PR's (a fork's PR, a clone of something else): fetch its URL.
  const source = remote ?? `https://${pr.host}/${pr.owner}/${pr.repo}.git`;
  if (input.offline) problems.push('CEZ_DRY_RUN=1: the PR was not fetched or checked out');
  else {
    const fetched = await git(['fetch', '--no-tags', '--quiet', source, `+refs/pull/${pr.number}/head`], 120_000);
    if (!fetched.ok) problems.push(`git fetch ${source} pull/${pr.number}/head failed — ${lastLine(fetched.stderr)}`);
    else {
      const resolved = await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
      if (resolved.ok && resolved.stdout.trim()) head = resolved.stdout.trim();
      else problems.push(`fetched pull/${pr.number}/head but could not read it — ${lastLine(resolved.stderr)}`);
    }
    // What was fetched must be the head GitHub reports for this PR.
    if (head && ghHead && head !== ghHead) {
      problems.push(`${source} pull/${pr.number}/head is ${head.slice(0, 12)}, not the PR's head ${ghHead.slice(0, 12)}; nothing was checked out`);
      head = '';
    }
  }

  if (head) {
    // A throwaway index, so neither the task's index nor its files are touched. Symlinks become
    // plain files (a PR's link cannot point a reader elsewhere), and no LFS download runs.
    const index = join(dir, 'index.tmp');
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_LFS_SKIP_SMUDGE: '1' };
    const read = await git(['-c', 'core.symlinks=false', 'read-tree', head], 60_000, env);
    const out = read.ok ? await git(['-c', 'core.symlinks=false', 'checkout-index', '-a', '-f', `--prefix=${tree}/`], 300_000, env) : read;
    rmSync(index, { force: true });
    if (out.ok) checkedOut = true;
    else problems.push(`could not export ${head.slice(0, 12)} — ${lastLine(out.stderr)}`);
  }

  if (diff === undefined && head) {
    // No gh: the PR's commits against its base, fetched fresh; a local base may be stale.
    const named = typeof meta.baseRefName === 'string' ? meta.baseRefName : input.baseBranch;
    const baseName = named && isSafeGitRef(named) ? named : undefined;
    let base: string | undefined;
    if (baseName) {
      const f = await git(['fetch', '--no-tags', '--quiet', source, `+refs/heads/${baseName}`], 120_000);
      const sha = f.ok ? await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']) : undefined;
      if (sha?.ok) { base = sha.stdout.trim(); diffBase = `${baseName} fetched from ${source}`; }
      else {
        for (const local of [...(remote ? [`${remote}/${baseName}`] : []), baseName]) {
          if ((await git(['rev-parse', '--verify', `${local}^{commit}`])).ok) { base = local; break; }
        }
        if (base) {
          diffBase = `local ${base} (may be stale)`;
          problems.push(`the diff is against the local ${base}, which may be behind the PR's base`);
        }
      }
    }
    const mb = base ? await git(['merge-base', base, head]) : undefined;
    const local = mb?.ok ? await git(['diff', '--no-color', '--no-ext-diff', mb.stdout.trim(), head], 60_000) : undefined;
    if (local?.ok) diff = local.stdout;
  }

  meta = {
    ...meta,
    ...(head ? { headRefOid: head } : {}),
    // Only GitHub's own headRefOid confirms the fetched commit is the PR's.
    headVerified: !!head && head === ghHead,
    ...(diff !== undefined ? { diffBase } : {}),
    checkedOut,
    ...(checkedOut ? { tree } : {}),
  };
  const metaPath = join(dir, `pr-${pr.number}.json`);
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  let diffPath = '';
  if (diff !== undefined) {
    diffPath = join(dir, `pr-${pr.number}.diff`);
    writeFileSync(diffPath, diff);
  } else problems.push('no diff could be saved');
  if (input.copyTo) {
    mkdirSync(input.copyTo, { recursive: true });
    for (const file of [metaPath, diffPath].filter(Boolean)) copyFileSync(file, join(input.copyTo, file.slice(dir.length + 1)));
  }
  return { checkedOut, head, tree: checkedOut ? tree : '', diffPath, metaPath, problems };
}
