import { existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

import { compareVersions, parseVersion } from '../self-update/semver.ts';
import type { RunnerId } from './agent-runner.ts';
import { quoteExecutable } from './shell-env.ts';

/**
 * How each agent CLI is installed and updated: the ONE table every install surface reads (the
 * cockpit's setup sheet, the first-run page, `server-install`, and the install hints). Spec
 * `.ai/specs/2026-11-25-agent-cli-install-and-update.md`.
 *
 * A command cezar may RUN needs `trust` other than `unverified`. `docs`: checked against the
 * vendor's official docs on 2026-11-25. `shipped`: cezar already ran it before this table existed
 * (spec 2026-10-26 setup, the `/providers/:id/update` hand-off), or it is the npm upgrade of a
 * package cezar already installs. Everything else is shown to copy, never run.
 */

export type InstallMethodId = 'native' | 'npm' | 'brew' | 'script';
export type RecipeTrust = 'docs' | 'shipped' | 'unverified';

interface PlatformCommand {
  unix?: string;
  windows?: string;
  /** macOS only, ahead of `unix`: for a vendor whose docs name a command for the Mac alone. */
  darwin?: string;
}

interface InstallMethod {
  id: InstallMethodId;
  trust: RecipeTrust;
  /** The tool this machine must have for the method to work. */
  needs: 'npm' | 'curl' | 'brew' | null;
  install?: PlatformCommand;
  /** `{bin}` is the resolved executable, quoted for this platform. */
  update?: { command: PlatformCommand; trust: RecipeTrust };
}

export interface AgentRecipe {
  provider: RunnerId;
  docsUrl: string;
  /** For the latest-version lookup; absent where the CLI is not on npm. */
  npmPackage?: string;
  /** Highest major cezar can drive (OpenCode 2.x replaced the server API the runner speaks). */
  npmMajor?: number;
  /** The CLI's own self-update, used when the install method is unknown or has none of its own. */
  selfUpdate?: { command: string; trust: RecipeTrust };
  /** The vendor keeps the CLI current by itself. `null` = not known. */
  autoUpdates: boolean | null;
  /** The oldest version cezar is known to drive; runtime "X or newer is required" errors add to it. */
  minVersion?: string;
  /** Never run by cezar, whatever its trust (owner decision 2026-11-25: OMP's third-party tap). */
  copyOnly?: string;
  /** No `sudo npm`: the vendor says a root-owned install cannot update itself. */
  noSudoNpm?: boolean;
  /** `cezar server-install` offers it with `npm -g` (its dependency step). */
  serverInstall?: boolean;
  methods: readonly InstallMethod[];
}

const npmMethod = (pkg: string, trust: RecipeTrust, spec = pkg): InstallMethod => ({
  id: 'npm',
  trust,
  needs: 'npm',
  install: { unix: `npm install -g ${spec}`, windows: `npm install -g ${spec}` },
  update: {
    command: { unix: `npm install -g ${spec === pkg ? `${pkg}@latest` : spec}`, windows: `npm install -g ${spec === pkg ? `${pkg}@latest` : spec}` },
    trust,
  },
});

export const AGENT_RECIPES: Readonly<Record<RunnerId, AgentRecipe>> = {
  claude: {
    provider: 'claude',
    serverInstall: true,
    docsUrl: 'https://code.claude.com/docs/en/setup',
    npmPackage: '@anthropic-ai/claude-code',
    selfUpdate: { command: '{bin} update', trust: 'docs' },
    autoUpdates: true,
    noSudoNpm: true,
    methods: [
      {
        id: 'native',
        trust: 'docs',
        needs: 'curl',
        install: { unix: 'curl -fsSL https://claude.ai/install.sh | bash', windows: 'irm https://claude.ai/install.ps1 | iex' },
        update: { command: { unix: '{bin} update', windows: '{bin} update' }, trust: 'docs' },
      },
      npmMethod('@anthropic-ai/claude-code', 'docs'),
      {
        id: 'brew',
        trust: 'docs',
        needs: 'brew',
        install: { unix: 'brew install --cask claude-code' },
        update: { command: { unix: 'brew upgrade claude-code' }, trust: 'docs' },
      },
    ],
  },
  codex: {
    provider: 'codex',
    serverInstall: true,
    docsUrl: 'https://developers.openai.com/codex/cli',
    npmPackage: '@openai/codex',
    autoUpdates: false,
    methods: [
      npmMethod('@openai/codex', 'shipped'),
      {
        id: 'brew',
        trust: 'unverified',
        needs: 'brew',
        install: { unix: 'brew install --cask codex' },
        update: { command: { unix: 'brew upgrade --cask codex' }, trust: 'unverified' },
      },
    ],
  },
  opencode: {
    provider: 'opencode',
    docsUrl: 'https://opencode.ai/docs/',
    npmPackage: 'opencode-ai',
    npmMajor: 1,
    // Plain `upgrade` stays on 1.x; only `--major` moves to 2.x.
    selfUpdate: { command: '{bin} upgrade', trust: 'shipped' },
    autoUpdates: null,
    methods: [
      { ...npmMethod('opencode-ai', 'shipped', 'opencode-ai@1'), update: undefined },
      { id: 'brew', trust: 'unverified', needs: 'brew', install: { unix: 'brew install opencode' } },
    ],
  },
  cursor: {
    provider: 'cursor',
    docsUrl: 'https://cursor.com/docs/cli/installation',
    selfUpdate: { command: '{bin} update', trust: 'shipped' },
    autoUpdates: null,
    methods: [{ id: 'script', trust: 'shipped', needs: 'curl', install: { unix: 'curl https://cursor.com/install -fsS | bash' } }],
  },
  copilot: {
    provider: 'copilot',
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
    npmPackage: '@github/copilot',
    autoUpdates: true,
    methods: [npmMethod('@github/copilot', 'shipped')],
  },
  gemini: {
    provider: 'gemini',
    serverInstall: true,
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    npmPackage: '@google/gemini-cli',
    autoUpdates: null,
    methods: [npmMethod('@google/gemini-cli', 'unverified')],
  },
  pi: {
    provider: 'pi',
    docsUrl: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent',
    npmPackage: '@mariozechner/pi-coding-agent',
    autoUpdates: null,
    methods: [npmMethod('@mariozechner/pi-coding-agent', 'unverified')],
  },
  junie: {
    provider: 'junie',
    docsUrl: 'https://junie.jetbrains.com/cli',
    npmPackage: '@jetbrains/junie',
    autoUpdates: null,
    methods: [npmMethod('@jetbrains/junie', 'unverified')],
  },
  antigravity: {
    provider: 'antigravity',
    docsUrl: 'https://antigravity.google/docs/cli',
    selfUpdate: { command: '{bin} update', trust: 'shipped' },
    autoUpdates: null,
    // Google's download page (antigravity.google/download, checked 2026-11-25) names this for macOS;
    // Linux and Windows keep the docs link until their commands are checked too.
    methods: [
      { id: 'script', trust: 'docs', needs: 'curl', install: { darwin: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' } },
    ],
  },
  kimi: {
    provider: 'kimi',
    docsUrl: 'https://moonshotai.github.io/kimi-code/',
    autoUpdates: null,
    methods: [],
  },
  omp: {
    provider: 'omp',
    docsUrl: 'https://omp.sh',
    autoUpdates: null,
    copyOnly: 'OMP installs from a third-party Homebrew tap, so cezar shows the command instead of running it.',
    methods: [
      {
        id: 'brew',
        trust: 'unverified',
        needs: 'brew',
        install: { unix: 'brew install can1357/tap/omp' },
        update: { command: { unix: 'brew upgrade omp' }, trust: 'unverified' },
      },
    ],
  },
};

export const recipeFor = (provider: RunnerId): AgentRecipe => AGENT_RECIPES[provider];

/** What this machine can install with. */
export interface InstallEnv {
  platform: NodeJS.Platform;
  npm: boolean;
  /** A global npm install works without sudo. */
  npmGlobalWritable: boolean;
  curl: boolean;
  sudo: boolean;
  brew: boolean;
}

/** One command, and whether cezar may run it here. `command` may be set while `runnable` is false:
 *  it is then the line to copy. */
export interface CommandPlan {
  command: string | null;
  runnable: boolean;
  method: InstallMethodId | null;
  /** The command starts with `sudo`, so its password goes in a terminal on the computer. */
  sudo: boolean;
}

const pick = (command: PlatformCommand | undefined, platform: NodeJS.Platform): string | undefined =>
  platform === 'win32' ? command?.windows : platform === 'darwin' ? command?.darwin ?? command?.unix : command?.unix;

const runnableTrust = (recipe: AgentRecipe, trust: RecipeTrust): boolean => !recipe.copyOnly && trust !== 'unverified';

const hasTool = (env: InstallEnv, needs: InstallMethod['needs']): boolean =>
  needs === null || (needs === 'npm' ? env.npm : needs === 'curl' ? env.curl || env.platform === 'win32' : env.brew);

/**
 * The install to offer here. A method cezar may run beats one it may not; within those, the
 * recipe's order, except that npm needs its global folder to be ours. `sudo npm` comes last (its
 * password goes in the terminal), and never for an agent whose vendor warns against it.
 */
export function planInstall(provider: RunnerId, env: InstallEnv): CommandPlan {
  const recipe = recipeFor(provider);
  const usable = recipe.methods.filter((method) => pick(method.install, env.platform) && hasTool(env, method.needs));
  const direct = usable.filter((method) => method.id !== 'npm' || env.npmGlobalWritable || env.platform === 'win32');
  // npm whose global folder needs root: only after everything that does not.
  const npmUsable = usable.find((method) => method.id === 'npm');
  const npm = npmUsable && !direct.includes(npmUsable) ? npmUsable : undefined;
  const viaNpm = (method: InstallMethod): CommandPlan => {
    const command = pick(method.install, env.platform)!;
    const runnable = runnableTrust(recipe, method.trust);
    if (env.sudo && !recipe.noSudoNpm) return { command: `sudo ${command}`, runnable, method: 'npm', sudo: true };
    // Plain npm, so the terminal shows the real permission error.
    return { command, runnable, method: 'npm', sudo: false };
  };
  const plain = (method: InstallMethod): CommandPlan =>
    ({ command: pick(method.install, env.platform)!, runnable: runnableTrust(recipe, method.trust), method: method.id, sudo: false });
  const runnableDirect = direct.find((method) => runnableTrust(recipe, method.trust));
  if (runnableDirect) return plain(runnableDirect);
  if (npm && runnableTrust(recipe, npm.trust)) return viaNpm(npm);
  if (direct[0]) return plain(direct[0]);
  if (npm) return viaNpm(npm);
  // Nothing here can install it: the first documented line, to copy once the tool is there.
  const fallback = recipe.methods.find((method) => pick(method.install, env.platform));
  return { command: fallback ? pick(fallback.install, env.platform)! : null, runnable: false, method: fallback?.id ?? null, sudo: false };
}

/**
 * The update for the copy of the CLI that is actually installed: its method's own update when
 * that is known (brew upgrades a brew install, npm an npm one), else the CLI's self-update.
 */
export function planUpdate(provider: RunnerId, installed: InstalledCli, env: InstallEnv): CommandPlan | null {
  const recipe = recipeFor(provider);
  const method = installed.method ? recipe.methods.find((candidate) => candidate.id === installed.method) : undefined;
  const own = method?.update && pick(method.update.command, env.platform);
  const template = own ?? recipe.selfUpdate?.command;
  if (!template) return null;
  const trust = own ? method!.update!.trust : recipe.selfUpdate!.trust;
  const command = template.replaceAll('{bin}', quoteExecutable(installed.executable, env.platform));
  if (own && method!.id === 'npm' && !env.npmGlobalWritable && env.platform !== 'win32') {
    if (recipe.noSudoNpm || !env.sudo) return { command, runnable: false, method: 'npm', sudo: false };
    return { command: `sudo ${command}`, runnable: runnableTrust(recipe, trust), method: 'npm', sudo: true };
  }
  // brew and npm upgrade through themselves: without the tool here, the line is only to copy.
  const toolHere = !own || (method!.id !== 'brew' && method!.id !== 'npm') || hasTool(env, method!.needs);
  return { command, runnable: toolHere && runnableTrust(recipe, trust), method: method?.id ?? installed.method, sudo: false };
}

export interface InstalledCli {
  /** What cezar spawns: a bare name or an absolute path. */
  executable: string;
  /** The binary found for it, symlinks resolved; null when nothing was found. */
  path: string | null;
  method: InstallMethodId | null;
}

/**
 * Which installer put this binary here, read from where it really lives. Homebrew keeps installs
 * under `Cellar`/`Caskroom`, npm under `node_modules`, and the Claude and Cursor installers in a
 * versioned folder under `~/.local/share`.
 */
export function installMethodFromPath(path: string): InstallMethodId | null {
  const normalized = path.replaceAll('\\', '/');
  if (/\/(Cellar|Caskroom)\//.test(normalized)) return 'brew';
  if (/\/node_modules\//.test(normalized)) return 'npm';
  if (/\/\.local\/share\/claude\//.test(normalized) || /\/\.local\/bin\/claude(\.exe)?$/i.test(normalized)) return 'native';
  if (/\/\.local\/share\/cursor-agent\//.test(normalized)) return 'script';
  return null;
}

function onPath(executable: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(executable)) return existsSync(executable) ? executable : null;
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD').split(';').map((ext) => ext.toLowerCase())] : [''];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, executable + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Find the binary cezar would spawn and how it was installed. Never throws. */
export function locateInstalledCli(
  executable: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): InstalledCli {
  const found = onPath(executable, platform, env);
  if (!found) return { executable, path: null, method: null };
  let real = found;
  try {
    real = realpathSync(found);
  } catch {
    // a dangling link still names its folder
  }
  return { executable, path: found, method: installMethodFromPath(real) ?? installMethodFromPath(found) };
}

export type VersionState = 'current' | 'update-available' | 'update-required' | 'unknown';

/** Below the minimum is `update-required`; behind the registry's latest is `update-available`. */
export function versionState(installed: string | null, minimum: string | null, latest: string | null): VersionState {
  if (!installed || !parseVersion(installed)) return 'unknown';
  if (minimum && parseVersion(minimum) && compareVersions(installed, minimum) < 0) return 'update-required';
  if (latest && parseVersion(latest)) return compareVersions(latest, installed) > 0 ? 'update-available' : 'current';
  return minimum ? 'current' : 'unknown';
}

/** The copy line the install hints quote: what this machine would run, else the docs page. */
export function installHintCommand(provider: RunnerId, platform: NodeJS.Platform = process.platform): string {
  const recipe = recipeFor(provider);
  const first = recipe.methods.find((method) => pick(method.install, platform));
  return first ? pick(first.install, platform)! : recipe.docsUrl;
}
