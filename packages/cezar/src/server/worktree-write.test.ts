import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fileHash, readWorktreePath } from './git-changes.ts';
import {
  createWorktreeFile,
  deleteWorktreeFile,
  editRefusal,
  recordEditBlob,
  renameWorktreeFile,
  replaceFile,
  writeWorktreeFile,
} from './worktree-write.ts';

/** The write primitive behind `PUT /runs/:id/files` (spec `2026-07-20-worktree-file-editing`),
 *  against a temp directory — no server, so each refusal is asserted at its source. */
describe('writeWorktreeFile', () => {
  let dir: string;
  const hashOf = (rel: string) => fileHash(readFileSync(join(dir, rel)));
  const read = (rel: string) => readFileSync(join(dir, rel), 'utf8');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-write-'));
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('overwrites the file and answers the new hash, leaving no tmp file behind', async () => {
    const res = await writeWorktreeFile(dir, 'src/a.ts', 'export const a = 2\n', hashOf('src/a.ts'));
    expect(res).toEqual({ ok: true, path: 'src/a.ts', size: 19, hash: hashOf('src/a.ts') });
    expect(read('src/a.ts')).toBe('export const a = 2\n');
    expect(readdirSync(join(dir, 'src'))).toEqual(['a.ts']);
  });

  it('writes the bytes verbatim — CRLF and a missing trailing newline survive', async () => {
    writeFileSync(join(dir, 'crlf.txt'), 'one\r\ntwo');
    const res = await writeWorktreeFile(dir, 'crlf.txt', 'one\r\nTWO', hashOf('crlf.txt'));
    expect(res.ok).toBe(true);
    expect(readFileSync(join(dir, 'crlf.txt'))).toEqual(Buffer.from('one\r\nTWO'));
  });

  it('allows empty content — truncating a file is a legitimate edit', async () => {
    expect((await writeWorktreeFile(dir, 'src/a.ts', '', hashOf('src/a.ts'))).ok).toBe(true);
    expect(read('src/a.ts')).toBe('');
  });

  it('refuses a stale base as a conflict and leaves the file alone', async () => {
    const stale = hashOf('src/a.ts');
    writeFileSync(join(dir, 'src', 'a.ts'), 'the agent got here first\n');
    const res = await writeWorktreeFile(dir, 'src/a.ts', 'mine\n', stale);
    expect(res).toMatchObject({ ok: false, kind: 'conflict' });
    expect(read('src/a.ts')).toBe('the agent got here first\n');
    expect(readdirSync(join(dir, 'src'))).toEqual(['a.ts']);
  });

  it('cannot create a file — a missing path is refused, not written', async () => {
    const res = await writeWorktreeFile(dir, 'src/new.ts', 'x', fileHash(Buffer.alloc(0)));
    expect(res).toMatchObject({ ok: false, kind: 'refused' });
    expect(existsSync(join(dir, 'src', 'new.ts'))).toBe(false);
  });

  it.each([
    ['a traversal', '../outside.txt'],
    ['the root .git', '.git/config'],
    ['a directory', 'src'],
  ])('refuses %s', async (_label, rel) => {
    writeFileSync(join(dir, '.git', 'config'), '[core]\n');
    expect(await writeWorktreeFile(dir, rel, 'x', 'sha256:0')).toMatchObject({ ok: false, kind: 'refused' });
  });

  // The rule that exists only for the write. `readWorktreePath` SERVES these paths — asserted
  // here too, so the test says why the deny rule is not redundant.
  it.each([
    'sub/.git/config',
    'sub/.git/hooks/pre-commit',
    'node_modules/pkg/index.js',
    'packages/web/node_modules/pkg/index.js',
  ])('refuses %s, which the read route serves', async (rel) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), 'original\n');
    const served = await readWorktreePath(dir, rel);
    expect(served).toMatchObject({ kind: 'file', content: 'original\n' });
    if (served.kind === 'file') expect(editRefusal(served)).not.toBeNull();

    expect(await writeWorktreeFile(dir, rel, 'pwned\n', hashOf(rel))).toMatchObject({ ok: false, kind: 'refused' });
    expect(read(rel)).toBe('original\n');
  });

  it('matches the denied directories the way a case-insensitive filesystem does', async () => {
    mkdirSync(join(dir, 'sub', '.GIT'), { recursive: true });
    writeFileSync(join(dir, 'sub', '.GIT', 'config'), 'original\n');
    const rel = 'sub/.GIT/config';
    expect(await writeWorktreeFile(dir, rel, 'pwned\n', hashOf(rel))).toMatchObject({ ok: false, kind: 'refused' });
    expect(read(rel)).toBe('original\n');
  });

  it('refuses binary, non-UTF-8 and over-cap targets', async () => {
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    writeFileSync(join(dir, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in latin-1
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(64));
    expect(await writeWorktreeFile(dir, 'bin.dat', 'x', 'sha256:0')).toMatchObject({ kind: 'refused' });
    expect(await writeWorktreeFile(dir, 'latin1.txt', 'cafe', hashOf('latin1.txt'))).toMatchObject({ kind: 'refused' });
    expect(readFileSync(join(dir, 'latin1.txt'))).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await writeWorktreeFile(dir, 'big.txt', 'x', hashOf('big.txt'), 32)).toMatchObject({ kind: 'refused' });
  });

  it('refuses content that grew past the cap, and content with no UTF-8 encoding', async () => {
    const base = hashOf('src/a.ts');
    expect(await writeWorktreeFile(dir, 'src/a.ts', 'x'.repeat(64), base, 32)).toMatchObject({ kind: 'refused' });
    expect(await writeWorktreeFile(dir, 'src/a.ts', 'lone \ud800 surrogate', base)).toMatchObject({ kind: 'refused' });
    expect(read('src/a.ts')).toBe('export const a = 1\n');
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink and keeps the executable bit', async () => {
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(dir, 'run.sh'), 0o755);
    symlinkSync(join(dir, 'run.sh'), join(dir, 'link.sh'));
    expect(await writeWorktreeFile(dir, 'link.sh', 'x', hashOf('run.sh'))).toMatchObject({ kind: 'refused' });

    expect((await writeWorktreeFile(dir, 'run.sh', '#!/bin/sh\necho hi\n', hashOf('run.sh'))).ok).toBe(true);
    expect(statSync(join(dir, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  // The property the atomic write buys: a target swapped for a link after resolution is REPLACED,
  // not followed. A future switch to a plain `writeFile(target)` must fail here.
  it.skipIf(process.platform === 'win32')('replaces a symlink rather than writing through it', async () => {
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'untouched\n');
    symlinkSync(outside, join(dir, 'target.txt'));
    writeFileSync(join(dir, 'tmp.txt'), 'new\n');
    await replaceFile(join(dir, 'tmp.txt'), join(dir, 'target.txt'));
    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
    expect(read('target.txt')).toBe('new\n');
  });
});

describe('create, delete and rename', () => {
  let dir: string;
  const read = (rel: string) => readFileSync(join(dir, rel), 'utf8');
  const there = (rel: string) => existsSync(join(dir, rel));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-fileops-'));
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a file, and the directories its path names', async () => {
    const res = await createWorktreeFile(dir, 'src/deep/er/new.ts', 'hello\n');
    expect(res).toEqual({ ok: true, path: 'src/deep/er/new.ts', size: 6, hash: fileHash(Buffer.from('hello\n')) });
    expect(read('src/deep/er/new.ts')).toBe('hello\n');
  });

  it('never overwrites: creating over an existing file is refused and leaves it alone', async () => {
    expect(await createWorktreeFile(dir, 'src/a.ts', 'clobbered\n')).toMatchObject({ ok: false, kind: 'refused' });
    expect(read('src/a.ts')).toBe('export const a = 1\n');
  });

  // The destination does not exist, so nothing on disk can be inspected for it — every refusal
  // here comes from the path as written, and must leave no file (and no directory) behind.
  it.each([
    ['a traversal', '../outside.txt'],
    ['the root .git', '.git/hooks/pre-commit'],
    ['a nested .git', 'vendor/lib/.git/hooks/pre-commit'],
    ['node_modules', 'node_modules/evil/index.js'],
    ['a nested node_modules', 'packages/web/node_modules/evil/index.js'],
    ['a case-folded .git', 'vendor/.GIT/config'],
    ['a path under a file', 'src/a.ts/child.ts'],
  ])('refuses to create under %s', async (_label, rel) => {
    expect(await createWorktreeFile(dir, rel, 'x')).toMatchObject({ ok: false, kind: 'refused' });
    expect(there(rel.split('/')[0] === '..' ? rel : rel)).toBe(false);
    expect(there('vendor')).toBe(false);
    expect(there('node_modules')).toBe(false);
    expect(there('packages')).toBe(false);
    expect(existsSync(join(dir, '..', 'outside.txt'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('refuses an NTFS stream spelling of .git', async () => {
    mkdirSync(join(dir, 'sub', '.git'), { recursive: true });
    writeFileSync(join(dir, 'sub', '.git', 'config'), 'original\n');
    const rel = 'sub/.git::$INDEX_ALLOCATION/config';
    expect(await createWorktreeFile(dir, rel, 'x')).toMatchObject({ ok: false, kind: 'refused' });
    expect(await writeWorktreeFile(dir, rel, 'x', 'sha256:0')).toMatchObject({ ok: false });
    expect(read('sub/.git/config')).toBe('original\n');
  });

  it.skipIf(process.platform === 'win32')('refuses to create through a symlinked directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cez-outside-'));
    symlinkSync(outside, join(dir, 'link'));
    expect(await createWorktreeFile(dir, 'link/new.txt', 'x')).toMatchObject({ ok: false, kind: 'refused' });
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('deletes a file and keeps its bytes as a git object first', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const res = await deleteWorktreeFile(dir, 'src/a.ts');
    expect(res).toMatchObject({ ok: true, path: 'src/a.ts' });
    expect(there('src/a.ts')).toBe(false);
    if (res.ok) {
      expect(execFileSync('git', ['cat-file', '-p', res.blob as string], { cwd: dir, encoding: 'utf8' })).toBe(
        'export const a = 1\n',
      );
    }
  });

  it('deletes a binary file too — removing one does not decode it', async () => {
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    expect(await deleteWorktreeFile(dir, 'bin.dat')).toMatchObject({ ok: true, path: 'bin.dat' });
    expect(there('bin.dat')).toBe(false);
  });

  it('refuses to delete a directory, a missing path, or anything git or the toolchain executes', async () => {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x\n');
    mkdirSync(join(dir, 'sub', '.git'), { recursive: true });
    writeFileSync(join(dir, 'sub', '.git', 'config'), 'x\n');
    for (const rel of ['src', 'nope.txt', 'node_modules/pkg/index.js', 'sub/.git/config', '../outside.txt']) {
      expect(await deleteWorktreeFile(dir, rel)).toMatchObject({ ok: false, kind: 'refused' });
    }
    expect(there('src/a.ts')).toBe(true);
    expect(there('node_modules/pkg/index.js')).toBe(true);
    expect(there('sub/.git/config')).toBe(true);
  });

  it('renames a file into a directory that does not exist yet', async () => {
    expect(await renameWorktreeFile(dir, 'src/a.ts', 'lib/core/a.ts')).toEqual({ ok: true, from: 'src/a.ts', to: 'lib/core/a.ts' });
    expect(there('src/a.ts')).toBe(false);
    expect(read('lib/core/a.ts')).toBe('export const a = 1\n');
  });

  it('never renames over an existing file, out of the worktree, or into an executed directory', async () => {
    writeFileSync(join(dir, 'src', 'b.ts'), 'b\n');
    for (const to of ['src/b.ts', '../a.ts', '.git/hooks/pre-commit', 'node_modules/a.ts', 'sub/.git/hooks/post-checkout']) {
      expect(await renameWorktreeFile(dir, 'src/a.ts', to)).toMatchObject({ ok: false, kind: 'refused' });
    }
    expect(read('src/a.ts')).toBe('export const a = 1\n');
    expect(read('src/b.ts')).toBe('b\n');
    expect(there('sub')).toBe(false);
  });

  it('refuses to rename a directory or a file out of node_modules', async () => {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x\n');
    expect(await renameWorktreeFile(dir, 'src', 'source')).toMatchObject({ ok: false, kind: 'refused' });
    expect(await renameWorktreeFile(dir, 'node_modules/pkg/index.js', 'stolen.js')).toMatchObject({ ok: false, kind: 'refused' });
    expect(there('src/a.ts')).toBe(true);
    expect(there('stolen.js')).toBe(false);
  });
});

describe('recordEditBlob', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-blob-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores the exact bytes as a git object without touching the index', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const bytes = Buffer.from('line one\r\nline two');
    const blob = await recordEditBlob(dir, bytes);
    expect(blob).toMatch(/^[0-9a-f]{40,64}$/);
    expect(execFileSync('git', ['cat-file', '-p', blob as string], { cwd: dir })).toEqual(bytes);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })).toBe('');
  });

  it('answers null outside a repository instead of failing the save', async () => {
    expect(await recordEditBlob(dir, Buffer.from('x'))).toBeNull();
  });
});
