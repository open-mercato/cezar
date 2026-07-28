import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { mergeWriteWorkspaceConfig } from '../workspace/config.js';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.js';
import { checkoutRepo, cleanupCheckout, isValidCheckoutName, parseRepoRef, type CloneRunner } from './checkout.js';
import { apiRequest } from './loopback-request.testkit.js';
import {
  WorkspaceEventBus,
  createApp,
  type ProjectsResponse,
  type RegisterProjectResponse,
  type ServerDeps,
} from './server.js';

/**
 * GUI clone (spec 2026-07-20-multi-project-workspace, step 4.3):
 * `POST /api/projects/checkout`, the `checkout-progress` feed, and — the part
 * that earns most of this file — the partial-clone cleanup guard.
 *
 * Everything runs against real temp directories with an INJECTED clone runner.
 * Nothing here mocks `checkoutRepo`, `cleanupCheckout` or the filesystem: the
 * thing under test is precisely "what ends up on disk", so faking the disk
 * would test nothing at all. The injected runner stands in for `gh` only —
 * it writes real files into the real target the module created.
 */

describe('checkout — repo reference parsing', () => {
  it('accepts every GitHub spelling and normalizes to owner/repo', () => {
    for (const input of [
      'open-mercato/cezar',
      'https://github.com/open-mercato/cezar',
      'https://github.com/open-mercato/cezar.git',
      'http://www.github.com/open-mercato/cezar/',
      'github.com/open-mercato/cezar',
      'git@github.com:open-mercato/cezar.git',
      'ssh://git@github.com/open-mercato/cezar',
      '  open-mercato/cezar  ',
    ]) {
      expect(parseRepoRef(input), input).toEqual({
        owner: 'open-mercato',
        repo: 'cezar',
        slug: 'open-mercato/cezar',
      });
    }
  });

  it('refuses non-GitHub, malformed and argv-smuggling inputs', () => {
    for (const input of [
      '',
      '   ',
      'cezar',
      'open-mercato/cezar/extra',
      'https://gitlab.com/owner/repo',
      'https://evil.example/github.com/owner/repo',
      '--upload-pack=touch /tmp/pwned',
      'owner/--flag',
      '../../etc/passwd',
      'owner/repo; rm -rf /',
      'a'.repeat(600),
    ]) {
      expect(parseRepoRef(input), input).toBeNull();
    }
  });

  it('a folder name is one boring path segment — never a traversal', () => {
    expect(isValidCheckoutName('cezar')).toBe(true);
    expect(isValidCheckoutName('my.repo_2-x')).toBe(true);
    for (const name of ['', '.', '..', '.ssh', 'a/b', 'a\\b', '../escape', '/abs', 'a'.repeat(200)]) {
      expect(isValidCheckoutName(name), name).toBe(false);
    }
  });
});

describe('checkout — the cleanup guard', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-root-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('deletes a direct child of the checkout root, recursively', async () => {
    const target = join(root, 'repo');
    mkdirSync(join(target, '.git', 'objects'), { recursive: true });
    writeFileSync(join(target, 'README.md'), 'x', 'utf8');
    expect(await cleanupCheckout(root, target)).toBe(true);
    expect(existsSync(target)).toBe(false);
    // The root itself survives — it is the operator's checkout root, not ours.
    expect(existsSync(root)).toBe(true);
  });

  it('REFUSES a directory outside the checkout root', async () => {
    const outside = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-outside-'));
    writeFileSync(join(outside, 'precious.txt'), 'keep me', 'utf8');
    try {
      expect(await cleanupCheckout(root, outside)).toBe(false);
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('REFUSES the checkout root itself and anything nested deeper than one level', async () => {
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(await cleanupCheckout(root, root)).toBe(false);
    expect(await cleanupCheckout(root, `${root}/`)).toBe(false);
    expect(await cleanupCheckout(root, nested)).toBe(false);
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it('REFUSES a symlink, even one that spells as a direct child of the root', async () => {
    // The swap attack: the target we created is replaced by a link to somewhere
    // real. `realpath` alone would resolve it and (if the victim happened to sit
    // under the root) delete it — the lstat check is what stops the class.
    const victim = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-victim-'));
    writeFileSync(join(victim, 'precious.txt'), 'keep me', 'utf8');
    const insideVictim = join(root, 'inside-victim');
    mkdirSync(insideVictim);
    writeFileSync(join(insideVictim, 'precious.txt'), 'keep me', 'utf8');
    const linkOut = join(root, 'repo');
    const linkIn = join(root, 'repo2');
    symlinkSync(victim, linkOut);
    symlinkSync(insideVictim, linkIn);
    try {
      expect(await cleanupCheckout(root, linkOut)).toBe(false);
      expect(await cleanupCheckout(root, linkIn)).toBe(false);
      expect(existsSync(join(victim, 'precious.txt'))).toBe(true);
      expect(existsSync(join(insideVictim, 'precious.txt'))).toBe(true);
    } finally {
      rmSync(victim, { recursive: true, force: true });
    }
  });

  it('REFUSES a path that does not exist, and a file', async () => {
    const file = join(root, 'a-file');
    writeFileSync(file, 'x', 'utf8');
    expect(await cleanupCheckout(root, join(root, 'nope'))).toBe(false);
    expect(await cleanupCheckout(root, file)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});

describe('checkoutRepo — clone, failure cleanup, existing target', () => {
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-'));
    // The `run: undefined` tests exercise the CEZ_DRY_RUN fake clone; without
    // this the default runner shells out to a real `gh repo clone`.
    process.env.CEZ_DRY_RUN = '1';
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const events: unknown[] = [];
  const run = (opts: Partial<Parameters<typeof checkoutRepo>[0]> = {}) => {
    events.length = 0;
    return checkoutRepo({
      url: 'open-mercato/cezar',
      projectsDir: root,
      onProgress: (event) => events.push(event),
      ...opts,
    });
  };

  /** A runner that writes a plausible half-clone and then fails — the shape a
   *  killed `git clone` leaves behind. */
  const failingRunner: CloneRunner = async (_ref, dir, onLine) => {
    onLine('Cloning into ...');
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'index.lock'), '', 'utf8');
    return {
      ok: false,
      error: 'fatal: could not read Username: terminal prompts disabled',
    };
  };

  it('the CEZ_DRY_RUN fake clone lands a repo at <projectsDir>/<repo> and reports done', async () => {
    const result = await run({ run: undefined, checkoutId: 'co-1' });
    expect(result).toMatchObject({
      ok: true,
      name: 'cezar',
      target: join(root, 'cezar'),
    });
    expect(existsSync(join(root, 'cezar', '.git'))).toBe(true);
    expect(readFileSync(join(root, 'cezar', 'README.md'), 'utf8')).toContain('cezar');
    // Progress reached the caller BEFORE the terminal event — the whole reason
    // the stream exists (a silent spinner is the failure mode).
    expect(events.at(-1)).toEqual({
      checkoutId: 'co-1',
      name: 'cezar',
      phase: 'done',
    });
    expect(events.filter((e) => (e as { phase: string }).phase === 'cloning').length).toBeGreaterThan(0);
    expect(events.every((e) => (e as { checkoutId: string }).checkoutId === 'co-1')).toBe(true);
  });

  it('honors an explicit name and refuses a traversing one without touching the disk', async () => {
    expect(await run({ name: 'my-checkout' })).toMatchObject({
      ok: true,
      target: join(root, 'my-checkout'),
    });
    for (const name of ['../escape', 'a/b', '..']) {
      const result = await run({ name });
      expect(result, name).toMatchObject({ ok: false, status: 400 });
    }
    // Only the legitimate one exists; nothing was created next to or above the root.
    expect(existsSync(join(root, 'my-checkout'))).toBe(true);
    expect(existsSync(join(root, '..', 'escape'))).toBe(false);
  });

  it('a FAILED clone is cleaned up, surfaces the error verbatim, and leaves the root empty', async () => {
    const result = await run({ run: failingRunner, checkoutId: 'co-2' });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(result).toHaveProperty('error', expect.stringContaining('could not read Username'));
    // THE cleanup assertion: no half-clone survives a failure.
    expect(existsSync(join(root, 'cezar'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ phase: 'error', checkoutId: 'co-2' });
    // …and because it was cleaned up, an immediate retry is a fresh clone
    // rather than the 409 a leftover directory would have produced.
    expect(await run({ checkoutId: 'co-3' })).toMatchObject({ ok: true });
  });

  it('a runner that THROWS is treated as a failed clone — same cleanup', async () => {
    const thrower: CloneRunner = async (_ref, dir) => {
      await mkdir(join(dir, '.git'), { recursive: true });
      throw new Error('socket hang up');
    };
    const result = await run({ run: thrower });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(existsSync(join(root, 'cezar'))).toBe(false);
  });

  it('degrades to { error, reason } + 503 when gh is not installed', async () => {
    const missing: CloneRunner = async () => ({
      ok: false,
      error: 'spawn gh ENOENT',
      notFound: true,
    });
    const result = await run({ run: missing });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(result).toHaveProperty('reason', expect.stringContaining('gh CLI not found'));
    expect(existsSync(join(root, 'cezar'))).toBe(false);
  });

  it('409s on an existing target and does NOT touch it', async () => {
    const existing = join(root, 'cezar');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'precious.txt'), 'someone else lives here', 'utf8');
    // A runner that would destroy the folder if it were ever reached.
    const forbidden: CloneRunner = async () => {
      throw new Error('the runner must not run when the target exists');
    };
    const result = await run({ run: forbidden });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(join(existing, 'precious.txt'), 'utf8')).toBe('someone else lives here');
    // Not even a progress event: nothing about this attempt started.
    expect(events).toEqual([]);
  });

  it('creates the checkout root on demand — a fresh install has never had one', async () => {
    const fresh = join(root, 'never', 'existed');
    const result = await checkoutRepo({
      url: 'open-mercato/cezar',
      projectsDir: fresh,
      onProgress: () => {},
    });
    expect(result).toMatchObject({ ok: true, target: join(fresh, 'cezar') });
  });
});

describe('POST /api/projects/checkout', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedProjectsDir = process.env.CEZ_PROJECTS_DIR;
  const savedRemote = process.env.CEZ_REMOTE;
  let home: string;
  let repoRoot: string;
  let checkoutRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-checkout-boot-'));
    checkoutRoot = join(home, 'cezar', 'projects');
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_PROJECTS_DIR;
    delete process.env.CEZ_REMOTE;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedProjectsDir === undefined) delete process.env.CEZ_PROJECTS_DIR;
    else process.env.CEZ_PROJECTS_DIR = savedProjectsDir;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      ...over,
    });

  const post = async (body: unknown, over: Partial<ServerDeps> = {}) => {
    const res = await apiRequest(makeApp(over), '/api/projects/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as Partial<RegisterProjectResponse> & { error?: string; reason?: string },
    };
  };

  const listProjectsViaApi = async (): Promise<ProjectsResponse> =>
    (await (await apiRequest(makeApp(), '/api/projects')).json()) as ProjectsResponse;

  /** Point the workspace at a temp checkout root, so nothing lands in `~`. */
  const useCheckoutRoot = () =>
    mergeWriteWorkspaceConfig((config) => {
      config.projectsDir = checkoutRoot;
    });

  it('clones into projectsDir, registers the result as source=checkout, and streams progress', async () => {
    await useCheckoutRoot();
    const bus = new WorkspaceEventBus();
    const seen: { event: string; data: unknown }[] = [];
    bus.on((event, data) => seen.push({ event, data }));

    const { status, body } = await post({ url: 'open-mercato/cezar', checkoutId: 'co-9' }, { workspaceEvents: bus });
    expect(status).toBe(200);
    expect(body.project).toMatchObject({
      name: 'cezar',
      source: 'checkout',
      status: 'ok',
    });
    expect(body.project?.root).toBe(join(checkoutRoot, 'cezar'));
    expect(existsSync(join(checkoutRoot, 'cezar', '.git'))).toBe(true);

    // The dialog's two feeds: `checkout-progress` while it runs, `project-added`
    // once at the end (which is what makes every open sidebar grow the group).
    const progress = seen.filter((s) => s.event === 'checkout-progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((s) => (s.data as { checkoutId: string }).checkoutId === 'co-9')).toBe(true);
    expect((progress.at(-1)?.data as { phase: string }).phase).toBe('done');
    expect(seen.filter((s) => s.event === 'project-added')).toEqual([
      { event: 'project-added', data: { project: body.project } },
    ]);

    // Immediately listable — the dialog navigates to `/p/<id>/` and the route
    // gate reads this list to decide the id is known.
    expect((await listProjectsViaApi()).projects.map((p) => p.id)).toContain(body.project?.id);
  });

  it('uses CEZ_PROJECTS_DIR as the zero-config checkout root and creates it recursively', async () => {
    const fromEnv = join(home, 'deep', 'environment', 'checkouts');
    process.env.CEZ_PROJECTS_DIR = fromEnv;
    const { status, body } = await post({ url: 'open-mercato/cezar' });
    expect(status).toBe(200);
    expect(body.project?.root).toBe(join(fromEnv, 'cezar'));
    expect(existsSync(join(fromEnv, 'cezar', '.git'))).toBe(true);
  });

  it('409s when the target folder already exists, leaving it and the registry untouched', async () => {
    await useCheckoutRoot();
    const existing = join(checkoutRoot, 'cezar');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'precious.txt'), 'mine', 'utf8');

    const { status, body } = await post({
      url: 'https://github.com/open-mercato/cezar.git',
    });
    expect(status).toBe(409);
    expect(body.error).toContain('already exists');
    expect(body.project).toBeUndefined();
    expect(readFileSync(join(existing, 'precious.txt'), 'utf8')).toBe('mine');
    expect((await listProjectsViaApi()).projects).toEqual([]);
  });

  it('surfaces a clone failure as a readable error, cleans up, and registers nothing', async () => {
    await useCheckoutRoot();
    const cloneRunner: CloneRunner = async (_ref, dir, onLine) => {
      onLine('Cloning into ...');
      await mkdir(join(dir, '.git'), { recursive: true });
      return { ok: false, error: 'ERROR: Repository not found.' };
    };
    const bus = new WorkspaceEventBus();
    const seen: { event: string; data: unknown }[] = [];
    bus.on((event, data) => seen.push({ event, data }));

    const { status, body } = await post({ url: 'open-mercato/nope' }, { cloneRunner, workspaceEvents: bus });
    expect(status).toBe(500);
    // Verbatim: gh's own words are the only ones that can tell the user WHY.
    expect(body.error).toContain('Repository not found');
    expect(existsSync(join(checkoutRoot, 'nope'))).toBe(false);
    expect((await listProjectsViaApi()).projects).toEqual([]);
    expect(seen.some((s) => s.event === 'project-added')).toBe(false);
    expect(seen.at(-1)).toMatchObject({
      event: 'checkout-progress',
      data: { phase: 'error' },
    });
  });

  it('degrades with { error, reason } when gh is unavailable', async () => {
    await useCheckoutRoot();
    const cloneRunner: CloneRunner = async () => ({
      ok: false,
      error: 'spawn gh ENOENT',
      notFound: true,
    });
    const { status, body } = await post({ url: 'open-mercato/cezar' }, { cloneRunner });
    expect(status).toBe(503);
    expect(body.reason).toContain('gh auth login');
    expect(body.error).toBe(body.reason);
  });

  it('400s a non-GitHub url, a traversing name, and a malformed body — nothing written', async () => {
    await useCheckoutRoot();
    for (const payload of [
      { url: 'https://gitlab.com/owner/repo' },
      { url: 'not a repo' },
      { url: 'open-mercato/cezar', name: '../escape' },
      {},
      { url: '  ' },
    ]) {
      const { status, body } = await post(payload);
      expect(status, JSON.stringify(payload)).toBe(400);
      expect(typeof body.error).toBe('string');
    }
    expect(existsSync(join(checkoutRoot, 'escape'))).toBe(false);
    expect((await listProjectsViaApi()).projects).toEqual([]);
  });

  it('a repo already registered under a DIFFERENT name still clones and registers fresh', async () => {
    // The 409-on-existing-dir path is about the folder, not the repo: two
    // checkouts of the same repo under different names are legitimate.
    await useCheckoutRoot();
    expect((await post({ url: 'open-mercato/cezar', name: 'one' })).status).toBe(200);
    const second = await post({ url: 'open-mercato/cezar', name: 'two' });
    expect(second.status).toBe(200);
    expect((await listProjectsViaApi()).projects.map((p) => p.name).sort()).toEqual(['one', 'two']);
  });

  it('a checkout that duplicates an ALREADY-registered root answers 409 with the existing entry', async () => {
    // Reachable when the folder was removed from disk but its registry row was
    // not: the clone succeeds, and registration recognises the realpath.
    await useCheckoutRoot();
    mkdirSync(checkoutRoot, { recursive: true });
    const target = join(checkoutRoot, 'cezar');
    mkdirSync(target, { recursive: true });
    const existing = await registerProject(target, 'local');
    rmSync(target, { recursive: true, force: true });
    clearProjectProbeCache();

    const { status, body } = await post({ url: 'open-mercato/cezar' });
    expect(status).toBe(409);
    expect(body.error).toContain(existing.id);
    // The clone is still on disk — a successful checkout is never deleted by a
    // registry outcome, and the message says where it is.
    expect(body.error).toContain(target);
    expect(existsSync(join(target, '.git'))).toBe(true);
  });
});
