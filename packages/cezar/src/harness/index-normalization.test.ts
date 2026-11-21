import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinWorktreeGitDir } from '../git-pin.js';
import { resetIndexToHead, snapshotHarnessReviewSubject, snapshotHarnessStageSubject } from './driver.js';

const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;

describe('index normalization', () => {
  let root: string;
  let cwd: string;
  let gitDir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const runtime = (op: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, op, '--worktree', cwd, ...args], { cwd, encoding: 'utf8' }));
  const write = (path: string, content: string) => fs.writeFileSync(join(cwd, path), content);
  const discover = () => [...new Set([
    ...git('diff', '--name-only', '-z', 'HEAD', '--').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean))].sort();
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'cez-round6-'));
    cwd = join(root, 'repo');
    fs.mkdirSync(join(cwd, 'src'), { recursive: true });
    fs.mkdirSync(join(cwd, 'outside'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    git('config', 'gc.auto', '0');
    git('config', 'maintenance.auto', 'false');
    for (const path of ['src/a.txt', 'src/x', 'src/unchanged', 'outside/other']) write(path, 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const worktree = join(root, 'task');
    git('worktree', 'add', '-q', '-b', 'task', worktree);
    cwd = worktree;
    gitDir = git('rev-parse', '--absolute-git-dir').trim();
    pinWorktreeGitDir(cwd, gitDir);
  });
  // Removing the benchmark's 10k-file repo can outlast the default hook timeout under load.
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  const cases = [
    'plain edit', 'MM', 'touched staged', 'intent-to-add', 'staged new edited',
    'assume-unchanged edited', 'assume-unchanged deleted', 'assume-unchanged dangling symlink',
    'skip-worktree edited non-sparse', 'skip-worktree deleted non-sparse',
    'sparse edit', 'sparse MM', 'sparse MM second Continue', 'sparse dangling symlink', 'sparse assume-unchanged dangling symlink',
  ];
  it.each(cases.map((state) => [
    `${['plain edit', 'sparse edit', 'sparse dangling symlink', 'sparse assume-unchanged dangling symlink'].includes(state) ? 'guard: ' : ''}[r6-index] capture → normalize → discover → real stage: ${state}`,
    state,
  ] as const))('%s', async (_name, state) => {
    const sparse = state.startsWith('sparse');
    if (sparse) {
      git('sparse-checkout', 'init', '--cone');
      git('sparse-checkout', 'set', 'src');
      expect(fs.existsSync(join(cwd, 'outside/other'))).toBe(false);
    }
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    const head = git('rev-parse', 'HEAD');
    const reflog = git('reflog', 'show', 'HEAD');
    const cache = git('ls-files', '--debug', 'src/unchanged');
    expect(cache).not.toMatch(/(?:ctime|mtime): 0:0/);
    write('src/x', 'visible edit\n');
    let target = 'src/a.txt';
    if (state === 'intent-to-add' || state === 'staged new edited') target = 'src/new';
    if (state.includes('assume-unchanged')) git('update-index', '--assume-unchanged', '--', target);
    if (state.includes('skip-worktree')) git('update-index', '--skip-worktree', '--', target);
    write(target, 'final edit\n');
    if (state.includes('MM') || state === 'touched staged' || state === 'staged new edited') {
      git('add', '--', target);
      if (state === 'touched staged') {
        const future = new Date(Date.now() + 10_000);
        fs.utimesSync(join(cwd, target), future, future);
      } else write(target, 'edited after staging\n');
    }
    if (state === 'intent-to-add') git('add', '-N', '--', target);
    if (state.includes('deleted')) fs.rmSync(join(cwd, target));
    if (state.includes('dangling symlink')) {
      fs.rmSync(join(cwd, target));
      fs.symlinkSync('missing-target', join(cwd, target));
      if (sparse) git('update-index', '--skip-worktree', '--', target);
    }
    const paths = join(root, 'paths.txt');
    for (let attempt = 0; attempt < (state.includes('second Continue') ? 2 : 1); attempt += 1) {
      const before = await snapshotHarnessStageSubject(cwd);
      const realIndex = fs.readFileSync(join(gitDir, 'index'));
      await snapshotHarnessReviewSubject(cwd);
      expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(realIndex);
      resetIndexToHead(cwd);
      expect(git('ls-files', '-v', '--', target)).not.toMatch(/^[a-zS] /m);
      expect(await snapshotHarnessStageSubject(cwd), 'subject must survive normalization').toBe(before);
      if (sparse) expect(git('ls-files', '-v', 'outside/other')).toBe('S outside/other\n');
      expect(git('ls-files', '--debug', 'src/unchanged')).toBe(cache);
      expect(git('diff', '--cached')).toBe('');
      const expected = [target, 'src/x'].sort();
      expect(discover(), 'complete handoff path set').toEqual(expected);
      expect(git('ls-files', '-v', '--', target)).not.toMatch(/^[a-zS] /m);
      fs.writeFileSync(paths, `${discover().join('\n')}\n`);
      expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready', stagedPaths: expected });
      expect(git('diff', '--cached', '--name-only').trim().split('\n')).toEqual(expected);
      expect(await snapshotHarnessStageSubject(cwd)).toBe(before);
      if (attempt === 0 && state.includes('second Continue')) write(target, 'second Continue edit\n');
    }
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('reflog', 'show', 'HEAD')).toBe(reflog);
    expect(runtime('verify', '--start-state', start)).toMatchObject({ status: 'clean', drift: [] });
  });

  it('[r6-index] clears unmerged stages without losing absent sparse bits', async () => {
    git('sparse-checkout', 'init', '--cone');
    git('sparse-checkout', 'set', 'src');
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    const blob = git('rev-parse', 'HEAD:src/a.txt').trim();
    git('update-index', '--force-remove', 'src/a.txt');
    execFileSync('git', ['update-index', '--index-info'], {
      cwd, input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tsrc/a.txt\n`).join(''),
    });
    expect(git('ls-files', '--unmerged')).not.toBe('');
    write('src/a.txt', 'resolved worktree bytes\n');
    const before = await snapshotHarnessStageSubject(cwd);
    expect(git('ls-files', '--unmerged')).not.toBe('');
    expect(() => resetIndexToHead(cwd)).not.toThrow();
    expect(git('ls-files', '--unmerged')).toBe('');
    expect(git('ls-files', '-v', 'outside/other')).toBe('S outside/other\n');
    expect(await snapshotHarnessStageSubject(cwd)).toBe(before);
    const paths = join(root, 'paths.txt');
    fs.writeFileSync(paths, `${discover().join('\n')}\n`);
    expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready', stagedPaths: ['src/a.txt'] });
    expect(runtime('verify', '--start-state', start)).toMatchObject({ status: 'clean', drift: [] });
  });

  it('guard: normalization keeps plain edits, unchanged stat caches and HEAD/reflog stable', async () => {
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    const cache = git('ls-files', '--debug', 'src/unchanged');
    write('src/a.txt', 'ordinary harness edit\n');
    const subject = await snapshotHarnessStageSubject(cwd);
    resetIndexToHead(cwd);
    expect(await snapshotHarnessStageSubject(cwd)).toBe(subject);
    expect(git('ls-files', '--debug', 'src/unchanged')).toBe(cache);
    const paths = join(root, 'paths.txt');
    fs.writeFileSync(paths, `${discover().join('\n')}\n`);
    expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready', stagedPaths: ['src/a.txt'] });
  });

  it('[r6-copy] seeds subject indexes with the real stat cache and timestamp', async () => {
    const copy = vi.spyOn(fs, 'copyFileSync');
    const times = vi.spyOn(fs, 'utimesSync');
    syncBuiltinESMExports();
    const index = fs.readFileSync(join(gitDir, 'index'));
    const { atime, mtime } = fs.statSync(join(gitDir, 'index'));
    await snapshotHarnessStageSubject(cwd);
    expect(copy).toHaveBeenCalledWith(join(gitDir, 'index'), expect.any(String));
    expect(times).toHaveBeenCalledWith(expect.any(String), atime, mtime);
    expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index);
  });

  it('[r6-private] stores both private subject indexes under the host Git directory', async () => {
    const create = vi.spyOn(fs, 'mkdtempSync');
    syncBuiltinESMExports();
    await snapshotHarnessStageSubject(cwd);
    await snapshotHarnessReviewSubject(cwd);
    expect(create).toHaveBeenCalledTimes(2);
    for (const [path] of create.mock.calls) expect(dirname(String(path))).toBe(gitDir);
    expect(fs.readdirSync(gitDir).filter((name) => name.startsWith('cez-subject-index-'))).toEqual([]);
  });

  it('[r6-private] unpinned subject copies use the supplied host artifact directory', async () => {
    cwd = join(root, 'repo');
    const artifacts = join(root, 'host-artifacts');
    fs.mkdirSync(artifacts);
    const create = vi.spyOn(fs, 'mkdtempSync');
    syncBuiltinESMExports();
    await snapshotHarnessStageSubject(cwd, artifacts);
    await snapshotHarnessReviewSubject(cwd, artifacts);
    expect(create).toHaveBeenCalledTimes(2);
    for (const [path] of create.mock.calls) expect(dirname(String(path))).toBe(artifacts);
    expect(fs.readdirSync(artifacts)).toEqual([]);
  });

  it('guard: subject copies keep the real index unchanged and ignore staging representation', async () => {
    write('src/new', 'new bytes\n');
    const subject = await snapshotHarnessStageSubject(cwd);
    git('add', '-N', 'src/new');
    const index = fs.readFileSync(join(gitDir, 'index'));
    expect(await snapshotHarnessStageSubject(cwd)).toBe(subject);
    expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index);
    git('add', 'src/new');
    expect(await snapshotHarnessStageSubject(cwd)).toBe(subject);
  });

  it.each([false, true])('[r6-hooks] subject writes disable relative post-index-change hooks (pinned=%s)', async (pinned) => {
    if (!pinned) {
      cwd = join(root, 'repo');
      gitDir = join(cwd, '.git');
    }
    fs.mkdirSync(join(cwd, '.husky'));
    const marker = join(root, 'hook-ran');
    fs.writeFileSync(join(cwd, '.husky/post-index-change'), `#!/bin/sh\nprintf hook >> '${marker}'\n`, { mode: 0o755 });
    git('config', 'core.hooksPath', '.husky');
    // Prove the hook is live on a private index, independently of the driver.
    execFileSync('git', ['read-tree', 'HEAD'], { cwd, env: { ...process.env, GIT_INDEX_FILE: join(gitDir, 'hook-test-index') } });
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    await snapshotHarnessStageSubject(cwd);
    await snapshotHarnessReviewSubject(cwd);
    resetIndexToHead(cwd);
    expect(fs.existsSync(marker), 'host-side index writes must not run hooks').toBe(false);
  });

  it('guard: an unpinned reset leaves ordinary staging and configured hooks untouched', () => {
    cwd = join(root, 'repo');
    write('src/a.txt', 'ordinary staged edit\n');
    git('add', 'src/a.txt');
    git('config', 'core.hooksPath', '.husky');
    const index = fs.readFileSync(join(cwd, '.git/index'));
    resetIndexToHead(cwd);
    expect(fs.readFileSync(join(cwd, '.git/index'))).toEqual(index);
    expect(git('config', 'core.hooksPath').trim()).toBe('.husky');
  });

  // Report-only; building the 10k-file repo dominates under full-suite load.
  it('subject snapshot timing on at least 10000 tracked files', async () => {
    fs.mkdirSync(join(cwd, 'src/bulk'));
    for (let i = 0; i < 10_000; i += 1) write(`src/bulk/${i}.txt`, `file ${i}\n${'x'.repeat(2048)}\n`);
    git('add', 'src/bulk');
    git('commit', '-qm', 'snapshot benchmark');
    const count = git('ls-files', '-z').split('\0').filter(Boolean).length;
    expect(count).toBeGreaterThanOrEqual(10_000);
    write('src/a.txt', 'one changed file\n');
    const timings: Record<string, number[]> = { stage: [], review: [] };
    for (const [name, snapshot] of [['stage', snapshotHarnessStageSubject], ['review', snapshotHarnessReviewSubject]] as const) {
      for (let i = 0; i < 5; i += 1) {
        const start = performance.now();
        await snapshot(cwd);
        timings[name]!.push(Math.round((performance.now() - start) * 100) / 100);
      }
    }
    process.stdout.write(`subject snapshot benchmark ${JSON.stringify({ count, timings })}\n`);
  }, 120_000);

  it('guard: Sandbox documentation retains the Codex runner temp exclusions', () => {
    const doc = fs.readFileSync(new URL('../../../../docs/multi-model-harness.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(doc).toContain('the shared `/tmp` and host `TMPDIR` are excluded');
  });
});
