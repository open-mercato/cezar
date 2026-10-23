import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureBareClone, waitForTeamSkills } from '../../src/skills-remote.js';

/**
 * A persisted `lastFetch` is evidence that the CLONE was fetched, not that it
 * still exists. Deleting the cache dir must rebuild the clone on the next load
 * (Zero config — written, never required), so the persisted timestamp must not
 * suppress `ensureBareClone`.
 */

test('a persisted fresh lastFetch does not suppress rebuilding a deleted clone', async (t) => {
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
  // Inside the window, but the clone it names is gone.
  mkdirSync(join(home, '.cache', 'cez'), { recursive: true });
  writeFileSync(
    join(home, '.cache', 'cez', 'team-skills-state.json'),
    JSON.stringify({ lastFetch: { [srcDir]: Date.now() } }),
  );
  rmSync(join(home, '.cache', 'cez', 'skills'), { recursive: true, force: true });

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
  try {
    const skills = await waitForTeamSkills(projectRoot);
    assert.deepEqual(skills.map((s) => s.name), ['demo']);
    const calls = (() => {
      try {
        return readFileSync(log, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    })();
    assert.ok(calls.some((line) => line.includes('clone')), `expected a clone, saw: ${JSON.stringify(calls)}`);
    assert.ok(existsSync(join(home, '.cache', 'cez', 'skills')));
  } finally {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
