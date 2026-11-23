import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimDataDirLock, dataDirInUseMessage, dataDirLockDirectory } from './data-dir-lock.ts';
import { ownProcessIdentity, processIdentityPlatformSupported } from './process-identity.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A real path: macOS tmpdir sits under the /var → /private/var symlink, which the fence refuses. */
function dataDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-data-lock-')));
  roots.push(root);
  const dir = join(root, '.ai/cezar');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function writeOwner(dir: string, fields: { pid: number; start: string; directory: string }): Promise<void> {
  const own = await ownProcessIdentity();
  const lockDir = dataDirLockDirectory(dir);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const identity = {
    token: randomUUID(), pid: fields.pid, start: fields.start, boot: own.boot, host: hostname(), directory: fields.directory,
    ...(own.pidNamespace === undefined ? {} : { pidNamespace: own.pidNamespace }),
  };
  writeFileSync(join(lockDir, 'owner.lock'), JSON.stringify(identity), { mode: 0o600 });
}

describe.skipIf(!processIdentityPlatformSupported())('claimDataDirLock', () => {
  it('refuses a second server on the same data dir until the first releases', async () => {
    const dir = dataDir();
    const first = await claimDataDirLock(dir);
    expect(first.kind).toBe('owned');

    const second = await claimDataDirLock(dir);
    expect(second).toEqual({ kind: 'held', pid: process.pid });
    expect(dataDirInUseMessage({ pid: process.pid }, dir)).toBe(`another cezar (pid ${process.pid}) already serves the tasks in ${dir}`);
    expect(dataDirInUseMessage({ pid: process.pid })).toBe(`another cezar (pid ${process.pid}) already serves this project's tasks`);

    if (first.kind === 'owned') await first.release();
    const third = await claimDataDirLock(dir);
    expect(third.kind).toBe('owned');
    if (third.kind === 'owned') await third.release();
  });

  it('reclaims the lock of a server that died without releasing it', async () => {
    const dir = dataDir();
    // A pid that existed and is gone now: the crashed cockpit.
    const exited = spawnSync(process.execPath, ['-e', '']);
    await writeOwner(dir, { pid: exited.pid!, start: '1', directory: dataDirLockDirectory(dir) });

    const claim = await claimDataDirLock(dir);
    expect(claim.kind).toBe('owned');
    if (claim.kind === 'owned') await claim.release();
  });

  it('does not fence a copied repo with the lock its original carried along', async () => {
    const dir = dataDir();
    const own = await ownProcessIdentity();
    // Live owner (this very process), but recorded for another directory: a `cp -r` of the repo.
    await writeOwner(dir, { pid: own.pid, start: own.start, directory: '/somewhere/else/.ai/cezar/server-lock' });

    const claim = await claimDataDirLock(dir);
    expect(claim.kind).toBe('owned');
    if (claim.kind === 'owned') await claim.release();
  });

  it('keeps a live lock recorded under another spelling of the same directory', async () => {
    const dir = dataDir();
    const own = await ownProcessIdentity();
    // Same physical directory reached through a symlink: a case-insensitive spelling or a bind mount
    // has the same shape. The liveness check must decide, not the string compare.
    const alias = join(roots[roots.length - 1]!, 'alias');
    symlinkSync(join(dir, '..', '..'), alias);
    await writeOwner(dir, { pid: own.pid, start: own.start, directory: dataDirLockDirectory(join(alias, '.ai/cezar')) });

    expect(await claimDataDirLock(dir)).toEqual({ kind: 'held', pid: own.pid });
  });

  it('names the lock file when the owner cannot be verified', () => {
    const reason = 'Cannot verify foreign owner identity';
    expect(dataDirInUseMessage({ pid: 7, reason }, '/r/.ai/cezar')).toBe(
      `another cezar (pid 7) already serves the tasks in /r/.ai/cezar (${reason}); if that process is gone, remove ${join('/r/.ai/cezar', 'server-lock', 'owner.lock')}`,
    );
    expect(dataDirInUseMessage({ pid: 7, reason })).toBe(
      `another cezar (pid 7) already serves this project's tasks (${reason}); if that process is gone, remove ${join('.ai/cezar', 'server-lock', 'owner.lock')}`,
    );
  });

  it('degrades instead of throwing when the data dir sits behind a symlink', async () => {
    const real = dataDir();
    const link = join(roots[roots.length - 1]!, 'linked');
    symlinkSync(join(real, '..', '..'), link);

    const claim = await claimDataDirLock(join(link, '.ai/cezar'));
    expect(claim.kind).toBe('degraded');
  });
});

describe('claimDataDirLock on an unsupported platform', () => {
  it.skipIf(processIdentityPlatformSupported())('degrades', async () => {
    expect((await claimDataDirLock(dataDir())).kind).toBe('degraded');
  });
});
