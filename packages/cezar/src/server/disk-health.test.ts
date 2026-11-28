import { afterEach, describe, expect, it, vi } from 'vitest';
import { healthResponseSchema } from '@open-mercato/cezar-contract';
import { resetDirSizeCacheForTests } from '../disk-space.ts';
import { diskHealth } from './disk-health.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** 9cdcedc3: health warns before the disk fills, without paying for it on the request path. */
describe('diskHealth', () => {
  afterEach(() => resetDirSizeCacheForTests());

  it('omits the key entirely when statfs cannot answer', () => {
    expect(diskHealth('/repo', () => undefined)).toEqual({});
  });

  it('reports ok without ever sizing the worktrees', () => {
    const sizer = vi.fn(async () => 1);
    expect(diskHealth('/repo', () => ({ freeBytes: 50 * GIB, totalBytes: 500 * GIB }), sizer)).toEqual({
      disk: { freeBytes: 50 * GIB, totalBytes: 500 * GIB, level: 'ok' },
    });
    expect(sizer).not.toHaveBeenCalled();
  });

  it('when low, sizes the worktrees in the background and reports the size once known', async () => {
    const probe = () => ({ freeBytes: 3000 * MIB, totalBytes: 500 * GIB });
    const sizer = vi.fn(async () => 7 * GIB);
    expect(diskHealth('/repo', probe, sizer).disk).toEqual({ freeBytes: 3000 * MIB, totalBytes: 500 * GIB, level: 'low' });
    expect(sizer).toHaveBeenCalledWith(expect.stringMatching(/\.ai[\\/]cezar[\\/]worktrees$/));
    await vi.waitFor(() => expect(diskHealth('/repo', probe, sizer).disk?.worktreesBytes).toBe(7 * GIB));
  });

  it('reports free space in steps, so a busy disk does not republish health every tick', () => {
    const at = (freeBytes: number) => diskHealth('/repo', () => ({ freeBytes, totalBytes: 500 * GIB })).disk?.freeBytes;
    expect(at(50 * GIB + 1)).toBe(at(50 * GIB + 300 * MIB));
    expect(at(3000 * MIB + 1)).toBe(at(3000 * MIB + 90 * MIB));
    expect(at(3000 * MIB)).not.toBe(at(3100 * MIB));
  });

  it('rounds the volume size to whole GiB — health is CORS-open, an exact size fingerprints the machine', () => {
    const total = diskHealth('/repo', () => ({ freeBytes: 50 * GIB, totalBytes: 500 * GIB + 123_456_789 })).disk?.totalBytes;
    expect(total).toBe(500 * GIB);
  });

  it('marks the spawn floor as critical, and the payload satisfies the contract', () => {
    const health = diskHealth('/repo', () => ({ freeBytes: 0.5 * GIB, totalBytes: 500 * GIB }), async () => null);
    expect(health.disk?.level).toBe('critical');
    expect(healthResponseSchema.shape.disk.parse(health.disk)).toEqual(health.disk);
  });

  it('carries the disk guard warning and its every-project total, even while the level is ok', () => {
    const sizer = vi.fn(async () => GIB);
    const health = diskHealth('/repo', () => ({ freeBytes: 40 * GIB, totalBytes: 500 * GIB }), sizer, {
      warning: 'Disk almost full — 21.0 GB in task worktrees',
      worktreesBytes: 2100 * 100 * MIB + 1234,
    });
    expect(health.disk).toEqual({
      freeBytes: 40 * GIB,
      totalBytes: 500 * GIB,
      level: 'ok',
      worktreesBytes: 2100 * 100 * MIB,
      guardWarning: 'Disk almost full — 21.0 GB in task worktrees',
    });
    expect(sizer).not.toHaveBeenCalled();
    expect(healthResponseSchema.shape.disk.parse(health.disk)).toEqual(health.disk);
  });
});
