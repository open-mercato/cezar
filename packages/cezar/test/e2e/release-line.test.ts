import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Async on purpose: the fake GitHub API below lives in this process, and a synchronous spawn would
// block the event loop it answers on.
const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(repoRoot, 'scripts', 'release-line.mts');

// Drives the orchestrator against a miniature workspace, a real git repo and a fake GitHub API.
// The .mts script runs on Node's type stripping (Node ≥ 22.18), importing the release decisions
// straight from packages/cezar/src — no build. npm is never reached: every run pins `--registry`.

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const LINE_016 = 'release/v0.16.x';

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
  await writeFile(join(root, 'CHANGELOG.md'), `# ${version} (2026-10-14)\n\n- older\n`);
  await writeFile(join(root, 'registry.json'), json({}));
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'add', '-A');
  await git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  // A global `tag.gpgSign=true` turns a lightweight tag into a signed one that needs a message.
  for (const tag of tags) await git(root, '-c', 'tag.gpgSign=false', 'tag', tag);
  return root;
}

const git = async (root: string, ...args: string[]) => (await execFile('git', args, { cwd: root })).stdout.trim();
const read = async (root: string, rel: string) => readFile(join(root, rel), 'utf8');
const version = async (root: string, dir: string) => JSON.parse(await read(root, `${dir}/package.json`)).version as string;
const setRegistry = (root: string, registry: Record<string, { latest?: string; versions?: string[] }>) =>
  writeFile(join(root, 'registry.json'), json(registry));

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** Just enough of the GitHub REST API for scripts/lib/github.mts. */
class FakeGitHub {
  calls: Call[] = [];
  refs = new Map<string, string>(); // 'heads/x' | 'tags/x' → sha
  releases = new Set<string>();
  mainChangelog = '# 0.16.1 (2026-10-20)\n\n- older\n';
  private server: Server | undefined;
  private n = 0;
  url = '';

  async start() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
        const path = (req.url ?? '').replace(/^\/repos\/o\/r/, '');
        this.calls.push({ method: req.method ?? '', path, body });
        const [status, data] = this.answer(req.method ?? '', path, body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      });
    });
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', done));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((done) => this.server!.close(() => done()));
  }

  writes() {
    return this.calls.filter((c) => c.method !== 'GET');
  }

  private answer(method: string, path: string, body: Record<string, unknown> | undefined): [number, unknown] {
    const ref = /^\/git\/ref\/(heads|tags)\/(.+)$/.exec(path);
    if (method === 'GET' && ref) {
      const sha = this.refs.get(`${ref[1]}/${decodeURIComponent(ref[2]!)}`);
      return sha ? [200, { object: { sha, type: 'commit' } }] : [404, { message: 'Not Found' }];
    }
    if (method === 'POST' && path === '/git/refs') {
      const key = String(body!.ref).replace(/^refs\//, '');
      if (this.refs.has(key)) return [422, { message: 'Reference already exists' }];
      this.refs.set(key, String(body!.sha));
      return [201, {}];
    }
    const patch = /^\/git\/refs\/heads\/(.+)$/.exec(path);
    if (method === 'PATCH' && patch) {
      this.refs.set(`heads/${patch[1]}`, String(body!.sha));
      return [200, {}];
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) return [200, { tree: { sha: 'base-tree' } }];
    if (method === 'POST' && path === '/git/trees') return [201, { sha: 'new-tree' }];
    if (method === 'POST' && path === '/git/commits') return [201, { sha: `fake-commit-${++this.n}` }];
    if (method === 'GET' && path.startsWith('/releases?')) return [200, [...this.releases].map((tag_name) => ({ tag_name }))];
    const rel = /^\/releases\/tags\/(.+)$/.exec(path);
    if (method === 'GET' && rel) return this.releases.has(decodeURIComponent(rel[1]!)) ? [200, {}] : [404, { message: 'Not Found' }];
    if (method === 'POST' && path === '/releases') {
      this.releases.add(String(body!.tag_name));
      return [201, {}];
    }
    if (method === 'POST' && path === '/releases/generate-notes') return [200, { body: "## What's Changed\n* a fix (#9)" }];
    if (method === 'GET' && path.startsWith('/contents/CHANGELOG.md')) {
      return [200, { sha: 'blob', content: Buffer.from(this.mainChangelog).toString('base64') }];
    }
    if (method === 'GET' && path.startsWith('/pulls?')) return [200, []];
    if (method === 'POST' && path === '/pulls') return [201, { number: 77, html_url: 'https://example.test/pull/77', node_id: 'PR_77' }];
    if (method === 'POST' && path === '/labels') return [201, {}];
    if (method === 'POST' && /^\/issues\/\d+\/labels$/.test(path)) return [200, []];
    return [404, { message: `fake GitHub has no ${method} ${path}` }];
  }
}

async function withGitHub(fn: (gh: FakeGitHub) => Promise<void>) {
  const gh = new FakeGitHub();
  await gh.start();
  try {
    await fn(gh);
  } finally {
    await gh.stop();
  }
}

function run(root: string, args: string[], env: Record<string, string> = {}) {
  return execFile(process.execPath, [script, ...args, '--date', '2026-10-20', '--registry', join(root, 'registry.json')], {
    env: {
      ...process.env,
      CEZ_RELEASE_ROOT: root,
      GITHUB_OUTPUT: join(root, 'out.txt'),
      GITHUB_REPOSITORY: 'o/r',
      GH_TOKEN: '',
      ...env,
    },
  });
}
const api = (gh: FakeGitHub, env: Record<string, string> = {}) => ({ GH_TOKEN: 't', GITHUB_API_URL: gh.url, ...env });

// ── tokenless dry runs: stamping ─────────────────────────────────────────────

test('prepare bumps a released line to its next patch, everywhere', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.15.2', ['v0.15.1', 'v0.15.2']);
  try {
    await writeFile(join(root, 'notes.md'), "## What's Changed\n* a fix (#1)\n");
    await setRegistry(root, { '@scope/impl': { latest: '0.15.2', versions: ['0.15.2'] } });
    const { stdout } = await run(root, ['prepare', '--dry-run', '--branch', 'release/v0.15.x', '--notes-file', join(root, 'notes.md')]);
    assert.match(stdout, /releasing 0\.15\.3 \(patch bump from 0\.15\.2\) under "latest"/);
    for (const dir of ['packages/contract', 'packages/api-client', 'packages/cezar', 'packages/web', 'alias-cezar', 'alias-cezar-run']) {
      assert.equal(await version(root, dir), '0.15.3', dir);
    }
    assert.deepEqual(JSON.parse(await read(root, 'packages/web/package.json')).dependencies, { '@scope/client': '^0.15.3', react: '^19.0.0' });
    const lock = JSON.parse(await read(root, 'package-lock.json'));
    assert.equal(lock.packages['packages/web'].version, '0.15.3');
    assert.equal(lock.packages['packages/cezar'].devDependencies['@scope/client'], '^0.15.3');
    assert.match(await read(root, 'CHANGELOG.md'), /^# 0\.15\.3 \(2026-10-20\)\n\n## What's Changed\n\* a fix \(#1\)\n\n# 0\.15\.2/);
    const out = await read(root, 'out.txt');
    assert.match(out, /^version=0\.15\.3$/m);
    assert.match(out, /^bumped=true$/m);
    assert.match(out, /^previousTag=v0\.15\.2$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare ships a fresh line's x.y.0 without a bump", { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.16.0', ['v0.15.2']);
  try {
    await run(root, ['prepare', '--dry-run', '--branch', LINE_016]);
    assert.equal(await version(root, 'packages/cezar'), '0.16.0');
    const out = await read(root, 'out.txt');
    assert.match(out, /^version=0\.16\.0$/m);
    assert.match(out, /^bumped=false$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare refuses a branch that is not a release line, touching nothing', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.15.2', ['v0.15.2']);
  try {
    await assert.rejects(run(root, ['prepare', '--dry-run', '--branch', 'main']));
    await assert.rejects(run(root, ['prepare', '--dry-run', '--branch', 'release/v0.14.x']));
    assert.equal(await version(root, 'packages/cezar'), '0.15.2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── prepare against GitHub: bump, resume, refuse ─────────────────────────────

test('prepare commits the bump to the line without forcing, and leaves tagging to `tag`', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.16.1', ['v0.16.0', 'v0.16.1']);
  try {
    await withGitHub(async (gh) => {
      gh.releases = new Set(['v0.16.0', 'v0.16.1']);
      await setRegistry(root, { '@scope/impl': { latest: '0.16.1', versions: ['0.16.0', '0.16.1'] } });
      await run(root, ['prepare', '--branch', LINE_016], api(gh));
      const out = await read(root, 'out.txt');
      assert.match(out, /^version=0\.16\.2$/m);
      assert.match(out, /^sha=fake-commit-1$/m);
      const move = gh.calls.find((c) => c.method === 'PATCH');
      assert.deepEqual(move, { method: 'PATCH', path: `/git/refs/heads/${LINE_016}`, body: { sha: 'fake-commit-1', force: false } });
      assert.ok(!gh.calls.some((c) => c.method === 'POST' && c.path === '/git/refs'), 'prepare must not tag');
      assert.ok(gh.calls.some((c) => c.path === '/releases/generate-notes'), 'notes are generated when no entry was written');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare resumes a tagged-but-unreleased version instead of cutting a newer one', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.16.2', ['v0.16.1', 'v0.16.2']);
  try {
    await withGitHub(async (gh) => {
      gh.releases = new Set(['v0.16.1']);
      await setRegistry(root, { '@scope/impl': { latest: '0.16.2', versions: ['0.16.1', '0.16.2'] } });
      await assert.rejects(run(root, ['prepare', '--branch', LINE_016], api(gh)), /re-run its "Release publish" run/);
      const out = await read(root, 'out.txt');
      assert.match(out, /^version=0\.16\.2$/m);
      assert.match(out, /^resume=true$/m);
      assert.deepEqual(gh.writes(), [], 'a resume writes nothing');
      assert.equal(await version(root, 'packages/cezar'), '0.16.2');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare refuses an untagged version that already has packages on npm', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.16.2', ['v0.16.1']);
  try {
    await withGitHub(async (gh) => {
      gh.releases = new Set(['v0.16.1']);
      // Half-published, then its tag deleted: only cezar-cli made it.
      await setRegistry(root, { 'impl-cli': { latest: '0.16.2', versions: ['0.16.1', '0.16.2'] } });
      await assert.rejects(run(root, ['prepare', '--branch', LINE_016], api(gh)), /restore the tag/);
      assert.deepEqual(gh.writes(), []);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── tag ──────────────────────────────────────────────────────────────────────

test('tag creates the release tag once, and refuses to move it', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.16.2', []);
  try {
    await withGitHub(async (gh) => {
      await run(root, ['tag', '--version', '0.16.2', '--sha', 'abc'], api(gh));
      assert.equal(gh.refs.get('tags/v0.16.2'), 'abc');
      await run(root, ['tag', '--version', '0.16.2', '--sha', 'abc'], api(gh));
      await assert.rejects(run(root, ['tag', '--version', '0.16.2', '--sha', 'def'], api(gh)), /already points at abc/);
      assert.equal(gh.refs.get('tags/v0.16.2'), 'abc');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── verify ───────────────────────────────────────────────────────────────────

async function lineFixture(versionOnTag: string) {
  const root = await makeFixture(versionOnTag, []);
  const head = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'update-ref', `refs/remotes/origin/release/v${versionOnTag.split('.').slice(0, 2).join('.')}.x`, head);
  return { root, head };
}

test('verify judges latest across every published package and passes a tag on its line', { timeout: 120_000 }, async () => {
  const { root, head } = await lineFixture('0.16.2');
  try {
    await withGitHub(async (gh) => {
      // impl-cli already went 0.17.0: a 0.16 patch must not take `latest` back.
      await setRegistry(root, { '@scope/impl': { latest: '0.16.1' }, 'impl-cli': { latest: '0.17.0' } });
      await run(root, ['verify', '--tag', 'v0.16.2'], api(gh));
      const out = await read(root, 'out.txt');
      assert.match(out, /^distTag=latest-0\.16$/m);
      assert.match(out, /^released=false$/m);
      assert.match(out, new RegExp(`^sha=${head}$`, 'm'));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verify skips a version that already has its GitHub Release', { timeout: 120_000 }, async () => {
  const { root } = await lineFixture('0.16.2');
  try {
    await withGitHub(async (gh) => {
      gh.releases = new Set(['v0.16.2']);
      await setRegistry(root, { '@scope/impl': { latest: '0.16.2' } });
      await run(root, ['verify', '--tag', 'v0.16.2'], api(gh));
      assert.match(await read(root, 'out.txt'), /^released=true$/m);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verify refuses a tag off its line, or one that does not name the manifests', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.16.2', []);
  try {
    await withGitHub(async (gh) => {
      // No refs/remotes/origin/release/v0.16.x containing HEAD.
      await assert.rejects(run(root, ['verify', '--tag', 'v0.16.2'], api(gh)), /is not on release\/v0\.16\.x/);
      await assert.rejects(run(root, ['verify', '--tag', 'v0.16.3'], api(gh)), /the tagged manifests say 0\.16\.2/);
      await assert.rejects(run(root, ['verify', '--tag', 'desktop-v0.1.0'], api(gh)), /not a vX\.Y\.Z release tag/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── announce ─────────────────────────────────────────────────────────────────

test('announce opens the changelog PR before creating the GitHub Release', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.16.2', []);
  try {
    await withGitHub(async (gh) => {
      gh.refs.set('heads/main', 'main-sha');
      await run(root, ['announce', '--version', '0.16.2', '--sha', 'abc', '--dist-tag', 'latest'], api(gh));
      const pr = gh.calls.findIndex((c) => c.method === 'POST' && c.path === '/pulls');
      const release = gh.calls.findIndex((c) => c.method === 'POST' && c.path === '/releases');
      assert.ok(pr >= 0 && release > pr, 'the Release (the "done" marker) comes after the changelog PR');
      const labels = gh.calls.find((c) => c.path === '/issues/77/labels')?.body?.labels;
      assert.deepEqual(labels, ['documentation', 'review', 'skip-changelog']);
      assert.equal(gh.calls[release]!.body!.target_commitish, 'abc');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('announce dry run previews the release body', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.15.2', []);
  try {
    const { stdout } = await run(root, ['announce', '--dry-run', '--version', '0.15.2', '--sha', 'abc123', '--dist-tag', 'latest-0.15']);
    assert.match(stdout, /would carry the entry to main, then release v0\.15\.2 at abc123 \(latest: false\)/);
    assert.match(stdout, /- older/);
    assert.match(stdout, /npx impl-run@0\.15\.2/);
    assert.match(stdout, /npx impl-run@latest-0\.15/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── cut ──────────────────────────────────────────────────────────────────────

test('cut names the line after main and moves main to the next minor', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.15.2', ['v0.15.2']);
  try {
    await run(root, ['cut', '--dry-run'], { GITHUB_REF_NAME: 'main' });
    const out = await read(root, 'out.txt');
    assert.match(out, /^releaseBranch=release\/v0\.15\.x$/m);
    assert.match(out, /^nextVersion=0\.16\.0$/m);
    for (const dir of ['packages/cezar', 'packages/web', 'alias-cezar-run']) assert.equal(await version(root, dir), '0.16.0', dir);
    assert.equal(JSON.parse(await read(root, 'package-lock.json')).packages['packages/web'].version, '0.16.0');
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

test('cut finishes a re-run from the same main commit, and refuses once main has moved', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.16.0', ['v0.15.2']);
  try {
    const head = await git(root, 'rev-parse', 'HEAD');
    await withGitHub(async (gh) => {
      gh.refs.set(`heads/${LINE_016}`, head);
      await run(root, ['cut'], api(gh, { GITHUB_REF_NAME: 'main' }));
      assert.ok(!gh.calls.some((c) => c.method === 'POST' && c.path === '/git/refs' && c.body?.ref === `refs/heads/${LINE_016}`));
      assert.deepEqual(gh.calls.find((c) => c.path === '/issues/77/labels')?.body?.labels, ['refactor', 'review', 'skip-changelog']);
    });
    await git(root, 'checkout', '--', '.');
    await withGitHub(async (gh) => {
      gh.refs.set(`heads/${LINE_016}`, 'an-older-main-commit');
      await assert.rejects(run(root, ['cut'], api(gh, { GITHUB_REF_NAME: 'main' })), /main has moved/);
      assert.ok(!gh.calls.some((c) => c.method === 'POST' && c.path === '/pulls'), 'no bump PR rebuilt from a newer main');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
