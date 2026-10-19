import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BranchTracking, LogEntry, RepoSync } from '@open-mercato/cezar-contract';
import { isSafeGitRef } from '../git-refs.ts';
import { resolveTaskRemotes } from '../git-remotes.ts';
import { pushCurrentBranch } from './git-changes.ts';

/**
 * The main checkout against its remote, Source-Control style (spec 2026-10-19-repo-git-sync):
 * read offline from remote-tracking refs, refreshed only by an explicit fetch/pull/push/sync.
 * Helpers never throw — every git failure is `{ ok:false, error }` with git's own words.
 */

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Network round trips (fetch, push) must never hang the cockpit on a credential prompt. */
const NETWORK_TIMEOUT_MS = 60_000;
const OUTGOING_CAP = 200;
const INCOMING_CAP = 50;

function git(cwd: string, args: string[], timeout?: number): Promise<GitResult> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        ...(timeout ? { timeout } : {}),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => done({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

function reason(res: GitResult, fallback: string): string {
  const lines = (res.stderr.trim() || res.stdout.trim()).split('\n').map((l) => l.trim()).filter(Boolean);
  // git prefixes the useful line with `fatal:`/`error:`; prefer it over progress chatter.
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? fallback;
}

const LOG_FORMAT = '--pretty=format:%h%x1f%s%x1f%an%x1f%cr';

function parseLog(stdout: string): LogEntry[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = '', author = '', when = ''] = line.split('\x1f');
      return { hash, subject, author, when };
    });
}

/** `[ahead 1, behind 2]` / `[gone]` / `` from `%(upstream:track)`. */
export function parseTrack(track: string, hasUpstream: boolean): Pick<BranchTracking, 'ahead' | 'behind' | 'gone'> {
  if (!hasUpstream) return { ahead: null, behind: null, gone: false };
  if (track.includes('gone')) return { ahead: null, behind: null, gone: true };
  const ahead = /ahead (\d+)/.exec(track)?.[1];
  const behind = /behind (\d+)/.exec(track)?.[1];
  return { ahead: ahead ? Number(ahead) : 0, behind: behind ? Number(behind) : 0, gone: false };
}

async function branchTracking(root: string, hide: ReadonlySet<string>): Promise<BranchTracking[]> {
  const res = await git(root, [
    'for-each-ref',
    '--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)',
    'refs/heads',
  ]);
  if (!res.ok) return [];
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', upstream = '', track = ''] = line.split('\0');
      return { name, upstream: upstream || null, ...parseTrack(track, Boolean(upstream)) };
    })
    .filter((b) => b.name && !b.name.startsWith('cez/') && !hide.has(b.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function lastFetchedAt(root: string): Promise<string | null> {
  const path = await git(root, ['rev-parse', '--git-path', 'FETCH_HEAD']);
  if (!path.ok) return null;
  try {
    return (await stat(resolve(root, path.stdout.trim()))).mtime.toISOString();
  } catch {
    return null;
  }
}

export async function repoSyncStatus(root: string, hide: ReadonlySet<string> = new Set()): Promise<RepoSync> {
  const [head, up, remotes, fetchedAt, branches] = await Promise.all([
    git(root, ['symbolic-ref', '--short', '-q', 'HEAD']),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    resolveTaskRemotes((args) => git(root, args)),
    lastFetchedAt(root),
    branchTracking(root, hide),
  ]);
  const branch = head.ok ? head.stdout.trim() || null : null;
  const upstream = branch && up.ok ? up.stdout.trim() || null : null;
  const base = {
    branch,
    upstream,
    pushRemote: remotes.push,
    lastFetchedAt: fetchedAt,
    // A task branch hidden from the list is still the one the user stands on.
    branches,
  };
  if (!upstream) {
    // Never published: everything no remote has is outgoing (VS Code's "Publish Branch").
    const local = remotes.names.length
      ? await git(root, ['log', `-${OUTGOING_CAP}`, '--format=%h', 'HEAD', '--not', '--remotes'])
      : { ok: false, stdout: '', stderr: '' };
    return {
      ...base,
      ahead: null,
      behind: null,
      outgoing: local.ok ? local.stdout.split('\n').filter(Boolean) : [],
      incoming: [],
    };
  }
  const [counts, out, inc] = await Promise.all([
    git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']),
    git(root, ['log', `-${OUTGOING_CAP}`, '--format=%h', '@{u}..HEAD']),
    git(root, ['log', `-${INCOMING_CAP}`, LOG_FORMAT, 'HEAD..@{u}']),
  ]);
  const [ahead, behind] = counts.ok ? counts.stdout.trim().split(/\s+/).map(Number) : [];
  return {
    ...base,
    ahead: Number.isFinite(ahead) ? (ahead as number) : null,
    behind: Number.isFinite(behind) ? (behind as number) : null,
    outgoing: out.ok ? out.stdout.split('\n').filter(Boolean) : [],
    incoming: inc.ok ? parseLog(inc.stdout) : [],
  };
}

export type SyncActionResult = { ok: true; message: string } | { ok: false; error: string };

/** One mutation per checkout at a time: a double-clicked Sync must not race its own pull. */
const inFlight = new Map<string, Promise<unknown>>();
function serialized<T>(root: string, work: () => Promise<T>): Promise<T> {
  const prev = inFlight.get(root) ?? Promise.resolve();
  const next = prev.then(work, work);
  inFlight.set(root, next);
  void next.finally(() => {
    if (inFlight.get(root) === next) inFlight.delete(root);
  });
  return next;
}

const dryRun = (): boolean => process.env.CEZ_DRY_RUN === '1';

/** `git fetch --prune` from every remote. Skipped under `CEZ_DRY_RUN=1` (no network). */
export function fetchRepo(root: string): Promise<SyncActionResult> {
  return serialized(root, async () => {
    if (dryRun()) return { ok: true, message: 'dry run — fetch skipped' };
    const remotes = await git(root, ['remote']);
    if (!remotes.stdout.trim()) return { ok: false, error: 'no remote configured' };
    const res = await git(
      root,
      ['-c', 'credential.interactive=false', 'fetch', '--all', '--prune', '--quiet'],
      NETWORK_TIMEOUT_MS,
    );
    if (!res.ok) return { ok: false, error: reason(res, 'git fetch failed') };
    return { ok: true, message: 'fetched' };
  });
}

/** Fetch the upstream, then fast-forward onto it. Never merges or rebases: a diverged branch
 *  is the user's call, so it comes back as a 409 that says so. */
export function pullRepo(root: string): Promise<SyncActionResult> {
  return serialized(root, () => pullUnlocked(root));
}

async function pullUnlocked(root: string): Promise<SyncActionResult> {
  const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok) return { ok: false, error: 'this branch has no upstream — push it first' };
  const upstream = up.stdout.trim();
  const remotes = await resolveTaskRemotes((args) => git(root, args));
  const remote = remotes.names.find((n) => upstream.startsWith(`${n}/`));
  if (remote && !dryRun()) {
    const branch = upstream.slice(remote.length + 1);
    if (!isSafeGitRef(branch)) return { ok: false, error: `invalid upstream: ${upstream}` };
    const fetched = await git(
      root,
      ['-c', 'credential.interactive=false', 'fetch', '--quiet', '--no-tags', remote, branch],
      NETWORK_TIMEOUT_MS,
    );
    if (!fetched.ok) return { ok: false, error: reason(fetched, 'git fetch failed') };
  }
  const counts = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (!counts.ok) return { ok: false, error: reason(counts, `could not compare HEAD with ${upstream}`) };
  const [ahead = 0, behind = 0] = counts.stdout.trim().split(/\s+/).map(Number);
  if (behind === 0) return { ok: true, message: 'already up to date' };
  if (ahead > 0) {
    return {
      ok: false,
      error: `${upstream} has diverged (${ahead} local, ${behind} incoming) — merge or rebase it yourself`,
    };
  }
  const merge = await git(root, ['merge', '--ff-only', '--quiet', '@{u}']);
  if (!merge.ok) return { ok: false, error: reason(merge, 'fast-forward failed') };
  return { ok: true, message: `pulled ${behind} commit${behind === 1 ? '' : 's'}` };
}

/** Push the current branch, publishing it (`-u`) when it has no upstream yet. */
export function pushRepo(root: string): Promise<SyncActionResult> {
  return serialized(root, () => pushUnlocked(root));
}

async function pushUnlocked(root: string): Promise<SyncActionResult> {
  if (dryRun()) return { ok: true, message: 'dry run — push skipped' };
  const res = await pushCurrentBranch(root);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, message: res.upstreamSet ? `published ${res.branch} to ${res.remote}` : `pushed ${res.branch}` };
}

/** VS Code's Sync: pull (fast-forward only), then push. */
export function syncRepo(root: string): Promise<SyncActionResult> {
  return serialized(root, async () => {
    const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (up.ok) {
      const pulled = await pullUnlocked(root);
      if (!pulled.ok) return pulled;
    }
    const pushed = await pushUnlocked(root);
    if (!pushed.ok) return pushed;
    return { ok: true, message: 'synced' };
  });
}
