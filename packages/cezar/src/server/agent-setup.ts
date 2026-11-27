import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { agentSetupProviderSchema, type AgentSetupProvider } from '@open-mercato/cezar-contract';

import { planInstall, type InstallEnv } from '../core/agent-install.ts';

/**
 * The machine half of installing an agent (spec 2026-10-26-first-run-onboarding, "Set up an agent
 * here"): what this host can install with. The commands live in `core/agent-install.ts`; a request
 * can never add to them.
 */

export const AGENT_SETUP_PROVIDERS: readonly AgentSetupProvider[] = agentSetupProviderSchema.options;

export type { InstallEnv } from '../core/agent-install.ts';

/** The command cezar would RUN here, or null when it would not run one (nothing here can install
 *  it, or the recipe is copy-only). `planInstall` also answers the line to copy instead. */
export function installCommand(provider: AgentSetupProvider, env: InstallEnv): string | null {
  const plan = planInstall(provider, env);
  return plan.runnable ? plan.command : null;
}

/** The line the PTY's shell runs for a command the user reads. A PowerShell one-liner goes encoded,
 *  because its quotes and pipe would otherwise have to survive `cmd.exe` and the PTY's own quoting. */
export function shellLine(command: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32' || !command.startsWith('irm ')) return command;
  return `powershell -NoProfile -EncodedCommand ${Buffer.from(command, 'utf16le').toString('base64')}`;
}

const PROBE_TIMEOUT_MS = 10_000;

function npmGlobalPrefix(platform: NodeJS.Platform): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('npm', ['prefix', '-g'], { timeout: PROBE_TIMEOUT_MS, shell: platform === 'win32' }, (error, stdout) => {
        const prefix = stdout?.toString().trim();
        resolve(error || !prefix ? null : prefix);
      });
    } catch {
      resolve(null); // a synchronous spawn throw degrades like a failed probe (#2312)
    }
  });
}

async function writable(path: string): Promise<boolean | 'absent'> {
  try {
    await access(path, fsConstants.W_OK);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : false;
  }
}

/** npm writes to both folders; one that does not exist yet is created under the prefix. */
async function globalFoldersWritable(prefix: string, platform: NodeJS.Platform): Promise<boolean> {
  const prefixState = await writable(prefix);
  if (platform === 'win32') return prefixState === true;
  for (const folder of [join(prefix, 'lib', 'node_modules'), join(prefix, 'bin')]) {
    const state = await writable(folder);
    if (state === false || (state === 'absent' && prefixState !== true)) return false;
  }
  return true;
}

function onPath(name: string, path: string): Promise<boolean> {
  return Promise.all(path.split(delimiter).filter(Boolean).map(async (dir) => {
    try {
      await access(join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  })).then((found) => found.includes(true));
}

export async function probeInstallEnv(platform: NodeJS.Platform = process.platform): Promise<InstallEnv> {
  const path = process.env.PATH ?? '';
  const [prefix, curl, sudo, brew] = await Promise.all([npmGlobalPrefix(platform), onPath('curl', path), onPath('sudo', path), onPath('brew', path)]);
  return {
    platform,
    npm: prefix !== null,
    npmGlobalWritable: prefix !== null && (await globalFoldersWritable(prefix, platform)),
    curl,
    sudo,
    brew,
  };
}
