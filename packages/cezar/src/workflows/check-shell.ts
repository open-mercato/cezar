import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface CheckShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

const GIT_BASH_SUFFIXES = [/\\git\\bin\\bash\.exe$/i, /\\git\\usr\\bin\\bash\.exe$/i];

function isGitBash(path: string): boolean {
  const normalized = win32.normalize(path).replaceAll('/', '\\');
  return GIT_BASH_SUFFIXES.some((suffix) => suffix.test(normalized));
}

function candidatePaths(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const pathValue = env.Path ?? env.PATH ?? '';
  for (const directory of pathValue.split(';')) {
    const trimmed = directory.trim().replace(/^"|"$/g, '');
    if (trimmed && isGitBash(win32.join(trimmed, 'bash.exe'))) {
      candidates.push(win32.join(trimmed, 'bash.exe'));
    }
  }

  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
    if (root) candidates.push(win32.join(root, 'Git', 'bin', 'bash.exe'));
  }
  if (env.LOCALAPPDATA) candidates.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  if (env.GIT_INSTALL_ROOT) candidates.push(win32.join(env.GIT_INSTALL_ROOT, 'bin', 'bash.exe'));
  return [...new Set(candidates)];
}

/**
 * Select the shell for a workflow check. Windows' `bash.exe` may be the WSL launcher, which is
 * not a POSIX shell and can fail before the user's command starts when its default distro is
 * unavailable. Prefer an installed Git Bash executable when one is discoverable by filesystem
 * inspection. There is deliberately no child-process probe, PATH rewrite, or config requirement:
 * the check still runs exactly once and reports the same spawn/exit/output result as before.
 */
export function resolveCheckShell(options: CheckShellOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return 'bash';
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  return candidatePaths(env).find((candidate) => fileExists(candidate)) ?? 'bash';
}
