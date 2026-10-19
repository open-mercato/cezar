import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(repoRoot, 'scripts', 'release-line.mjs');

// Like release.test.ts, this drives the orchestrator against a miniature workspace and needs
// `npm run build` first (it imports packages/cezar/dist/release/*.js). Only --dry-run paths:
// nothing here reaches GitHub or npm.

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function makeFixture(version: string, tags: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-release-line-'));
  const pkg = async (dir: string, manifest: Record<string, unknown>) => {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'package.json'), json(manifest));
  };
  await pkg('.', { name: 'fake-monorepo', private: true });
  await pkg('packages/contract', { name: '@scope/contract', version, private: true });
  await pkg('packages/api-client', { name: '@scope/client', version, private: true, dependencies: { '@scope/contract': `^${version}` } });
  await pkg('packages/cezar', { name: '@scope/impl', version, devDependencies: { '@scope/client': `^${version}` } });
  await pkg('packages/web', { name: '@scope/web', version, private: true, dependencies: { '@scope/client': `^${version}`, react: '^19.0.0' } });
  await pkg('alias-cezar', { name: 'impl-cli', version, dependencies: { '@scope/impl': `^${version}` } });
  await pkg('alias-cezar-run', { name: 'impl-run', version, dependencies: { '@scope/impl': `^${version}` } });
  await writeFile(
    join(root, 'package-lock.json'),
    json({
      name: 'fake-monorepo',
      lockfileVersion: 3,
      packages: {
        '': { name: 'fake-monorepo' },
        'packages/web': { name: '@scope/web', version, dependencies: { '@scope/client': `^${version}`, react: '^19.0.0' } },
        'packages/cezar': { name: '@scope/impl', version, devDependencies: { '@scope/client': `^${version}` } },
      },
    }),
  );
  await writeFile(join(root, 'CHANGELOG.md'), `# 0.15.2 (2026-10-14)\n\n- older\n`);
  const git = (...args: string[]) => execFile('git', args, { cwd: root });
  await git('init', '-q', '-b', 'main');
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const tag of tags) await git('tag', tag);
  return root;
}

function run(root: string, args: string[], env: Record<string, string> = {}) {
  return execFile(process.execPath, [script, ...args, '--date', '2026-10-20'], {
    env: {
      ...process.env,
      CEZ_RELEASE_ROOT: root,
      GITHUB_OUTPUT: join(root, 'out.txt'),
      GH_TOKEN: '',
      ...env,
    },
  });
}

const read = async (root: string, rel: string) => readFile(join(root, rel), 'utf8');
const version = async (root: string, dir: string) => JSON.parse(await read(root, `${dir}/package.json`)).version as string;

test('prepare bumps a tagged line to its next patch, everywhere, and keeps latest', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.15.2', ['v0.15.1', 'v0.15.2']);
  try {
    await writeFile(join(root, 'notes.md'), "## What's Changed\n* a fix (#1)\n");
    const { stdout } = await run(root, [
      'prepare', '--dry-run', '--branch', 'release/v0.15.x', '--notes-file', join(root, 'notes.md'), '--latest', '0.15.2',
    ]);
    assert.match(stdout, /releasing 0\.15\.3 \(patch bump from 0\.15\.2\) under "latest"/);
    for (const dir of ['packages/contract', 'packages/api-client', 'packages/cezar', 'packages/web', 'alias-cezar', 'alias-cezar-run']) {
      assert.equal(await version(root, dir), '0.15.3', dir);
    }
    const web = JSON.parse(await read(root, 'packages/web/package.json'));
    assert.deepEqual(web.dependencies, { '@scope/client': '^0.15.3', react: '^19.0.0' });
    const lock = JSON.parse(await read(root, 'package-lock.json'));
    assert.equal(lock.packages['packages/web'].version, '0.15.3');
    assert.equal(lock.packages['packages/cezar'].devDependencies['@scope/client'], '^0.15.3');
    assert.match(await read(root, 'CHANGELOG.md'), /^# 0\.15\.3 \(2026-10-20\)\n\n## What's Changed\n\* a fix \(#1\)\n\n# 0\.15\.2/);
    const out = await read(root, 'out.txt');
    assert.match(out, /^version=0\.15\.3$/m);
    assert.match(out, /^bumped=true$/m);
    assert.match(out, /^distTag=latest$/m);
    assert.match(out, /^previousTag=v0\.15\.2$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare publishes a backport to an older line under latest-X.Y', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.15.3', ['v0.15.3', 'v0.16.0']);
  try {
    await run(root, ['prepare', '--dry-run', '--branch', 'release/v0.15.x', '--latest', '0.16.0']);
    const out = await read(root, 'out.txt');
    assert.match(out, /^version=0\.15\.4$/m);
    assert.match(out, /^distTag=latest-0\.15$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare ships a fresh line's x.y.0 without a bump", { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.16.0', ['v0.15.2']);
  try {
    await run(root, ['prepare', '--dry-run', '--branch', 'release/v0.16.x', '--latest', '0.15.2']);
    assert.equal(await version(root, 'packages/cezar'), '0.16.0');
    const out = await read(root, 'out.txt');
    assert.match(out, /^version=0\.16\.0$/m);
    assert.match(out, /^bumped=false$/m);
    assert.match(out, /^distTag=latest$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare refuses a branch that is not a release line, touching nothing', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.15.2', ['v0.15.2']);
  try {
    await assert.rejects(run(root, ['prepare', '--dry-run', '--branch', 'main', '--latest', '0.15.2']));
    await assert.rejects(run(root, ['prepare', '--dry-run', '--branch', 'release/v0.14.x', '--latest', '0.15.2']));
    assert.equal(await version(root, 'packages/cezar'), '0.15.2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cut names the line after main and moves main to the next minor', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.15.2', ['v0.15.2']);
  try {
    await run(root, ['cut', '--dry-run'], { GITHUB_REF_NAME: 'main' });
    const out = await read(root, 'out.txt');
    assert.match(out, /^releaseBranch=release\/v0\.15\.x$/m);
    assert.match(out, /^nextVersion=0\.16\.0$/m);
    for (const dir of ['packages/cezar', 'packages/web', 'alias-cezar-run']) assert.equal(await version(root, dir), '0.16.0', dir);
    assert.equal(JSON.parse(await read(root, 'package-lock.json')).packages['packages/web'].version, '0.16.0');
    // The changelog belongs to the release, not the cut.
    assert.equal(await read(root, 'CHANGELOG.md'), '# 0.15.2 (2026-10-14)\n\n- older\n');

    await assert.rejects(run(root, ['cut', '--dry-run'], { GITHUB_REF_NAME: 'release/v0.15.x' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cut hands main's Unreleased section to the line", { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.15.2', ['v0.15.2']);
  try {
    await writeFile(join(root, 'CHANGELOG.md'), '# Unreleased\n\n- big feature\n\n# 0.15.2 (2026-10-14)\n\n- older\n');
    await run(root, ['cut', '--dry-run'], { GITHUB_REF_NAME: 'main' });
    assert.equal(await read(root, 'CHANGELOG.md'), '# 0.15.2 (2026-10-14)\n\n- older\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('announce builds the release notes from the changelog entry', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.15.2', []);
  try {
    const { stdout } = await run(root, ['announce', '--dry-run', '--version', '0.15.2', '--sha', 'abc123', '--dist-tag', 'latest-0.15']);
    assert.match(stdout, /would release v0\.15\.2 at abc123 \(latest: false\)/);
    assert.match(stdout, /- older/);
    assert.match(stdout, /npx impl-run@0\.15\.2/);
    assert.match(stdout, /npx impl-run@latest-0\.15/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
