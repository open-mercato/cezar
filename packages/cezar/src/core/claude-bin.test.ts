import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveClaudeBin } from './claude-bin.ts';

function writeExecutable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho 2.1.0\n');
  chmodSync(path, 0o755);
}

describe.skipIf(process.platform === 'win32')('resolveClaudeBin', () => {
  let root: string;
  let home: string;
  let pathDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-claude-bin-'));
    home = join(root, 'home');
    pathDir = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(pathDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds a native-installer ~/.local/bin/claude that is not on PATH', () => {
    const native = join(home, '.local', 'bin', 'claude');
    writeExecutable(native);
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'darwin')).toBe(native);
  });

  it('finds a legacy ~/.claude/local/claude install', () => {
    const local = join(home, '.claude', 'local', 'claude');
    writeExecutable(local);
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'linux')).toBe(local);
  });

  it('prefers `claude` on PATH over the known locations', () => {
    writeExecutable(join(pathDir, 'claude'));
    writeExecutable(join(home, '.local', 'bin', 'claude'));
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'darwin')).toBe('claude');
  });

  it('CEZ_CLAUDE_BIN wins over everything', () => {
    writeExecutable(join(pathDir, 'claude'));
    expect(resolveClaudeBin({ PATH: pathDir, CEZ_CLAUDE_BIN: '/opt/x/claude' }, home, 'darwin')).toBe('/opt/x/claude');
  });

  it('ignores a non-executable file at a known location', () => {
    const native = join(home, '.local', 'bin', 'claude');
    writeExecutable(native);
    chmodSync(native, 0o644);
    // Only the home-relative candidates are under test control; the fixed system paths are
    // absent on CI, so anything but the native path proves the non-executable file was skipped.
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'darwin')).not.toBe(native);
  });
});
