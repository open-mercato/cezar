import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { sandboxRuntimeCliPath } from './claude-guard.js';

function contains(root: string, path: string): boolean {
  const entry = relative(root, path);
  return !isAbsolute(entry) && entry !== '..' && !entry.startsWith(`..${sep}`);
}

export function validationLauncherPath(cwd: string, path: string): string {
  const worktree = realpathSync(cwd);
  return path.split(delimiter).filter((entry) => {
    if (!isAbsolute(entry)) return false;
    try { return !contains(worktree, realpathSync(entry)); } catch { return false; }
  }).join(delimiter);
}

export function createValidationSandbox(cwd: string, prepare: boolean, logDir?: string) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('isolated project checks require macOS or Linux (including WSL 2)');
  }
  const cli = sandboxRuntimeCliPath();
  const worktree = realpathSync(cwd);
  const systemTemp = realpathSync(tmpdir());
  const parent = contains(worktree, systemTemp) ? realpathSync('/tmp') : systemTemp;
  if (contains(worktree, parent)) throw new Error('sandbox policy must be stored outside the task worktree');

  const root = mkdtempSync(join(parent, 'cez-validation-'));
  try {
    const home = join(root, 'home');
    const scratch = join(root, 'tmp');
    const ghConfig = join(home, 'gh');
    mkdirSync(ghConfig, { recursive: true });
    mkdirSync(scratch);
    // Corepack downloads the selected package manager during Prepare. Keep only that cache
    // between gates so the manager also works during the subsequent offline checks.
    const corepack = logDir ? join(realpathSync(logDir), 'validation-corepack') : join(home, 'corepack');
    mkdirSync(corepack, { recursive: true });
    if (realpathSync(corepack) !== corepack) throw new Error('invalid validation tool cache path');
    const settings = join(root, 'sandbox.json');
    const toolchain = dirname(dirname(realpathSync(process.execPath)));
    writeFileSync(settings, JSON.stringify({
      network: {
        // Only the explicit Prepare project action may fetch from package registries.
        allowedDomains: prepare ? ['registry.npmjs.org', 'registry.yarnpkg.com'] : [],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [homedir()],
        allowRead: [worktree, home, scratch, corepack, toolchain],
        allowWrite: [worktree, home, scratch, corepack],
        denyWrite: [join(worktree, '.git')],
      },
    }), { mode: 0o600, flag: 'wx' });
    return {
      env: {
        HOME: home, GH_CONFIG_DIR: ghConfig, TMPDIR: scratch, TMP: scratch, TEMP: scratch, COREPACK_HOME: corepack,
        XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
      },
      command(args: string[]): { executable: string; args: string[] } {
        return { executable: process.execPath, args: [cli, '--settings', settings, '--', '/bin/bash', ...args] };
      },
      cleanup() { rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
