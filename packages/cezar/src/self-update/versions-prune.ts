/**
 * Pruning old installs under `~/.cezar/versions`. Every update leaves the previous version behind
 * for rollback and nothing ever removed one, so a dev machine collected two dozen (~65k files).
 *
 * The policy keeps the RUNNING version plus the `keep - 1` most recently installed others, and
 * never removes:
 *   - the version `current` points at, or the one this process runs;
 *   - a version another live process runs — its lease in `versions/.in-use/` (written by every
 *     cockpit at boot) or a `ps` command line naming `versions/<id>/`;
 *   - a linked checkout (a link costs no disk, and it is the developer's own pick);
 *   - anything while an install is in flight: a `.staging-*` directory whose pid is alive skips
 *     the whole prune, and `versions/.lock` serializes the prune's renames with the installer's
 *     commit (`installer.ts`).
 * A victim is renamed to `.trash-*` under the lock (atomic, and invisible to `listInstalled`),
 * then deleted outside it; a trash dir a killed process left behind is deleted on the next prune.
 * `versions.backup-*` siblings are listed, and removed only on an explicit `--backups`.
 */

import { execFile } from 'node:child_process';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cezarHomeDir } from '../paths.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { activeId, CURRENT_LINK, listInstalled, versionsDir } from './layout.ts';

/** Versions kept by default: the running one plus two previous ones for rollback. */
export const DEFAULT_VERSION_RETENTION = 3;
const LOCK_FILE = '.lock';
const LEASE_DIR = '.in-use';
const STAGING_PREFIX = '.staging-';
const TRASH_PREFIX = '.trash-';
const BACKUP_PREFIX = 'versions.backup-';
/** A lock whose owner cannot be read is stale after this long (a crash mid-write). */
const UNREADABLE_LOCK_STALE_MS = 10 * 60_000;

export type KeepReason = 'running' | 'current' | 'in-use' | 'recent' | 'link';

export interface PruneOptions {
  /** Versions to keep, the running one included. Below 1 nothing is pruned. */
  keep: number;
  dryRun?: boolean;
  /** Also remove `versions.backup-*` directories (explicit CLI only). */
  backups?: boolean;
  env?: NodeJS.ProcessEnv;
  /** The running entry file (`process.argv[1]`); decides which version is "running". */
  entry?: string;
  /** Test seams. `modulePath` stands in for this module's own file (see `runningVersionId`). */
  modulePath?: string;
  isAlive?: (pid: number) => boolean;
  processIds?: (env: NodeJS.ProcessEnv) => Promise<Set<string>>;
}

export interface PruneResult {
  keep: number;
  dryRun: boolean;
  /** Why nothing was pruned (an install in flight, the lock held). */
  skipped?: string;
  kept: Array<{ id: string; reason: KeepReason }>;
  removed: Array<{ id: string; version: string; installedAt: string }>;
  failed: Array<{ id: string; error: string }>;
  backups: Array<{ name: string; path: string; removed: boolean }>;
}

export function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The first path segment of `path` under `root`, or null when it is not under it. */
function segmentUnder(path: string, root: string): string | null {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length).split(sep)[0] || null;
}

/** This module's own file. Node realpaths an ESM module URL, so it names `versions/<id>/` even
 *  when the process was started through `versions/current/…`. */
const MODULE_PATH = fileURLToPath(import.meta.url);

/**
 * The version id this process runs from: this module's own `versions/<id>/` when it lives under
 * one (a `current` flipped by `cezar update` after start must not rename it), else the entry
 * file's `versions/<id>/…`, `current` resolved, else null.
 */
export function runningVersionId(entry: string, env: NodeJS.ProcessEnv = process.env, modulePath: string = MODULE_PATH): string | null {
  const roots = [resolve(versionsDir(env)), realOrSelf(versionsDir(env))];
  for (const root of roots) {
    const id = segmentUnder(realOrSelf(modulePath), root);
    if (id && id !== CURRENT_LINK && !id.startsWith('.')) return id;
  }
  for (const path of [resolve(entry), realOrSelf(entry)]) {
    for (const root of roots) {
      const id = segmentUnder(path, root);
      if (!id) continue;
      return id === CURRENT_LINK ? activeId(env) : id;
    }
  }
  return null;
}

/** The pid a `.staging-<id>-<pid>` / `.staging-shell-<pid>` / `.trash-<id>-<pid>-<n>` name carries. */
function pidOf(name: string, trailing: RegExp): number | null {
  const match = trailing.exec(name);
  return match ? Number(match[1]) : null;
}

// ---- the lock --------------------------------------------------------------------------------

/**
 * Take `versions/.lock` (an `O_EXCL` file holding the owner's pid). A lock whose owner is dead is
 * broken; `waitMs` polls for a live one. Returns the release, or null when it stayed held.
 */
export async function acquireVersionsLock(
  opts: { env?: NodeJS.ProcessEnv; waitMs?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<(() => void) | null> {
  const env = opts.env ?? process.env;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const dir = versionsDir(env);
  const path = join(dir, LOCK_FILE);
  const deadline = Date.now() + (opts.waitMs ?? 0);
  mkdirSync(dir, { recursive: true });
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return () => releaseVersionsLock(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = lockOwner(path);
    if (owner === undefined) continue; // released between the open and the read
    if (isStale(path, owner, isAlive)) {
      breakStaleLock(path, owner, isAlive);
      continue;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

let breakSeq = 0;

/** The pid a lock file holds: NaN when unreadable as one, undefined when the file is gone. */
function lockOwner(path: string): number | undefined {
  try {
    return Number(readFileSync(path, 'utf8').trim());
  } catch {
    return undefined;
  }
}

function isStale(path: string, owner: number, isAlive: (pid: number) => boolean): boolean {
  return Number.isInteger(owner) && owner > 0 ? !isAlive(owner) : Date.now() - safeMtime(path) > UNREADABLE_LOCK_STALE_MS;
}

/**
 * Break a stale lock without deleting a fresh one a concurrent breaker just took: move it aside
 * atomically, then check the moved file is still the dead owner's. If it is not, someone took the
 * lock between our read and the rename — put it back (unless a third party already re-took it).
 */
function breakStaleLock(path: string, owner: number, isAlive: (pid: number) => boolean): void {
  const aside = `${path}.stale-${process.pid}-${breakSeq++}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // another breaker or the owner moved it first
  }
  const moved = lockOwner(aside);
  if (moved !== undefined && Object.is(moved, owner) && isStale(aside, moved, isAlive)) {
    rmSync(aside, { force: true });
    return;
  }
  try {
    // link() refuses an existing path, so a lock re-taken meanwhile is never clobbered.
    linkSync(aside, path);
  } catch {
    // the lock was re-taken: the moved one's owner lost it, as any O_EXCL loser would
  }
  rmSync(aside, { force: true });
}

/** Release only a lock that is still ours: a stale-breaker may have handed it to someone else. */
function releaseVersionsLock(path: string): void {
  if (lockOwner(path) === process.pid) rmSync(path, { force: true });
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

// ---- in-use leases ---------------------------------------------------------------------------

/**
 * Record that this process runs `entry`'s version, so another cezar's prune keeps it after a
 * `use` flips `current` away. Removed on exit; a dead pid's lease is ignored and swept.
 */
export function registerVersionLease(entry: string, env: NodeJS.ProcessEnv = process.env): void {
  const id = runningVersionId(entry, env);
  if (!id) return;
  const dir = join(versionsDir(env), LEASE_DIR);
  const path = join(dir, `${process.pid}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ id, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    process.once('exit', () => {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    });
  } catch {
    // A read-only home only costs this protection; recency and `current` still apply.
  }
}

function leasedIds(env: NodeJS.ProcessEnv, isAlive: (pid: number) => boolean, sweep: boolean): Set<string> {
  const dir = join(versionsDir(env), LEASE_DIR);
  const ids = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return ids;
  }
  for (const name of names) {
    const pid = pidOf(name, /^(\d+)\.json$/);
    if (pid === null) continue;
    const path = join(dir, name);
    if (!isAlive(pid)) {
      if (sweep) rmSync(path, { force: true });
      continue;
    }
    try {
      const lease = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown };
      if (typeof lease.id === 'string') ids.add(lease.id);
    } catch {
      // half-written: its owner is alive, the next prune reads it
    }
  }
  return ids;
}

/** Version ids named by a running process's command line (`…/versions/<id>/…`). POSIX only;
 *  any failure answers an empty set — leases and recency still protect. */
export function processVersionIds(env: NodeJS.ProcessEnv = process.env): Promise<Set<string>> {
  if (process.platform === 'win32') return Promise.resolve(new Set());
  const roots = [...new Set([resolve(versionsDir(env)), realOrSelf(versionsDir(env))])];
  return new Promise((resolvePromise) => {
    execFile('ps', ['-Ao', 'args='], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      const ids = new Set<string>();
      if (!error) {
        for (const root of roots) {
          const prefix = `${root}${sep}`;
          for (let at = stdout.indexOf(prefix); at !== -1; at = stdout.indexOf(prefix, at + 1)) {
            const id = /^[0-9A-Za-z][0-9A-Za-z.+-]*/.exec(stdout.slice(at + prefix.length))?.[0];
            if (id && id !== CURRENT_LINK) ids.add(id);
          }
        }
      }
      resolvePromise(ids);
    });
  });
}

// ---- backups ---------------------------------------------------------------------------------

/** `versions.backup-*` directories beside `versions/` — leftovers of a manual migration. */
export function listVersionBackups(env: NodeJS.ProcessEnv = process.env): Array<{ name: string; path: string }> {
  const home = cezarHomeDir(env);
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(BACKUP_PREFIX))
      .map((entry) => ({ name: entry.name, path: join(home, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// ---- the prune -------------------------------------------------------------------------------

export async function pruneVersions(opts: PruneOptions): Promise<PruneResult> {
  const env = opts.env ?? process.env;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const dryRun = opts.dryRun === true;
  const result: PruneResult = { keep: opts.keep, dryRun, kept: [], removed: [], failed: [], backups: [] };

  const backups = listVersionBackups(env);
  for (const backup of backups) {
    let removed = false;
    if (opts.backups && !dryRun) {
      try {
        rmSync(backup.path, { recursive: true, force: true });
        removed = true;
      } catch (error) {
        result.failed.push({ id: backup.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    result.backups.push({ ...backup, removed: removed || (opts.backups === true && dryRun) });
  }

  const dir = versionsDir(env);
  if (opts.keep < 1 || !existsSync(dir)) return result;

  const busy = liveStaging(dir, isAlive);
  if (busy) return { ...result, skipped: `an install is in progress (${busy})` };

  const release = dryRun ? () => {} : await acquireVersionsLock({ env, isAlive });
  if (!release) return { ...result, skipped: 'another prune or install holds versions/.lock' };
  const trash: string[] = [];
  try {
    // Re-checked under the lock: an install that started meanwhile wins.
    const late = liveStaging(dir, isAlive);
    if (late) return { ...result, skipped: `an install is in progress (${late})` };
    const inUse = new Set([...leasedIds(env, isAlive, !dryRun), ...(await (opts.processIds ?? processVersionIds)(env))]);
    const current = activeId(env);
    const running = opts.entry ? runningVersionId(opts.entry, env, opts.modulePath) : null;
    const installed = listInstalled(env);
    const plan: Array<{ entry: (typeof installed)[number]; reason: KeepReason | null }> = [];
    // The running version is one of the `keep`; the rest go to the most recently installed.
    let budget = opts.keep - (installed.some((entry) => entry.id === running && entry.source !== 'link') ? 1 : 0);
    for (const entry of installed) {
      let reason: KeepReason | null = null;
      if (entry.source === 'link') reason = 'link';
      else if (entry.id === running) reason = 'running';
      else if (budget > 0) {
        budget -= 1;
        reason = entry.id === current ? 'current' : inUse.has(entry.id) ? 'in-use' : 'recent';
      } else if (entry.id === current) reason = 'current';
      else if (inUse.has(entry.id)) reason = 'in-use';
      plan.push({ entry, reason });
    }
    for (const { entry, reason } of plan) {
      if (reason) {
        result.kept.push({ id: entry.id, reason });
        continue;
      }
      if (dryRun) {
        result.removed.push({ id: entry.id, version: entry.version, installedAt: entry.installedAt });
        continue;
      }
      // `cezar use` from a launcher takes no lock: never trash what `current` points at now.
      if (entry.id === activeId(env)) {
        result.kept.push({ id: entry.id, reason: 'current' });
        continue;
      }
      const target = join(dir, `${TRASH_PREFIX}${entry.id}-${process.pid}-${Date.now()}`);
      try {
        renameSync(join(dir, entry.id), target);
        trash.push(target);
        result.removed.push({ id: entry.id, version: entry.version, installedAt: entry.installedAt });
      } catch (error) {
        result.failed.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    release();
  }
  if (!dryRun) {
    trash.push(...leftovers(dir, isAlive));
    await Promise.all(trash.map((path) => rm(path, { recursive: true, force: true }).catch(() => {})));
  }
  return result;
}

/** The name of a `.staging-*` dir whose installer is still alive, or null. */
function liveStaging(dir: string, isAlive: (pid: number) => boolean): string | null {
  for (const name of safeReaddir(dir)) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const pid = pidOf(name, /-(\d+)$/);
    // An unparseable staging name is someone's install we cannot judge: treat it as live.
    if (pid === null || isAlive(pid)) return name;
  }
  return null;
}

/** Trash and staging dirs a dead process left behind. */
function leftovers(dir: string, isAlive: (pid: number) => boolean): string[] {
  const out: string[] = [];
  for (const name of safeReaddir(dir)) {
    const pid = name.startsWith(TRASH_PREFIX)
      ? pidOf(name, /-(\d+)-\d+$/)
      : name.startsWith(STAGING_PREFIX)
        ? pidOf(name, /-(\d+)$/)
        : null;
    if (pid !== null && pid !== process.pid && !isAlive(pid)) out.push(join(dir, name));
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---- automatic runs --------------------------------------------------------------------------

/** The configured retention: `versionRetention` in `~/.cezar/config.json`, default 3, 0 = off. */
export async function configuredVersionRetention(): Promise<number> {
  const config = await loadWorkspaceConfig();
  return config.versionRetention ?? DEFAULT_VERSION_RETENTION;
}

/** One automatic prune (startup, after an update): configured retention, backups never touched,
 *  every failure swallowed — housekeeping must never break the caller. */
export async function autoPruneVersions(opts: { entry: string; env?: NodeJS.ProcessEnv; onLog?: (line: string) => void }): Promise<PruneResult | null> {
  try {
    const keep = await configuredVersionRetention();
    if (keep < 1) return null;
    const result = await pruneVersions({ keep, entry: opts.entry, env: opts.env });
    if (result.removed.length > 0) opts.onLog?.(`pruned ${result.removed.length} old cezar version(s): ${result.removed.map((entry) => entry.id).join(', ')}`);
    return result;
  } catch {
    return null;
  }
}

/** At boot: lease the running version, then prune once after `delayMs` — off the boot path. */
export function startVersionPruning(opts: { entry: string; env?: NodeJS.ProcessEnv; delayMs?: number; onLog?: (line: string) => void }): void {
  registerVersionLease(opts.entry, opts.env);
  const timer = setTimeout(() => void autoPruneVersions(opts), opts.delayMs ?? 30_000);
  timer.unref?.();
}
