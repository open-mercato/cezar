import { constants, lstatSync, realpathSync, renameSync } from 'node:fs';
import { chmod, mkdir, open, rm, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { ensureDataGitignore } from '../data-gitignore.ts';

export function assertNoSymlink(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Webhook storage symlink is not allowed'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
export function statePath(directory: string, name: string): string {
  if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(name)) throw new Error('Invalid webhook state path');
  const path = join(directory, name); assertNoSymlink(path); return path;
}
function git(root: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise(resolveResult => execFile('git', args, { cwd: root, timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => resolveResult({ ok: !error, stdout })));
}
export async function prepareStorage(root: string, dataDir: string, dryRun: boolean): Promise<string> {
  assertNoSymlink(dataDir);
  const canonicalRoot = realpathSync(root);
  const rel = relative(canonicalRoot, resolve(dataDir));
  if (rel.startsWith('..') || !rel || rel.startsWith('/') || isAbsolute(rel)) throw new Error('Webhook data directory is outside its project');
  ensureDataGitignore(canonicalRoot);
  const base = join(dataDir, 'webhooks'); assertNoSymlink(base);
  const ignored = await git(canonicalRoot, ['check-ignore', '--quiet', '--', join(base, 'endpoints.json')]);
  const tracked = await git(canonicalRoot, ['ls-files', '-z', '--', base]);
  if (!tracked.ok || tracked.stdout) throw new Error('Webhook private state is tracked or cannot be checked');
  if (!ignored.ok) throw new Error('Webhook private state is not ignored');
  await mkdir(base, { recursive: true, mode: 0o700 }); await chmod(base, 0o700);
  const directory = dryRun ? join(base, 'dry-run') : base; assertNoSymlink(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  return directory;
}
export async function syncDirectory(directory: string): Promise<void> {
  // Windows cannot open a directory as a file descriptor (EPERM/EACCES/EISDIR) and some
  // filesystems refuse a directory fsync; the durability barrier degrades there. On POSIX those
  // codes are real failures, so only the codes a POSIX fsync is known to reject are tolerated.
  const tolerated = process.platform === 'win32'
    ? ['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EPERM', 'EACCES']
    : ['EINVAL', 'ENOTSUP', 'EBADF'];
  let handle;
  try { handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (tolerated.includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
  try { await handle.sync(); } catch (error) {
    if (!tolerated.includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { await handle.close(); }
}
export interface PreparedWrite { publish(): void; finish(): Promise<void>; discard(): Promise<void> }
/** Async preparation, synchronous publication: callers can check capture sequence without yielding. */
export async function prepareWrite(directory: string, name: string, value: unknown): Promise<PreparedWrite> {
  return prepareText(directory, name, JSON.stringify(value) + '\n');
}
export async function prepareText(directory: string, name: string, content: string | Uint8Array): Promise<PreparedWrite> {
  const target = statePath(directory, name);
  const temporary = statePath(directory, `${name}.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content, 'utf8'); await file.sync(); }
  catch (error) { await file.close(); await rm(temporary, { force: true }); throw error; }
  await file.close();
  let published = false;
  return {
    publish() { assertNoSymlink(target); renameSync(temporary, target); published = true; },
    async finish() { if (!published) throw new Error('Webhook state has not been published'); await syncDirectory(directory); },
    async discard() { if (!published) await rm(temporary, { force: true }); },
  };
}
export async function atomicWrite(directory: string, name: string, value: unknown): Promise<void> {
  const prepared = await prepareWrite(directory, name, value);
  try { prepared.publish(); await prepared.finish(); } finally { await prepared.discard(); }
}
export class StateIntegrityError extends Error {}
export async function readState<T>(directory: string, name: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const file = await open(statePath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).size > 256 * 1024 * 1024) throw new Error('State too large');
      const raw = await file.readFile('utf8');
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new StateIntegrityError(`Invalid webhook state: ${name}`); }
      const result = schema.safeParse(parsed);
      if (!result.success) throw new StateIntegrityError(`Invalid webhook state: ${name}`);
      return result.data;
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Only after exclusive ownership proves this is copied state bound to a different root. */
export async function discardCopiedState(directory: string): Promise<void> {
  const known = new Set(['endpoints.json', 'identity.json', 'outbox.ndjson', 'cursor.json', 'failure-episodes.json', 'deliveries.ndjson', 'activity.ndjson', 'limits.json', 'outbox-tail-latest.quarantine']);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = statePath(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Copied webhook storage contains a symlink');
    if (entry.name === 'events') {
      for (const child of await readdir(path, { withFileTypes: true })) {
        statePath(path, child.name);
        if (!child.isFile()) throw new Error('Invalid copied webhook admission');
      }
      await rm(path, { recursive: true });
    } else if (known.has(entry.name) || /^outbox-tail-[0-9a-f-]+\.quarantine$/.test(entry.name) || /^(deliveries\.ndjson|activity\.ndjson|limits\.json)\.corrupt-[0-9a-f-]{36}$/.test(entry.name) || entry.name.endsWith('.tmp')) {
      if (!entry.isFile()) throw new Error('Invalid copied webhook file');
      await rm(path);
    }
  }
  await syncDirectory(directory);
}

/** Caller must hold exclusive ownership; no live writer may have a prepared publication. */
export async function cleanupInterruptedWrites(directory: string): Promise<void> {
  for (const child of ['', 'events']) {
    const base = child ? statePath(directory, child) : directory;
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let changed = false;
    for (const entry of entries) {
      const atomicTemporary = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.[0-9a-f]{8}-[0-9a-f-]{27}\.tmp$/.test(entry.name);
      const oldDiagnostic = !child && /^outbox-tail-[0-9a-f]{8}-[0-9a-f-]{27}\.quarantine$/.test(entry.name);
      const compaction = !child && /^outbox-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(entry.name);
      if (!atomicTemporary && !oldDiagnostic && !compaction) continue;
      const path = statePath(base, entry.name);
      if (!entry.isFile()) throw new Error('Invalid interrupted webhook write');
      await rm(path); changed = true;
    }
    if (changed) await syncDirectory(base);
  }
}
