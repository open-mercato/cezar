import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Where Claude Code's own installers put the binary, most specific first. cezar inherits the
 * PATH of whatever launched it, and that PATH often lacks these dirs: the native installer
 * (`curl -fsSL https://claude.ai/install.sh | bash`) writes `~/.local/bin/claude` and only adds
 * the dir to the user's shell rc, so a cezar started from an IDE, a launcher, `npx`, or a shell
 * that never sourced that rc reported claude "not installed" on a host that has it — while a
 * Homebrew install (whose bin dir is on the system PATH) was found. Probing the known locations
 * after PATH keeps detection zero-config.
 */
export function claudeInstallCandidates(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') return [join(home, '.local', 'bin', 'claude.exe')];
  return [
    join(home, '.local', 'bin', 'claude'), // native installer (install.sh)
    join(home, '.claude', 'local', 'claude'), // legacy `claude migrate-installer` local install
    '/opt/homebrew/bin/claude', // Homebrew, Apple silicon
    '/usr/local/bin/claude', // Homebrew, Intel / manual symlink
  ];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onSearchPath(bin: string, searchPath: string, platform: NodeJS.Platform): boolean {
  const names = platform === 'win32' ? [`${bin}.exe`, `${bin}.com`] : [bin];
  const sep = platform === 'win32' ? ';' : delimiter;
  return searchPath.split(sep).some((dir) => dir && names.some((name) => isExecutable(join(dir, name))));
}

/**
 * The Claude Code binary to run: `CEZ_CLAUDE_BIN`, else `claude` when it is on PATH, else the
 * first installed candidate from {@link claudeInstallCandidates}, else a bare `claude` (so the
 * spawn fails with the usual "not found" and its install hint). Re-resolved on every call — a
 * handful of `access()` probes — so installing claude while cezar runs needs no restart.
 */
export function resolveClaudeBin(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.CEZ_CLAUDE_BIN) return env.CEZ_CLAUDE_BIN;
  if (onSearchPath('claude', env.PATH ?? '', platform)) return 'claude';
  return claudeInstallCandidates(home, platform).find(isExecutable) ?? 'claude';
}
