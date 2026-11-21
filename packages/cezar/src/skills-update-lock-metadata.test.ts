import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsUpdateService } from './skills-update.ts';

const boundary = vi.hoisted(() => ({
  path: '',
  afterMetadata: undefined as (() => Promise<void>) | undefined,
  statError: undefined as Error | undefined,
  readError: undefined as Error | undefined,
  handles: [] as Array<{ handle: FileHandle; close: ReturnType<typeof vi.spyOn> }>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const afterMetadata = async () => {
    const hook = boundary.afterMetadata;
    boundary.afterMetadata = undefined;
    await hook?.();
  };
  return {
    ...fs,
    // Apply the same actual pathname replacement at the old stat(path) boundary
    // and the fixed descriptor.stat() boundary, so the regression runs both ways.
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const result = await fs.stat(...args);
      if (String(args[0]) === boundary.path) await afterMetadata();
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === boundary.path && args[1] === 'r') {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, 'stat').mockImplementation((async () => {
          if (boundary.statError) throw boundary.statError;
          const result = await stat();
          await afterMetadata();
          return result;
        }) as typeof handle.stat);
        if (boundary.readError) vi.spyOn(handle, 'readFile').mockRejectedValue(boundary.readError);
        boundary.handles.push({ handle, close: vi.spyOn(handle, 'close') });
      }
      return handle;
    },
  };
});

describe('skills-update lock metadata file identity', () => {
  const dryRun = process.env.CEZ_DRY_RUN;
  let root: string;
  let home: string;
  let repo: string;
  const now = Date.now();

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '0';
    root = await mkdtemp(join(tmpdir(), 'cez-lock-metadata-'));
    home = join(root, 'home'); repo = join(root, 'repo');
    await mkdir(join(home, '.cache', 'cez'), { recursive: true });
    await mkdir(repo);
    await writeFile(join(repo, 'skills-lock.json'), JSON.stringify({ skills: { om: { source: 'open-mercato/skills' } } }));
    boundary.path = join(home, '.cache', 'cez', 'skills-update.lock');
    boundary.afterMetadata = undefined; boundary.statError = undefined; boundary.readError = undefined;
    boundary.handles = [];
  });

  afterEach(async () => {
    for (const { handle } of boundary.handles) await handle.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    if (dryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = dryRun;
  });

  function service(run = vi.fn(async () => ({ stdout: '', stderr: '' }))) {
    return { run, service: new SkillsUpdateService({ homeDir: home, now: () => now, resolveNpx: async () => 'npx', run }) };
  }

  function expectClosed() {
    expect(boundary.handles).toHaveLength(1);
    const tracked = boundary.handles[0];
    if (!tracked) throw new Error('metadata descriptor was not opened');
    expect(tracked.close).toHaveBeenCalledOnce();
    expect(tracked.handle.fd).toBe(-1);
  }

  it('keeps a live owner busy when the pathname becomes malformed after metadata lookup', async () => {
    await writeFile(boundary.path, `${process.pid}\n${now}\n`);
    boundary.afterMetadata = async () => {
      await rename(boundary.path, join(root, 'original-lock'));
      await writeFile(boundary.path, 'malformed replacement');
    };
    const { service: updater, run } = service();
    expect((await updater.check(repo)).status).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(boundary.path, 'utf8')).toBe('malformed replacement');
    expectClosed();
  });

  it('uses the opened malformed file fallback rather than a replacement live PID', async () => {
    await writeFile(boundary.path, 'malformed original');
    const fallback = now - 1000;
    await utimes(boundary.path, new Date(fallback), new Date(fallback));
    boundary.afterMetadata = async () => {
      await rename(boundary.path, join(root, 'original-lock'));
      await writeFile(boundary.path, `${process.pid}\n${now}\n`);
    };
    // Exercise the metadata decision separately: removing a competing replacement
    // during stale recovery belongs to CodeQL30, outside this reader fix.
    const updater = service().service as unknown as { readLockMetadata(path: string): Promise<{ timestamp: number; alive: boolean }> };
    expect(await updater.readLockMetadata(boundary.path)).toEqual({ timestamp: fallback, alive: false });
    expectClosed();
  });

  it('closes a live-owner descriptor on contention', async () => {
    await writeFile(boundary.path, `${process.pid}\n${now}\n`);
    const { service: updater, run } = service();
    expect((await updater.check(repo)).status).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
    expectClosed();
  });

  it('still recovers a malformed lock and releases its own lock', async () => {
    await writeFile(boundary.path, 'malformed');
    const { service: updater, run } = service();
    expect((await updater.check(repo)).status).toBe('current');
    expect(run).toHaveBeenCalledOnce();
    await expect(readFile(boundary.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expectClosed();
  });

  it.each([
    { age: 120_000, status: 'unavailable', calls: 0 },
    { age: 120_001, status: 'current', calls: 1 },
  ])('preserves live-owner stale boundary at $age ms', async ({ age, status, calls }) => {
    await writeFile(boundary.path, `${process.pid}\n${now - age}\n`);
    const { service: updater, run } = service();
    expect((await updater.check(repo)).status).toBe(status);
    expect(run).toHaveBeenCalledTimes(calls);
    expectClosed();
  });

  it('keeps a permission-denied PID probe busy', async () => {
    await writeFile(boundary.path, `${process.pid}\n${now}\n`);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); });
    const { service: updater, run } = service();
    expect((await updater.check(repo)).status).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
    expectClosed();
  });

  it('closes the descriptor and preserves graceful degradation when metadata fails', async () => {
    await writeFile(boundary.path, `${process.pid}\n${now}\n`);
    boundary.statError = Object.assign(new Error('metadata unavailable'), { code: 'EIO' });
    const { service: updater, run } = service();
    expect((await updater.check(repo)).status).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
    expectClosed();
  });

  it('retains the malformed/read-failure fallback and closes the descriptor', async () => {
    await writeFile(boundary.path, 'malformed');
    boundary.readError = Object.assign(new Error('read unavailable'), { code: 'EIO' });
    const { service: updater, run } = service();
    expect((await updater.check(repo)).status).toBe('current');
    expect(run).toHaveBeenCalledOnce();
    expectClosed();
  });
});
