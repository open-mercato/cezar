import { accessSync, constants } from 'node:fs';
import { execPath } from 'node:process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where Claude Code's own installers put a binary this process can SPAWN, most specific first.
 *
 * cezar inherits the PATH of whatever launched it, and that PATH often lacks these dirs: the
 * native installer (`curl -fsSL https://claude.ai/install.sh | bash`) writes `~/.local/bin/claude`
 * and only adds the dir to the user's shell rc, so a cezar started from an IDE, a launcher,
 * `npx`, or a shell that never sourced that rc reported claude "not installed" on a host that has
 * it — while a Homebrew install (whose bin dir is on the system PATH) was found. Probing the
 * known locations after PATH keeps detection zero-config.
 *
 * `nodeBinDir` is the directory holding the running node, which is also where `npm install -g`
 * puts its shims under nvm, fnm, volta or a user `npm prefix`. (cezar's own Ubuntu installer
 * shells out to `sudo npm -g` under the SYSTEM node, so it lands in `/usr/bin` or `/usr/local/bin`
 * rather than here — those are covered below.)
 *
 * NOTE the deliberate absence of `.cmd`/`.bat`: every consumer of {@link resolveClaudeBin} hands
 * the result to `spawn`/`execFile` with no shell, and modern Node refuses to spawn those
 * directly — running them through a shell instead would reintroduce the BatBadBut injection
 * surface closed in #459. `resolveOnPath` in `server/open-in-app.ts` excludes them for the same
 * reason. Shell consumers get {@link claudeShellCandidates}, which may include them.
 */
export function claudeInstallCandidates(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  nodeBinDir: string = dirname(execPath),
): string[] {
  if (platform === 'win32') {
    return [
      join(home, '.local', 'bin', 'claude.exe'), // native installer
      join(nodeBinDir, 'claude.exe'), // npm global, next to node.exe
    ];
  }
  return [
    join(home, '.local', 'bin', 'claude'), // native installer (install.sh)
    join(home, '.claude', 'local', 'claude'), // legacy `claude migrate-installer` local install
    join(nodeBinDir, 'claude'), // `npm install -g`, incl. nvm/fnm/volta prefixes
    join(home, '.npm-global', 'bin', 'claude'), // `npm config set prefix ~/.npm-global`
    '/opt/homebrew/bin/claude', // Homebrew, Apple silicon
    '/usr/local/bin/claude', // Homebrew Intel, manual symlink, system `sudo npm -g`
    '/usr/bin/claude', // distro packaging, system `sudo npm -g` on Debian/Ubuntu
  ];
}

/**
 * The same locations, plus the ones only a SHELL can run. On Windows `npm install -g` writes a
 * `claude.cmd` shim and no `.exe` at all, so the terminal handoff — which hands its command to
 * `cmd /K` — would otherwise miss the most common Windows install entirely. Safe here precisely
 * because there IS a shell: the hazard the spawn list avoids does not apply.
 */
export function claudeShellCandidates(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  nodeBinDir: string = dirname(execPath),
): string[] {
  const spawnable = claudeInstallCandidates(home, platform, nodeBinDir);
  if (platform !== 'win32') return spawnable;
  return [...spawnable, join(nodeBinDir, 'claude.cmd'), join(home, '.local', 'bin', 'claude.cmd')];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `bin` runnable from `searchPath`? Mirrors what a shell does: split on the platform's
 * delimiter and probe each dir. `suffixes` are the Windows extensions to try — kept to the
 * directly-spawnable ones by default, for the reason spelled out on
 * {@link claudeInstallCandidates}.
 */
function onSearchPath(
  bin: string,
  searchPath: string,
  platform: NodeJS.Platform,
  suffixes: readonly string[] = ['.exe', '.com'],
): boolean {
  const names = platform === 'win32' ? suffixes.map((suffix) => `${bin}${suffix}`) : [bin];
  // `path.delimiter` describes the HOST, but `platform` may be an injected value under test;
  // derive the separator from `platform` so the two can never disagree.
  const sep = platform === 'win32' ? ';' : ':';
  return searchPath.split(sep).some((dir) => dir && names.some((name) => isExecutable(join(dir, name))));
}

/**
 * The Claude Code binary to SPAWN: `CEZ_CLAUDE_BIN`, else `claude` when it is on PATH, else the
 * first installed candidate from {@link claudeInstallCandidates}, else a bare `claude` (so the
 * spawn fails with the usual "not found" and its install hint). Re-resolved on every call — a
 * handful of `access()` probes — so installing claude while cezar runs needs no restart.
 *
 * `CEZ_CLAUDE_BIN` is returned verbatim and unvalidated on purpose: an operator who points it at
 * the wrong path should get a loud failure naming their path, not a silent fallback.
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
 * The claude binary as a command a SHELL will run, or `null` when a bare `claude` is the best
 * answer available.
 *
 * The distinction matters for the terminal handoff (`open-in-app.ts` / `server.ts`): detection
 * may find claude at `~/.local/bin/claude` using THIS process's environment, but the terminal it
 * then opens is a different environment — on Linux a non-interactive bash that never sources the
 * rc the native installer appended `~/.local/bin` to, on Windows a `cmd` inheriting the same
 * PATH-less environment. Handing those a bare `claude` offers the user a menu entry that opens a
 * window saying `command not found`. A resolved absolute path works in every one of them.
 *
 * Unlike {@link resolveClaudeBin} this DOES validate: a path nobody can execute — including a
 * mistyped `CEZ_CLAUDE_BIN` — must not suppress the plain `claude` that a shell finding it on its
 * own PATH would run perfectly well, and must never turn a working menu entry into a broken one.
 */
export function claudeShellCommand(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  candidates: string[] = claudeShellCandidates(home, platform),
): string | null {
  if (env.CEZ_CLAUDE_BIN) return isExecutable(env.CEZ_CLAUDE_BIN) ? env.CEZ_CLAUDE_BIN : null;
  if (onSearchPath('claude', env.PATH ?? '', platform, ['.exe', '.cmd', '.bat', '.com'])) return null;
  return candidates.find(isExecutable) ?? null;
}
