import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoFileQuerySchema, repoTreeSchema, type RepoTree } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { listRepoPaths, repoIndexContains } from './git-changes.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * The repository file browser's server half (spec `.ai/specs/2026-10-05-repo-file-browser.md`,
 * #1279): the contract shapes, the `git ls-files` index helper, and the two routes.
 *
 * The load-bearing case is the Q5 membership guard on `GET /repo/files`. These routes read the
 * user's REAL checkout, where `readWorktreePath` alone would happily serve an ignored untracked
 * `.env` — so "an ignored untracked secret is unreadable, a tracked one is served" is the first
 * thing asserted here, not an afterthought.
 */

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function initRepo(dir: string): void {
  g(dir, 'init', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@cezar.local');
  g(dir, 'config', 'user.name', 'cezar-test');
  g(dir, 'config', 'commit.gpgsign', 'false');
}

describe('contract: repoTreeSchema / repoFileQuerySchema', () => {
  it('requires `truncated` — a client must not be able to miss a partial index', () => {
    expect(repoTreeSchema.safeParse({ paths: ['a.ts'], truncated: false }).success).toBe(true);
    // The whole point: an index presented without its truncation flag would read as the whole repo.
    expect(repoTreeSchema.safeParse({ paths: ['a.ts'] }).success).toBe(false);
    expect(repoTreeSchema.safeParse({ paths: 'a.ts', truncated: false }).success).toBe(false);
  });

  it('refuses an empty path and a `raw` that is neither 0 nor 1', () => {
    expect(repoFileQuerySchema.safeParse({ path: 'a.ts' }).success).toBe(true);
    expect(repoFileQuerySchema.safeParse({ path: 'a.ts', raw: '1' }).success).toBe(true);
    expect(repoFileQuerySchema.safeParse({ path: 'a.ts', raw: '0' }).success).toBe(true);
    expect(repoFileQuerySchema.safeParse({ path: '' }).success).toBe(false);
    expect(repoFileQuerySchema.safeParse({}).success).toBe(false);
    expect(repoFileQuerySchema.safeParse({ path: 'a.ts', raw: 'yes' }).success).toBe(false);
  });
});

describe('listRepoPaths — the repository path index', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-repotree-'));
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists tracked and untracked-not-ignored paths, skips ignored ones, sorts stably', async () => {
    writeFileSync(join(dir, '.gitignore'), 'secret.env\nbuild/\n');
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1\n');
    writeFileSync(join(dir, 'a with space.txt'), 'spaced\n');
    writeFileSync(join(dir, 'ünïcode.md'), '# unicode\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/deep.ts'), 'deep\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');

    // Untracked but NOT ignored — in the index set by design (it is the user's own new file).
    writeFileSync(join(dir, 'untracked.ts'), 'new\n');
    // Ignored, untracked — the case the content route's guard exists for.
    writeFileSync(join(dir, 'secret.env'), 'TOKEN=shh\n');
    mkdirSync(join(dir, 'build'));
    writeFileSync(join(dir, 'build/out.js'), 'compiled\n');

    const result = await listRepoPaths(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(false);
    expect(result.paths).toContain('untracked.ts');
    expect(result.paths).toContain('a with space.txt');
    expect(result.paths).toContain('ünïcode.md');
    expect(result.paths).toContain('src/deep.ts');
    expect(result.paths).not.toContain('secret.env');
    expect(result.paths).not.toContain('build/out.js');
    expect([...result.paths]).toEqual([...result.paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('flips `truncated` at the entry cap and keeps the first `cap` paths', async () => {
    for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) writeFileSync(join(dir, name), '1\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'four');

    const capped = await listRepoPaths(dir, 2);
    expect(capped).toMatchObject({ ok: true, paths: ['a.ts', 'b.ts'], truncated: true });

    const whole = await listRepoPaths(dir, 4);
    expect(whole).toMatchObject({ ok: true, truncated: false });
  });

  it('fails rather than returning a partial list when the byte cap is exceeded', async () => {
    const long = 'x'.repeat(180);
    mkdirSync(join(dir, long));
    for (let i = 0; i < 20; i += 1) writeFileSync(join(dir, long, `file-${long}-${i}.txt`), '1\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'long paths');

    const result = await listRepoPaths(dir, 20_000, 256);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('too large to serve');
    // No `paths` key at all — a partial index must not be mistakable for the whole one.
    expect('paths' in result).toBe(false);
  });

  it('answers `{ ok: false }` outside a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-notrepo-'));
    try {
      const result = await listRepoPaths(plain);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('is empty, not an error, for a repository that tracks nothing', async () => {
    expect(await listRepoPaths(dir)).toEqual({ ok: true, paths: [], truncated: false });
  });
});

describe('repoIndexContains — the Q5 membership guard', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-repoidx-'));
    initRepo(dir);
    writeFileSync(join(dir, '.gitignore'), 'ignored.env\n');
    writeFileSync(join(dir, 'tracked.ts'), 'ok\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'base');
    writeFileSync(join(dir, 'ignored.env'), 'TOKEN=shh\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('admits indexed paths and refuses an ignored file that exists on disk', async () => {
    expect(await repoIndexContains(dir, 'tracked.ts')).toEqual({ ok: true, indexed: true });
    expect(await repoIndexContains(dir, 'ignored.env')).toEqual({ ok: true, indexed: false });
    expect(await repoIndexContains(dir, 'nope.ts')).toEqual({ ok: true, indexed: false });
  });

  it('ignores the response entry cap — a tracked file is readable however large the index is', async () => {
    // `listRepoPaths(dir, 1)` would slice `tracked.ts` away; membership must not inherit that cap.
    writeFileSync(join(dir, 'aaa-first.ts'), '1\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', 'second');
    expect((await listRepoPaths(dir, 1)).ok).toBe(true);
    expect(await repoIndexContains(dir, 'tracked.ts')).toEqual({ ok: true, indexed: true });
  });
});

describe('repo file-browser routes', () => {
  let repoRoot: string;
  let app: Hono;
  let store: RunStore;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-repofiles-'));
    initRepo(repoRoot);
    // The RunStore lives inside the repo — ignore it, plus the untracked secret this suite is about.
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\nsecret.env\nnode_modules/\n');
    writeFileSync(join(repoRoot, 'readme.md'), '# Title\n\n- one\n- two\n');
    mkdirSync(join(repoRoot, 'src'));
    writeFileSync(join(repoRoot, 'src/app.ts'), 'export const app = 1\n');
    // A TRACKED `.env` — readable by design: it is already in the index and in the remote.
    writeFileSync(join(repoRoot, '.env'), 'PUBLIC=yes\n');
    // 1×1 transparent PNG.
    writeFileSync(
      join(repoRoot, 'logo.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-m', 'base');

    // Present on disk, ignored, never in the index.
    writeFileSync(join(repoRoot, 'secret.env'), 'TOKEN=shh\n');
    mkdirSync(join(repoRoot, 'node_modules'));
    writeFileSync(join(repoRoot, 'node_modules/evil.js'), 'require("fs")\n');

    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: {} as unknown as RunManager, // these routes never touch it
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const file = (query: string) => apiRequest(app, `/api/v1/repo/files?${query}`);
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  // ---- the security-critical guard -------------------------------------------------------

  it('refuses an ignored untracked file that is sitting on disk', async () => {
    const res = await file('path=secret.env');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('path is not in the repository index: secret.env');
  });

  it('gives an absent path the SAME wording as an ignored one, disclosing nothing', async () => {
    const ignored = await errorOf(await file('path=secret.env'));
    const absent = await errorOf(await file('path=never-existed.env'));
    expect(absent).toBe('path is not in the repository index: never-existed.env');
    // Only the echoed path differs — the sentence is identical, so the answer cannot be read as
    // "this ignored file exists".
    expect(ignored.replace('secret.env', 'X')).toBe(absent.replace('never-existed.env', 'X'));
  });

  it('refuses an ignored directory tree', async () => {
    const res = await file('path=node_modules%2Fevil.js');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('not in the repository index');
  });

  it('serves a TRACKED .env — it is in the index and in the remote already', async () => {
    const res = await file('path=.env');
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ type: 'file', content: 'PUBLIC=yes\n' });
  });

  it('refuses traversal, .git internals and symlinks', async () => {
    for (const path of ['../outside.txt', '.git/config', '/etc/passwd']) {
      const res = await file(`path=${encodeURIComponent(path)}`);
      expect(res.status).toBe(409);
    }

    symlinkSync('/etc/passwd', join(repoRoot, 'link.txt'));
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-m', 'symlink');
    // `git ls-files` DOES list a symlink, so the index guard passes and the resolver's own
    // refusal is what stops it — both guards are independent and both run.
    const linked = await file('path=link.txt');
    expect(linked.status).toBe(409);
    expect(await errorOf(linked)).toContain('symlinks are not served');
  });

  it('rejects a missing or empty path, and a bogus raw value, as a 400 before the handler', async () => {
    expect((await apiRequest(app, '/api/v1/repo/files')).status).toBe(400);
    expect((await file('path=')).status).toBe(400);
    expect((await file('path=src%2Fapp.ts&raw=maybe')).status).toBe(400);
    // A REPEATED key reaches the validator as an array. The older /runs/:id/files had to collapse
    // that to the first value for compatibility; this route is new and says no instead.
    expect((await file('path=src%2Fapp.ts&path=.env')).status).toBe(400);
  });

  // ---- the ordinary answers ----------------------------------------------------------------

  it('serves an indexed text file with its content', async () => {
    const res = await file('path=src%2Fapp.ts');
    expect(res.status).toBe(200);
    expect(res.headers.get('vary')).toBe('Accept');
    expect((await res.json()) as object).toMatchObject({
      type: 'file',
      path: 'src/app.ts',
      binary: false,
      tooLarge: false,
      content: 'export const app = 1\n',
    });
  });

  it('serves an indexed image raw, with nosniff and the sandbox CSP', async () => {
    const res = await file('path=logo.png&raw=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('refuses raw for a non-image, in the wording /runs/:id/files already uses', async () => {
    const res = await file('path=src%2Fapp.ts&raw=1');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('raw serving is limited to images');
  });

  it('reports an over-cap file as tooLarge with no content', async () => {
    writeFileSync(join(repoRoot, 'big.txt'), 'x'.repeat(600_000));
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-m', 'big');
    const res = await file('path=big.txt');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tooLarge: boolean; content?: string };
    expect(body.tooLarge).toBe(true);
    expect(body.content).toBeUndefined();
  });

  it('refuses a submodule entry as a non-file rather than inventing a view', async () => {
    const sub = mkdtempSync(join(tmpdir(), 'cez-submodule-'));
    try {
      initRepo(sub);
      writeFileSync(join(sub, 'inner.txt'), 'inner\n');
      g(sub, 'add', '-A');
      g(sub, 'commit', '-m', 'inner');
      g(repoRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'vendor');
      g(repoRoot, 'commit', '-m', 'add submodule');

      const res = await file('path=vendor');
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('not a regular file');
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  // ---- the tree route ----------------------------------------------------------------------

  it('GET /repo/tree answers the index, ignored paths absent', async () => {
    const res = await apiRequest(app, '/api/v1/repo/tree');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RepoTree;
    expect(repoTreeSchema.safeParse(body).success).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.paths).toEqual(['.env', '.gitignore', 'logo.png', 'readme.md', 'src/app.ts']);
  });

  it('GET /repo/tree outside a repository is the same 409 wording as /repo/changes', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-plain-'));
    try {
      const plainStore = RunStore.open(join(plain, '.ai/cezar'));
      const plainApp = createApp({
        repoRoot: plain,
        store: plainStore,
        manager: {} as unknown as RunManager,
        version: '0.0.0-test',
      });
      const tree = await apiRequest(plainApp, '/api/v1/repo/tree');
      const changes = await apiRequest(plainApp, '/api/v1/repo/changes');
      expect(tree.status).toBe(409);
      expect(await errorOf(tree)).toBe('not a git repository');
      expect(await errorOf(changes)).toBe('not a git repository');
      plainStore.flush();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('GET /repo/files outside a repository is a 409, not a 500', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-plain2-'));
    try {
      const plainStore = RunStore.open(join(plain, '.ai/cezar'));
      const plainApp = createApp({
        repoRoot: plain,
        store: plainStore,
        manager: {} as unknown as RunManager,
        version: '0.0.0-test',
      });
      const res = await apiRequest(plainApp, '/api/v1/repo/files?path=a.ts');
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe('not a git repository');
      plainStore.flush();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('is a pure read — neither route touches the user’s index or working tree', async () => {
    const before = g(repoRoot, 'status', '--porcelain');
    await apiRequest(app, '/api/v1/repo/tree');
    await file('path=src%2Fapp.ts');
    await file('path=secret.env');
    expect(g(repoRoot, 'status', '--porcelain')).toBe(before);
  });
});
