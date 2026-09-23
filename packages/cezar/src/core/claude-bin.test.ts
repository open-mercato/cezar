import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeInstallCandidates, claudeShellCommand, resolveClaudeBin } from './claude-bin.ts';

function writeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho 2.1.0\n');
  chmodSync(path, 0o755);
}

describe.skipIf(process.platform === 'win32')('resolveClaudeBin', () => {
  let root: string;
  let home: string;
  let pathDir: string;
  let nodeBinDir: string;
  /** Every candidate under this test's control, so no assertion can be satisfied — or defeated —
   *  by a claude the developer happens to have at `/opt/homebrew/bin` or `/usr/local/bin`. */
  let candidates: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-claude-bin-'));
    home = join(root, 'home');
    pathDir = join(root, 'bin');
    nodeBinDir = join(root, 'node-bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(pathDir, { recursive: true });
    mkdirSync(nodeBinDir, { recursive: true });
    candidates = claudeInstallCandidates(home, 'darwin', nodeBinDir)
      .filter((candidate) => candidate.startsWith(root));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds a native-installer ~/.local/bin/claude that is not on PATH', () => {
    const native = join(home, '.local', 'bin', 'claude');
    writeExecutable(native);
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'darwin', candidates)).toBe(native);
  });

  it('finds a legacy ~/.claude/local/claude install', () => {
    const local = join(home, '.claude', 'local', 'claude');
    writeExecutable(local);
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'linux', candidates)).toBe(local);
  });

  it('finds an `npm install -g` claude next to the running node — what cezar\'s own installer uses', () => {
    const npmGlobal = join(nodeBinDir, 'claude');
    writeExecutable(npmGlobal);
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'darwin', candidates)).toBe(npmGlobal);
  });

  it('prefers `claude` on PATH over the known locations', () => {
    writeExecutable(join(pathDir, 'claude'));
    writeExecutable(join(home, '.local', 'bin', 'claude'));
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'darwin', candidates)).toBe('claude');
  });

  it('prefers the native installer over the npm global when both exist', () => {
    const native = join(home, '.local', 'bin', 'claude');
    writeExecutable(native);
    writeExecutable(join(nodeBinDir, 'claude'));
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'darwin', candidates)).toBe(native);
  });

  it('CEZ_CLAUDE_BIN wins over everything', () => {
    writeExecutable(join(pathDir, 'claude'));
    expect(resolveClaudeBin({ PATH: pathDir, CEZ_CLAUDE_BIN: '/opt/x/claude' }, home, 'darwin', candidates))
      .toBe('/opt/x/claude');
  });

  it('treats an empty CEZ_CLAUDE_BIN as unset rather than as an empty binary name', () => {
    const native = join(home, '.local', 'bin', 'claude');
    writeExecutable(native);
    expect(resolveClaudeBin({ PATH: pathDir, CEZ_CLAUDE_BIN: '' }, home, 'darwin', candidates)).toBe(native);
  });

  it('ignores a non-executable file at a known location', () => {
    const native = join(home, '.local', 'bin', 'claude');
    writeExecutable(native);
    chmodSync(native, 0o644);
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'darwin', candidates)).toBe('claude');
  });

  it('falls back to a bare `claude` when nothing is installed anywhere', () => {
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'darwin', candidates)).toBe('claude');
  });

  it('ignores a DIRECTORY named claude, on PATH and at a known location alike', () => {
    // Every directory carries the execute bit, so `X_OK` alone accepts a folder — and the spawn
    // then dies with EACCES instead of the "not found" plus install hint the fallback exists for.
    mkdirSync(join(pathDir, 'claude'), { recursive: true });
    mkdirSync(join(home, '.local', 'bin', 'claude'), { recursive: true });
    const npmGlobal = join(nodeBinDir, 'claude');
    writeExecutable(npmGlobal);
    expect(resolveClaudeBin({ PATH: pathDir }, home, 'darwin', candidates)).toBe(npmGlobal);
  });

  it('searches every PATH entry, split by the separator of the platform it was asked about', () => {
    const second = join(root, 'bin2');
    writeExecutable(join(second, 'claude'));
    expect(resolveClaudeBin({ PATH: `${pathDir}:${second}` }, home, 'linux', candidates)).toBe('claude');
  });

  it('ignores empty PATH entries instead of probing the working directory', () => {
    writeExecutable(join(home, '.local', 'bin', 'claude'));
    // A trailing/doubled `:` means "the cwd" to some shells; we must not honour that.
    expect(resolveClaudeBin({ PATH: `${pathDir}::` }, home, 'darwin', candidates))
      .toBe(join(home, '.local', 'bin', 'claude'));
  });
});

describe('claudeInstallCandidates', () => {
  it('covers the native installer, the legacy local install, npm global, and Homebrew on posix', () => {
    expect(claudeInstallCandidates('/home/u', 'linux', '/nvm/v22/bin')).toEqual([
      '/home/u/.local/bin/claude',
      '/home/u/.claude/local/claude',
      '/nvm/v22/bin/claude',
      '/home/u/.npm-global/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ]);
  });

  it('offers the .cmd shim on win32, because that is what `npm install -g` writes there', () => {
    // `join` renders with the HOST's separator, so build the expectation the same way rather
    // than hard-coding backslashes that only appear when the suite runs on Windows.
    const nodeBinDir = join('C:', 'Program Files', 'nodejs');
    expect(claudeInstallCandidates(join('C:', 'Users', 'u'), 'win32', nodeBinDir))
      .toContain(join(nodeBinDir, 'claude.cmd'));
  });
});

describe.skipIf(process.platform === 'win32')('claudeShellCommand', () => {
  // Empty candidates, so a claude the developer really has at `/opt/homebrew/bin` cannot decide
  // the outcome — the same hermeticity the `resolveClaudeBin` block above buys with a temp dir.
  const NONE: string[] = [];

  it('is null when only a bare `claude` is known, so callers keep their own PATH fallback', () => {
    expect(claudeShellCommand({ PATH: '' }, '/nonexistent-home', 'linux', NONE)).toBeNull();
  });

  it('is the resolved path when one was found off PATH', () => {
    expect(claudeShellCommand({ PATH: '', CEZ_CLAUDE_BIN: '/opt/x/claude' }, '/nonexistent-home', 'linux', NONE))
      .toBe('/opt/x/claude');
  });

  it('is null when claude is on PATH — the caller already has a working bare command there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-claude-shell-'));
    try {
      writeExecutable(join(dir, 'claude'));
      expect(claudeShellCommand({ PATH: dir }, '/nonexistent-home', 'linux', NONE)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
