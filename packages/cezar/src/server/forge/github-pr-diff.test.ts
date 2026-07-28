import { describe, expect, it, vi } from 'vitest';
import { fetchPrFilePages, GH_PR_DIFF_FILE_CAP } from './github.ts';

const row = (n: number) => ({
  filename: `src/file-${n}.ts`,
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch: '@@ -1 +1 @@\n-old\n+new',
});

describe('GitHub PR file pagination', () => {
  it('stops on a short page', async () => {
    const run = vi.fn(async (page: number) => JSON.stringify(page === 1 ? [row(1)] : []));
    expect(await fetchPrFilePages(run)).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never requests beyond the 300-file contract cap', async () => {
    const run = vi.fn(async (page: number) =>
      JSON.stringify(Array.from({ length: 100 }, (_, index) => row((page - 1) * 100 + index))),
    );
    expect(await fetchPrFilePages(run)).toHaveLength(GH_PR_DIFF_FILE_CAP);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith(3);
  });

  it('rejects malformed GitHub page envelopes at the boundary', async () => {
    await expect(fetchPrFilePages(async () => JSON.stringify({ files: [] }))).rejects.toThrow();
  });
});
