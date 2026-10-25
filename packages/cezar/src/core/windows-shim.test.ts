import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disclaimedCommand } from './disclaim-spawn.ts';
import { shimScript, shimTarget, spawnableCommand } from './windows-shim.ts';

// Verbatim shapes of what `npm i -g` (cmd-shim) and pnpm write on Windows.
const NPM_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');
const PNPM_SHIM = [
  '@SETLOCAL', '@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\..\\codex\\bin\\codex.js" %*',
  ') ELSE (', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', '  node  "%~dp0\\..\\codex\\bin\\codex.js" %*', ')',
].join('\r\n');
// cmd-shim's `.ps1` twin for a node bin, and both shims for a native bin (opencode-ai ships an .exe).
const NPM_PS1 = [
  '#!/usr/bin/env pwsh', '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent', '', '$exe=""',
  '$ret=0', 'if (Test-Path "$basedir/node$exe") {', '  if ($MyInvocation.ExpectingInput) {',
  '    $input | & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args', '  } else {',
  '    & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args', '  }', '} else {',
  '  if ($MyInvocation.ExpectingInput) {', '    $input | & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args',
  '  } else {', '    & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args', '  }', '}', 'exit $ret',
].join('\n');
const NATIVE_CMD = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
].join('\r\n');
const NATIVE_PS1 = [
  '#!/usr/bin/env pwsh', '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent', '',
  'if ($MyInvocation.ExpectingInput) {', '  $input | & "$basedir/node_modules/opencode-ai/bin/opencode.exe"   $args',
  '} else {', '  & "$basedir/node_modules/opencode-ai/bin/opencode.exe"   $args', '}', 'exit $LASTEXITCODE',
].join('\n');

describe('spawnableCommand (telemetry a330744e)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-shim-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const npmInstall = () => {
    const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    mkdirSync(join(script, '..'), { recursive: true });
    writeFileSync(script, '');
    writeFileSync(join(dir, 'codex.cmd'), NPM_SHIM);
    return { shim: join(dir, 'codex.cmd'), script };
  };

  it('runs an npm shim as node <script>, with no shell', () => {
    const { shim, script } = npmInstall();
    expect(spawnableCommand(shim, ['login', 'status'], { platform: 'win32', nodePath: 'NODE' }))
      .toEqual(['NODE', [script, 'login', 'status']]);
  });

  it('prefers the node.exe the shim ships beside it', () => {
    const { shim, script } = npmInstall();
    writeFileSync(join(dir, 'node.exe'), '');
    expect(spawnableCommand(shim, ['--version'], { platform: 'win32', nodePath: 'NODE' }))
      .toEqual([join(dir, 'node.exe'), [script, '--version']]);
  });

  it('reads a pnpm shim, whose target appears in both branches', () => {
    const bin = join(dir, 'bin');
    const script = join(dir, 'codex', 'bin', 'codex.js');
    mkdirSync(bin);
    mkdirSync(join(script, '..'), { recursive: true });
    writeFileSync(script, '');
    writeFileSync(join(bin, 'codex.cmd'), PNPM_SHIM);
    expect(shimScript(join(bin, 'codex.cmd'))).toBe(script);
  });

  // Telemetry 3626ac13: CEZ_OPENCODE_BIN pointed at npm's opencode.ps1, which Node cannot spawn.
  it('reads the .ps1 twin npm writes beside the .cmd', () => {
    const { script } = npmInstall();
    writeFileSync(join(dir, 'codex.ps1'), NPM_PS1);
    expect(spawnableCommand(join(dir, 'codex.ps1'), ['--version'], { platform: 'win32', nodePath: 'NODE' }))
      .toEqual(['NODE', [script, '--version']]);
  });

  it('runs the native binary a shim launches directly, from either shim', () => {
    const exe = join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    mkdirSync(join(exe, '..'), { recursive: true });
    writeFileSync(exe, '');
    writeFileSync(join(dir, 'opencode.cmd'), NATIVE_CMD);
    writeFileSync(join(dir, 'opencode.ps1'), NATIVE_PS1);
    for (const shim of ['opencode.cmd', 'opencode.ps1']) {
      expect(spawnableCommand(join(dir, shim), ['auth', 'list'], { platform: 'win32', nodePath: 'NODE' }))
        .toEqual([exe, ['auth', 'list']]);
    }
    expect(shimScript(join(dir, 'opencode.cmd'))).toBeNull();
  });

  it('runs an extensionless bin with node only when its shebang names node', () => {
    const bin = join(dir, 'node_modules', 'tool', 'bin', 'tool');
    mkdirSync(join(bin, '..'), { recursive: true });
    writeFileSync(join(dir, 'tool.cmd'), NPM_SHIM.replace('@openai\\codex\\bin\\codex.js', 'tool\\bin\\tool'));
    writeFileSync(bin, '#!/usr/bin/env node\nrequire("./x")');
    expect(shimTarget(join(dir, 'tool.cmd'))).toEqual({ kind: 'node', path: bin });
    writeFileSync(bin, '#!/bin/sh\necho hi');
    expect(shimTarget(join(dir, 'tool.cmd'))).toBeNull();
  });

  it('runs a .js override with node', () => {
    const script = join(dir, 'codex.js');
    writeFileSync(script, '');
    expect(spawnableCommand(script, ['app-server'], { platform: 'win32', nodePath: 'NODE' }))
      .toEqual(['NODE', [script, 'app-server']]);
  });

  it('leaves anything it does not understand untouched, so the spawn reports its own error', () => {
    writeFileSync(join(dir, 'custom.cmd'), '@echo off\r\ncall something-else.exe %*');
    const custom = join(dir, 'custom.cmd');
    expect(spawnableCommand(custom, ['x'], { platform: 'win32' })).toEqual([custom, ['x']]);
    // a shim whose script is gone
    writeFileSync(join(dir, 'gone.cmd'), NPM_SHIM);
    expect(spawnableCommand(join(dir, 'gone.cmd'), [], { platform: 'win32' })).toEqual([join(dir, 'gone.cmd'), []]);
    expect(spawnableCommand(join(dir, 'missing.cmd'), [], { platform: 'win32' })).toEqual([join(dir, 'missing.cmd'), []]);
    expect(spawnableCommand('codex', ['a'], { platform: 'win32' })).toEqual(['codex', ['a']]);
  });

  it('changes nothing off Windows', () => {
    const { shim } = npmInstall();
    expect(spawnableCommand(shim, ['a'], { platform: 'linux' })).toEqual([shim, ['a']]);
  });

  it('is what every runner spawn gets through disclaimedCommand', () => {
    const { shim, script } = npmInstall();
    const [file, argv] = disclaimedCommand(shim, ['app-server'], undefined, { platform: 'win32', hostEnv: {} });
    expect(argv).toEqual([script, 'app-server']);
    expect(file).not.toBe(shim);
  });
});
