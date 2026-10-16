import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as remote from './skills-remote.ts';
import { bareDirFor, isPinnedSha, shouldPassiveFetch } from './skills-remote.ts';

/** Namespace-resolved so these tests load against a build that predates the
 *  export and fail on behavior, not on an import error. */
const abortBackground = (remote as { abortTeamSkillsBackgroundWork?: () => void }).abortTeamSkillsBackgroundWork;
const settleBackground = (remote as { settleTeamSkillsBackgroundWork?: () => Promise<void> })
  .settleTeamSkillsBackgroundWork;
const resetAbort = (remote as { resetTeamSkillsBackgroundWorkAbort?: () => void })
  .resetTeamSkillsBackgroundWorkAbort;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

describe('background team-skills work can be stopped', () => {
  it('kills a pending clone so nothing touches the cache after teardown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-bg-home-'));
    const srcDir = mkdtempSync(join(tmpdir(), 'cez-bg-src-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'cez-bg-root-'));
    const shimDir = mkdtempSync(join(tmpdir(), 'cez-bg-shim-'));
    const prevHome = process.env.HOME;
    const prevCezHome = process.env.CEZ_HOME;
    const prevPath = process.env.PATH;
    process.env.HOME = home;
    process.env.CEZ_HOME = home;

    const git = (args: string[]) => execFileSync('git', args, { cwd: srcDir, encoding: 'utf8' });
    git(['-c', 'init.defaultBranch=main', 'init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    mkdirSync(join(srcDir, 'demo'));
    writeFileSync(join(srcDir, 'demo', 'SKILL.md'), '---\ndescription: demo\n---\nbody\n');
    git(['add', '-A']);
    git(['commit', '-m', 'init']);

    mkdirSync(join(projectRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.ai/cezar', 'config.json'),
      JSON.stringify({ skillsRepos: [{ repo: srcDir, ref: 'main' }] }),
    );

    // A clone that stalls keeps the child writing under the cache dir, exactly
    // the window a teardown removal can land in.
    const log = join(shimDir, 'calls.log');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$*" in *clone*) sleep 3;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);
    process.env.PATH = `${shimDir}:${prevPath ?? ''}`;

    try {
      remote.getTeamSkillsCached(projectRoot);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        let calls = '';
        try { calls = readFileSync(log, 'utf8'); } catch { /* not started yet */ }
        if (calls.includes('clone')) break;
        await delay(20);
      }

      abortBackground?.();
      await settleBackground?.();
      // Long enough for the stalled clone to have completed if it was not killed.
      await delay(3_500);

      expect(existsSync(join(bareDirFor(srcDir), 'HEAD'))).toBe(false);
    } finally {
      resetAbort?.();
      process.env.PATH = prevPath;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevCezHome === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = prevCezHome;
      for (const dir of [home, srcDir, projectRoot, shimDir]) rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
