import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readHarnessFsEntry, readRegularFileFollowing } from './fs-read.js';

// CodeQL js/file-system-race on every model-reachable read goes through one descriptor.
describe('readHarnessFsEntry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-fs-read-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a regular file with its stat', () => {
    writeFileSync(join(dir, 'a.json'), '{"ok":true}');
    const entry = readHarnessFsEntry(join(dir, 'a.json'));
    expect(entry.kind).toBe('file');
    if (entry.kind !== 'file') return;
    expect(entry.content?.toString('utf8')).toBe('{"ok":true}');
    expect(entry.stat.size).toBe(11);
  });

  it('reports a symlink without reading what it points at', () => {
    writeFileSync(join(dir, 'secret'), 'token');
    symlinkSync(join(dir, 'secret'), join(dir, 'result.json'));
    expect(readHarnessFsEntry(join(dir, 'result.json'))).toEqual({
      kind: 'symlink',
      target: join(dir, 'secret'),
    });
  });

  it('withholds the bytes of a file over the limit', () => {
    writeFileSync(join(dir, 'big'), 'x'.repeat(64));
    const entry = readHarnessFsEntry(join(dir, 'big'), 16);
    expect(entry.kind).toBe('file');
    if (entry.kind !== 'file') return;
    expect(entry.content).toBeNull();
    expect(entry.stat.size).toBe(64);
  });

  it('reports a directory as another kind of entry', () => {
    mkdirSync(join(dir, 'sub'));
    const entry = readHarnessFsEntry(join(dir, 'sub'));
    expect(entry.kind).toBe('other');
    if (entry.kind === 'other') expect(entry.stat.isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('never blocks on a FIFO', () => {
    const fifo = join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const entry = readHarnessFsEntry(fifo);
    expect(entry.kind).toBe('other');
    if (entry.kind === 'other') expect(entry.stat.isFIFO()).toBe(true);
  });

  it('throws ENOENT for a missing path', () => {
    expect(() => readHarnessFsEntry(join(dir, 'missing'))).toThrow(/ENOENT/);
  });
});

describe('readRegularFileFollowing', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-fs-follow-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('follows a symlink to a regular file and refuses anything else', () => {
    writeFileSync(join(dir, 'target.mjs'), 'export {}');
    symlinkSync(join(dir, 'target.mjs'), join(dir, 'link.mjs'));
    mkdirSync(join(dir, 'sub'));
    expect(readRegularFileFollowing(join(dir, 'link.mjs'))?.toString('utf8')).toBe('export {}');
    expect(readRegularFileFollowing(join(dir, 'sub'))).toBeNull();
  });
});
