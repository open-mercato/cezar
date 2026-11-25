import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RUNNER_IDS } from './agent-runner.ts';
import {
  AGENT_RECIPES,
  brewKindFromPath,
  installHintCommand,
  installMethodFromPath,
  locateInstalledCli,
  planInstall,
  planUpdate,
  versionState,
  type InstallEnv,
} from './agent-install.ts';

const mac: InstallEnv = { platform: 'darwin', npm: true, npmGlobalWritable: true, curl: true, sudo: true, brew: true };

describe('AGENT_RECIPES', () => {
  it('has one recipe per runner, each with a docs link', () => {
    expect(Object.keys(AGENT_RECIPES).sort()).toEqual([...RUNNER_IDS].sort());
    for (const recipe of Object.values(AGENT_RECIPES)) expect(recipe.docsUrl).toMatch(/^https:\/\//);
  });
});

describe('planInstall', () => {
  it('offers a copy-only line for an unverified installer, never a runnable one', () => {
    expect(planInstall('gemini', mac)).toEqual({ command: 'npm install -g @google/gemini-cli', runnable: false, method: 'npm', sudo: false });
    expect(planInstall('omp', mac)).toMatchObject({ command: 'brew install can1357/tap/omp', runnable: false });
  });

  it('has only the docs link for an agent whose installer is unknown', () => {
    expect(planInstall('kimi', mac)).toEqual({ command: null, runnable: false, method: null, sudo: false });
    expect(installHintCommand('kimi', 'linux')).toBe('https://moonshotai.github.io/kimi-code/');
  });

  it("runs Antigravity's installer from Google's download page on every platform", () => {
    const unix = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
    expect(planInstall('antigravity', mac)).toEqual({ command: unix, runnable: true, method: 'script', sudo: false });
    expect(planInstall('antigravity', { ...mac, platform: 'linux' })).toEqual({ command: unix, runnable: true, method: 'script', sudo: false });
    expect(planInstall('antigravity', { ...mac, platform: 'win32' })).toEqual({ command: 'irm https://antigravity.google/cli/install.ps1 | iex', runnable: true, method: 'script', sudo: false });
    // Without curl it is the line to copy, not one to run.
    expect(planInstall('antigravity', { ...mac, curl: false })).toEqual({ command: unix, runnable: false, method: 'script', sudo: false });
    expect(installHintCommand('antigravity', 'linux')).toBe(unix);
  });

  it('never offers sudo npm for Claude Code', () => {
    const plan = planInstall('claude', { ...mac, curl: false, brew: false, npmGlobalWritable: false });
    expect(plan.sudo).toBe(false);
    expect(plan.command).toBe('npm install -g @anthropic-ai/claude-code');
  });

  it('prefers a Homebrew install that needs no password over sudo npm', () => {
    expect(planInstall('codex', { ...mac, npmGlobalWritable: false })).toEqual({ command: 'brew install --cask codex', runnable: true, method: 'brew', sudo: false });
    expect(planInstall('codex', mac)).toMatchObject({ command: 'npm install -g @openai/codex', method: 'npm' });
  });

  it('prefers sudo npm, which cezar may run, over an unverified line', () => {
    expect(planInstall('codex', { ...mac, npmGlobalWritable: false, brew: false })).toMatchObject({ command: 'sudo npm install -g @openai/codex', runnable: true, sudo: true });
    expect(planInstall('opencode', { ...mac, npmGlobalWritable: false })).toMatchObject({ command: 'sudo npm install -g opencode-ai@1', runnable: true, sudo: true });
  });
});

describe('Homebrew casks (macOS only)', () => {
  const linux: InstallEnv = { ...mac, platform: 'linux' };

  it('never offers a cask on Linux: an apt Node with Linuxbrew falls back to sudo npm', () => {
    const rootNpm = { ...linux, npmGlobalWritable: false };
    expect(planInstall('codex', rootNpm)).toEqual({ command: 'sudo npm install -g @openai/codex', runnable: true, method: 'npm', sudo: true });
    expect(planInstall('claude', { ...linux, curl: false })).toMatchObject({ command: 'npm install -g @anthropic-ai/claude-code', method: 'npm' });
    expect(planInstall('codex', { ...mac, npmGlobalWritable: false })).toMatchObject({ command: 'brew install --cask codex', method: 'brew' });
  });

  it('upgrades a cask with --cask, and a formula copy without it', () => {
    const cask = { executable: 'codex', path: '/opt/homebrew/bin/codex', method: 'brew' as const, brewKind: 'cask' as const };
    const formula = { ...cask, brewKind: 'formula' as const };
    expect(planUpdate('codex', cask, mac)).toMatchObject({ command: 'brew upgrade --cask codex', runnable: true });
    // No verified formula upgrade, and Codex has no updater of its own: a line to copy.
    expect(planUpdate('codex', formula, mac)).toEqual({ command: 'brew upgrade codex', runnable: false, method: 'brew', sudo: false });
    expect(planUpdate('codex', formula, linux)).toEqual({ command: 'brew upgrade codex', runnable: false, method: 'brew', sudo: false });
    // Claude Code has its own updater for a formula copy.
    expect(planUpdate('claude', { ...formula, executable: 'claude' }, linux)).toMatchObject({ command: "'claude' update", runnable: true });
  });

  it('tells a cask from a formula by where the binary lives', () => {
    expect(brewKindFromPath('/opt/homebrew/Caskroom/codex/0.170.0/codex')).toBe('cask');
    expect(brewKindFromPath('/home/linuxbrew/.linuxbrew/Cellar/codex/0.170.0/bin/codex')).toBe('formula');
    expect(brewKindFromPath('/usr/local/bin/codex')).toBeUndefined();
  });
});

describe('planUpdate', () => {
  const at = (method: 'native' | 'npm' | 'brew' | 'script' | null) => ({ executable: 'claude', path: '/x/claude', method });

  it('follows the method the CLI was installed with', () => {
    expect(planUpdate('claude', at('native'), mac)?.command).toBe("'claude' update");
    expect(planUpdate('claude', at('npm'), mac)?.command).toBe('npm install -g @anthropic-ai/claude-code@latest');
    expect(planUpdate('claude', at('brew'), mac)?.command).toBe('brew upgrade claude-code');
    expect(planUpdate('claude', at(null), mac)).toMatchObject({ command: "'claude' update", runnable: true });
  });

  it('shows a brew upgrade to copy when brew is no longer here', () => {
    expect(planUpdate('claude', at('brew'), { ...mac, brew: false })).toMatchObject({ command: 'brew upgrade claude-code', runnable: false });
    expect(planUpdate('claude', at('native'), { ...mac, brew: false, curl: false })).toMatchObject({ runnable: true });
  });

  it("keeps OpenCode on the major cezar drives, through its own upgrade", () => {
    expect(planUpdate('opencode', { executable: 'opencode', path: '/x/opencode', method: 'npm' }, mac)).toMatchObject({ command: "'opencode' upgrade", runnable: true });
  });

  it('updates a Homebrew Codex with brew, which the owner verified', () => {
    expect(planUpdate('codex', { executable: 'codex', path: '/x/codex', method: 'brew', brewKind: 'cask' }, mac)).toMatchObject({ command: 'brew upgrade --cask codex', runnable: true });
  });

  it('shows an unverified update instead of running it', () => {
    expect(planUpdate('gemini', { executable: 'gemini', path: '/x/gemini', method: 'npm' }, mac)).toMatchObject({ command: 'npm install -g @google/gemini-cli@latest', runnable: false });
    expect(planUpdate('kimi', { executable: 'kimi', path: '/x/kimi', method: null }, mac)).toBeNull();
  });

  it('only shows an npm update when npm is not on this machine', () => {
    const noNpm = { ...mac, npm: false, npmGlobalWritable: false, sudo: true };
    expect(planUpdate('codex', { executable: 'codex', path: '/x', method: 'npm' }, noNpm)).toEqual({ command: 'npm install -g @openai/codex@latest', runnable: false, method: 'npm', sudo: false });
  });

  it('asks for sudo when npm needs root, but never for Claude Code', () => {
    const root = { ...mac, npmGlobalWritable: false };
    expect(planUpdate('copilot', { executable: 'copilot', path: '/x', method: 'npm' }, root)).toMatchObject({ command: 'sudo npm install -g @github/copilot@latest', sudo: true, runnable: true });
    expect(planUpdate('claude', at('npm'), root)).toMatchObject({ sudo: false, runnable: false });
  });
});

describe('installMethodFromPath', () => {
  it.each([
    ['/opt/homebrew/Caskroom/codex/0.170.0/codex', 'brew'],
    ['/opt/homebrew/Cellar/opencode/1.19.2/bin/opencode', 'brew'],
    ['/usr/local/lib/node_modules/@openai/codex/bin/codex.js', 'npm'],
    ['/Users/me/.local/share/claude/versions/2.1.3', 'native'],
    ['/Users/me/.local/share/cursor-agent/versions/2026.10.22/cursor-agent', 'script'],
    ['C:\\Users\\me\\.local\\bin\\claude.exe', 'native'],
    ['C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd', 'npm'],
    ['/usr/bin/gemini', null],
  ])('%s → %s', (path, method) => {
    expect(installMethodFromPath(path)).toBe(method);
  });
});

describe('locateInstalledCli', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the method through the symlink on PATH', () => {
    dir = mkdtempSync(join(tmpdir(), 'cez-locate-'));
    const real = join(dir, 'lib', 'node_modules', '@openai', 'codex', 'bin');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'codex.js'), '');
    mkdirSync(join(dir, 'bin'));
    symlinkSync(join(real, 'codex.js'), join(dir, 'bin', 'codex'));
    expect(locateInstalledCli('codex', 'linux', { PATH: join(dir, 'bin') })).toEqual({ executable: 'codex', path: join(dir, 'bin', 'codex'), method: 'npm' });
    expect(locateInstalledCli('missing', 'linux', { PATH: join(dir, 'bin') })).toEqual({ executable: 'missing', path: null, method: null });
  });

  it('recognizes Windows npm global cmd-shim wrappers in any prefix so planUpdate works', () => {
    dir = mkdtempSync(join(tmpdir(), 'cez-win-npm-'));
    const prefix = join(dir, 'custom-npm-prefix');
    mkdirSync(join(prefix, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    writeFileSync(
      join(prefix, 'codex.cmd'),
      '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );
    writeFileSync(
      join(prefix, 'copilot.ps1'),
      '#!/usr/bin/env pwsh\n& "$basedir/node$exe" "$basedir/node_modules/@github/copilot/bin/copilot.js" $args\n',
    );
    writeFileSync(
      join(prefix, 'gemini'),
      '#!/bin/sh\nexec node "$basedir/node_modules/@google/gemini-cli/dist/index.js" "$@"\n',
    );
    writeFileSync(join(prefix, 'plain.cmd'), '@ECHO off\r\necho not an npm shim\r\n');

    const winEnv: InstallEnv = { platform: 'win32', npm: true, npmGlobalWritable: true, curl: true, sudo: false, brew: false };
    const codex = locateInstalledCli('codex', 'win32', { PATH: prefix });
    expect(codex).toEqual({ executable: 'codex', path: join(prefix, 'codex.cmd'), method: 'npm' });
    expect(planUpdate('codex', codex, winEnv)).toEqual({
      command: 'npm install -g @openai/codex@latest',
      runnable: true,
      method: 'npm',
      sudo: false,
    });
    expect(locateInstalledCli('copilot', 'win32', { PATH: prefix, PATHEXT: '.PS1' }).method).toBe('npm');
    expect(locateInstalledCli('gemini', 'win32', { PATH: prefix }).method).toBe('npm');
    expect(locateInstalledCli('plain', 'win32', { PATH: prefix }).method).toBeNull();
  });
});

describe('versionState', () => {
  it('flags below the minimum first, then a newer release', () => {
    expect(versionState('1.17.0', '1.18.0', '1.21.0')).toBe('update-required');
    expect(versionState('1.18.0', '1.18.0', '1.21.0')).toBe('update-available');
    expect(versionState('1.21.0', null, '1.21.0')).toBe('current');
    expect(versionState('2026.10.22-27dcf5f', null, null)).toBe('unknown');
    expect(versionState(null, '1.0.0', '1.0.0')).toBe('unknown');
  });
});
