import { accessSync, constants, statSync } from 'node:fs';
import { execPath } from 'node:process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where Claude Code's own installers put the binary, most specific first. cezar inherits the
 * PATH of whatever launched it, and that PATH often lacks these dirs: the native installer
 * (`curl -fsSL https://claude.ai/install.sh | bash`) writes `~/.local/bin/claude` and only adds
 * the dir to the user's shell rc, so a cezar started from an IDE, a launcher, `npx`, or a shell
 * that never sourced that rc reported claude "not installed" on a host that has it — while a
 * Homebrew install (whose bin dir is on the system PATH) was found. Probing the known locations
 * after PATH keeps detection zero-config.
 *
 * `nodeBinDir` is the directory holding the running node — under nvm, fnm, volta or any other
 * version manager, that is also where `npm install -g` puts its shims, which is how cezar's OWN
 * installer installs claude (`server-install/steps.ts`, `NPM_GLOBAL`). Without it cezar could
 * install claude through its own installer and still report it missing, the very bug this module
 * exists to fix.
 */
export function claudeInstallCandidates(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  nodeBinDir: string = dirname(execPath),
): string[] {
  if (platform === 'win32') {
    return [
      join(home, '.local', 'bin', 'claude.exe'), // native installer
      // npm's global shims sit next to node.exe itself, and `npm install -g` writes a `.cmd`.
      join(nodeBinDir, 'claude.cmd'),
      join(nodeBinDir, 'claude.exe'),
    ];
  }
  return [
    join(home, '.local', 'bin', 'claude'), // native installer (install.sh)
    join(home, '.claude', 'local', 'claude'), // legacy `claude migrate-installer` local install
    // `npm install -g @anthropic-ai/claude-code`, incl. nvm/fnm/volta prefixes and the
    // `npm config set prefix ~/.npm-global` convention.
    join(nodeBinDir, 'claude'),
    join(home, '.npm-global', 'bin', 'claude'),
    '/opt/homebrew/bin/claude', // Homebrew, Apple silicon
    '/usr/local/bin/claude', // Homebrew, Intel / manual symlink
  ];
}

/** A runnable FILE. Every directory carries the execute bit, so `X_OK` alone would accept a
 *  folder named `claude` and turn the clean "not found" fallback into an `EACCES` at spawn time. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Is `bin` runnable from `searchPath`? Mirrors what a shell does: split on the platform's
 * delimiter and probe each dir for the executable, trying the Windows shim suffixes there — an
 * `npm install -g` on Windows produces `claude.cmd`, not `claude.exe`, so a suffix list that
 * stops at `.exe` misses the most common Windows install outright.
 */
function onSearchPath(bin: string, searchPath: string, platform: NodeJS.Platform): boolean {
  const names = platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`, `${bin}.com`] : [bin];
  // `delimiter` describes the HOST, but `platform` may be an injected value under test; derive
  // the separator from `platform` so the two never disagree.
  const sep = platform === 'win32' ? ';' : ':';
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
  candidates: string[] = claudeInstallCandidates(home, platform),
): string {
  if (env.CEZ_CLAUDE_BIN) return env.CEZ_CLAUDE_BIN;
  if (onSearchPath('claude', env.PATH ?? '', platform)) return 'claude';
  return candidates.find(isExecutable) ?? 'claude';
}

/**
 * The claude binary as a command a SHELL will run, or `null` when only a bare `claude` is known.
 *
 * The distinction matters for the terminal handoff (`open-in-app.ts` / `server.ts`): detection
 * may find claude at `~/.local/bin/claude` using THIS process's environment, but the terminal it
 * then opens is a different environment — on Linux a non-interactive bash that never sources the
 * rc the native installer appended `~/.local/bin` to, on Windows a `cmd` inheriting the same
 * PATH-less env. Handing those a bare `claude` offers the user a menu entry that opens a window
 * saying `command not found`. A resolved absolute path works in every one of them.
 */
export function claudeShellCommand(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  candidates: string[] = claudeInstallCandidates(home, platform),
): string | null {
  const resolved = resolveClaudeBin(env, home, platform, candidates);
  return resolved === 'claude' ? null : resolved;
}
