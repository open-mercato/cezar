import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinWorktreeGitDir, pinnedGitEnv } from '../git-pin.js';
import { readHarnessFsEntry } from '../fs-read.js';
import { harnessDiff, resetIndexToHead, snapshotHarnessReviewSubject, snapshotHarnessStageSubject } from './driver.js';

const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// Real-runtime git spawns dominate under full-suite load.
describe('review subject and staged bytes parity', { timeout: 60_000 }, () => {
  let root: string;
  let cwd: string;
  let gitDir: string;
  let realGit: string;
  const git = (...args: string[]) => execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
  const write = (path: string, content: string) => {
    fs.mkdirSync(join(cwd, path, '..'), { recursive: true });
    fs.writeFileSync(join(cwd, path), content);
  };
  const runtime = (op: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, op, '--worktree', cwd, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, CEZ_HARNESS_GIT_DIR: gitDir, CEZ_HARNESS_GIT_WORK_TREE: cwd },
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 << 20,
  }));
  const sparse = (mode = 'cone') => {
    git('sparse-checkout', 'set', ...(mode === 'non-cone' ? ['--no-cone', '/src/'] : ['--cone', ...(mode === 'sparse-index' ? ['--sparse-index'] : []), 'src']));
  };
  beforeEach(() => {
    realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    root = fs.mkdtempSync(join(tmpdir(), 'cez-round8-'));
    cwd = join(root, 'repo'); fs.mkdirSync(cwd);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
    git('config', 'gc.auto', '0'); git('config', 'maintenance.auto', 'false');
    for (const path of ['src/a.txt', 'src/x', 'src/unchanged', 'outside/edit', 'outside/absent']) write(path, 'base\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const task = join(root, 'task'); git('worktree', 'add', '-q', '-b', 'task', task); cwd = task;
    gitDir = git('rev-parse', '--absolute-git-dir').trim(); pinWorktreeGitDir(cwd, gitDir);
    // A reviewer-less profile runs only the review subject builder.
    fs.writeFileSync(join(root, 'config.json'), JSON.stringify({ agentHarness: { version: 1, delivery: { mode: 'stage-only' }, models: {}, profiles: { subject: { reviewers: [] } } } }));
    // Observe the real runtime's Git output without replacing its subject builder.
    const bin = join(root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconst cp = require('node:child_process'); const fs = require('node:fs');
const args = process.argv.slice(2); const r = cp.spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, input: args.some((arg) => ['--stdin', '--pathspec-from-file=-', '--index-info'].includes(arg)) ? fs.readFileSync(0) : undefined, maxBuffer: 256 << 20 });
if (process.env.GIT_INDEX_FILE && args.includes('diff') && args.includes('--cached') && args.includes('--binary') && r.status === 0) fs.writeFileSync(${JSON.stringify(join(root, 'subject.diff'))}, r.stdout);
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status ?? 1);\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

  const reviewSubjectSha = (...args: string[]): string => {
    const out = runtime('review', '--config', join(root, 'config.json'), '--profile', 'subject', '--output-dir', join(root, 'review-out'), ...args);
    return JSON.parse(fs.readFileSync(out.jsonPath, 'utf8')).reviewContract.subjectSha256;
  };
  const subject = (paths?: string[]) => {
    const pathsFile = join(root, 'paths');
    if (paths) fs.writeFileSync(pathsFile, paths.join('\n') + '\n');
    const subjectSha256 = reviewSubjectSha(...(paths ? ['--paths-file', pathsFile] : []));
    const bytes = fs.readFileSync(join(root, 'subject.diff'));
    expect(subjectSha256).toBe(digest(bytes));
    return bytes;
  };
  const start = () => { const path = join(root, 'start.json'); runtime('capture', '--output', path); return path; };
  const stage = (startState: string, paths: string[]) => {
    fs.writeFileSync(join(root, 'paths'), paths.join('\n') + '\n');
    return runtime('stage', '--start-state', startState, '--paths-file', join(root, 'paths'));
  };
  const cached = () => Buffer.from(git('diff', '--cached', '--no-ext-diff', '--binary', 'HEAD', '--'));
  const discover = () => [...new Set([
    ...git('diff', '--name-only', '-z', 'HEAD', '--').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean).map((path) => path.replace(/\/$/, '')))].sort();

  it.each(['materialized edit', 'new'])('[r8-sparse] real subject includes out-of-cone %s and equals staged bytes', async (kind) => {
    sparse(); const captured = start();
    const path = kind === 'new' ? 'outside/new' : 'outside/edit';
    write('src/a.txt', 'inside edit\n'); write(path, 'outside edit\n');
    const paths = [path, 'src/a.txt'];
    const index = fs.readFileSync(join(gitDir, 'index'));
    for (const scope of [paths, undefined]) {
      const reviewed = subject(scope);
      expect(reviewed.toString(), 'out-of-cone content must be reviewed').toContain('outside edit');
      expect(reviewed.toString()).toContain(`b/${path}`);
      expect(reviewed.toString()).not.toContain('deleted file');
      expect(await harnessDiff(cwd, scope ?? [], join(root, 'private-index'))).toEqual(reviewed);
      expect(fs.readFileSync(join(gitDir, 'index')), 'subject must not write real index').toEqual(index);
    }
    const reviewed = subject(paths);
    expect(resetIndexToHead(cwd)).toBeUndefined();
    expect(stage(captured, paths)).toMatchObject({ status: 'ready', stagedPaths: paths });
    expect(cached(), 'subject == staged handoff bytes').toEqual(reviewed);
    expect(git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean)).toEqual(paths);
  });

  it.each([false, true])('[r8-council] real advisor op reviews the staged sparse bytes (scoped=%s)', (scoped) => {
    sparse(); const captured = start(); write('src/a.txt', 'inside edit\n'); write('outside/edit', 'outside edit\n');
    const paths = ['outside/edit', 'src/a.txt']; fs.writeFileSync(join(root, 'paths'), paths.join('\n') + '\n');
    const reviewer = join(root, 'reviewer.mjs');
    fs.writeFileSync(reviewer, 'process.stdout.write(JSON.stringify({verdict:"approve",findings:[],notes:[]}))');
    fs.writeFileSync(join(root, 'council.json'), JSON.stringify({ agentHarness: {
      version: 1, delivery: { mode: 'stage-only' }, models: { stub: { adapter: 'command', family: 'stub', model: 'stub', roles: ['reviewer'], commands: { review: [process.execPath, reviewer] } } },
      profiles: { council: { reviewers: ['stub'], reviewPolicy: { mode: 'all-required' }, retry: { maxAttempts: 1 } } },
    } }));
    const index = fs.readFileSync(join(gitDir, 'index'));
    const result = runtime('review', '--config', join(root, 'council.json'), '--profile', 'council',
      ...(scoped ? ['--paths-file', join(root, 'paths')] : []), '--output-dir', join(root, 'council-output'), '--prompt-dir', join(root, 'prompts'));
    expect(result.verdict).toBe('approve');
    const reviewed = fs.readFileSync(join(root, 'subject.diff'));
    const prompt = fs.readFileSync(join(root, 'prompts', 'reviewer-prompt-stub.txt'), 'utf8');
    expect(prompt).toContain('outside edit'); expect(prompt).toContain(reviewed.toString());
    expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index);
    resetIndexToHead(cwd); expect(stage(captured, paths)).toMatchObject({ status: 'ready', stagedPaths: paths });
    expect(cached()).toEqual(reviewed);
  });

  const states = [
    'plain edit', 'MM', 'touched staged', 'intent-to-add', 'staged new edited',
    'assume-unchanged edited', 'assume-unchanged deleted', 'assume-unchanged dangling symlink',
    'skip-worktree edited non-sparse', 'skip-worktree deleted non-sparse',
    'sparse edit', 'sparse MM', 'sparse MM second Continue', 'sparse dangling symlink', 'sparse assume-unchanged dangling symlink',
    'cone materialized edit', 'cone new', 'non-cone materialized edit', 'non-cone new',
    'sparse-index materialized edit', 'sparse-index new', 'sparse assume-unchanged edited', 'split-index', 'sparse split-index',
  ];
  it.each(states.map((state) => [`${/materialized edit|cone new|sparse-index new/.test(state) ? '' : 'guard: '}[r8-parity] subject == staged handoff: ${state}`, state] as const))('%s', async (_name, state) => {
    const isSparse = /sparse|cone/.test(state) && !state.includes('non-sparse');
    if (isSparse) sparse(state.startsWith('non-cone') ? 'non-cone' : state.startsWith('sparse-index') ? 'sparse-index' : 'cone');
    if (state.includes('split-index')) git('config', 'core.splitIndex', 'true');
    const captured = start(); const head = git('rev-parse', 'HEAD'); const reflog = git('reflog', 'show', 'HEAD');
    write('src/x', 'visible edit\n');
    const target = /materialized edit/.test(state) ? 'outside/edit' : /cone new|sparse-index new/.test(state) ? 'outside/new'
      : ['intent-to-add', 'staged new edited'].includes(state) ? 'src/new' : 'src/a.txt';
    if (state.includes('assume-unchanged')) git('update-index', '--assume-unchanged', '--', target);
    if (state.includes('skip-worktree')) git('update-index', '--skip-worktree', '--', target);
    write(target, 'final edit\n');
    if (state.includes('MM') || ['touched staged', 'staged new edited'].includes(state)) {
      git('add', '--', target);
      if (state === 'touched staged') { const future = new Date(Date.now() + 10_000); fs.utimesSync(join(cwd, target), future, future); }
      else write(target, 'edited after staging\n');
    }
    if (state === 'intent-to-add') git('add', '-N', '--', target);
    if (state.includes('deleted')) fs.rmSync(join(cwd, target));
    if (state.includes('dangling symlink')) {
      fs.rmSync(join(cwd, target)); fs.symlinkSync('missing-target', join(cwd, target));
      if (isSparse) git('update-index', '--skip-worktree', '--', target);
    }
    for (let attempt = 0; attempt < (state.includes('second Continue') ? 2 : 1); attempt += 1) {
      const paths = [target, 'src/x'].sort(); const index = fs.readFileSync(join(gitDir, 'index'));
      const shared = fs.readdirSync(gitDir).filter((name) => name.startsWith('sharedindex.'));
      const reviewed = subject(paths); expect(subject()).toEqual(reviewed);
      expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index);
      expect(fs.readdirSync(gitDir).filter((name) => name.startsWith('sharedindex.'))).toEqual(shared);
      if (!isSparse) {
        for (const selected of [paths, []]) expect(legacyDiff(selected)).toEqual(reviewed);
      }
      expect(await snapshotHarnessStageSubject(cwd)).toBe(legacyHash(false));
      expect(await snapshotHarnessReviewSubject(cwd)).toBe(legacyHash(true));
      expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index);
      expect(fs.readdirSync(gitDir).filter((name) => name.startsWith('sharedindex.'))).toEqual(shared);
      expect(resetIndexToHead(cwd)).toBeUndefined();
      expect(discover()).toEqual(paths);
      for (const selected of [paths, []]) expect(await harnessDiff(cwd, selected, join(root, 'driver-index'))).toEqual(reviewed);
      expect(stage(captured, paths)).toMatchObject({ status: 'ready', stagedPaths: paths });
      expect(cached(), 'subject == staged handoff bytes').toEqual(reviewed);
      if (isSparse) {
        expect(git('ls-files', '-v', 'outside/absent')).toBe('S outside/absent\n');
        expect(git('diff', '--cached', '--diff-filter=D', '--', 'outside')).toBe('');
      }
      if (state.includes('second Continue')) write(target, 'second Continue edit\n');
    }
    expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('reflog', 'show', 'HEAD')).toBe(reflog);
  }, 30_000);

  // Reference the fresh-index algorithm shipped at 569ea14c.
  function legacyDiff(paths: string[]): Buffer {
    const indexPath = join(root, 'legacy-index');
    const env = { ...process.env, ...pinnedGitEnv(cwd), GIT_INDEX_FILE: indexPath };
    const oldGit = (args: string[]) => execFileSync(realGit, ['-c', 'core.splitIndex=false', ...args], { cwd, env });
    try {
      oldGit(['read-tree', 'HEAD']); oldGit(['add', '-A', ...(paths.length ? ['--', ...paths.map((p) => `:(literal)${p}`)] : [])]);
      return oldGit(['diff', '--cached', '--no-ext-diff', '--binary', 'HEAD']);
    } finally { fs.rmSync(indexPath, { force: true }); }
  }
  // Independent copy of 569ea14c's status/content digest; hashes exclude index choreography.
  function legacyHash(review: boolean): string {
    const hash = createHash('sha256'); const indexPath = join(root, 'legacy-hash-index');
    const env = { ...process.env, ...pinnedGitEnv(cwd), GIT_INDEX_FILE: indexPath, GIT_OPTIONAL_LOCKS: '0' };
    const oldGit = (...args: string[]) => execFileSync(realGit, ['-c', 'core.splitIndex=false', ...args], { cwd, env });
    hash.update('\0head\0'); hash.update(oldGit('rev-parse', 'HEAD'));
    try {
      const source = join(gitDir, 'index'); const { atime, mtime } = fs.statSync(source);
      fs.copyFileSync(source, indexPath); fs.utimesSync(indexPath, atime, mtime);
      oldGit('read-tree', '--reset', 'HEAD');
      let sparse = false;
      try { sparse = oldGit('config', '--bool', 'core.sparseCheckout').toString().trim() === 'true'; } catch { /* unset */ }
      const entries = oldGit('ls-files', '-v', '-z').toString().split('\0').filter(Boolean);
      for (const entry of entries) {
        if (/^[a-z] /.test(entry)) oldGit('update-index', '--no-assume-unchanged', '--', entry.slice(2));
        if (/^[Ss] /.test(entry)) {
          let present = false; try { fs.lstatSync(join(cwd, entry.slice(2))); present = true; } catch { /* absent */ }
          if (!sparse || present) oldGit('update-index', '--no-skip-worktree', '--', entry.slice(2));
        }
      }
      const paths = oldGit('status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames').toString().split('\0').filter(Boolean).map((e) => e.slice(3)).sort();
      for (const path of paths) {
        hash.update('\0'); hash.update(path); hash.update('\0');
        try {
          const entry = readHarnessFsEntry(join(cwd, path));
          if (entry.kind === 'symlink') hash.update(`symlink:${entry.target}`);
          else if (entry.kind === 'file') { hash.update(`file:${entry.stat.mode & 0o111 ? 'executable' : 'regular'}\0`); hash.update(entry.content!); }
          else hash.update(`mode:${entry.stat.mode}`);
        } catch { hash.update('absent'); }
      }
      if (review) { hash.update('\0head-reflog\0'); hash.update(oldGit('reflog', 'show', 'HEAD', '--format=%H%x09%gs')); }
      return hash.digest('hex');
    } finally { fs.rmSync(indexPath, { force: true }); }
  }

  it.each([false, true])('[r8-sparse-delete] git rm --sparse stages exactly the reviewed deletion (visible=%s)', async (visible) => {
    sparse(); const captured = start(); git('rm', '--sparse', 'outside/edit');
    if (visible) write('src/a.txt', 'visible edit\n');
    const paths = ['outside/edit', ...(visible ? ['src/a.txt'] : [])];
    const reviewed = subject(paths);
    expect(subject()).toEqual(reviewed);
    expect(reviewed.toString()).toContain('deleted file mode');
    expect(reviewed.toString()).toContain('outside/edit');
    expect(resetIndexToHead(cwd)).toBeUndefined();
    expect(await harnessDiff(cwd, paths, join(root, 'driver-index'))).toEqual(reviewed);
    const result = stage(captured, paths);
    expect(result).toMatchObject({ status: 'ready', stagedPaths: paths });
    expect(cached()).toEqual(reviewed); expect(git('ls-files', '-v', 'outside/edit')).toBe('');
  });

  it('[r8-sparse-absent] exact absent skip-worktree allowlist entries warn without deleting', async () => {
    sparse(); const captured = start(); write('src/a.txt', 'visible edit\n');
    const paths = ['outside/absent', 'src/a.txt']; const reviewed = subject(paths);
    expect(reviewed.toString()).not.toContain('outside/absent');
    expect(await harnessDiff(cwd, paths, join(root, 'driver-index'))).toEqual(reviewed);
    resetIndexToHead(cwd); const result = stage(captured, paths);
    expect(result).toMatchObject({ status: 'ready', stagedPaths: ['src/a.txt'] });
    expect(result.warnings.join('\n')).toContain('git sparse-checkout add');
    expect(result.warnings.join('\n')).toContain('outside/absent');
    expect(cached()).toEqual(reviewed);
  });

  it('[r8-sparse-delete] absent entries and directory scopes never delete out-of-cone files', async () => {
    sparse(); const captured = start(); write('src/a.txt', 'visible edit\n');
    const paths = ['outside', 'src/a.txt']; const reviewed = subject(paths);
    expect(await harnessDiff(cwd, paths, join(root, 'driver-index'))).toEqual(reviewed);
    resetIndexToHead(cwd);
    expect(stage(captured, paths)).toMatchObject({ status: 'ready', stagedPaths: ['src/a.txt'] });
    expect(cached()).toEqual(reviewed); expect(git('diff', '--cached', '--diff-filter=D')).toBe('');
    expect(git('ls-files', '-v', 'outside/absent')).toBe('S outside/absent\n');
  });

  it('[r8-spaces] real subject and stage preserve leading and trailing spaces', () => {
    const captured = start(); const paths = [' leading', 'trailing '];
    for (const path of paths) write(path, `content: ${path}\n`);
    const reviewed = subject(paths);
    for (const path of paths) expect(reviewed.toString()).toContain(`content: ${path}`);
    expect(stage(captured, paths)).toMatchObject({ status: 'ready', stagedPaths: paths });
    expect(cached()).toEqual(reviewed);
  });

  it('guard: [r8-spaces] CRLF and blank lines work in stage and review paths files', () => {
    const captured = start(); write('src/a.txt', 'visible edit\n');
    const pathsFile = join(root, 'paths'); fs.writeFileSync(pathsFile, '\r\nsrc/a.txt\r\n\r\n');
    reviewSubjectSha('--paths-file', pathsFile);
    const reviewed = fs.readFileSync(join(root, 'subject.diff'));
    expect(runtime('stage', '--start-state', captured, '--paths-file', pathsFile)).toMatchObject({ status: 'ready', stagedPaths: ['src/a.txt'] });
    expect(cached()).toEqual(reviewed);
  });

  it('guard: [r8-subject-arms] artifacts and explicit diff ranges retain precedence and bytes', () => {
    write('src/a.txt', 'visible edit\n'); const artifact = join(root, 'artifact.md'); fs.writeFileSync(artifact, 'artifact subject\n');
    expect(reviewSubjectSha('--artifact', artifact, '--paths-file', 'missing', '--diff-range', 'bad-ref')).toBe(digest('artifact subject\n'));
    expect(reviewSubjectSha('--diff-range', 'HEAD')).toBe(digest(git('diff', '--no-ext-diff', 'HEAD')));
    fs.writeFileSync(join(root, 'empty-paths'), '\n\r\n');
    expect(() => reviewSubjectSha('--paths-file', join(root, 'empty-paths'))).toThrow(/Review allowlist is empty/);
  });

  it('[r8-index-copy] a missing sparse index fails closed instead of inventing deletions', async () => {
    sparse(); write('src/a.txt', 'visible edit\n'); fs.rmSync(join(gitDir, 'index'));
    for (const scope of [[], ['src/a.txt']]) {
      await expect(harnessDiff(cwd, scope, join(root, 'private-index'))).rejects.toThrow(/ENOENT/);
      expect(fs.existsSync(join(root, 'private-index'))).toBe(false);
    }
    expect(() => subject(['src/a.txt'])).toThrow(/ENOENT/);
    expect(fs.readFileSync(join(cwd, 'src/a.txt'), 'utf8')).toBe('visible edit\n');
  });

  it('guard: [r8-index-copy] full worktrees retain the missing-index fallback', async () => {
    write('src/a.txt', 'visible edit\n'); const expected = legacyDiff(['src/a.txt']); fs.rmSync(join(gitDir, 'index'));
    for (const scope of [[], ['src/a.txt']]) expect(await harnessDiff(cwd, scope, join(root, 'private-index'))).toEqual(expected);
  });

  it('guard: [r8-empty] ghost-only driver subjects stay empty and clean up private indexes', async () => {
    for (const mode of ['full', 'sparse']) {
      if (mode === 'sparse') sparse();
      expect(await harnessDiff(cwd, ['missing'], join(root, 'private-index'))).toEqual(Buffer.alloc(0));
      expect(fs.existsSync(join(root, 'private-index'))).toBe(false);
    }
  });

  it('guard: [r8-empty-sparse] absent-only sparse scopes refuse an empty handoff without index changes', () => {
    sparse(); const captured = start(); const index = fs.readFileSync(join(gitDir, 'index'));
    expect(() => subject(['outside/absent'])).toThrow();
    expect(() => stage(captured, ['outside/absent'])).toThrow();
    expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index); expect(cached()).toEqual(Buffer.alloc(0));
  });

  it('guard: [r8-reset] a non-pinned cwd returns without touching the enclosing index', () => {
    const index = fs.readFileSync(join(gitDir, 'index')); const subdir = join(cwd, 'src');
    expect(resetIndexToHead(subdir)).toBeUndefined(); expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index);
  });

  it('guard: [r8-nonsparse] subject bytes and hashes retain the 569ea14c fresh-index contract', async () => {
    write('src/a.txt', 'visible edit\n'); write('src/new', 'new\n');
    for (const scope of [['src/a.txt', 'src/new'], []]) expect(subject(scope.length ? scope : undefined)).toEqual(legacyDiff(scope));
    expect(await snapshotHarnessStageSubject(cwd)).toBe(legacyHash(false));
    expect(await snapshotHarnessReviewSubject(cwd)).toBe(legacyHash(true));
  });
});
