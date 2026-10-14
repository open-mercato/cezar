import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  escapeCmdArg,
  findOpencodeOnPath,
  opencodeInstallCandidates,
  prepareOpencodeCommand,
  resolveOpencodeBin,
  unwrapOpencodeShim,
  execOpencode,
} from './opencode-bin.ts';

describe('opencode-bin resolution and execution', () => {
  let root: string;
  let home: string;
  let binDir: string;
  let nodeBinDir: string;
  let appDataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-opencode-bin-'));
    home = join(root, 'home');
    binDir = join(root, 'bin');
    nodeBinDir = join(root, 'node-bin');
    appDataDir = join(root, 'appdata');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(nodeBinDir, { recursive: true });
    mkdirSync(appDataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('unwrapOpencodeShim', () => {
    it('unwraps Windows npm shim when node_modules/opencode-ai/bin/opencode.exe exists', () => {
      const shim = join(binDir, 'opencode.cmd');
      const targetExe = join(binDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      mkdirSync(dirname(targetExe), { recursive: true });
      writeFileSync(targetExe, 'binary content');
      writeFileSync(shim, `@ECHO off\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*\r\n`);

      expect(unwrapOpencodeShim(shim)).toBe(targetExe);
    });

    it('unwraps sibling opencode.exe if present', () => {
      const shim = join(binDir, 'opencode.cmd');
      const targetExe = join(binDir, 'opencode.exe');
      writeFileSync(targetExe, 'binary content');
      writeFileSync(shim, `@ECHO off\r\n"%~dp0\\opencode.exe" %*\r\n`);

      expect(unwrapOpencodeShim(shim)).toBe(targetExe);
    });

    it('returns null if no underlying .exe exists', () => {
      const shim = join(binDir, 'opencode.cmd');
      writeFileSync(shim, `@ECHO off\r\necho fallback\r\n`);

      expect(unwrapOpencodeShim(shim)).toBeNull();
    });
  });

  describe('resolveOpencodeBin on Windows', () => {
    it('resolves direct opencode.exe on PATH', () => {
      const exe = join(binDir, 'opencode.exe');
      writeFileSync(exe, 'bin');

      const resolved = resolveOpencodeBin(
        undefined,
        {},
        'win32',
        binDir,
      );
      expect(resolved).toBe(exe);
    });

    it('resolves npm opencode.cmd on PATH and unwraps to underlying opencode.exe', () => {
      const shim = join(binDir, 'opencode.cmd');
      const exe = join(binDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      mkdirSync(dirname(exe), { recursive: true });
      writeFileSync(exe, 'bin');
      writeFileSync(shim, `@ECHO off\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*\r\n`);

      const resolved = resolveOpencodeBin(
        undefined,
        {},
        'win32',
        binDir,
      );
      expect(resolved).toBe(exe);
    });

    it('resolves standalone opencode.cmd on PATH when no .exe is available', () => {
      const shim = join(binDir, 'opencode.cmd');
      writeFileSync(shim, `@ECHO off\r\necho standalone\r\n`);

      const resolved = resolveOpencodeBin(
        undefined,
        {},
        'win32',
        binDir,
      );
      expect(resolved).toBe(shim);
    });

    it('resolves opencode.ps1 on PATH', () => {
      const psShim = join(binDir, 'opencode.ps1');
      writeFileSync(psShim, `& opencode.exe $args`);

      const resolved = resolveOpencodeBin(
        undefined,
        {},
        'win32',
        binDir,
      );
      expect(resolved).toBe(psShim);
    });

    it('resolves from installer candidate directory when missing from PATH', () => {
      const candidateExe = join(appDataDir, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      mkdirSync(dirname(candidateExe), { recursive: true });
      writeFileSync(candidateExe, 'bin');

      const candidates = [candidateExe];
      const resolved = resolveOpencodeBin(
        undefined,
        {},
        'win32',
        binDir, // binDir has no opencode
        candidates,
      );
      expect(resolved).toBe(candidateExe);
    });

    it('falls back to bare opencode when missing from PATH and candidates', () => {
      const resolved = resolveOpencodeBin(
        undefined,
        {},
        'win32',
        binDir,
        [],
      );
      expect(resolved).toBe('opencode');
    });

    it('honors CEZ_OPENCODE_BIN override and unwraps shim if possible', () => {
      const customDir = join(root, 'custom');
      mkdirSync(customDir, { recursive: true });
      const shim = join(customDir, 'opencode.cmd');
      const exe = join(customDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      mkdirSync(dirname(exe), { recursive: true });
      writeFileSync(exe, 'bin');
      writeFileSync(shim, `@ECHO off\r\n`);

      const resolved = resolveOpencodeBin(
        undefined,
        { CEZ_OPENCODE_BIN: shim },
        'win32',
        binDir,
      );
      expect(resolved).toBe(exe);
    });

    it('honors CEZ_OPENCODE_BIN override without unwrapping if no .exe exists', () => {
      const customShim = join(root, 'custom.cmd');
      writeFileSync(customShim, `@ECHO off\r\n`);

      const resolved = resolveOpencodeBin(
        undefined,
        { CEZ_OPENCODE_BIN: customShim },
        'win32',
        binDir,
      );
      expect(resolved).toBe(customShim);
    });

    it('handles paths containing spaces', () => {
      const spaceDir = join(root, 'Program Files', 'OpenCode');
      mkdirSync(spaceDir, { recursive: true });
      const exe = join(spaceDir, 'opencode.exe');
      writeFileSync(exe, 'bin');

      const resolved = resolveOpencodeBin(
        undefined,
        { CEZ_OPENCODE_BIN: exe },
        'win32',
        binDir,
      );
      expect(resolved).toBe(exe);
    });
  });

  describe('resolveOpencodeBin on POSIX', () => {
    it('resolves opencode on PATH', () => {
      const posixBin = join(binDir, 'opencode');
      writeFileSync(posixBin, '#!/bin/sh\n');

      const resolved = resolveOpencodeBin(
        undefined,
        {},
        'linux',
        binDir,
      );
      expect(resolved).toBe(posixBin);
    });

    it('honors CEZ_OPENCODE_BIN override', () => {
      const resolved = resolveOpencodeBin(
        undefined,
        { CEZ_OPENCODE_BIN: '/custom/bin/opencode' },
        'darwin',
      );
      expect(resolved).toBe('/custom/bin/opencode');
    });

    it('falls back to bare opencode when missing', () => {
      const resolved = resolveOpencodeBin(
        undefined,
        {},
        'linux',
        binDir,
        [],
      );
      expect(resolved).toBe('opencode');
    });
  });

  describe('prepareOpencodeCommand and argument escaping', () => {
    it('escapes arguments safely for cmd.exe', () => {
      expect(escapeCmdArg('')).toBe('""');
      expect(escapeCmdArg('normal')).toBe('normal');
      expect(escapeCmdArg('--version')).toBe('--version');
      expect(escapeCmdArg('hello world')).toBe('"hello world"');
      expect(escapeCmdArg('foo"bar')).toBe('"foo""bar"');
      expect(escapeCmdArg('a&b')).toBe('"a&b"');
      expect(escapeCmdArg('a|b')).toBe('"a|b"');
      expect(escapeCmdArg('a^b')).toBe('"a^b"');
      expect(escapeCmdArg('%VAR%')).toBe('"%VAR%"');
    });

    it('wraps .cmd files with cmd.exe /d /s /c and windowsVerbatimArguments', () => {
      const cmdPath = 'C:\\tools\\opencode.cmd';
      const prepared = prepareOpencodeCommand(cmdPath, ['auth', 'list'], 'win32');

      expect(prepared.file.toLowerCase()).toContain('cmd.exe');
      expect(prepared.args[0]).toBe('/d');
      expect(prepared.args[1]).toBe('/s');
      expect(prepared.args[2]).toBe('/c');
      expect(prepared.args[3]).toBe('""C:\\tools\\opencode.cmd" auth list"');
      expect(prepared.windowsVerbatimArguments).toBe(true);
    });

    it('prevents shell injection through argument metacharacters', () => {
      const cmdPath = 'C:\\tools\\opencode.cmd';
      const maliciousArg = 'test" & calc.exe & echo "pwned';
      const prepared = prepareOpencodeCommand(cmdPath, [maliciousArg], 'win32');

      // Double quotes inside argument are doubled and argument is quoted
      expect(prepared.args[3]).toBe('""C:\\tools\\opencode.cmd" "test"" & calc.exe & echo ""pwned""');
    });

    it('wraps .ps1 files with powershell.exe', () => {
      const psPath = 'C:\\tools\\opencode.ps1';
      const prepared = prepareOpencodeCommand(psPath, ['--version'], 'win32');

      expect(prepared.file).toBe('powershell.exe');
      expect(prepared.args).toEqual([
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        psPath,
        '--version',
      ]);
      expect(prepared.windowsVerbatimArguments).toBeUndefined();
    });

    it('wraps .mjs files with node executable on Windows', () => {
      const mjsPath = 'D:\\test\\mock.mjs';
      const prepared = prepareOpencodeCommand(mjsPath, ['serve'], 'win32');

      expect(prepared.file).toBe(process.execPath);
      expect(prepared.args).toEqual([mjsPath, 'serve']);
    });

    it('spawns .exe directly without cmd.exe or shell wrapping', () => {
      const exePath = 'C:\\Program Files\\OpenCode\\opencode.exe';
      const prepared = prepareOpencodeCommand(exePath, ['--version'], 'win32');

      expect(prepared.file).toBe(exePath);
      expect(prepared.args).toEqual(['--version']);
      expect(prepared.windowsVerbatimArguments).toBeUndefined();
    });

    it('spawns directly on POSIX platforms', () => {
      const prepared = prepareOpencodeCommand('/usr/local/bin/opencode', ['--version'], 'linux');

      expect(prepared.file).toBe('/usr/local/bin/opencode');
      expect(prepared.args).toEqual(['--version']);
    });
  });

  describe('execution and error handling', () => {
    it('executes a command and returns stdout on success', async () => {
      const testScript = join(root, 'test-version.mjs');
      writeFileSync(testScript, `console.log("1.19.0");\n`);

      const { stdout } = await execOpencode(testScript, []);
      expect(stdout.trim()).toBe('1.19.0');
    });

    it('propagates non-zero exit code on failure', async () => {
      const failScript = join(root, 'test-fail.mjs');
      writeFileSync(failScript, `console.error("error message"); process.exit(3);\n`);

      await expect(execOpencode(failScript, [])).rejects.toThrow();
    });

    it('handles process timeout', async () => {
      const hangScript = join(root, 'test-hang.mjs');
      writeFileSync(hangScript, `setTimeout(() => {}, 60000);\n`);

      await expect(execOpencode(hangScript, [], { timeout: 200 })).rejects.toThrow();
    });
  });
});
