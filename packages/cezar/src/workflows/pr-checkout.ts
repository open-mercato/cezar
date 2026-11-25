import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** Every GitHub pull-request URL in `text`, in order. */
export function parsePrUrls(text: string): PrRef[] {
  const out: PrRef[] = [];
  for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g)) {
    const [url, host = '', owner = '', repo = '', n = ''] = m;
    if (isGithubHost(host.toLowerCase())) out.push({ host: host.toLowerCase(), owner, repo: repo.replace(/\.git$/i, ''), number: Number(n), url });
  }
  return out;
}

/** The first GitHub pull-request URL in `text`. */
export function parsePrUrl(text: string): PrRef | undefined {
  return parsePrUrls(text)[0];
}

/**
 * The PR this checkout reviews: the first URL in the task that is a pull request of a repository
 * this checkout has a remote for — a URL quoted from an issue body or another project is never
 * fetched into the user's object store. Falls back to the first URL (its checkout then refuses).
 */
export async function pickPr(cwd: string, text: string, run: Exec = exec): Promise<PrRef | undefined> {
  const prs = parsePrUrls(text);
  for (const pr of prs) if (await prRemote(cwd, pr, run)) return pr;
  return prs[0];
}

export type Exec = (file: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const exec: Exec = (file, args, { cwd, timeoutMs, env }) => new Promise((done) => {
  execFile(file, args, {
    cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    // Unattended: an HTTPS credential prompt fails instead of hanging (SSH: `batchSshEnv`).
    env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
  }, (err, stdout, stderr) => done({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr || err?.message || '') }));
});

export interface PrCheckoutInput {
  /** A checkout of the repository, for git: only objects and temporary private refs change; its files and FETCH_HEAD never do. */
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
  /** Private refs the fetches land in (`refs/cezar/pr-checkouts/<run>`), deleted afterwards —
   *  never FETCH_HEAD, which on an in-place run is the user's and another fetch may replace. */
  refPrefix: string;
  exec?: Exec;
  /** Waits before the one re-fetch of a head GitHub has not published yet; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
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

/** Hosts that are some other forge, never an SSH alias of a GitHub host. */
const OTHER_FORGE = /(^|\.)(gitlab|bitbucket|codeberg|gitea|forgejo|sourcehut|sr\.ht|azure|visualstudio)(\.|$)/;

/** An SSH URL (`ssh://`, `git+ssh://` or scp-like `host:path`), the only form an SSH alias takes. */
const isSshUrl = (url: string) => /^(ssh|git\+ssh):\/\//i.test(url) || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && /^[^/:]+:/.test(url));

export interface PrRemoteMatch {
  name: string;
  /** Matched through an SSH host alias, not the PR's own host: only GitHub's head can vouch for it. */
  viaAlias: boolean;
}

/**
 * The remote whose URL IS the PR's repository: same owner/repo on the PR's host, or an SSH URL on
 * a host that is neither a GitHub host nor another forge (an alias, `git@github-work:o/r`).
 * Another GitHub host is another repository. Undefined when none is — then nothing is fetched.
 */
export async function prRemoteMatch(cwd: string, pr: PrRef, run: Exec = exec): Promise<PrRemoteMatch | undefined> {
  const res = await run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd, timeoutMs: 10_000 });
  let alias: string | undefined;
  for (const line of res.ok ? res.stdout.split('\n') : []) {
    const m = /^remote\.(.+)\.url (.*)$/.exec(line.trim());
    const url = m?.[2] ?? '';
    const parsed = m ? parseRemote(url) : null;
    const host = parsed?.host.toLowerCase();
    if (!m || !parsed || !host || !isSafeGitRef(m[1]!)) continue;
    if (parsed.owner.toLowerCase() !== pr.owner.toLowerCase() || parsed.repo.toLowerCase() !== pr.repo.toLowerCase()) continue;
    if (host === pr.host) return { name: m[1]!, viaAlias: false };
    if (!alias && isSshUrl(url.trim()) && !isGithubHost(host) && !OTHER_FORGE.test(host)) alias = m[1]!;
  }
  return alias ? { name: alias, viaAlias: true } : undefined;
}

/** The name of `prRemoteMatch`'s remote. */
export async function prRemote(cwd: string, pr: PrRef, run: Exec = exec): Promise<string | undefined> {
  return (await prRemoteMatch(cwd, pr, run))?.name;
}

/**
 * SSH that fails instead of prompting, on the user's own SSH command: BatchMode is appended to
 * `GIT_SSH_COMMAND` or `core.sshCommand` (their key, their proxy), never put in their place. A
 * `GIT_SSH` program is left alone — `GIT_SSH_COMMAND` would override it.
 */
export async function batchSshEnv(cwd: string, run: Exec = exec, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv | undefined> {
  const BATCH = '-o BatchMode=yes';
  const own = env.GIT_SSH_COMMAND?.trim();
  if (own) return { ...env, GIT_SSH_COMMAND: `${own} ${BATCH}` };
  if (env.GIT_SSH?.trim()) return undefined;
  const configured = await run('git', ['config', '--get', 'core.sshCommand'], { cwd, timeoutMs: 10_000 });
  const command = configured.ok ? configured.stdout.trim() : '';
  return { ...env, GIT_SSH_COMMAND: command ? `${command} ${BATCH}` : `ssh ${BATCH}` };
}

const lastLine = (s: string) => s.trim().split('\n').pop()?.slice(0, 300) ?? '';

/** The sha-1 and sha-256 empty trees: `GIT_ATTR_SOURCE` there means the PR's own `.gitattributes`
 *  cannot name a local filter driver for the export (git 2.42+; older git ignores it). */
const EMPTY_TREE = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' };

/** Files the checkout wrote are read-only on disk too: a reviewer's write is refused by the OS as
 *  well as by its tool rules. */
function writeReadOnly(path: string, content: string): void {
  rmSync(path, { force: true });
  writeFileSync(path, content, { mode: 0o444, flag: 'wx' });
}

/**
 * Never throws: a disk error (read-only home, full disk) is a failed checkout, so the walk takes
 * `checkout.failed` and the reviewers fall back to `gh`.
 */
export async function checkoutPr(input: PrCheckoutInput): Promise<PrCheckoutResult> {
  try {
    return await checkoutPrOrThrow(input);
  } catch (err) {
    // Nothing may outlive a failed checkout as if it were one: no tree, and no metadata or diff
    // still saying `checkedOut: true` for agents to read through `--add-dir`.
    try { rmSync(join(input.dir, 'tree'), { recursive: true, force: true }); } catch { /* nothing more to do */ }
    try {
      for (const name of readdirSync(input.dir)) {
        if (/^pr-\d+\.(json|diff)$/.test(name)) rmSync(join(input.dir, name), { force: true });
      }
    } catch { /* nothing more to do */ }
    return {
      checkedOut: false, head: '', tree: '', diffPath: '', metaPath: '',
      problems: [`the PR checkout failed — ${lastLine(err instanceof Error ? err.message : String(err))}`],
    };
  }
}

async function checkoutPrOrThrow(input: PrCheckoutInput): Promise<PrCheckoutResult> {
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

  const match = input.offline ? undefined : await prRemoteMatch(cwd, pr, run);
  // An alias may point anywhere; without GitHub's head, what it serves cannot pass as the PR.
  const remote = match && (!match.viaAlias || ghHead) ? match.name : undefined;
  const source = remote ?? '';
  const sshEnv = remote ? await batchSshEnv(cwd, run) : undefined;
  const headRef = `${input.refPrefix}/head`;
  const baseRef = `${input.refPrefix}/base`;
  const touchedRefs = new Set<string>();
  /** Fetch one ref into a private ref and resolve it there. */
  const fetchInto = async (from: string, into: string): Promise<{ sha?: string; error?: string }> => {
    touchedRefs.add(into);
    const f = await git(['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', source, `+${from}:${into}`], 120_000, sshEnv);
    if (!f.ok) return { error: lastLine(f.stderr) };
    const r = await git(['rev-parse', '--verify', `${into}^{commit}`]);
    return r.ok && r.stdout.trim() ? { sha: r.stdout.trim() } : { error: `could not read it — ${lastLine(r.stderr)}` };
  };
  const pullRef = `refs/pull/${pr.number}/head`;
  try {
    if (input.offline) problems.push('CEZ_DRY_RUN=1: the PR was not fetched or checked out');
    else if (match && !remote) problems.push(`the remote ${match.name} is an SSH alias and GitHub did not confirm the PR's head; the PR was not fetched`);
    else if (!remote) problems.push(`no remote of this repository is ${pr.owner}/${pr.repo} on ${pr.host}; the PR was not fetched`);
    else {
      let got = await fetchInto(pullRef, headRef);
      // GitHub moves refs/pull/N/head a moment after a push: one more look before calling it a mismatch.
      if (got.sha && ghHead && got.sha !== ghHead) {
        await (input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(3_000);
        got = await fetchInto(pullRef, headRef);
      }
      if (got.error) problems.push(got.error.startsWith('could not read')
        ? `fetched pull/${pr.number}/head but ${got.error}`
        : `git fetch ${source} pull/${pr.number}/head failed — ${got.error}`);
      else head = got.sha!;
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
      const format = (await git(['rev-parse', '--show-object-format'])).stdout.trim() === 'sha256' ? 'sha256' : 'sha1';
      const env = { ...process.env, GIT_INDEX_FILE: index, GIT_LFS_SKIP_SMUDGE: '1', GIT_ATTR_SOURCE: EMPTY_TREE[format] };
      const read = await git(['-c', 'core.symlinks=false', 'read-tree', head], 60_000, env);
      const out = read.ok ? await git(['-c', 'core.symlinks=false', 'checkout-index', '-a', '-f', `--prefix=${tree}/`], 300_000, env) : read;
      rmSync(index, { force: true });
      if (out.ok) checkedOut = true;
      else {
        // A half-written tree is no checkout: nothing may read it as one.
        rmSync(tree, { recursive: true, force: true });
        problems.push(`could not export ${head.slice(0, 12)} — ${lastLine(out.stderr)}`);
      }
    }

    if (diff === undefined && head) {
      // No gh: the PR's commits against its base, fetched fresh; a local base may be stale.
      const fromGithub = typeof meta.baseRefName === 'string';
      const named = fromGithub ? meta.baseRefName as string : input.baseBranch;
      const baseName = named && isSafeGitRef(named) ? named : undefined;
      if (named && !baseName) problems.push(`the base branch name ${JSON.stringify(named.slice(0, 80))} is not a safe git ref; no diff was made`);
      // GitHub did not name the PR's base: the task's may be another branch altogether.
      const whose = fromGithub ? '' : ' (the task\'s base: GitHub did not name the PR\'s)';
      if (baseName && !fromGithub) problems.push(`the diff is against the task's base ${baseName}, which may not be the PR's base`);
      let base: string | undefined;
      if (baseName) {
        const fetched = await fetchInto(`refs/heads/${baseName}`, baseRef);
        if (fetched.sha) { base = fetched.sha; diffBase = `${baseName}${whose} fetched from ${source}`; }
        else {
          for (const local of [...(remote ? [`${remote}/${baseName}`] : []), baseName]) {
            if ((await git(['rev-parse', '--verify', `${local}^{commit}`])).ok) { base = local; break; }
          }
          if (base) {
            diffBase = `local ${base}${whose} (may be stale)`;
            problems.push(`the diff is against the local ${base}, which may be behind the PR's base`);
          }
        }
      }
      const mb = base ? await git(['merge-base', base, head]) : undefined;
      const local = mb?.ok ? await git(['diff', '--no-color', '--no-ext-diff', mb.stdout.trim(), head], 60_000) : undefined;
      if (local?.ok) diff = local.stdout;
    }
  } finally {
    for (const ref of touchedRefs) await git(['update-ref', '-d', ref]);
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
  writeReadOnly(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  let diffPath = '';
  if (diff !== undefined) {
    diffPath = join(dir, `pr-${pr.number}.diff`);
    writeReadOnly(diffPath, diff);
  } else problems.push('no diff could be saved');
  if (input.copyTo) {
    mkdirSync(input.copyTo, { recursive: true });
    for (const file of [metaPath, diffPath].filter(Boolean)) {
      const target = join(input.copyTo, file.slice(dir.length + 1));
      rmSync(target, { force: true }); // a re-run's copy replaces a read-only one
      copyFileSync(file, target);
      chmodSync(target, 0o444);
    }
  }
  return { checkedOut, head, tree: checkedOut ? tree : '', diffPath, metaPath, problems };
}
