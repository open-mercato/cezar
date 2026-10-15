import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bareDirFor, isPinnedSha, shouldPassiveFetch } from './skills-remote.ts';

const TTL = 6 * 60 * 60 * 1_000;

describe('shouldPassiveFetch', () => {
  it('fetches on the first passive touch this process', () => {
    // A clone left by an earlier run must be refreshed on first read, else a
    // long-running server serves whatever ref that old clone happened to have.
    expect(shouldPassiveFetch({ attempted: false, fetchedAt: 0, now: 1_000, ttlMs: TTL })).toBe(true);
  });

  it('does not re-fetch within the TTL once touched', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - 60_000, now, ttlMs: TTL })).toBe(false);
  });

  it('re-fetches once the last fetch is older than the TTL', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL - 1, now, ttlMs: TTL })).toBe(true);
  });

  it('treats exactly-TTL as still fresh (strictly greater re-fetches)', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL, now, ttlMs: TTL })).toBe(false);
  });
});

describe('bareDirFor', () => {
  it('keys the global cache on owner__name regardless of URL shape', () => {
    const expected = bareDirFor('open-mercato/skills');
    expect(bareDirFor('https://github.com/open-mercato/skills.git')).toBe(expected);
    expect(bareDirFor('git@github.com:open-mercato/skills')).toBe(expected);
    expect(expected.endsWith('open-mercato__skills')).toBe(true);
  });
});

describe('isPinnedSha', () => {
  it('accepts 40- and 64-hex, rejects branch names', () => {
    expect(isPinnedSha('a'.repeat(40))).toBe(true);
    expect(isPinnedSha('b'.repeat(64))).toBe(true);
    expect(isPinnedSha('main')).toBe(false);
  });
});

describe('the passive background skills load', () => {
  it('does not keep a finished process alive while its clone is still running', () => {
    // A headless `cezar run` finished its task in 2s and then sat for 60 more:
    // the background clone of the skills repo held the event loop until its
    // timeout — and on a slow link that clone never completes inside it, so it
    // happened on every run without a warm cache. A fake `git` that hangs
    // stands in for that clone; the process must exit anyway.
    const dir = mkdtempSync(join(tmpdir(), 'cez-bg-clone-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nsleep 20\nexit 1\n', { mode: 0o755 });
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      const script = join(dir, 'probe.mts');
      writeFileSync(script, [
        `import { getTeamSkillsCached } from ${JSON.stringify(fileURLToPath(new URL('./skills-remote.ts', import.meta.url)))};`,
        `getTeamSkillsCached(${JSON.stringify(repo)});`,
      ].join('\n'));
      const started = Date.now();
      execFileSync(process.execPath, ['--import', 'tsx', script], {
        // Run from this package so `--import tsx` resolves its own devDependency.
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        // HOME too: the skills cache lives under the home directory, never the developer's.
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CEZ_HOME: join(dir, 'home'), HOME: join(dir, 'home') },
        stdio: 'ignore',
        timeout: 30_000,
      });
      // Well under the fake clone's 20s: nothing waited on it.
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
