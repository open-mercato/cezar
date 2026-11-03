import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { stateFingerprint } from './recovery.ts';
it('hashes the entire file including bytes past the state size cap and binds missing state to identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-recovery-'));
  const binding = { projectId: 'project', installationId: 'install', root: directory, generation: randomUUID() };
  try {
    const missing = await stateFingerprint(directory, '123', binding);
    expect(await stateFingerprint(directory, '123', { ...binding, generation: randomUUID() })).not.toBe(missing);
    const bytes = Buffer.alloc(3 * 1024 * 1024, 1); await writeFile(join(directory, '123.json'), bytes);
    const first = await stateFingerprint(directory, '123', binding);
    bytes[bytes.length - 1] = 2; await writeFile(join(directory, '123.json'), bytes);
    expect(await stateFingerprint(directory, '123', binding)).not.toBe(first);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('refuses symlinks and nonregular files instead of authorizing reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-recovery-'));
  const binding = { projectId: 'project', installationId: 'install', root: directory, generation: randomUUID() };
  try {
    await writeFile(join(directory, 'target'), '{}'); await symlink(join(directory, 'target'), join(directory, '123.json'));
    await expect(stateFingerprint(directory, '123', binding)).rejects.toThrow('symlink');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
