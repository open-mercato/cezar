import { describe, expect, it } from 'vitest';
import { resolveCheckShell } from './check-shell.ts';

describe('resolveCheckShell', () => {
  it('keeps the existing bare bash selection on Unix', () => {
    expect(resolveCheckShell({ platform: 'linux', env: {}, fileExists: () => true })).toBe('bash');
    expect(resolveCheckShell({ platform: 'darwin', env: {}, fileExists: () => true })).toBe('bash');
  });

  it('prefers Git Bash on PATH over the WSL launcher', () => {
    const git = String.raw`C:\Program Files\Git\bin`;
    const wsl = String.raw`C:\Windows\System32`;
    expect(
      resolveCheckShell({
        platform: 'win32',
        env: { PATH: `${wsl};${git}` },
        fileExists: (path) => path.toLowerCase().includes('git\\bin\\bash.exe'),
      }),
    ).toBe(String.raw`C:\Program Files\Git\bin\bash.exe`);
  });

  it('discovers the standard Git installation when it is not on PATH', () => {
    expect(
      resolveCheckShell({
        platform: 'win32',
        env: { ProgramFiles: String.raw`C:\Program Files`, PATH: String.raw`C:\Windows\System32` },
        fileExists: (path) => path === String.raw`C:\Program Files\Git\bin\bash.exe`,
      }),
    ).toBe(String.raw`C:\Program Files\Git\bin\bash.exe`);
  });

  it('falls back to bare bash when Git Bash is not installed', () => {
    let probes = 0;
    expect(
      resolveCheckShell({
        platform: 'win32',
        env: { PATH: String.raw`C:\Windows\System32`, ProgramFiles: String.raw`C:\Program Files` },
        fileExists: () => {
          probes += 1;
          return false;
        },
      }),
    ).toBe('bash');
    expect(probes).toBe(1);
  });
});
