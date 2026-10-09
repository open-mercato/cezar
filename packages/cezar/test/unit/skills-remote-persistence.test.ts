import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureBareClone, waitForTeamSkills } from '../../src/skills-remote.js';

/**
 * A persisted `lastFetch` inside the six-hour window must stop a fresh process
 * from paying another `git fetch` at boot. The cache file is written under
 * `~/.cache/cez`, and an unwritable/missing one degrades to in-memory state.
 */

function installGitShim(): { calls: () => string[]; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cez-git-shim-'));
  const log = join(dir, 'calls.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(join(dir, 'git'), 0o755);
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

test('a persisted fresh lastFetch skips the boot git fetch', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'cez-src-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'cez-root-'));
  const prevHome = process.env.HOME;
  const prevCezHome = process.env.CEZ_HOME;
  process.env.HOME = home;
  process.env.CEZ_HOME = home; // the cache resolves under CEZ_HOME when pinned
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCezHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = prevCezHome;
    for (const dir of [home, srcDir, projectRoot]) rmSync(dir, { recursive: true, force: true });
  });

  const g = (args: string[]) => execFileSync('git', args, { cwd: srcDir, encoding: 'utf8' });
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  mkdirSync(join(srcDir, 'demo'));
  writeFileSync(join(srcDir, 'demo', 'SKILL.md'), '---\ndescription: demo\n---\nbody\n');
  g(['add', '-A']);
  g(['commit', '-m', 'init']);
  await ensureBareClone(srcDir);

  mkdirSync(join(projectRoot, '.ai/cezar'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.ai/cezar', 'config.json'),
    JSON.stringify({ skillsRepos: [{ repo: srcDir, ref: 'main' }] }),
  );
  // The bookkeeping a previous process would have persisted within the window.
  mkdirSync(join(home, '.cache', 'cez'), { recursive: true });
  writeFileSync(
    join(home, '.cache', 'cez', 'team-skills-state.json'),
    JSON.stringify({ lastFetch: { [srcDir]: Date.now() } }),
  );

  const shim = installGitShim();
  try {
    const skills = await waitForTeamSkills(projectRoot);
    assert.deepEqual(skills.map((s) => s.name), ['demo']);
    assert.equal(
      shim.calls().some((line) => line.includes('fetch')),
      false,
      `expected no git fetch, saw: ${JSON.stringify(shim.calls())}`,
    );
  } finally {
    shim.restore();
  }
});

test('an unwritable cache dir degrades to in-memory state without failing', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'cez-src-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'cez-root-'));
  const prevHome = process.env.HOME;
  const prevCezHome = process.env.CEZ_HOME;
  process.env.HOME = home;
  process.env.CEZ_HOME = home; // the cache resolves under CEZ_HOME when pinned
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCezHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = prevCezHome;
    for (const dir of [home, srcDir, projectRoot]) rmSync(dir, { recursive: true, force: true });
  });

  const g = (args: string[]) => execFileSync('git', args, { cwd: srcDir, encoding: 'utf8' });
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  mkdirSync(join(srcDir, 'demo'));
  writeFileSync(join(srcDir, 'demo', 'SKILL.md'), '---\ndescription: demo\n---\nbody\n');
  g(['add', '-A']);
  g(['commit', '-m', 'init']);
  await ensureBareClone(srcDir);

  mkdirSync(join(projectRoot, '.ai/cezar'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.ai/cezar', 'config.json'),
    JSON.stringify({ skillsRepos: [{ repo: srcDir, ref: 'main' }] }),
  );
  // A DIRECTORY where the state file should be: every read and atomic rename
  // fails, so persistence degrades to the in-memory maps without throwing.
  mkdirSync(join(home, '.cache', 'cez', 'team-skills-state.json'), { recursive: true });

  const skills = await waitForTeamSkills(projectRoot);
  assert.deepEqual(skills.map((s) => s.name), ['demo']);
});
