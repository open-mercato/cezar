import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyLifecycleConfigUpdate, lifecycleConfigFromRaw, readLifecycleConfig, writeLifecycleConfig } from './config.ts';
import { worktreeLifecycleConfigSchema } from '@open-mercato/cezar-contract';

let root: string;
let path: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'cez-lifecycle-config-')));
  path = join(root, '.ai', 'cezar', 'config.json');
  await fs.mkdir(join(root, '.ai', 'cezar'), { recursive: true });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const entry = () => ({ id: randomUUID(), command: '  printf hello\n' });

describe('current lifecycle configuration', () => {
  it('distinguishes absent and intentionally empty from malformed/unreadable config', async () => {
    expect(await readLifecycleConfig(root)).toEqual({ config: { afterCreate: [], beforeRemove: [] }, revision: null, configured: false });
    const empty = await writeLifecycleConfig(root, { afterCreate: [], beforeRemove: [] }, null);
    expect(empty.configured).toBe(true);
    expect(empty.revision).not.toBeNull();
    await fs.writeFile(path, '{bad');
    await expect(readLifecycleConfig(root)).rejects.toThrow('malformed');
    await fs.writeFile(path, '{"worktreeLifecycle":null}');
    await expect(readLifecycleConfig(root)).rejects.toThrow('Invalid');
    await fs.unlink(path);
    await fs.mkdir(path);
    await expect(readLifecycleConfig(root)).rejects.toThrow('cannot be read');
  });
  it('preserves raw unrelated/future config and authored whitespace while replacing both lists', async () => {
    const initial = entry();
    await fs.writeFile(path, JSON.stringify({ arbitraryFuture: { x: true }, defaultRunner: 'codex', worktreeLifecycle: { afterCreate: [initial], beforeRemove: [] } }));
    const current = await readLifecycleConfig(root);
    await writeLifecycleConfig(root, { afterCreate: [{ ...initial, name: 'new name' }], beforeRemove: [entry()] }, current.revision);
    const raw = JSON.parse(await fs.readFile(path, 'utf8'));
    expect(raw.arbitraryFuture).toEqual({ x: true });
    expect(raw.defaultRunner).toBe('codex');
    expect(raw.worktreeLifecycle.afterCreate[0]).toEqual({ ...initial, name: 'new name' });
    expect(raw.worktreeLifecycle.beforeRemove).toHaveLength(1);
  });
  it('preserves unsupported lifecycle keys on disk and refuses to treat them as an empty gate', async () => {
    const text = JSON.stringify({ unrelated: true, worktreeLifecycle: { afterCreate: [], beforeRemove: [], futureHook: ['do cleanup'] } });
    await fs.writeFile(path, text);
    await expect(readLifecycleConfig(root)).rejects.toThrow('Invalid');
    expect(await fs.readFile(path, 'utf8')).toBe(text);
    await expect(writeLifecycleConfig(root, { afterCreate: [], beforeRemove: [] }, null)).rejects.toThrow('Invalid');
    expect(await fs.readFile(path, 'utf8')).toBe(text);
    expect(worktreeLifecycleConfigSchema.safeParse({ afterCreate: [{ ...entry(), future: true }], beforeRemove: [] }).success).toBe(false);
  });
  it('detects stale saves including direct file edits and serializes concurrent writers', async () => {
    const config = { afterCreate: [entry()], beforeRemove: [] };
    const saved = await writeLifecycleConfig(root, config, null);
    const results = await Promise.allSettled([
      writeLifecycleConfig(root, { afterCreate: [entry()], beforeRemove: [] }, saved.revision),
      writeLifecycleConfig(root, { afterCreate: [], beforeRemove: [entry()] }, saved.revision),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await fs.writeFile(path, JSON.stringify({ worktreeLifecycle: config }));
    const beforeEdit = await readLifecycleConfig(root);
    await fs.writeFile(path, JSON.stringify({ worktreeLifecycle: { ...config, afterCreate: [{ ...config.afterCreate[0], command: 'changed' }] } }));
    await expect(writeLifecycleConfig(root, config, beforeEdit.revision)).rejects.toThrow('changed');
  });
  it('allows explicit clear without resetting other config; rejects invalid IDs and limits', async () => {
    const initial = { worktreeLifecycle: { afterCreate: [entry()], beforeRemove: [] }, unrelated: true };
    const cleared = applyLifecycleConfigUpdate(initial, null, lifecycleConfigFromRaw(initial).revision);
    expect(cleared).toEqual({ unrelated: true });
    const duplicate = entry();
    expect(worktreeLifecycleConfigSchema.safeParse({ afterCreate: [duplicate], beforeRemove: [duplicate] }).success).toBe(false);
    expect(worktreeLifecycleConfigSchema.safeParse({ afterCreate: Array.from({ length: 33 }, entry), beforeRemove: [] }).success).toBe(false);
    for (const command of ['', ' \n ', 'x'.repeat(32 * 1024 + 1)]) expect(worktreeLifecycleConfigSchema.safeParse({ afterCreate: [{ ...entry(), command }], beforeRemove: [] }).success).toBe(false);
  });
});
