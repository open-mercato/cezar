import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { shellQuote, withEnvPrefix } from '../core/shell-env.ts';
import { isWsl, wslDistroName } from './wsl.ts';

/**
 * Open a real terminal window at `cwd` running `command` — the "take over the
 * agent session locally" handoff. Cross-platform strategy ported from
 * github-janitor's `openInTerminal.ts`: macOS via osascript, Windows via
 * cmd/start, Linux by probing common emulators with a temp launch script
 * (which sidesteps per-emulator quoting rules). WSL (#361) reuses the Linux
 * script but hands it to a Windows-side terminal through interop, re-entering
 * the distro with `wsl.exe` — there is no Linux desktop of its own to open
 * `x-terminal-emulator` etc. on.
 *
 * Returns true when a launcher was started without an immediate error; the
 * caller shows a copy-the-command fallback otherwise.
 */
export async function openInTerminal(
  cwd: string,
  command: string,
  /** Environment the opened shell must carry — today, the agent account's config dir (spec
   *  2026-07-29-agent-profiles). Rendered per platform and made to PERSIST, because the window
   *  stays open and the user types the next `claude` in it themselves. An empty/absent env
   *  changes nothing about the command. Returns false without launching anything when the
   *  values cannot be embedded safely: a terminal silently aimed at the wrong account is worse
   *  than no terminal, since nothing in the window would say so. */
  env: Record<string, string> = {},
): Promise<boolean> {
  const prefixed = withEnvPrefix(command, env, process.platform);
  if (prefixed === null) return false;

  if (process.platform === 'darwin') {
    const script = `cd ${shellQuote(cwd)} && ${prefixed}`;
    return runDetached('osascript', [
      '-e',
      'tell application "Terminal" to activate',
      '-e',
      `tell application "Terminal" to do script ${appleScriptQuote(script)}`,
    ]);
  }

  if (process.platform === 'win32') {
    const inner = `cd /d "${cwd}" && ${prefixed}`;
    // Windows Terminal first, classic cmd window as fallback.
    if (await runDetached('cmd', ['/c', 'start', '', 'wt', '-d', cwd, 'cmd', '/K', prefixed])) {
      return true;
    }
    return runDetached('cmd', ['/c', 'start', '', 'cmd', '/K', inner]);
  }

  // Linux/other: a temp script avoids each emulator's own quoting rules.
  const scriptPath = writeLaunchScript(cwd, prefixed);

  if (isWsl()) {
    // No Linux GUI here — go through interop to a Windows terminal, which re-enters this same
    // distro (`wsl.exe -d <distro>`) to run the script we just wrote. `scriptPath`/`cwd` stay
    // POSIX: `wsl.exe` interprets its command line inside the distro, not on the Windows side.
    for (const [bin, args] of wslTerminalLaunchers(scriptPath, wslDistroName())) {
      if (await runDetached(bin, args)) return true;
    }
    return false;
  }

  const candidates: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', scriptPath]],
    ['gnome-terminal', ['--', scriptPath]],
    ['konsole', ['-e', scriptPath]],
    ['wezterm', ['start', '--', scriptPath]],
    ['kitty', [scriptPath]],
    ['alacritty', ['-e', scriptPath]],
    ['xterm', ['-e', scriptPath]],
  ];
  for (const [bin, args] of candidates) {
    if (await runDetached(bin, args)) return true;
  }
  return false;
}

/** The Windows-side (bin, args) candidates for launching `scriptPath` inside `distro` through
 *  WSL interop, in try-order — Windows Terminal first, a classic console window as fallback. Pure
 *  (no spawning) so the exact command line is unit-testable without a real WSL host.
 *
 *  Every launcher here is shell-free by construction, and must stay that way: routing through
 *  `cmd.exe` (`/c start …`) would reintroduce BatBadBut (CVE-2024-27980, see #459). Passing an
 *  argument array is NOT protection when the binary is a shell — libuv only quotes arguments
 *  containing space, tab or quote, so a space-free `distro` like `a&calc&` would reach `cmd`
 *  live and be interpreted. `wt.exe` and `conhost.exe` parse no metacharacters, so the same
 *  input is inert. `distro` is additionally validated at the source (`wslDistroName`). */
export function wslTerminalLaunchers(scriptPath: string, distro: string): Array<[string, string[]]> {
  return [
    ['wt.exe', ['wsl.exe', '-d', distro, '--', scriptPath]],
    ['conhost.exe', ['wsl.exe', '-d', distro, '--', scriptPath]],
  ];
}

/** Writes the temp launch script shared by the plain-Linux and WSL branches: `cd` into the
 *  worktree, run `command`, then drop into an interactive shell so the window stays open. */
function writeLaunchScript(cwd: string, command: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-term-'));
  const scriptPath = join(dir, 'launch.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\ncd ${shellQuote(cwd)}\n${command}\nexec bash\n`, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** Spawn detached; success = no error within a short settle window. */
function runDetached(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: 'ignore', detached: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.once('error', () => settle(false));
    setTimeout(() => {
      child.unref();
      settle(true);
    }, 250);
  });
}

function appleScriptQuote(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
