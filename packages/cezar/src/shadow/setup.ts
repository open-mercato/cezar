import { accessSync, chmodSync, constants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultGit,
  gitConfigEnv,
  planPushRedirect,
  readRemotes,
  remoteSlug,
  verifyPushRedirect,
  type Git,
} from './git-redirect.ts';
import { LEDGER_VERSION, shadowDir, shadowPaths, writeShadowConfig } from './ledger.ts';

/**
 * Arming a shadow run (spec `2026-10-06-shadow-runs` § Arming). Idempotent: every spawn of the run
 * (first turn, Continue, restart recovery) calls it, and it rewrites the scripts and re-verifies
 * the redirect each time, so a moved repository or an upgraded cezar never runs on stale wiring.
 *
 * Three things, all local, no daemon:
 *  1. one bare SHADOW REMOTE per configured remote, borrowing the user's object store through
 *     `objects/info/alternates` (a push transfers nothing new) with a `pre-receive` hook that
 *     records and rejects;
 *  2. a `gh` shim directory placed first on the run's PATH;
 *  3. the `GIT_CONFIG_*` environment that rewrites every push URL, VERIFIED by asking git where
 *     each remote now pushes. A run whose redirect cannot be proven does not start.
 */

export class ShadowSetupError extends Error {
  constructor(message: string) {
    super(`shadow mode could not be armed: ${message}`);
    this.name = 'ShadowSetupError';
  }
}

export interface ShadowEnvironment {
  /** Merged into the agent's environment LAST, so nothing per-step can undo it. */
  env: Record<string, string>;
  /** Names of the remotes whose pushes are captured. */
  remotes: string[];
  /** The `gh` reads pass through to; null when gh is not installed. */
  realGh: string | null;
}

/** How the shim is started: this very node binary and the sibling entry file. */
export interface ShimInvocation {
  node: string;
  args: string[];
}

/**
 * The entry is `shim-main.js` next to this module in a build, and `shim-main.ts` in a source
 * checkout - the same pair the cockpit hands agents as `CEZ_BIN`. A `.ts` entry needs type
 * stripping, which Node 23.6+ does by default and 22.6+ does behind a flag.
 */
export function shimInvocation(moduleUrl: string = import.meta.url): ShimInvocation {
  const here = fileURLToPath(moduleUrl);
  const ts = here.endsWith('.ts');
  const entry = join(dirname(here), ts ? 'shim-main.ts' : 'shim-main.js');
  const stripsByDefault = Boolean((process.features as { typescript?: unknown }).typescript);
  const flags = ts ? ['--no-warnings', ...(stripsByDefault ? [] : ['--experimental-strip-types'])] : [];
  return { node: process.execPath, args: [...flags, entry] };
}

/** Case-insensitive env read: Windows spells it `Path`. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) return value;
  return undefined;
}

/**
 * The absolute path of `name` on `searchPath`, skipping `exclude` (the shim's own directory). A
 * directory with the right name is not a binary (#1066), and on Windows only `.exe`/`.com` count:
 * a `.cmd` cannot be spawned without a shell, and a shell is the BatBadBut surface #459 closed.
 */
export function findExecutable(
  name: string,
  searchPath: string,
  platform: NodeJS.Platform = process.platform,
  exclude: readonly string[] = [],
): string | null {
  const separator = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.com`] : [name];
  const key = (path: string) => {
    const normalized = resolve(path).replace(/[\\/]+$/, '');
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const skipped = new Set(exclude.map(key));
  for (const dir of searchPath.split(separator)) {
    if (!dir || skipped.has(key(dir))) continue;
    for (const candidate of names) {
      const path = join(dir, candidate);
      try {
        if (!statSync(path).isFile()) continue;
        if (platform !== 'win32') accessSync(path, constants.X_OK);
        return path;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** Git for Windows runs hooks and scripts through its own sh, which reads `C:/x` but not `C:\x`. */
const shPath = (value: string, platform: NodeJS.Platform) => (platform === 'win32' ? value.replace(/\\/g, '/') : value);
/** cmd.exe expands `%VAR%` even inside quotes; a Windows path cannot contain `"`. */
const cmdQuote = (value: string) => `"${value.replace(/%/g, '%%')}"`;

function writeScript(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  try {
    chmodSync(path, 0o755);
  } catch {
    // Windows has no exec bit; git for Windows and cmd do not need one.
  }
}

function shCommand(invocation: ShimInvocation, platform: NodeJS.Platform): string {
  return [invocation.node, ...invocation.args].map((part) => shQuote(shPath(part, platform))).join(' ');
}

const GENERATED = 'cezar shadow mode (spec 2026-10-06-shadow-runs): generated on every run start, do not edit.';

export interface PrepareShadowOptions {
  dataDir: string;
  runId: string;
  repoRoot: string;
  /** The environment the agent's PATH is derived from. */
  hostEnv?: NodeJS.ProcessEnv;
  git?: Git;
  platform?: NodeJS.Platform;
  invocation?: ShimInvocation;
}

export async function prepareShadowRun(options: PrepareShadowOptions): Promise<ShadowEnvironment> {
  const platform = options.platform ?? process.platform;
  const git = options.git ?? defaultGit;
  const hostEnv = options.hostEnv ?? process.env;
  const invocation = options.invocation ?? shimInvocation();
  const paths = shadowPaths(shadowDir(options.dataDir, options.runId));
  mkdirSync(paths.bin, { recursive: true });
  mkdirSync(paths.remotes, { recursive: true });

  const remotes = await readRemotes(options.repoRoot, git);
  // The object store every worktree of this repository writes to. A shadow remote that borrows it
  // already "has" every commit the agent made, so a push sends nothing but ref names.
  const common = await git(options.repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const objects = common.ok && common.stdout.trim() ? join(common.stdout.trim(), 'objects') : null;
  const targetOf = (name: string) => join(paths.remotes, `${remoteSlug(name)}.git`);

  for (const remote of remotes) {
    const target = targetOf(remote.name);
    if (!existsSync(join(target, 'HEAD'))) {
      const init = await git(paths.dir, ['init', '--bare', '--quiet', target]);
      if (!init.ok) {
        throw new ShadowSetupError(`could not create the shadow remote for "${remote.name}" (${init.stderr.trim().split('\n')[0]})`);
      }
    }
    if (objects) {
      mkdirSync(join(target, 'objects', 'info'), { recursive: true });
      writeFileSync(join(target, 'objects', 'info', 'alternates'), `${objects}\n`, 'utf8');
    }
    const hooks = join(target, 'hooks');
    mkdirSync(hooks, { recursive: true });
    // A global `core.hooksPath` (secret scanners set one) would silence this hook and let the push
    // land unrecorded; the shadow remote's own config pins its hooks to its own directory.
    // `--git-dir`, never a cwd inside the bare repository: `safe.bareRepository=explicit` refuses
    // the latter.
    const pinned = await git(paths.dir, [`--git-dir=${target}`, 'config', 'core.hooksPath', shPath(hooks, platform)]);
    if (!pinned.ok) throw new ShadowSetupError(`could not configure the shadow remote for "${remote.name}"`);
    writeScript(
      join(hooks, 'pre-receive'),
      `#!/bin/sh\n# ${GENERATED}\nexec ${shCommand(invocation, platform)} pre-receive ${shQuote(shPath(paths.dir, platform))} ${shQuote(remote.name)}\n`,
    );
  }

  const planned = planPushRedirect(remotes, { remoteTarget: targetOf, blockedBase: paths.blocked });
  if (!planned.ok) throw new ShadowSetupError(planned.reason);
  const gitEnv = gitConfigEnv(planned.plan.entries);
  // The probe's own scratch repository: a run outside any git repository still gets a verified
  // catch-all, and nothing about the user's repository can make the probe pass or fail.
  if (!existsSync(join(paths.probe, 'HEAD'))) {
    const init = await git(paths.dir, ['init', '--bare', '--quiet', paths.probe]);
    if (!init.ok) throw new ShadowSetupError(`could not create the probe repository (${init.stderr.trim().split('\n')[0]})`);
  }
  const refusal = await verifyPushRedirect(options.repoRoot, remotes, planned.plan, { ...hostEnv, ...gitEnv }, paths.probe, git, platform);
  if (refusal) throw new ShadowSetupError(refusal);

  const hostPath = readEnv(hostEnv, 'PATH') ?? '';
  const realGh = findExecutable('gh', hostPath, platform, [paths.bin]);
  writeShadowConfig(paths.dir, { v: LEDGER_VERSION, runId: options.runId, repoRoot: options.repoRoot, realGh });

  writeScript(
    join(paths.bin, 'gh'),
    `#!/bin/sh\n# ${GENERATED}\nexec ${shCommand(invocation, platform)} gh ${shQuote(shPath(paths.dir, platform))} "$@"\n`,
  );
  writeScript(
    join(paths.bin, 'gh.cmd'),
    `@echo off\r\nrem ${GENERATED}\r\n${[invocation.node, ...invocation.args].map(cmdQuote).join(' ')} gh ${cmdQuote(paths.dir)} %*\r\nexit /b %ERRORLEVEL%\r\n`,
  );

  const separator = platform === 'win32' ? ';' : ':';
  return {
    env: {
      ...gitEnv,
      PATH: hostPath ? `${paths.bin}${separator}${hostPath}` : paths.bin,
      CEZ_SHADOW: '1',
      // Where the shim lives, for the check-step wrapper below to put back in front of a PATH
      // that a login profile rewrote.
      CEZ_SHADOW_BIN: paths.bin,
    },
    remotes: remotes.map((remote) => remote.name),
    realGh,
  };
}

/**
 * `env` laid over `base` with every case-variant of an overridden name removed first. Windows
 * treats `Path` and `PATH` as one variable, and a child env carrying both hands the process
 * whichever the platform picks - the same trap `buildChildEnv` closes for agent spawns (#785).
 */
export function withEnvOverrides(base: NodeJS.ProcessEnv, env: Record<string, string>): NodeJS.ProcessEnv {
  const overridden = new Set(Object.keys(env).map((key) => key.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!overridden.has(key.toUpperCase())) out[key] = value;
  return { ...out, ...env };
}

/**
 * How a shadow run's check step is started: `bash -lc SHADOW_CHECK_WRAPPER`, with the command in
 * `CEZ_SHADOW_COMMAND`. A login shell sources the user's profiles, and those may REWRITE PATH -
 * Debian's `/etc/profile` replaces it, macOS `path_helper` and `brew shellenv` put system and
 * Homebrew directories first - which would put the real gh ahead of the shim. So the wrapper puts
 * the shim back in front after the profiles ran, refuses to run the check unless `gh` now resolves
 * to the shim (an alias or function named `gh` fails this too, on purpose), and only then
 * evaluates the command, in this same shell, exactly as `bash -lc <command>` would.
 */
export const SHADOW_CHECK_WRAPPER = [
  'bin="$CEZ_SHADOW_BIN"',
  'if command -v cygpath >/dev/null 2>&1; then bin="$(cygpath -u "$bin")"; fi',
  'PATH="$bin:$PATH"; export PATH',
  'if [ "$(command -v gh)" != "$bin/gh" ]; then',
  '  echo "cezar shadow: gh does not resolve to the shadow shim in this shell; the check did not run" >&2',
  '  exit 97',
  'fi',
  'eval "$CEZ_SHADOW_COMMAND"',
].join('\n');

/** What the agent is told. Cooperation is the first line of defense; the shim is the second. */
export const SHADOW_INSTRUCTIONS = `## Shadow mode

This task runs in SHADOW MODE (cezar). Work exactly as you normally would: edit, commit, run the
tests, and attempt the pushes, pull requests and comments the task calls for.

Nothing you do leaves this machine. \`git push\` is recorded and then rejected with a
"cezar shadow" message, and \`gh\` commands that would change GitHub print a "recorded" notice
instead of running. Read-only \`gh\` commands work normally. A human reviews the recorded actions
in the cockpit and decides which ones to carry out.

Do not retry, force or reroute a recorded action (another remote, another URL, the GitHub API
directly), and do not treat the rejection as an error to fix. In your final message, list every
action that was recorded rather than executed.`;

/**
 * A deleted run takes its shadow state with it: the directory, and the refs that pinned its
 * commits (`refs/cezar/shadow/<runId>/`). Never throws - a leftover pin costs disk, not safety.
 */
export async function removeShadowState(dataDir: string, runId: string, repoRoot: string, git: Git = defaultGit): Promise<void> {
  const listed = await git(repoRoot, ['for-each-ref', '--format=%(refname)', `refs/cezar/shadow/${runId}/`]);
  for (const ref of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    await git(repoRoot, ['update-ref', '-d', ref]);
  }
  try {
    rmSync(shadowDir(dataDir, runId), { recursive: true, force: true });
  } catch {
    // best effort
  }
}
