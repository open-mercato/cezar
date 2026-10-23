import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { cleanupCheckout, isValidCheckoutName, parseRepoRef } from '../server/checkout.ts';

/**
 * Cloning a fleet job's repo from any https host (GitLab, Bitbucket, Gitea, self-hosted), strictly
 * validated: https only, no credentials in the URL, no transport tricks (`ext::`, `file://`,
 * option-like values), a directory name derived from the path. GitHub keeps its own `gh` path
 * (`checkoutRepo`); this is for everything else. Private repos on other hosts need the node's own
 * git credential helper — jobs never carry credentials.
 */

export interface HttpsRepo {
  /** Canonical clone URL: `https://host[:port]/a/b.git`. */
  url: string;
  host: string;
  /** Path segments without `.git`, e.g. `['group', 'sub', 'repo']`. */
  segments: string[];
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const CLONE_TIMEOUT_MS = 10 * 60_000;

/** `null` when `input` is not a plain https repository URL. */
export function parseHttpsRepo(input: string): HttpsRepo | null {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 512 || /[\s\u0000-\u001f\u007f\\]/.test(raw) || raw.startsWith('-')) return null;
  if (!/^https:\/\//i.test(raw)) return null; // not http, ssh, git, file, ext::, scp-like ...
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (!HOST.test(host) || host.includes('..')) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > 0) segments[segments.length - 1] = (segments[segments.length - 1] as string).replace(/\.git$/i, '');
  if (segments.length < 2 || segments.length > 8 || !segments.every((s) => SEGMENT.test(s) && !s.includes('..'))) return null;
  const port = url.port ? `:${url.port}` : '';
  return { url: `https://${host}${port}/${segments.join('/')}.git`, host, segments };
}

/** Runs `git clone` into an existing empty directory; injectable for tests. */
export type GitCloneRunner = (url: string, dir: string) => Promise<{ ok: true } | { ok: false; error: string }>;

export const gitCloneRunner: GitCloneRunner = (url, dir) =>
  new Promise((done) => {
    execFile(
      'git',
      // Allow https only, whatever the repo's submodules or redirects ask for.
      ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'clone', '--', url, dir],
      { timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' },
      (err, _stdout, stderr) => done(err ? { ok: false, error: (stderr || err.message).trim().split('\n').slice(-2).join(' ') } : { ok: true }),
    );
  });

export type CloneOutcome = { ok: true; target: string } | { ok: false; error: string };

/**
 * Clone `repo` into `<projectsDir>/<name>`. The directory is created non-recursively first, so a
 * failure only ever cleans up what this call made. The name is the repo, else owner-repo, else
 * host-owner-repo when earlier ones are taken.
 */
export async function cloneHttpsRepo(repo: HttpsRepo, projectsDir: string, run: GitCloneRunner = gitCloneRunner): Promise<CloneOutcome> {
  if (!isAbsolute(projectsDir)) return { ok: false, error: `checkout root is not an absolute path: ${projectsDir}` };
  const root = resolve(projectsDir);
  await mkdir(root, { recursive: true });
  const repoName = repo.segments[repo.segments.length - 1] as string;
  const owner = repo.segments[repo.segments.length - 2] as string;
  for (const name of [repoName, `${owner}-${repoName}`, `${repo.host}-${owner}-${repoName}`]) {
    if (!isValidCheckoutName(name)) continue;
    const target = join(root, name);
    try {
      await mkdir(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { ok: false, error: `could not create ${target}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const result = await run(repo.url, target).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
    if (!result.ok) {
      await cleanupCheckout(root, target);
      return { ok: false, error: result.error };
    }
    return { ok: true, target };
  }
  return { ok: false, error: 'every candidate folder name is already taken' };
}

/** GitHub spellings (`owner/repo`, https, ssh) go through `gh`; anything else must be plain https. */
export function classifyRepo(input: string): { kind: 'github' } | { kind: 'https'; repo: HttpsRepo } | { kind: 'invalid' } {
  if (parseRepoRef(input)) return { kind: 'github' };
  const repo = parseHttpsRepo(input);
  return repo ? { kind: 'https', repo } : { kind: 'invalid' };
}

/** A browsable URL for a pushed branch on forges whose URL shape is known; undefined otherwise. */
export function branchWebUrl(remote: string, branch: string): string | undefined {
  const repo = parseHttpsRepo(remote.replace(/^(?:git@|ssh:\/\/git@)([^:/]+)[:/]/, 'https://$1/'));
  if (!repo) return undefined;
  const path = repo.segments.join('/');
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  if (repo.host.includes('gitlab')) return `https://${repo.host}/${path}/-/tree/${ref}`;
  if (repo.host === 'bitbucket.org') return `https://${repo.host}/${path}/src/${ref}`;
  return `https://${repo.host}/${path}/tree/${ref}`;
}
