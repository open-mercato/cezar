import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import * as storage from './storage.ts';
import { acquireOwnership } from './ownership.ts';
import { WebhookService } from './service.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookCoordinator } from './coordinator.ts';
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
function fixture() {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'webhook-owner-recovery-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const directory = join(root, '.ai/cezar/webhooks'), lock = join(directory, 'owner.lock');
  const options = { root, dataDir: join(root, '.ai/cezar'), projectId: 'fixture', mode: 'local' as const, serverPorts: () => [], scheduler: new WebhookScheduler(), send: async () => ({ kind: 'http' as const, status: 204 }) };
  const open = async () => { const service = (await WebhookService.open(options))!; cleanups.push(() => service.dispose()); return service; };
  return { root, directory, lock, open };
}
const replacementToken = '00000000-0000-4000-8000-000000000001';
it.each(['sync', 'enumeration', 'orphan'] as const)('retains acquisition cleanup after %s fails and storage is repaired', async phase => {
  const x = fixture();
  if (phase === 'orphan') {
    await (await x.open()).dispose();
    // An actual dead orphan reaches the post-publication rm boundary.
    const owner = await acquireOwnership(x.directory);
    const record = JSON.parse(fs.readFileSync(x.lock, 'utf8')); await owner!.release();
    fs.writeFileSync(join(x.directory, `owner-record-${replacementToken}.json`), JSON.stringify({ ...record, token: replacementToken, pid: 2147483647 }));
  }
  const unlink = fs.unlinkSync;
  vi.spyOn(fs, 'unlinkSync').mockImplementation(path => { if (String(path) === x.lock) throw new Error('unlink EACCES'); unlink(path); });
  if (phase === 'sync') vi.spyOn(storage, 'syncDirectory').mockRejectedValueOnce(new Error('sync EIO'));
  if (phase === 'enumeration') {
    const readdir = fsp.readdir;
    vi.spyOn(fsp, 'readdir').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => { if (String(path) === x.directory) throw new Error('enumeration EIO'); return Reflect.apply(readdir, fsp, [path, ...args]); }) as typeof fsp.readdir);
  }
  if (phase === 'orphan') {
    const rm = fsp.rm;
    vi.spyOn(fsp, 'rm').mockImplementation(async (path, options) => { if (String(path).endsWith(`owner-record-${replacementToken}.json`)) throw new Error('orphan EIO'); await rm(path, options); });
  }
  syncBuiltinESMExports();
  await expect(x.open()).rejects.toThrow();
  const original = fs.readFileSync(x.lock, 'utf8');
  for (let n = 0; n < 2; n++) await expect(x.open()).rejects.toThrow();
  expect(fs.readFileSync(x.lock, 'utf8')).toBe(original);
  vi.restoreAllMocks(); syncBuiltinESMExports();
  const contenders = await Promise.allSettled([x.open(), x.open(), x.open()]);
  const winners = contenders.filter(result => result.status === 'fulfilled');
  expect(winners).toHaveLength(1);
  const repaired = winners[0]!.value;
  expect(fs.readFileSync(x.lock, 'utf8')).not.toBe(original);
  await expect(x.open()).rejects.toThrow('Another process owns');
  await repaired.dispose(); expect(fs.existsSync(x.lock)).toBe(false);
});
it('retained acquisition cleanup preserves a live replacement token', async () => {
  const x = fixture(); const unlink = fs.unlinkSync;
  vi.spyOn(storage, 'syncDirectory').mockRejectedValueOnce(new Error('sync EIO'));
  vi.spyOn(fs, 'unlinkSync').mockImplementation(path => { if (String(path) === x.lock) throw new Error('unlink EACCES'); unlink(path); }); syncBuiltinESMExports();
  await expect(x.open()).rejects.toThrow();
  const original = fs.readFileSync(x.lock, 'utf8');
  const replacement = JSON.stringify({ ...JSON.parse(original), token: replacementToken });
  fs.writeFileSync(x.lock, replacement);
  vi.restoreAllMocks(); syncBuiltinESMExports();
  await expect(x.open()).rejects.toThrow('Another process owns');
  expect(fs.readFileSync(x.lock, 'utf8')).toBe(replacement);
  // Verified mismatch retires our cleanup handle; it must not later delete the old token.
  fs.writeFileSync(x.lock, original);
  await expect(x.open()).rejects.toThrow('Another process owns');
});
it.each(['unreadable', 'malformed'] as const)('coordinator retains %s release metadata until repair', async fault => {
  const x = fixture();
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], singleProject: true });
  cleanups.push(() => coordinator.dispose());
  await coordinator.get('fixture', x.root);
  const original = fs.readFileSync(x.lock, 'utf8');
  if (fault === 'unreadable') {
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((path, ...args) => { if (String(path) === x.lock) throw Object.assign(new Error('read EACCES'), { code: 'EACCES' }); return open(path, ...args); }); syncBuiltinESMExports();
  } else fs.writeFileSync(x.lock, '{}');
  const warning = await coordinator.remove(x.root);
  expect(coordinator.count()).toBe(0);
  await coordinator.discover(); await coordinator.discover();
  vi.restoreAllMocks(); syncBuiltinESMExports();
  if (fault === 'malformed') fs.writeFileSync(x.lock, original);
  expect(fs.readFileSync(x.lock, 'utf8')).toBe(original);
  await coordinator.discover();
  const repaired = await coordinator.get('fixture', x.root);
  expect(repaired).toBeDefined(); expect(warning).toContain('cleanup');
  expect(fs.readFileSync(x.lock, 'utf8')).not.toBe(original);
});
it.each(['replacement', 'missing'] as const)('retiring cleanup accepts verified %s without deleting another owner', async state => {
  const x = fixture();
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], singleProject: true });
  cleanups.push(() => coordinator.dispose());
  await coordinator.get('fixture', x.root);
  const original = fs.readFileSync(x.lock, 'utf8'), open = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((path, ...args) => { if (String(path) === x.lock) throw new Error('read EACCES'); return open(path, ...args); }); syncBuiltinESMExports();
  await coordinator.remove(x.root);
  vi.restoreAllMocks(); syncBuiltinESMExports();
  if (state === 'replacement') {
    const replacement = JSON.stringify({ ...JSON.parse(original), token: replacementToken });
    fs.writeFileSync(x.lock, replacement); await coordinator.discover();
    expect(fs.readFileSync(x.lock, 'utf8')).toBe(replacement);
    await expect(coordinator.get('fixture', x.root)).rejects.toThrow('Another process owns');
  } else { fs.unlinkSync(x.lock); await coordinator.discover(); }
  // Successful release retires the handle even if its original bytes later reappear.
  fs.writeFileSync(x.lock, original); await coordinator.discover();
  expect(fs.readFileSync(x.lock, 'utf8')).toBe(original);
});
