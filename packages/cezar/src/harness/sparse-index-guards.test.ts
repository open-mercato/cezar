import childProcess, { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinWorktreeGitDir } from '../git-pin.js';
import { harnessDiff, normalizeHarnessIndex, resetIndexToHead, snapshotHarnessReviewSubject, snapshotHarnessStageSubject } from './driver.js';

const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;

describe('sparse and split index guards', () => {
  let root: string;
  let cwd: string;
  let gitDir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  const runtime = (op: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, op, '--worktree', cwd, ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  const write = (path: string, content: string) => fs.writeFileSync(join(cwd, path), content);
  const sparse = () => { git('sparse-checkout', 'init', '--cone'); git('sparse-checkout', 'set', 'src'); };
  // A reviewer-less profile runs only the review subject builder.
  const subjectConfig = () => {
    const config = join(root, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ agentHarness: { version: 1, delivery: { mode: 'stage-only' }, models: {}, profiles: { subject: { reviewers: [] } } } }));
    return config;
  };
  const review = (...args: string[]) => {
    const out = runtime('review', '--config', subjectConfig(), '--profile', 'subject', '--output-dir', join(root, 'review-out'), ...args);
    return JSON.parse(fs.readFileSync(out.jsonPath, 'utf8')) as { reviewContract: { subjectSha256: string } };
  };
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'cez-round7-'));
    cwd = join(root, 'repo');
    fs.mkdirSync(join(cwd, 'src'), { recursive: true });
    fs.mkdirSync(join(cwd, 'outside'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    git('config', 'gc.auto', '0');
    for (const path of ['src/a.txt', 'outside/edit', 'outside/absent']) write(path, 'base\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const worktree = join(root, 'task');
    git('worktree', 'add', '-q', '-b', 'task', worktree);
    cwd = worktree;
    gitDir = git('rev-parse', '--absolute-git-dir').trim();
    pinWorktreeGitDir(cwd, gitDir);
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['new', 'materialized edit'])('[r7-sparse-add] real runtime stages outside-cone %s', async (state) => {
    sparse();
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    fs.mkdirSync(join(cwd, 'outside'), { recursive: true });
    const path = state === 'new' ? 'outside/new' : 'outside/edit';
    write(path, 'outside edit\n'); write('src/a.txt', 'inside edit\n');
    const subject = await snapshotHarnessStageSubject(cwd);
    resetIndexToHead(cwd);
    expect(git('ls-files', '-v', 'outside/absent')).toBe('S outside/absent\n');
    const paths = join(root, 'paths');
    fs.writeFileSync(paths, `${path}\nsrc/a.txt\n`);
    expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready', stagedPaths: [path, 'src/a.txt'] });
    expect(git('diff', '--cached', '--name-only')).toBe(`${path}\nsrc/a.txt\n`);
    expect(git('diff', '--cached', '--diff-filter=D')).toBe('');
    expect(await snapshotHarnessStageSubject(cwd)).toBe(subject);
    expect(runtime('verify', '--start-state', start)).toMatchObject({ status: 'clean', drift: [] });
  });

  it('guard: [r7-sparse-add] in-cone edits keep absent outside entries and HEAD/reflog', () => {
    sparse();
    const start = join(root, 'start.json'); runtime('capture', '--output', start);
    write('src/a.txt', 'inside edit\n'); resetIndexToHead(cwd);
    const paths = join(root, 'paths'); fs.writeFileSync(paths, 'src/a.txt\n');
    expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready', stagedPaths: ['src/a.txt'] });
    expect(git('ls-files', '-v', 'outside/absent')).toBe('S outside/absent\n');
    expect(runtime('verify', '--start-state', start)).toMatchObject({ status: 'clean', drift: [] });
  });

  it('[r7-sparse-lock] retries reset after index.lock without losing absent S bits', () => {
    sparse();
    let resets = 0;
    const calls: string[][] = [];
    normalizeHarnessIndex(cwd, (args) => {
      calls.push(args);
      if (args[0] === 'read-tree' && args.includes('--reset') && resets++ === 0) {
        fs.writeFileSync(join(gitDir, 'index.lock'), 'held');
        try { return execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }); }
        finally { fs.rmSync(join(gitDir, 'index.lock')); }
      }
      return execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    });
    expect(git('ls-files', '-v', 'outside/absent'), 'sparse reset must preserve S bits').toBe('S outside/absent\n');
    expect(calls.filter((args) => args[0] === 'read-tree')).toEqual([['read-tree', '--reset', 'HEAD'], ['read-tree', '--reset', 'HEAD']]);
  });

  it('guard: [r7-sparse-lock] a persistent lock leaves the real sparse index intact', () => {
    sparse();
    write('src/a.txt', 'staged before lock\n'); git('add', 'src');
    const index = fs.readFileSync(join(gitDir, 'index'));
    fs.writeFileSync(join(gitDir, 'index.lock'), 'held');
    try {
      expect(() => resetIndexToHead(cwd)).not.toThrow();
      expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index);
    } finally { fs.rmSync(join(gitDir, 'index.lock')); }
    expect(git('ls-files', '-v', 'outside/absent')).toBe('S outside/absent\n');
  });

  it('[r7-sparse-error] fails closed on other sparse reset errors', () => {
    sparse();
    const calls: string[][] = [];
    expect(() => normalizeHarnessIndex(cwd, (args) => {
      calls.push(args);
      if (args[0] === 'read-tree') throw new Error('index is corrupt');
      return Buffer.from(git(...args));
    })).toThrow('index is corrupt');
    expect(calls.filter((args) => args[0] === 'read-tree')).toHaveLength(1);
  });

  it('guard: [r7-sparse-lock] full checkouts retain the plain read-tree fallback', () => {
    const calls: string[][] = [];
    normalizeHarnessIndex(cwd, (args) => {
      calls.push(args);
      if (args[0] === 'read-tree' && args.includes('--reset')) throw new Error('unsupported reset');
      return Buffer.from(git(...args));
    });
    expect(calls).toContainEqual(['read-tree', 'HEAD']);
  });

  const traceGit = () => {
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(root, 'bin'); const log = join(root, 'git-argv');
    fs.mkdirSync(bin);
    fs.writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    return () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  };

  it('guard: [r7-argv] small non-sparse allowlists still use literal argv without --sparse', () => {
    const start = join(root, 'start.json'); runtime('capture', '--output', start);
    write('src/a.txt', 'small edit\n');
    const paths = join(root, 'paths'); fs.writeFileSync(paths, 'src/a.txt\n');
    const calls = traceGit();
    expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready' });
    expect(calls().filter((line) => line.startsWith('add '))).toEqual(['add -- :(literal)src/a.txt']);
  });

  it('[r7-argmax] real runtime stages 12000 long literal paths through stdin', () => {
    const start = join(root, 'start.json'); runtime('capture', '--output', start);
    const paths = Array.from({ length: 12_000 }, (_, i) => `src/${String(i).padStart(5, '0')}-${'x'.repeat(100)}[a].txt`);
    for (const path of paths) write(path, 'new\n');
    const pathsFile = join(root, 'paths'); fs.writeFileSync(pathsFile, paths.join('\n') + '\n');
    const calls = traceGit();
    expect(runtime('stage', '--start-state', start, '--paths-file', pathsFile)).toMatchObject({ status: 'ready', stagedPaths: paths });
    expect(calls().filter((line) => line.startsWith('add '))).toEqual(['add --pathspec-from-file=- --pathspec-file-nul']);
    expect(runtime('verify', '--start-state', start)).toMatchObject({ status: 'clean', drift: [] });
  }, 30_000);

  it('[r7-review-argv] real runtime bounds review add and diff path arguments', () => {
    const paths = Array.from({ length: 400 }, (_, i) => `src/${String(i).padStart(5, '0')}-${'x'.repeat(100)}.txt`);
    for (const path of paths) write(path, 'new\n');
    const pathsFile = join(root, 'paths'); fs.writeFileSync(pathsFile, paths.join('\n') + '\n');
    const calls = traceGit();
    expect(review('--paths-file', pathsFile).reviewContract.subjectSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const line of calls()) expect(Buffer.byteLength(line), 'review path arguments stay bounded').toBeLessThan(18_000);
    expect(calls().some((line) => line.includes('add -A --pathspec-from-file=- --pathspec-file-nul'))).toBe(true);
    expect(git('diff', '--cached')).toBe('');
  });

  it('guard: [r7-review-argv] small review path lists keep argv and scope', () => {
    write('src/a.txt', 'selected\n'); write('outside/edit', 'unrelated\n');
    const pathsFile = join(root, 'paths'); fs.writeFileSync(pathsFile, 'src/a.txt\n');
    const calls = traceGit();
    const { reviewContract } = review('--paths-file', pathsFile);
    expect(calls().some((line) => line.endsWith('add -A -- :(literal)src/a.txt'))).toBe(true);
    expect(reviewContract.subjectSha256).toBe(createHash('sha256').update(git('diff', '--binary', 'HEAD', '--', 'src/a.txt')).digest('hex'));
  });

  it('guard: [r7-path-batches] harnessDiff keeps literal scope and excludes unrelated edits', async () => {
    write('src/a.txt', 'allowed\n'); write('outside/edit', 'unrelated\n');
    const diff = await harnessDiff(cwd, ['src/a.txt'], join(root, 'private-index'));
    expect(diff.toString()).toContain('+allowed'); expect(diff.toString()).not.toContain('unrelated');
    expect(git('diff', '--cached')).toBe('');
  });

  it.each(['stage', 'review'] as const)('[r7-split] %s snapshot creates no sharedindex files and preserves the real split index', async (kind) => {
    for (let i = 0; i < 50; i++) write(`src/f${i}`, 'base\n');
    git('add', 'src'); git('commit', '-qm', 'split fixture');
    git('config', 'core.splitIndex', 'true'); git('update-index', '--split-index');
    for (let i = 0; i < 30; i++) write(`src/f${i}`, 'changed\n');
    git('add', 'src');
    const before = fs.readdirSync(gitDir).filter((name) => name.startsWith('sharedindex.')).sort();
    const old = new Date(Date.now() - 30 * 86400_000);
    for (const name of before) fs.utimesSync(join(gitDir, name), old, old);
    const index = fs.readFileSync(join(gitDir, 'index'));
    await (kind === 'stage' ? snapshotHarnessStageSubject : snapshotHarnessReviewSubject)(cwd);
    expect(fs.readdirSync(gitDir).filter((name) => name.startsWith('sharedindex.')).sort()).toEqual(before);
    expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index);
    expect(git('status', '--porcelain')).toContain('M  src/f');
    expect(git('config', '--bool', 'core.splitIndex').trim()).toBe('true');
  });

  it('[r7-runtime-split] real runtime review snapshot creates no sharedindex files', () => {
    git('config', 'core.splitIndex', 'true');
    git('update-index', '--split-index');
    write('src/a.txt', 'edited\n');
    const before = fs.readdirSync(gitDir).filter((name) => name.startsWith('sharedindex.')).sort();
    const index = fs.readFileSync(join(gitDir, 'index'));
    review();
    expect(fs.readdirSync(gitDir).filter((name) => name.startsWith('sharedindex.')).sort()).toEqual(before);
    expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index);
  });

  it('guard: [r7-split] real reset retains the user split-index setting', () => {
    git('config', 'core.splitIndex', 'true'); git('update-index', '--split-index');
    write('src/a.txt', 'edited\n'); git('add', 'src'); resetIndexToHead(cwd);
    expect(git('config', '--bool', 'core.splitIndex').trim()).toBe('true');
    expect(git('rev-parse', '--shared-index-path').trim()).not.toBe('');
    expect(git('diff', '--cached')).toBe('');
  });

  it('[r7-advice] private snapshot commands silence sparse-index expansion advice', async () => {
    sparse(); git('sparse-checkout', 'reapply', '--sparse-index'); write('src/a.txt', 'edited\n');
    const spy = vi.spyOn(childProcess, 'execFileSync'); syncBuiltinESMExports();
    await snapshotHarnessStageSubject(cwd); await snapshotHarnessReviewSubject(cwd);
    const calls = spy.mock.calls.filter(([, , options]) => typeof options === 'object' && options?.env?.GIT_INDEX_FILE);
    expect(calls.length).toBeGreaterThan(0);
    for (const [, args] of calls) expect(args).toEqual(expect.arrayContaining(['advice.sparseIndexExpanded=false']));
  });

  it('guard: [r7-advice] snapshot errors retain git stderr', async () => {
    fs.writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/missing\n');
    await expect(snapshotHarnessStageSubject(cwd)).rejects.toThrow(/unknown revision|ambiguous argument/);
  });
});
