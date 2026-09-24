import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLaunchScript, openInTerminal, refuseSpawnUnderTest, wslTerminalLaunchers } from './open-in-terminal.ts';

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

/**
 * #785: this opener used to `mkdtemp` a `cez-term-*` directory per launch and never
 * remove it. On a host whose `/tmp` is a tmpfs that never reboots, that litter is part
 * of what exhausts the directory the agents' output capture depends on — the failure
 * this issue is really about. Asserted on `createLaunchScript` rather than through
 * `openInTerminal`, so the test never spawns a real terminal emulator.
 */
describe('launch-script cleanup (#785)', () => {
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Poll rather than sleep a fixed span: the cleanup is a real timer, and a
   *  loaded event loop (the full suite runs these files in parallel) makes any
   *  single "long enough" wait a coin toss. */
  const waitGone = async (path: string) => {
    for (let i = 0; i < 200 && existsSync(path); i += 1) await settle(10);
    return !existsSync(path);
  };

  it('writes a runnable script, then removes its directory', async () => {
    const scriptPath = createLaunchScript('/some/worktree', 'claude --resume abc', 5);
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, 'utf8')).toContain('claude --resume abc');
    expect(dirname(scriptPath)).toMatch(/cez-term-/);

    expect(await waitGone(dirname(scriptPath))).toBe(true);
    expect(existsSync(scriptPath)).toBe(false);
  });

  it('survives long enough for a slow emulator to start', async () => {
    const scriptPath = createLaunchScript('/some/worktree', ':', 10_000);
    try {
      await settle(20);
      // Still there — the cleanup is a grace period, not a race with the launcher.
      expect(existsSync(scriptPath)).toBe(true);
    } finally {
      rmSync(dirname(scriptPath), { recursive: true, force: true });
    }
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

/**
 * #820 — the backstop. A test that reaches a real launcher opens a window on the developer's
 * machine; the suite once left a Terminal sitting in a fixture directory it had already deleted.
 * The guard makes that omission impossible to commit, because it fails loudly instead of
 * succeeding quietly.
 */
describe('the spawn guard (#820)', () => {
  const saved = process.env.CEZ_ALLOW_TEST_SPAWN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_ALLOW_TEST_SPAWN;
    else process.env.CEZ_ALLOW_TEST_SPAWN = saved;
  });

  it('refuses, naming the command and the seam to inject', () => {
    delete process.env.CEZ_ALLOW_TEST_SPAWN;
    expect(() => refuseSpawnUnderTest('osascript', ['-e', 'tell application "Terminal"']))
      .toThrow(/refusing to spawn a launcher from a test: osascript -e tell application "Terminal"/)
    expect(() => refuseSpawnUnderTest('osascript', [])).toThrow(/ServerDeps\.openTerminal/);
  });

  it('lets a file that has mocked child_process through, explicitly', () => {
    process.env.CEZ_ALLOW_TEST_SPAWN = '1';
    expect(() => refuseSpawnUnderTest('osascript', ['-e', 'x'])).not.toThrow();
  });

  it('never fires outside a test run', () => {
    delete process.env.CEZ_ALLOW_TEST_SPAWN;
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => refuseSpawnUnderTest('osascript', ['-e', 'x'])).not.toThrow();
    } finally {
      if (vitest !== undefined) process.env.VITEST = vitest;
    }
  });

  it('stops openInTerminal before it can reach the OS', async () => {
    delete process.env.CEZ_ALLOW_TEST_SPAWN;
    // The exact call #820 reported: `openInApp('terminal', dir)` → `openInTerminal(dir, ':')`.
    await expect(openInTerminal('/tmp/some-account-folder', ':')).rejects.toThrow(/refusing to spawn/);
  });
});
