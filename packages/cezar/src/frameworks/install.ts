import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FrameworkInstallSource } from './builtins.ts';
import { scrubbedEnv } from './state.ts';

const run = promisify(execFile);

/**
 * One-click install of a built-in framework's own installer (Settings → Framework → "Install into
 * this repo"). The source is fetched at its pinned commit into `~/.cache/cez/frameworks/<id>/<sha>/`
 * (reused afterwards) and its installer runs against the repo. Never throws.
 */

export type InstallResult =
  | { ok: true; output: string; changedPaths: string[]; committed: boolean; note?: string }
  /** `conflict` → the repo's state refuses it (409); `failed` → download or installer (502). */
  | { ok: false; code: 'conflict' | 'failed'; error: string };

export interface InstallOptions {
  /** Commit the changed paths when the checked-out branch is the one cards fork from. */
  commit?: boolean;
  /** `.ai/cezar/config.json` `baseBranch`; absent → the checked-out branch (`chooseForkBase`). */
  baseBranch?: string;
  /** Defaults to `~/.cache/cez/frameworks`; tests point it at a temp dir. */
  cacheRoot?: string;
  timeoutMs?: number;
}

export function frameworksCacheRoot(): string {
  return join(homedir(), '.cache', 'cez', 'frameworks');
}

const inFlight = new Map<string, Promise<InstallResult>>();

/** Serialized per repo: a second click while one runs gets the same result, never a second run. */
export function installFramework(repoRoot: string, id: string, source: FrameworkInstallSource, opts: InstallOptions = {}): Promise<InstallResult> {
  const key = resolve(repoRoot);
  const running = inFlight.get(key);
  if (running) return running;
  const job = doInstall(key, id, source, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

/** `CEZ_DRY_RUN=1`: no network, no writes. */
export async function dryRunInstall(): Promise<InstallResult> {
  return { ok: true, output: '', changedPaths: [], committed: false, note: 'CEZ_DRY_RUN=1 — nothing was downloaded or written.' };
}

/** The branch a commit would land on, and the one cards fork from. */
export async function installTarget(repoRoot: string, configuredBase?: string): Promise<{ currentBranch: string | null; baseBranch: string | null }> {
  const current = await currentBranch(repoRoot);
  return { currentBranch: current, baseBranch: configuredBase ?? current };
}

const gitEnv = () => ({ ...scrubbedEnv(), GIT_TERMINAL_PROMPT: '0' });

async function git(cwd: string, args: string[], timeout = 30_000) {
  return run('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: gitEnv() });
}

async function currentBranch(repoRoot: string): Promise<string | null> {
  try {
    return (await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5_000)).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** `.ai/sdd/` → `:(glob).ai/sdd/**`; a file stays itself. */
export function writesToPathspecs(writes: readonly string[]): string[] {
  return writes.map((w) => `:(glob)${w.endsWith('/') ? `${w}**` : w}`);
}

/** `git status --porcelain -z` under `pathspecs`: path → status code. */
async function statusOf(repoRoot: string, pathspecs: string[]): Promise<Map<string, string>> {
  const { stdout } = await git(repoRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...pathspecs]);
  const out = new Map<string, string>();
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (line.length < 4) continue;
    out.set(line.slice(3), line.slice(0, 2));
    if (line[0] === 'R' || line[0] === 'C') i++; // the rename's source path follows
  }
  return out;
}

async function doInstall(repoRoot: string, id: string, source: FrameworkInstallSource, opts: InstallOptions): Promise<InstallResult> {
  const timeout = opts.timeoutMs ?? 120_000;
  const pathspecs = writesToPathspecs(source.writes);
  let before: Map<string, string>;
  try {
    await git(repoRoot, ['rev-parse', '--show-toplevel'], 5_000);
    before = await statusOf(repoRoot, pathspecs);
  } catch {
    return { ok: false, code: 'conflict', error: 'this project is not a git repository — the installer needs one' };
  }
  // The installer replaces its skill folders wholesale; local edits to an existing install would be lost.
  if (existsSync(join(repoRoot, source.marker)) && before.size) {
    return {
      ok: false,
      code: 'conflict',
      error: `commit or discard local changes first — ${[...before.keys()].slice(0, 3).join(', ')}${before.size > 3 ? ` and ${before.size - 3} more` : ''} would be overwritten`,
    };
  }

  const checkout = await ensureSource(opts.cacheRoot ?? frameworksCacheRoot(), id, source, timeout);
  if (!checkout.ok) return { ok: false, code: 'failed', error: checkout.error };

  let output: string;
  try {
    const res = await run(process.execPath, [join(checkout.dir, source.installer), repoRoot], {
      cwd: checkout.dir,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: scrubbedEnv(),
    });
    output = res.stdout.trim();
  } catch (err) {
    return { ok: false, code: 'failed', error: `the ${source.label} installer failed: ${oneLine(err)}` };
  }

  let after: Map<string, string>;
  try {
    after = await statusOf(repoRoot, pathspecs);
  } catch (err) {
    return { ok: false, code: 'failed', error: `installed, but git status failed: ${oneLine(err)}` };
  }
  const changedPaths = [...after].filter(([path, code]) => before.get(path) !== code).map(([path]) => path).sort();
  if (!changedPaths.length) return { ok: true, output, changedPaths, committed: false, note: 'Nothing changed — this version is already installed.' };

  const { currentBranch: branch, baseBranch: base } = await installTarget(repoRoot, opts.baseBranch);
  const unseen = `Cards run in worktrees off ${base ?? 'the base branch'}, so they will not see these files until they are committed there.`;
  if (!opts.commit) return { ok: true, output, changedPaths, committed: false, note: `Left uncommitted. ${unseen}` };
  if (!branch) return { ok: true, output, changedPaths, committed: false, note: `Left uncommitted: HEAD is detached. ${unseen}` };
  if (branch !== base) {
    return { ok: true, output, changedPaths, committed: false, note: `Left uncommitted: you are on ${branch}, not ${base}. ${unseen}` };
  }
  try {
    await git(repoRoot, ['add', '-A', '--', ...changedPaths]);
    await git(repoRoot, ['commit', '-q', '-m', `chore: install ${source.name} (${source.ref.slice(0, 7)})`, '--', ...changedPaths], 60_000);
  } catch (err) {
    return { ok: true, output, changedPaths, committed: false, note: `Installed, but the commit failed: ${oneLine(err)}. ${unseen}` };
  }
  return { ok: true, output, changedPaths, committed: true, note: `Committed on ${branch}.` };
}

/** The pinned checkout in the cache, fetched once into a temp dir and renamed into place. */
async function ensureSource(
  cacheRoot: string,
  id: string,
  source: FrameworkInstallSource,
  timeout: number,
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  if (!/^[0-9a-f]{40}$/.test(source.ref)) return { ok: false, error: `${source.label}: the pinned ref is not a full commit sha` };
  const dir = join(cacheRoot, id, source.ref);
  if (await isCheckout(dir, source)) return { ok: true, dir };
  const failed = (err: unknown) => ({ ok: false as const, error: `could not download ${source.label} at ${source.ref.slice(0, 7)}: ${oneLine(err)}` });
  let tmp: string;
  try {
    await mkdir(join(cacheRoot, id), { recursive: true });
    tmp = await mkdtemp(join(cacheRoot, id, `.${source.ref.slice(0, 7)}-`));
  } catch (err) {
    return failed(err);
  }
  try {
    await git(tmp, ['init', '-q']);
    try {
      await git(tmp, ['fetch', '-q', '--depth', '1', '--no-tags', source.repo, source.ref], timeout);
    } catch {
      // A server that refuses a bare sha: fetch its branches and tags, then find the commit.
      await git(tmp, ['fetch', '-q', source.repo, '+refs/heads/*:refs/remotes/src/*', '+refs/tags/*:refs/tags/*'], timeout);
    }
    await git(tmp, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', source.ref]);
    if (!(await isCheckout(tmp, source))) return failed('the checkout does not match the pinned commit');
    await rm(dir, { recursive: true, force: true });
    try {
      await rename(tmp, dir);
    } catch (err) {
      // Another process won the race; its checkout is as good as ours.
      if (!(await isCheckout(dir, source))) return failed(err);
    }
    return { ok: true, dir };
  } catch (err) {
    return failed(err);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function isCheckout(dir: string, source: FrameworkInstallSource): Promise<boolean> {
  if (!existsSync(join(dir, source.installer))) return false;
  try {
    return (await git(dir, ['rev-parse', 'HEAD'], 5_000)).stdout.trim() === source.ref;
  } catch {
    return false;
  }
}

function oneLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string; killed?: boolean };
  if (e.killed) return 'timed out';
  const text = (e.stderr?.trim() || e.message || String(err)).trim();
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? text;
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
