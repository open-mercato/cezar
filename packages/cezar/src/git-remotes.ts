import { execFile } from 'node:child_process';
import { isSafeGitRef } from './git-refs.ts';

/**
 * The PR-target ("base") remote and the push remote, so nothing hard-codes `origin` (#1383).
 * Base: `gh repo set-default`, else a remote GitHub confirms is `origin`'s fork parent, else
 * `origin`, else the first remote. Push: `remote.pushDefault`, else `origin`, else base.
 */

export interface RemoteGitRunResult {
  ok: boolean;
  stdout: string;
}

export type RemoteGitRunner = (args: string[]) => Promise<RemoteGitRunResult>;

export interface TaskRemotes {
  /** The PR-target remote, or null when the repo has no remotes. */
  base: string | null;
  /** The remote task branches are pushed to, or null when the repo has no remotes. */
  push: string | null;
  /** Every configured remote name — what `splitRemoteRef` recognizes as a prefix. */
  names: string[];
}

export interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parse a git remote URL into host/owner/repo. Handles the scheme forms
 * (`https://`, `ssh://`, `git://`, with optional credentials and port) and the
 * scp-like form (`git@host:owner/repo.git`). Null for local paths and anything
 * else that doesn't look like a forge remote.
 */
export function parseRemote(remote: string): ParsedRemote | null {
  const r = remote.trim().replace(/\/+$/, '');
  let host: string | undefined;
  let path: string | undefined;
  const url = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(r);
  if (url) {
    [, host, path] = url;
  } else {
    // scp-like: [user@]host:owner/repo(.git) — a leading '/' (local path)
    // can't match the host group, so plain directories fall through to null.
    const scp = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(r);
    if (!scp) return null;
    [, host, path] = scp;
  }
  if (!host || !path) return null;
  const parts = path.replace(/\.git$/i, '').split('/').filter(Boolean);
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (!owner || !repo) return null;
  return { host: host.toLowerCase(), owner, repo };
}

/** `owner/name` of a GitHub repo's fork parent, or null (not a fork, no `gh`, offline). */
export type ForkParentLookup = (repo: ParsedRemote) => Promise<string | null>;

const PARENT_TIMEOUT_MS = 10_000;
/** A failed lookup (offline, gh signed out) is retried after this long; an answer is kept. */
const PARENT_RETRY_MS = 10 * 60_000;
const parentCache = new Map<string, { value: Promise<string | null>; expires: number }>();

const ghForkParent: ForkParentLookup = (repo) => {
  const key = `${repo.host}/${repo.owner}/${repo.repo}`.toLowerCase();
  const hit = parentCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = new Promise<string | null>((resolve) => {
    execFile(
      'gh',
      ['api', '--hostname', repo.host, `repos/${repo.owner}/${repo.repo}`, '--jq', '.parent.full_name // ""'],
      { timeout: PARENT_TIMEOUT_MS, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
      (err, stdout) => resolve(err ? null : stdout.trim()),
    );
  });
  // '' = "not a fork", a real answer; null = no answer, ask again later.
  const entry = { value: value.then((v) => v || null), expires: Number.POSITIVE_INFINITY };
  parentCache.set(key, entry);
  void value.then((v) => {
    if (v === null) entry.expires = Date.now() + PARENT_RETRY_MS;
  });
  return entry.value;
};

let forkParentLookup: ForkParentLookup = ghForkParent;

/** Test seam: replace the GitHub fork-parent lookup; `null` restores the real one. */
export function setForkParentLookup(lookup: ForkParentLookup | null): void {
  forkParentLookup = lookup ?? ghForkParent;
  parentCache.clear();
}

export async function resolveTaskRemotes(runGit: RemoteGitRunner): Promise<TaskRemotes> {
  // One process: every `remote.*` key — urls (raw, before insteadOf), gh-resolved, pushDefault.
  const res = await runGit(['config', '--get-regexp', '^remote\\.']);
  const urls = new Map<string, string>();
  let ghResolved: string | null = null;
  let pushDefault = '';
  for (const line of res.ok ? res.stdout.split('\n') : []) {
    const m = /^remote\.(.+)\.(url|gh-resolved) (.*)$/.exec(line.trim());
    if (m) {
      const [, name = '', key, value = ''] = m;
      if (key === 'url' && !urls.has(name)) urls.set(name, value);
      else if (key === 'gh-resolved' && value === 'base') ghResolved ??= name;
      continue;
    }
    const pd = /^remote\.pushdefault (.*)$/.exec(line.trim());
    if (pd) pushDefault = pd[1] ?? '';
  }
  // Dash-guard (#431): names become positional git operands.
  const names = [...urls.keys()].filter(isSafeGitRef);
  if (names.length === 0) return { base: null, push: null, names };

  let base: string | null = ghResolved && names.includes(ghResolved) ? ghResolved : null;
  if (!base && names.includes('origin')) base = await forkParentRemote(urls, names);
  base ??= names.includes('origin') ? 'origin' : (names[0] as string);

  const push = names.includes(pushDefault) ? pushDefault : names.includes('origin') ? 'origin' : base;
  return { base, push, names };
}

/**
 * The remote whose repo GitHub reports as `origin`'s fork parent. Name alone proves nothing:
 * `upstream` is the canonical repo on a contributor's fork but the vendored project on a
 * downstream fork — only the parent link tells them apart. Skipped under `CEZ_DRY_RUN=1`.
 */
async function forkParentRemote(urls: Map<string, string>, names: string[]): Promise<string | null> {
  if (names.length < 2 || process.env.CEZ_DRY_RUN === '1') return null;
  const origin = parseRemote(urls.get('origin') ?? '');
  // Only GitHub can answer (`FORGE_HOSTS` in forge/index.ts); never spawn `gh` for GitLab & co.
  if (origin?.host !== 'github.com') return null;
  const parent = (await forkParentLookup(origin))?.toLowerCase();
  if (!parent) return null;
  for (const name of names) {
    const r = name === 'origin' ? null : parseRemote(urls.get(name) ?? '');
    if (r && r.host === origin.host && `${r.owner}/${r.repo}`.toLowerCase() === parent) return name;
  }
  return null;
}

/**
 * Split `upstream/main` into `{ remote: 'upstream', branch: 'main' }` when the prefix is a
 * configured remote; anything else (`feat/x`) is `remote: null`. Longest remote name wins.
 */
export function splitRemoteRef(ref: string, names: readonly string[]): { remote: string | null; branch: string } {
  let best: string | null = null;
  for (const name of names) {
    if (ref.startsWith(`${name}/`) && ref.length > name.length + 1 && (!best || name.length > best.length)) {
      best = name;
    }
  }
  return best ? { remote: best, branch: ref.slice(best.length + 1) } : { remote: null, branch: ref };
}
