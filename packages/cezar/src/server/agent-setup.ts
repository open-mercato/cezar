import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import type { AgentSetupProvider } from '@open-mercato/cezar-contract';

/**
 * How each agent is installed (spec 2026-10-26-first-run-onboarding, "Set up an agent here"). The
 * only place the install commands of the first-run page live; a request can never add to them.
 */

export const AGENT_SETUP_PROVIDERS: readonly AgentSetupProvider[] = ['claude', 'codex', 'opencode', 'cursor', 'copilot'];

const NPM_PACKAGE: Partial<Record<AgentSetupProvider, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  // Pinned: OpenCode 2.x replaced the server API the runner drives (`unsupportedServerMessage`).
  opencode: 'opencode-ai@1',
  copilot: '@github/copilot',
};

const SCRIPT: Partial<Record<AgentSetupProvider, { unix: string; windows?: string }>> = {
  claude: {
    unix: 'curl -fsSL https://claude.ai/install.sh | bash',
    windows: 'irm https://claude.ai/install.ps1 | iex',
  },
  cursor: { unix: 'curl https://cursor.com/install -fsS | bash' },
};

export interface InstallEnv {
  platform: NodeJS.Platform;
  npm: boolean;
  /** A global npm install works without sudo. */
  npmGlobalWritable: boolean;
  curl: boolean;
  sudo: boolean;
}

/**
 * The one command to run here, or null when this machine has nothing that can install it.
 * Without sudo first: npm where its global folder is ours, then the vendor's script, and `sudo npm`
 * only when nothing else is left (the terminal is where the password goes).
 */
export function installCommand(provider: AgentSetupProvider, env: InstallEnv): string | null {
  const pkg = NPM_PACKAGE[provider];
  const script = SCRIPT[provider];
  const npmInstall = pkg && env.npm ? `npm install -g ${pkg}` : null;
  // A native `.exe` before npm's `.cmd` shim, which `resolveClaudeBin` deliberately does not accept.
  if (env.platform === 'win32') return script?.windows ?? npmInstall;
  if (npmInstall && env.npmGlobalWritable) return npmInstall;
  if (script && env.curl) return script.unix;
  if (npmInstall && env.sudo) return `sudo ${npmInstall}`;
  return npmInstall;
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
    execFile('npm', ['prefix', '-g'], { timeout: PROBE_TIMEOUT_MS, shell: platform === 'win32' }, (error, stdout) => {
      const prefix = stdout?.toString().trim();
      resolve(error || !prefix ? null : prefix);
    });
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
  const [prefix, curl, sudo] = await Promise.all([npmGlobalPrefix(platform), onPath('curl', path), onPath('sudo', path)]);
  return {
    platform,
    npm: prefix !== null,
    npmGlobalWritable: prefix !== null && (await globalFoldersWritable(prefix, platform)),
    curl,
    sudo,
  };
}
