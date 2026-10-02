import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLaunchScript, handoffCommand, openInTerminal, refuseSpawnUnderTest, wslTerminalLaunchers } from './open-in-terminal.ts';

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
 * A terminal emulator is single-instance over D-Bus: the window cezar opens is created by the
 * emulator ALREADY RUNNING since login and inherits ITS PATH, not cezar's. A CLI only an
 * interactive shell finds — `kilo` in `~/.kilo/bin`, added by a `.bashrc` line — is therefore
 * absent there, and "Connect" answered `kilo: command not found` for a CLI cezar itself had just
 * run successfully (reported from the Providers card).
 *
 * So the handoff prepends cezar's own PATH dirs. Asserted through `handoffCommand`, the whole of
 * what a launcher would run — `openInTerminal` itself would open a window on this machine (#820).
 */
describe('handoffCommand PATH handoff (single-instance emulator)', () => {
  it('prepends cezar PATH dirs so a CLI the session shell finds is findable in the window', () => {
    const command = handoffCommand('kilo auth login', {}, 'linux', '/usr/bin:/home/u/.kilo/bin');
    expect(command).toBe('export PATH=\'/usr/bin\':\'/home/u/.kilo/bin\':"$PATH"; kilo auth login');
  });

  it('keeps the account env and the command, PATH first', () => {
    const command = handoffCommand('claude --resume abc', { CLAUDE_CONFIG_DIR: '/w' }, 'linux', '/usr/bin');
    expect(command).toBe(
      'export PATH=\'/usr/bin\':"$PATH"; export CLAUDE_CONFIG_DIR=\'/w\'; claude --resume abc',
    );
  });

  it('degrades to the bare command when the PATH cannot be embedded — never refuses', () => {
    // Best-effort by design: unlike the account env, a missing PATH augmentation cannot aim the
    // window at the wrong account, and the command may still resolve.
    const evil = `/home/u${String.fromCharCode(9)}bin`;
    expect(handoffCommand('kilo auth login', {}, 'linux', evil)).toBe('kilo auth login');
    expect(handoffCommand('kilo auth login', {}, 'linux', undefined)).toBe('kilo auth login');
  });

  it('still fails CLOSED on an unembeddable account env', () => {
    expect(handoffCommand('claude --resume abc', { CLAUDE_CONFIG_DIR: 'a"b' }, 'win32', 'C:\\tools'))
      .toBeNull();
  });

  it('renders the win32 spelling, PATH dirs and all', () => {
    expect(handoffCommand('kilo auth login', {}, 'win32', String.raw`C:\tools;C:\Users\u\.kilo\bin`))
      .toBe('set "PATH=C:\\tools;C:\\Users\\u\\.kilo\\bin;%PATH%" && kilo auth login');
  });
});

/**
 * CodeQL alert #18 — the native win32 branch hands `cwd` to `cmd /c start`, and libuv leaves a
 * space-free argument unquoted, so a worktree path carrying `&` would run a second command.
 * Both cases stay spawn-free: the refusal returns before any launcher, and a clean path is proven
 * to REACH the launcher by the #820 guard throwing.
 */
describe('openInTerminal on win32 (BatBadBut, alert #18)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const saved = process.env.CEZ_ALLOW_TEST_SPAWN;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    if (saved === undefined) delete process.env.CEZ_ALLOW_TEST_SPAWN;
    else process.env.CEZ_ALLOW_TEST_SPAWN = saved;
  });
  const onWindows = () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    delete process.env.CEZ_ALLOW_TEST_SPAWN;
  };

  it.each([
    String.raw`C:\dev\a&calc`,
    String.raw`C:\dev\a|calc`,
    String.raw`C:\dev\a^b`,
    String.raw`C:\dev\%COMSPEC%`,
    String.raw`C:\dev\a!b`,
  ])('refuses a worktree path cmd would interpret: %s', async (cwd) => {
    onWindows();
    await expect(openInTerminal(cwd, ':')).resolves.toBe(false);
  });

  it('still launches for an ordinary path, spaces and parentheses included', async () => {
    onWindows();
    await expect(openInTerminal(String.raw`C:\Program Files (x86)\dev\proj`, ':')).rejects.toThrow(/refusing to spawn/);
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
