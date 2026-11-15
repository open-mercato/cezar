import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cachedDirSize,
  DISK_SOFT_BYTES,
  diskFloorBytes,
  diskFloorRefusal,
  diskFullAgentErrorText,
  diskLevel,
  isDiskFullError,
  lowDiskSpaceMessage,
  probeDiskSpace,
  resetDirSizeCacheForTests,
} from './disk-space.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

describe('probeDiskSpace (9cdcedc3)', () => {
  it('answers for a path that does not exist yet, from its nearest existing ancestor', () => {
    const space = probeDiskSpace(join(tmpdir(), 'cez-disk-probe-never-created', 'worktrees'));
    expect(space).toBeDefined();
    expect(space!.totalBytes).toBeGreaterThan(0);
    expect(space!.freeBytes).toBeGreaterThanOrEqual(0);
  });
});

describe('diskFloorBytes / diskLevel', () => {
  it('is 1 GiB on a large volume and 2% on a small one', () => {
    expect(diskFloorBytes(1000 * GIB)).toBe(GIB);
    expect(diskFloorBytes(10 * GIB)).toBe(Math.floor(10 * GIB * 0.02));
  });

  it('is critical under the floor, low under the soft threshold, ok above it', () => {
    expect(diskLevel({ freeBytes: 500 * MIB, totalBytes: 500 * GIB })).toBe('critical');
    expect(diskLevel({ freeBytes: 2 * GIB, totalBytes: 500 * GIB })).toBe('low');
    expect(diskLevel({ freeBytes: DISK_SOFT_BYTES, totalBytes: 500 * GIB })).toBe('ok');
  });
});

describe('diskFloorRefusal', () => {
  it('refuses below the floor with the actionable message', () => {
    const probe = () => ({ freeBytes: 300 * MIB, totalBytes: 500 * GIB });
    expect(diskFloorRefusal('codex', '/w/t', probe)).toBe(lowDiskSpaceMessage('codex', '/w/t', 300 * MIB));
    expect(lowDiskSpaceMessage('codex', '/w/t', 300 * MIB)).toMatch(
      /^codex: cannot start — only 300 MB free on the disk holding \/w\/t\. .*Settings → Worktrees → Reclaim now.*then Continue\.$/,
    );
  });

  it('never blocks above the floor, nor when the probe cannot answer', () => {
    expect(diskFloorRefusal('codex', '/w', () => ({ freeBytes: 2 * GIB, totalBytes: 500 * GIB }))).toBeNull();
    expect(diskFloorRefusal('codex', '/w', () => undefined)).toBeNull();
  });
});

describe('ENOSPC agent error helper', () => {
  it('recognizes Node’s wording and the bare code', () => {
    expect(isDiskFullError('ENOSPC: no space left on device, write')).toBe(true);
    expect(isDiskFullError('write failed: No space left on device')).toBe(true);
    expect(isDiskFullError('rate limited')).toBe(false);
  });

  it('keeps the original text and adds free space plus the existing cleanup', () => {
    const text = diskFullAgentErrorText('ENOSPC: no space left on device, write', '/w', () => ({ freeBytes: 12 * MIB, totalBytes: GIB }));
    expect(text).toMatch(/^ENOSPC: no space left on device, write — the disk is full \(12 MB free now on the disk holding \/w\)\. Please free space — Settings → Worktrees/);
    expect(diskFullAgentErrorText('ENOSPC', undefined)).toMatch(/^ENOSPC — the disk is full\. Please/);
    expect(diskFullAgentErrorText('timeout', '/w')).toBeNull();
  });
});

describe('cachedDirSize', () => {
  afterEach(() => resetDirSizeCacheForTests());

  it('never awaits the sizer: undefined first, the cached value after, one sizer call per TTL', async () => {
    const sizer = vi.fn(async () => 42);
    expect(cachedDirSize('/w', sizer, 0)).toBeUndefined();
    await vi.waitFor(() => expect(cachedDirSize('/w', sizer)).toBe(42));
    expect(sizer).toHaveBeenCalledTimes(1);
  });

  it('treats an unmeasurable size (null, Windows) as unknown', async () => {
    const sizer = vi.fn(async () => null);
    cachedDirSize('/x', sizer);
    await vi.waitFor(() => expect(sizer).toHaveBeenCalled());
    await Promise.resolve();
    expect(cachedDirSize('/x', sizer)).toBeUndefined();
  });
});
