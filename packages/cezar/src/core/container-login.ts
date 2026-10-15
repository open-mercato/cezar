import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { BASE_IMAGE_TAG } from './podman-launcher.ts';
import { PodmanUnavailable, ensureBaseImage, ensurePodmanMachine } from './podman-lifecycle.ts';
import { GUEST_CLAUDE_LOGIN_DIR, containerClaudeLoginDir, containerClaudeLoginReady } from './container-agents.ts';

const USAGE = `usage: cez container-login claude [status]

  claude          sign in once for isolated Claude tasks. The login is the containers' own (not
                  this machine's), kept in ${'~/.cezar/container-logins/claude'}, and every task
                  container refreshes it itself.
  claude status   say whether that login is set up`;

/**
 * `cez container-login claude` — the one-time sign-in behind the container-only Claude login
 * (`containerClaudeLoginDir`). `claude auth login` runs INSIDE the base image with its login store
 * pointed at the mounted directory, so the login is made where it is used: a Linux store, a file,
 * never this machine's Keychain. The person at the terminal opens the printed URL and pastes the code.
 */
export async function runContainerLoginCommand(args: readonly string[], bin = 'podman'): Promise<number> {
  const [agent, sub] = args;
  if (agent !== 'claude' || (sub !== undefined && sub !== 'status')) {
    console.error(USAGE);
    return 1;
  }
  const dir = containerClaudeLoginDir();
  if (sub === 'status') {
    console.log(containerClaudeLoginReady(dir)
      ? `isolated Claude tasks sign in with their own login (${dir})`
      : 'no container login yet — isolated Claude tasks use a copy of this machine\'s login; run `cez container-login claude`');
    return 0;
  }
  try {
    await ensurePodmanMachine(bin);
    console.log('preparing the agent image (first run builds it)…');
    await ensureBaseImage(bin);
  } catch (err) {
    console.error(err instanceof PodmanUnavailable ? err.message : String(err));
    return 1;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tty = process.stdin.isTTY ? ['-it'] : ['-i'];
  const code = await new Promise<number>((resolve) => {
    const child = spawn(bin, [
      'run', ...tty, '--rm',
      '-v', `${dir}:${GUEST_CLAUDE_LOGIN_DIR}`,
      '-e', `CLAUDE_SECURESTORAGE_CONFIG_DIR=${GUEST_CLAUDE_LOGIN_DIR}`,
      BASE_IMAGE_TAG, 'claude', 'auth', 'login',
    ], { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (exit) => resolve(exit ?? 1));
  });
  if (code === 0 && containerClaudeLoginReady(dir)) {
    console.log('\n✓ isolated Claude tasks now sign in with this login and refresh it themselves.');
    return 0;
  }
  console.error('\nthe sign-in did not complete — isolated Claude tasks keep using a copy of this machine\'s login.');
  return 1;
}
