import { describe, expect, it } from 'vitest';

import { installCommand, shellLine, type InstallEnv } from './agent-setup.ts';

const linux: InstallEnv = { platform: 'linux', npm: true, npmGlobalWritable: true, curl: true, sudo: true };

describe('installCommand', () => {
  it('uses npm when its global folder is writable', () => {
    expect(installCommand('codex', linux)).toBe('npm install -g @openai/codex');
    expect(installCommand('copilot', linux)).toBe('npm install -g @github/copilot');
  });

  it('pins OpenCode to the major the runner can drive', () => {
    expect(installCommand('opencode', linux)).toBe('npm install -g opencode-ai@1');
  });

  it('prefers the vendor script over sudo when npm would need root', () => {
    expect(installCommand('claude', { ...linux, npmGlobalWritable: false })).toBe('curl -fsSL https://claude.ai/install.sh | bash');
  });

  it('asks for sudo only when no script exists', () => {
    expect(installCommand('codex', { ...linux, npmGlobalWritable: false })).toBe('sudo npm install -g @openai/codex');
  });

  it('runs plain npm without sudo, so the terminal shows the real error', () => {
    expect(installCommand('codex', { ...linux, npmGlobalWritable: false, sudo: false })).toBe('npm install -g @openai/codex');
  });

  it('has no answer without the tool the recipe needs', () => {
    expect(installCommand('codex', { ...linux, npm: false, npmGlobalWritable: false })).toBeNull();
    expect(installCommand('cursor', { ...linux, curl: false })).toBeNull();
  });

  it('prefers a native installer on Windows and never uses sudo there', () => {
    const windows: InstallEnv = { platform: 'win32', npm: true, npmGlobalWritable: false, curl: true, sudo: false };
    expect(installCommand('claude', windows)).toContain('install.ps1');
    expect(installCommand('codex', windows)).toBe('npm install -g @openai/codex');
    expect(installCommand('cursor', windows)).toBeNull();
  });
});

describe('shellLine', () => {
  it('encodes a PowerShell one-liner on Windows, so no quote or pipe reaches cmd.exe', () => {
    const line = shellLine('irm https://claude.ai/install.ps1 | iex', 'win32');
    const encoded = line.split(' ').at(-1) ?? '';
    expect(line).toMatch(/^powershell -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('irm https://claude.ai/install.ps1 | iex');
  });

  it('leaves everything else as the user reads it', () => {
    expect(shellLine('npm install -g @openai/codex', 'win32')).toBe('npm install -g @openai/codex');
    expect(shellLine('curl -fsSL https://claude.ai/install.sh | bash', 'linux')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
  });
});
