import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireOwnership, OwnershipCleanupError } from './ownership.ts';
import { WebhookService } from './service.ts';
import { WebhookScheduler } from './scheduler.ts';
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
function fixture() {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'webhook-candidate-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const directory = join(root, '.ai/cezar/webhooks');
  const options = { root, dataDir: join(root, '.ai/cezar'), projectId: 'fixture', mode: 'local' as const, serverPorts: () => [], scheduler: new WebhookScheduler() };
  const open = async () => { const service = (await WebhookService.open(options))!; cleanups.push(() => service.dispose()); return service; };
  return { directory, open };
}
/** Open-descriptor count where the OS exposes it: Linux `/proc/self/fd`, macOS `/dev/fd`. */
function descriptorCount(): number | undefined {
  for (const dir of ['/proc/self/fd', '/dev/fd']) { try { return fs.readdirSync(dir).length; } catch { /* not available */ } }
  return undefined;
}
function candidateFault(phase: 'write' | 'sync') {
  const open = fsp.open;
  vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]).includes('owner-record-')) {
      if (phase === 'write') {
        const write = file.writeFile.bind(file);
        file.writeFile = async () => { await write('{'); throw new Error('partial ENOSPC'); };
      } else file.sync = async () => { throw new Error('sync EIO'); };
    }
    return file;
  });
  syncBuiltinESMExports();
}
it.each(['write', 'sync'] as const)('service reopens after repeated initial candidate %s failures without accumulating files or descriptors', async phase => {
  const x = fixture();
  await (await x.open()).dispose();
  const descriptors = descriptorCount();
  candidateFault(phase);
  for (let i = 0; i < 12; i++) await expect(x.open()).rejects.toThrow(phase === 'write' ? 'ENOSPC' : 'EIO');
  expect(fs.readdirSync(x.directory).filter(n => n.startsWith('owner-'))).toEqual([]);
  const after = descriptorCount();
  // Linux exposes /proc/self/fd, macOS /dev/fd; elsewhere the leak check is skipped.
  if (descriptors !== undefined && after !== undefined) expect(after).toBeLessThanOrEqual(descriptors);
  vi.restoreAllMocks(); syncBuiltinESMExports();
  for (let i = 0; i < 3; i++) await (await x.open()).dispose();
});
it('service restarts despite a crash-left malformed unpublished candidate, but refuses malformed published metadata', async () => {
  const x = fixture(); await (await x.open()).dispose();
  const path = join(x.directory, 'owner-record-00000000-0000-4000-8000-000000000001.json');
  fs.writeFileSync(path, '{');
  for (let i = 0; i < 3; i++) await (await x.open()).dispose();
  // Without a readable identity there is no proof its writer died: preserve the file.
  expect(fs.readFileSync(path, 'utf8')).toBe('{');
  fs.linkSync(path, join(x.directory, 'owner.lock'));
  await expect(x.open()).rejects.toThrow('Invalid webhook owner metadata');
  fs.unlinkSync(join(x.directory, 'owner.lock'));
});
it('does not delete a concurrent live writer while its candidate is partial', async () => {
  const x = fixture(); await (await x.open()).dispose();
  const open = fsp.open;
  let resume!: () => void, started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  let first = true, candidate = '';
  vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
    const file = await open(...args);
    if (first && String(args[0]).includes('owner-record-')) {
      first = false; candidate = String(args[0]);
      const write = file.writeFile.bind(file);
      file.writeFile = async data => { await write('{'); started(); await paused; await file.truncate(0); await file.write(String(data), 0, 'utf8'); };
    }
    return file;
  }); syncBuiltinESMExports();
  const contender = acquireOwnership(x.directory);
  await writing;
  try {
    const winner = await acquireOwnership(x.directory);
    expect(winner?.valid()).toBe(true);
    expect(fs.readFileSync(candidate, 'utf8')).toBe('{');
    await winner!.release();
  } finally {
    resume();
    const owner = await contender;
    try { expect(owner?.valid()).toBe(true); } finally { await owner?.release(); }
  }
});
it('retains unpublished candidate cleanup ownership when removal fails', async () => {
  const x = fixture(); await (await x.open()).dispose();
  candidateFault('write');
  const rm = fsp.rm;
  vi.spyOn(fsp, 'rm').mockImplementation(async (path, options) => {
    if (String(path).includes('owner-record-')) throw new Error('cleanup EACCES');
    await rm(path, options);
  }); syncBuiltinESMExports();
  let failure: unknown;
  try { await acquireOwnership(x.directory); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(OwnershipCleanupError);
  vi.restoreAllMocks(); syncBuiltinESMExports();
  await (failure as OwnershipCleanupError).ownership.release();
  expect(fs.readdirSync(x.directory).filter(n => n.startsWith('owner-'))).toEqual([]);
  await (await x.open()).dispose();
});

it('service retains initial-write cleanup across retries and repairs without leaking candidates', async () => {
  const x = fixture(); await (await x.open()).dispose();
  candidateFault('write');
  const rm = fsp.rm;
  vi.spyOn(fsp, 'rm').mockImplementation(async (path, options) => {
    if (String(path).includes('owner-record-')) throw new Error('cleanup EACCES');
    await rm(path, options);
  }); syncBuiltinESMExports();
  await expect(x.open()).rejects.toThrow('acquisition cleanup failed');
  const candidates = fs.readdirSync(x.directory).filter(n => n.startsWith('owner-record-'));
  expect(candidates).toHaveLength(1);
  for (let i = 0; i < 3; i++) await expect(x.open()).rejects.toThrow('cleanup EACCES');
  expect(fs.readdirSync(x.directory).filter(n => n.startsWith('owner-record-'))).toEqual(candidates);
  vi.restoreAllMocks(); syncBuiltinESMExports();
  await (await x.open()).dispose();
  expect(fs.readdirSync(x.directory).filter(n => n.startsWith('owner-'))).toEqual([]);
});
it.each(['live', 'malformed'] as const)('preserves the %s successor slot of a dead published owner', async state => {
  const x = fixture(); await (await x.open()).dispose();
  const owner = await acquireOwnership(x.directory);
  const record = JSON.parse(fs.readFileSync(join(x.directory, 'owner.lock'), 'utf8'));
  await owner!.release();
  const dead = { ...record, token: '00000000-0000-4000-8000-000000000002', pid: 2147483647 };
  fs.writeFileSync(join(x.directory, 'owner.lock'), JSON.stringify(dead));
  const next = join(x.directory, `owner-next-${dead.token}.json`);
  const content = state === 'live' ? JSON.stringify(record) : '{';
  fs.writeFileSync(next, content);
  if (state === 'live') expect(await acquireOwnership(x.directory)).toBeUndefined();
  else await expect(acquireOwnership(x.directory)).rejects.toThrow('Invalid webhook owner metadata');
  expect(fs.readFileSync(next, 'utf8')).toBe(content);
  expect(JSON.parse(fs.readFileSync(join(x.directory, 'owner.lock'), 'utf8'))).toEqual(dead);
  fs.unlinkSync(join(x.directory, 'owner.lock'));
});
