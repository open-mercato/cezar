import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RUNNER_IDS } from './agent-runner.ts';
import {
  AGENT_RECIPES,
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

  it('prefers sudo npm, which cezar may run, over an unverified Homebrew line', () => {
    expect(planInstall('codex', { ...mac, npmGlobalWritable: false })).toMatchObject({ command: 'sudo npm install -g @openai/codex', runnable: true, sudo: true });
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

  it('shows an unverified update instead of running it', () => {
    expect(planUpdate('codex', { executable: 'codex', path: '/x/codex', method: 'brew' }, mac)).toMatchObject({ command: 'brew upgrade --cask codex', runnable: false });
    expect(planUpdate('kimi', { executable: 'kimi', path: '/x/kimi', method: null }, mac)).toBeNull();
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
