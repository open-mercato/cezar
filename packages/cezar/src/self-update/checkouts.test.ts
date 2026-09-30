import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCheckout, cezarPackageRoot, discoverCheckouts } from './checkouts.ts';
import { SelfUpdateService } from './service.ts';
import { activate, activeId, branchSlug, currentEntry, linkCheckout, linkId, listInstalled, listLinks, removeInstalled, versionDir, versionsDir } from './layout.ts';

/** A built cezar monorepo checkout: packages/cezar with dist/index.js and web/dist/index.html. */
function fakeCheckout(root: string, version = '0.13.0', built = true): string {
  const pkg = join(root, 'packages', 'cezar');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@open-mercato/cezar', version }));
  if (built) {
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'index.js'), '// entry\n');
    mkdirSync(join(pkg, 'web', 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'web', 'dist', 'index.html'), '<!doctype html>');
  }
  return realpathSync(pkg);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

describe('linked checkouts', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-link-'));
    env = { ...process.env, CEZ_HOME: join(home, 'cezar-home') };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('slugs a branch into semver build metadata', () => {
    expect(branchSlug('cez/cb28888e')).toBe('cez-cb28888e');
    expect(branchSlug('feat//weird name!')).toBe('feat-weird-name');
    expect(linkId('0.13.0', 'cez/cb28888e')).toBe('0.13.0+cez-cb28888e');
    expect(linkId('0.13.0', '///')).toBe('0.13.0+checkout');
  });

  it('links a built checkout in place, lists it, activates it, and unlinks without touching it', () => {
    const pkg = fakeCheckout(join(home, 'wt'));
    const result = linkCheckout(pkg, 'cez/cb28888e', env);
    expect(result.id).toBe('0.13.0+cez-cb28888e');
    const link = join(versionDir(result.id, env), 'node_modules', '@open-mercato', 'cezar');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(pkg);

    const [entry] = listInstalled(env);
    expect(entry).toMatchObject({ id: result.id, source: 'link', branch: 'cez/cb28888e', checkout: pkg, version: '0.13.0' });

    activate(result.id, env);
    expect(activeId(env)).toBe(result.id);
    expect(readFileSync(currentEntry(env), 'utf8')).toBe('// entry\n');

    expect(() => removeInstalled(result.id, env)).toThrow(/is active/);
  });

  it('removes the link, never the checkout', () => {
    const pkg = fakeCheckout(join(home, 'wt'));
    const { id } = linkCheckout(pkg, 'main', env);
    removeInstalled(id, env);
    expect(existsSync(versionDir(id, env))).toBe(false);
    expect(existsSync(join(pkg, 'dist', 'index.js'))).toBe(true);
  });

  it('re-linking a checkout replaces its old entry; another checkout with the same id gets its own', () => {
    const pkg = fakeCheckout(join(home, 'a'));
    linkCheckout(pkg, 'feature', env);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@open-mercato/cezar', version: '0.14.0' }));
    const again = linkCheckout(pkg, 'feature', env);
    expect(again.id).toBe('0.14.0+feature');
    expect(listLinks(env).map((entry) => entry.id)).toEqual(['0.14.0+feature']);

    const other = fakeCheckout(join(home, 'b'), '0.14.0');
    const second = linkCheckout(other, 'feature', env);
    expect(second.id).toMatch(/^0\.14\.0\+feature\.[0-9a-z]+$/);
    expect(listLinks(env)).toHaveLength(2);
  });

  it('refuses what is not a built cezar package', () => {
    expect(() => linkCheckout(join(home, 'nothing'), 'x', env)).toThrow(/is not a @open-mercato\/cezar package/);
    const unbuilt = fakeCheckout(join(home, 'raw'), '0.13.0', false);
    expect(() => linkCheckout(unbuilt, 'x', env)).toThrow(/not built/);
  });

  it('hides a link whose worktree is gone, but still finds it to prune', () => {
    const tree = join(home, 'gone');
    const { id } = linkCheckout(fakeCheckout(tree), 'gone', env);
    rmSync(tree, { recursive: true, force: true });
    expect(listInstalled(env)).toEqual([]);
    expect(listLinks(env).map((entry) => entry.id)).toEqual([id]);
    expect(existsSync(versionsDir(env))).toBe(true);
  });

  it('finds the cezar package root in the monorepo layout and the single-package one', () => {
    const mono = fakeCheckout(join(home, 'mono'));
    expect(cezarPackageRoot(join(home, 'mono'))).toBe(join(home, 'mono', 'packages', 'cezar'));
    expect(realpathSync(cezarPackageRoot(mono)!)).toBe(mono);
    const flat = join(home, 'flat');
    mkdirSync(flat, { recursive: true });
    writeFileSync(join(flat, 'package.json'), JSON.stringify({ name: '@open-mercato/cezar', version: '0.9.0' }));
    expect(cezarPackageRoot(flat)).toBe(flat);
    expect(cezarPackageRoot(home)).toBeNull();
  });

  it('discovers every worktree of a registered cezar repo, built or not', async () => {
    const repo = join(home, 'repo');
    fakeCheckout(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), 'dist\nweb/dist\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'cez/abc12345', join(home, 'wt-task'));
    mkdirSync(env.CEZ_HOME!, { recursive: true });
    writeFileSync(join(env.CEZ_HOME!, 'config.json'), JSON.stringify({ projects: [{ id: 'cezar', root: realpathSync(repo) }] }));

    const found = await discoverCheckouts(env);
    expect(found.map((c) => [c.branch, c.built, c.linked, c.id])).toEqual([
      ['main', true, false, '0.13.0+main'],
      ['cez/abc12345', false, false, '0.13.0+cez-abc12345'],
    ]);

    linkCheckout(found[0]!.packageRoot, 'main', env);
    expect((await discoverCheckouts(env))[0]).toMatchObject({ linked: true, id: '0.13.0+main' });
  });

  // Forty `cez/<id8>` branches read the same: discovery names each by the task that owns it, its
  // last commit, and whether the build predates that commit — newest work first.
  it('labels worktrees with their task, last commit and build age, newest commit first', async () => {
    const repo = join(home, 'repo');
    fakeCheckout(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), 'dist\nweb/dist\n.ai\n');
    git(repo, 'add', '.');
    execFileSync('git', ['commit', '-q', '-m', 'init'], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: '2026-09-01T10:00:00Z' },
    });
    const task = join(repo, '.ai', 'cezar', 'worktrees', 'abc12345-run');
    git(repo, 'worktree', 'add', '-q', '-b', 'cez/abc12345', task);
    fakeCheckout(task);
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'feat: the newer work'], {
      cwd: task,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: '2026-09-20T10:00:00Z' },
    });
    // Built before its last commit.
    const old = new Date('2026-09-10T10:00:00Z');
    utimesSync(join(task, 'packages', 'cezar', 'dist', 'index.js'), old, old);
    writeFileSync(
      join(repo, '.ai', 'cezar', 'runs.json'),
      JSON.stringify([
        { id: 'abc12345-run', title: 'raw prompt', titleSummary: 'Fix the version dialog', status: 'review', worktreePath: task, branch: 'cez/abc12345' },
        { id: 'broken' },
        'not a row',
      ]),
    );
    mkdirSync(env.CEZ_HOME!, { recursive: true });
    writeFileSync(join(env.CEZ_HOME!, 'config.json'), JSON.stringify({ projects: [{ id: 'cezar', root: realpathSync(repo) }] }));

    const found = await discoverCheckouts(env);
    expect(found.map((c) => c.branch)).toEqual(['cez/abc12345', 'main']);
    expect(found[0]).toMatchObject({
      task: { id: 'abc12345-run', title: 'Fix the version dialog', status: 'review' },
      commit: { subject: 'feat: the newer work', at: '2026-09-20T10:00:00.000Z' },
      builtAt: '2026-09-10T10:00:00.000Z',
      stale: true,
    });
    expect(found[1]).toMatchObject({ task: null, commit: { subject: 'init' }, stale: false });
  });

  it('builds a checkout: npm install only when dependencies are missing, then server and cockpit', async () => {
    const worktree = join(home, 'wt');
    const pkg = fakeCheckout(worktree, '0.13.0', false);
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ scripts: { build: 'x', 'build:server': 'x', 'build:web': 'x' } }));
    const calls: string[] = [];
    const npm = async (args: string[]) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[1] === 'build:web') fakeCheckout(worktree);
    };
    await buildCheckout({ worktree, packageRoot: pkg }, () => {}, npm);
    expect(calls).toEqual(['install --no-audit', 'run build:server', 'run build:web']);

    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    calls.length = 0;
    await buildCheckout({ worktree, packageRoot: pkg }, () => {}, npm);
    expect(calls).toEqual(['run build:server', 'run build:web']);

    await expect(buildCheckout({ worktree: home, packageRoot: join(home, 'nothing') }, () => {}, async () => {})).rejects.toThrow(/still missing/);
  });

  it('a failed rebuild keeps the cockpit build the running server serves', async () => {
    const worktree = join(home, 'wt');
    const pkg = fakeCheckout(worktree, '0.13.0', true);
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ scripts: { 'build:server': 'x', 'build:web': 'x' } }));
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    const npm = async (args: string[]) => {
      if (args[1] !== 'build:web') return;
      rmSync(join(pkg, 'web', 'dist'), { recursive: true, force: true }); // vite's emptyOutDir
      throw new Error('vite exited with 1');
    };
    await expect(buildCheckout({ worktree, packageRoot: pkg }, () => {}, npm)).rejects.toThrow(/vite exited/);
    expect(existsSync(join(pkg, 'web', 'dist', 'index.html'))).toBe(true);
    expect(existsSync(join(pkg, 'web', '.dist-before-build'))).toBe(false);
  });

  // Two clones on `main` both slug to `0.13.0+main`; `apply` resolves by id, so a shared id let a
  // pick of one clone build and run the other.
  it('gives two checkouts on the same branch distinct ids, and apply() runs the one picked', async () => {
    const clone = (name: string) => {
      const repo = join(home, name);
      fakeCheckout(repo);
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', `init ${name}`);
      return realpathSync(repo);
    };
    const a = clone('a');
    const b = clone('b');
    mkdirSync(env.CEZ_HOME!, { recursive: true });
    writeFileSync(join(env.CEZ_HOME!, 'config.json'), JSON.stringify({ projects: [{ id: 'a', root: a }, { id: 'b', root: b }] }));

    const ids = async () => new Map((await discoverCheckouts(env)).map((c) => [c.worktree, c.id]));
    const before = await ids();
    expect(before.get(a)).toBe('0.13.0+main');
    expect(before.get(b)).toMatch(/^0\.13\.0\+main\.[0-9a-z]+$/);

    const svc = new SelfUpdateService({
      pkgName: '@open-mercato/cezar',
      version: '0.13.0',
      entry: join(versionsDir(env), 'current', 'node_modules', '@open-mercato', 'cezar', 'dist', 'index.js'),
      restart: () => {},
      env,
    });
    const job = svc.apply(before.get(b)!);
    await vi.waitFor(() => expect(job.status).toBe('restarting'));
    expect(activeId(env)).toBe(before.get(b));
    expect(listLinks(env).find((link) => link.id === before.get(b))?.checkout).toBe(join(b, 'packages', 'cezar'));
    // Linking B under its suffixed id leaves A's plain id free — and both stay put.
    expect(await ids()).toEqual(before);
  });

  // "not built" and "needs rebuild" used to be dead ends in the picker: switching now builds first.
  it('apply() builds an unbuilt worktree, then links, activates and restarts into it', async () => {
    const repo = join(home, 'repo');
    fakeCheckout(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), 'dist\nweb/dist\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const task = join(home, 'wt-task');
    git(repo, 'worktree', 'add', '-q', '-b', 'cez/abc12345', task);
    mkdirSync(env.CEZ_HOME!, { recursive: true });
    writeFileSync(join(env.CEZ_HOME!, 'config.json'), JSON.stringify({ projects: [{ id: 'cezar', root: realpathSync(repo) }] }));

    const built: string[] = [];
    let restarted = false;
    const svc = new SelfUpdateService({
      pkgName: '@open-mercato/cezar',
      version: '0.13.0',
      entry: join(versionsDir(env), 'current', 'node_modules', '@open-mercato', 'cezar', 'dist', 'index.js'),
      restart: () => (restarted = true),
      env,
      buildCheckout: async (checkout, log) => {
        log('built');
        built.push(checkout.worktree);
        fakeCheckout(checkout.worktree);
      },
    });
    const job = svc.apply('0.13.0+cez-abc12345');
    await vi.waitFor(() => expect(job.status).toBe('restarting'));
    expect(job.error).toBeUndefined();
    expect(built).toEqual([realpathSync(task)]);
    expect(job.log).toContain('building cez/abc12345 first');
    expect(activeId(env)).toBe('0.13.0+cez-abc12345');
    await vi.waitFor(() => expect(restarted).toBe(true));
  });
});
