import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchGithubPrDiff } from './github.ts';

/** A PATH shim that logs every `gh` invocation and answers canned JSON. */
function installGhShim(): { calls: () => string[]; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cez-gh-shim-'));
  const log = join(dir, 'calls.log');
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`
      + `case "$*" in\n`
      + `  *"pr view"*) printf '%s' '{"headRefOid":"0123456789abcdef0123456789abcdef01234567"}' ;;\n`
      + `  *"api"*) printf '%s' '[]' ;;\n`
      + `  *) printf '%s' '{}' ;;\n`
      + `esac\n`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ''}`;
  return {
    calls: () => {
      try {
        return readFileSync(log, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    restore: () => {
      process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('fetchGithubPrDiff head-SHA cache', () => {
  it('a warm PR-diff cache costs no gh spawn at all', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-gh-cwd-'));
    const shim = installGhShim();
    try {
      const first = await fetchGithubPrDiff(cwd, 7);
      expect(first.available).toBe(true);
      const afterFirst = shim.calls();
      expect(afterFirst.some((line) => line.includes('pr view'))).toBe(true);

      const second = await fetchGithubPrDiff(cwd, 7);
      expect(second).toEqual(first);
      // Head is memoized separately from the diff, so the second request does not
      // pay `gh pr view` just to rebuild the cache key.
      expect(shim.calls()).toEqual(afterFirst);
    } finally {
      shim.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
