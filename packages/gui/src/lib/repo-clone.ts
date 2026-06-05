import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const exec = promisify(execFile);

const REPOS_DIR = join(homedir(), '.cezar', 'repos');

/**
 * Creates a temporary GIT_ASKPASS script that outputs the token.
 * This avoids embedding the token in the remote URL (which leaks via
 * process listing and persists in .git/config on disk).
 */
async function createAskPassScript(token: string): Promise<string> {
  const scriptPath = join(REPOS_DIR, `.askpass-${randomBytes(8).toString('hex')}`);
  // The script outputs the token when git asks for credentials
  // On Windows this would need to be a .cmd file, but this is a server-side lib
  await writeFile(scriptPath, `#!/bin/sh\necho "${token}"\n`, { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

/**
 * Ensures a local clone of the repo exists and is up-to-date.
 * Returns the absolute path to the repo root.
 *
 * Clones to ~/.cezar/repos/<owner>-<repo>. If already cloned,
 * fetches latest from origin.
 *
 * Uses GIT_ASKPASS to inject the token securely — the token is never
 * embedded in the remote URL or visible in process listings.
 */
export async function ensureRepoClone(
  owner: string,
  repo: string,
  githubToken: string,
  baseBranch: string = 'main',
): Promise<string> {
  await mkdir(REPOS_DIR, { recursive: true });

  const repoDir = join(REPOS_DIR, `${owner}-${repo}`);
  // Clean URL — no credentials embedded
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  // Create temporary askpass script for secure token injection
  const askPassPath = await createAskPassScript(githubToken);

  const gitEnv = {
    ...process.env,
    GIT_ASKPASS: askPassPath,
    // Also set these to prevent git from falling back to other credential helpers
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };

  try {
    if (existsSync(join(repoDir, '.git'))) {
      // Ensure the remote URL doesn't contain embedded credentials
      await exec('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: repoDir, env: gitEnv });
      await exec('git', ['fetch', 'origin'], { cwd: repoDir, env: gitEnv });
      await exec('git', ['checkout', baseBranch], { cwd: repoDir, env: gitEnv }).catch(() => {
        return exec('git', ['checkout', '-b', baseBranch, `origin/${baseBranch}`], { cwd: repoDir, env: gitEnv });
      });
      await exec('git', ['reset', '--hard', `origin/${baseBranch}`], { cwd: repoDir, env: gitEnv });
    } else {
      await exec('git', ['clone', '--depth', '50', '--branch', baseBranch, cloneUrl, repoDir], { env: gitEnv });
    }
  } finally {
    // Always clean up the askpass script
    await rm(askPassPath, { force: true }).catch(() => {});
  }

  return repoDir;
}
