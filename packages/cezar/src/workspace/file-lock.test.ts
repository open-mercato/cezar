import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cezarHomeDir, workspaceConfigPath } from '../paths.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';
import { FileLockTimeoutError, withFileLock } from './file-lock.ts';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

function liveProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
  children.push(child);
  if (!child.pid) throw new Error('no pid');
  return child;
}

describe('workspace file lock', () => {
  it('does not steal a live owner and recovers the lock after that process exits', async () => {
    const lock = `${workspaceConfigPath()}.lock`;
    await rm(lock, { recursive: true, force: true });
    await writeFile(workspaceConfigPath(), JSON.stringify({ branding: { name: 'before' } }));
    const owner = liveProcess();
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, String(owner.pid)), '');
    await expect(mergeWriteWorkspaceConfig((config) => {
      config.branding = { name: 'blocked' };
    }, { lockTimeoutMs: 80 })).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect((await loadWorkspaceConfig()).branding.name).toBe('before');

    owner.kill('SIGKILL');
    await new Promise((done) => owner.once('exit', () => done(undefined)));
    await mergeWriteWorkspaceConfig((config) => {
      config.branding = { name: 'after' };
    });
    expect((await loadWorkspaceConfig()).branding.name).toBe('after');
  });

  it('creates a missing parent directory before taking the lock', async () => {
    const lock = join(cezarHomeDir(), 'fresh-home', 'config.json.lock');
    await rm(dirname(lock), { recursive: true, force: true });
    await expect(withFileLock(lock, async () => 'written', 50)).resolves.toBe('written');
  });

  it('re-enters a lock this call already holds', async () => {
    const lock = join(cezarHomeDir(), 'reenter.lock');
    await rm(lock, { recursive: true, force: true });
    const value = await withFileLock(lock, () => withFileLock(lock, async () => 'inner', 50), 50);
    expect(value).toBe('inner');
  });
});
