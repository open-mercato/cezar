import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  limits: [] as number[],
  dropName: undefined as string | undefined,
  dropPath: undefined as string | undefined,
}));

vi.mock('./concurrency.ts', async () => {
  const actual = await vi.importActual<typeof import('./concurrency.ts')>('./concurrency.ts');
  return {
    ...actual,
    mapWithConcurrency: async <T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>) => {
      probe.limits.push(limit);
      return actual.mapWithConcurrency(items, limit, async (item, index) => {
        probe.active += 1;
        probe.peak = Math.max(probe.peak, probe.active);
        try {
          if (probe.dropName !== undefined && (item as { name?: string }).name === probe.dropName) {
            await rm(probe.dropPath ?? '', { force: true });
          }
          return await fn(item, index);
        } finally {
          probe.active -= 1;
        }
      });
    },
  };
});

const { browseDirectory } = await import('./fs-browse.ts');
const { readWorktreePath } = await import('./git-changes.ts');

const roots: string[] = [];
afterEach(async () => {
  probe.active = 0;
  probe.peak = 0;
  probe.limits = [];
  probe.dropName = undefined;
  probe.dropPath = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('filesystem listing callsites use the bounded worker pool', () => {
  it('browseDirectory overlaps entry work, passes 16, and preserves sorted order', async () => {
    const root = await mkdtemp('cez-listing-browse-');
    roots.push(root);
    await Promise.all(Array.from({ length: 40 }, (_, i) => mkdir(join(root, `dir-${String(i).padStart(2, '0')}`))));

    const result = await browseDirectory({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.dirs.map((entry) => entry.name)).toEqual(Array.from({ length: 40 }, (_, i) => `dir-${String(i).padStart(2, '0')}`));
    expect(probe.limits).toEqual([16]);
    expect(probe.peak).toBe(16);
  });

  it('readWorktreePath overlaps file stats, preserves order, and omits a failed size', async () => {
    const root = await mkdtemp('cez-listing-files-');
    roots.push(root);
    await mkdir(join(root, '.git'));
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(join(root, `file-${String(i).padStart(2, '0')}.txt`), 'x')));
    probe.dropName = 'file-07.txt';
    probe.dropPath = join(root, probe.dropName);

    const result = await readWorktreePath(root, '');
    expect(result.kind).toBe('dir');
    if (result.kind !== 'dir') return;
    expect(result.entries.map((entry) => entry.name)).toEqual(Array.from({ length: 40 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`));
    expect(result.entries.find((entry) => entry.name === 'file-07.txt')).toEqual({ name: 'file-07.txt', type: 'file' });
    expect(probe.limits).toEqual([16]);
    expect(probe.peak).toBe(16);
  });
});
