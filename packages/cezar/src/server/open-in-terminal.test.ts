import { describe, expect, it } from 'vitest';

import { openInTerminal, wslTerminalLaunchers } from './open-in-terminal.ts';

describe('wslTerminalLaunchers (#361 WSL support)', () => {
  it('tries Windows Terminal first, re-entering the distro through wsl.exe', () => {
    const [first] = wslTerminalLaunchers('/tmp/cez-term-abc/launch.sh', 'Ubuntu');
    expect(first).toEqual(['wt.exe', ['wsl.exe', '-d', 'Ubuntu', '--', '/tmp/cez-term-abc/launch.sh']]);
  });

  it('falls back to a classic console window, same wsl.exe re-entry', () => {
    const [, second] = wslTerminalLaunchers('/tmp/cez-term-abc/launch.sh', 'Ubuntu');
    expect(second).toEqual(['conhost.exe', ['wsl.exe', '-d', 'Ubuntu', '--', '/tmp/cez-term-abc/launch.sh']]);
  });

  // Regression guard for the BatBadBut class (CVE-2024-27980) that #459 fixed in the sibling
  // opener: an argument array does not save you when the binary itself is a shell, because libuv
  // leaves space-free arguments unquoted, so `distro` could carry a metacharacter into cmd.
  // Scoped to the WSL launchers on purpose — openInTerminal's native win32 branch still builds a
  // `cmd /c start` line, which this says nothing about.
  it('routes no WSL launcher through a shell', () => {
    for (const [bin] of wslTerminalLaunchers('/tmp/script.sh', 'Ubuntu')) {
      expect(bin).not.toMatch(/^(cmd|command|powershell|pwsh)(\.exe)?$/i);
    }
  });

  it('addresses the distro the launch actually runs in, not a hardcoded default', () => {
    const [first] = wslTerminalLaunchers('/tmp/script.sh', 'Debian');
    expect(first?.[1]).toContain('Debian');
  });
});

describe('openInTerminal env (spec 2026-07-29-agent-profiles)', () => {
  it('refuses to launch anything when the account env cannot be embedded safely', async () => {
    // Fail CLOSED. Launching the bare command would open a terminal on a DIFFERENT account than
    // the user asked for, and nothing in the window would say so — worse than not opening one.
    // The refusal happens before any spawn, which is what makes this assertable without mocks.
    await expect(
      openInTerminal('/tmp', 'claude --resume abc', {
        CLAUDE_CONFIG_DIR: `/home/u${String.fromCharCode(10)}evil`,
      }),
    ).resolves.toBe(false);
  });
});
