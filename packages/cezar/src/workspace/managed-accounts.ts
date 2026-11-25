import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProviderId } from '../core/provider-auth.ts';
import { buildChildEnv } from '../core/agent-env.ts';
import { profileEnv } from '../core/agent-profiles.ts';
import { loginExecutable } from '../core/login-drivers/process.ts';
import { spawnableCommand } from '../core/windows-shim.ts';
import { agentHomesDir, expandTilde } from '../paths.ts';
import { loadAgentAccounts, mergeWriteAgentAccounts, type AgentAccount } from './agent-accounts.ts';

/**
 * Account folders cezar creates itself (spec 2026-11-24-add-account-in-cockpit): one private
 * folder per account under `~/.cezar/agent-homes/<provider>/<id>`, so a login added from the
 * cockpit never touches the user's own CLI login. Only these folders are ever deleted by cezar.
 */

/** A pending account older than this, with no live sign-in, is swept at boot. */
export const PENDING_ACCOUNT_MAX_AGE_MS = 24 * 60 * 60_000;
const LOGOUT_TIMEOUT_MS = 15_000;

export function managedAccountDir(provider: ProviderId, id: string): string {
  return join(agentHomesDir(), provider, id);
}

/**
 * Create the account's folder (and `agent-homes/` itself) private to this user. Throws `EEXIST`
 * when the folder is already there: a leftover is never adopted, credentials and all.
 */
export async function createManagedAccountDir(provider: ProviderId, id: string): Promise<string> {
  await mkdir(join(agentHomesDir(), provider), { recursive: true, mode: 0o700 });
  await chmod(agentHomesDir(), 0o700).catch(() => {});
  const dir = managedAccountDir(provider, id);
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

/**
 * Is `path` strictly inside `agentHomesDir()`, symlinks resolved? The one gate on every delete: a
 * hand-edited `configDir` must never make cezar remove a folder it did not create.
 */
export async function isInsideAgentHomes(path: string): Promise<boolean> {
  let root: string;
  let target: string;
  try {
    root = await realpath(agentHomesDir());
    target = await realpath(expandTilde(path));
  } catch {
    return false;
  }
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * May cezar treat this account's folder as one it made (log it out, delete it, let a phone remove
 * it)? Only its own `agent-homes/<provider>/<id>`, symlinks resolved; a hand-edited flag or path
 * never widens that. A folder already gone is judged by its stored path.
 */
export async function isManagedAccountDir(account: Pick<AgentAccount, 'provider' | 'id' | 'configDir'>): Promise<boolean> {
  const expanded = resolve(expandTilde(account.configDir));
  if (expanded !== resolve(managedAccountDir(account.provider, account.id))) return false;
  try {
    await lstat(expanded);
  } catch {
    return true;
  }
  return isInsideAgentHomes(expanded);
}

/** Delete a managed account's folder. False when it is gone already or outside `agent-homes/`. */
export async function removeManagedAccountDir(path: string): Promise<boolean> {
  const expanded = expandTilde(path);
  try {
    await lstat(expanded);
  } catch {
    return false;
  }
  if (!(await isInsideAgentHomes(expanded))) return false;
  await rm(expanded, { recursive: true, force: true });
  return true;
}

/** The CLI's own logout, so a Keychain item tied to the folder does not outlive it. */
const LOGOUT_ARGS: Partial<Record<ProviderId, readonly string[]>> = {
  claude: ['auth', 'logout'],
  codex: ['logout'],
};

export type RunLogout = (executable: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

const defaultRunLogout: RunLogout = (executable, args, env) =>
  new Promise((resolve) => {
    // Best-effort: whatever the CLI answers, the folder is deleted next.
    const [program, argv] = spawnableCommand(executable, args, { env });
    execFile(program, argv, { env, timeout: LOGOUT_TIMEOUT_MS, windowsHide: true }, () => resolve());
  });

/** Log the account out with its own CLI, under the account's env. Never throws. */
export async function logoutManagedAccount(
  account: Pick<AgentAccount, 'provider' | 'configDir'>,
  runLogout: RunLogout = defaultRunLogout,
): Promise<void> {
  const args = LOGOUT_ARGS[account.provider];
  if (!args) return;
  const env = buildChildEnv({ backend: account.provider, extraEnv: profileEnv(account.provider, expandTilde(account.configDir)) });
  await runLogout(loginExecutable(account.provider), args, env).catch(() => {});
}

/**
 * Remove pending managed accounts nobody finished signing in (a closed tab, a closed laptop).
 * `isLive` names accounts with a sign-in still running, which are kept. Never throws.
 */
export async function sweepPendingAccounts(options: {
  now?: number;
  maxAgeMs?: number;
  isLive?: (provider: ProviderId, id: string) => boolean;
} = {}): Promise<string[]> {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? PENDING_ACCOUNT_MAX_AGE_MS;
  const stale = (account: AgentAccount) => {
    if (!account.managed || !account.pending) return false;
    if (options.isLive?.(account.provider, account.id)) return false;
    const added = Date.parse(account.addedAt);
    return !Number.isFinite(added) || now - added > maxAge;
  };
  let candidates: AgentAccount[];
  try {
    candidates = (await loadAgentAccounts()).accounts.filter(stale);
  } catch {
    return [];
  }
  if (candidates.length === 0) return [];
  const ids = new Set(candidates.map((account) => account.id));
  // Only rows the write really dropped: one that signed in meanwhile keeps its folder.
  const removed: AgentAccount[] = [];
  try {
    await mergeWriteAgentAccounts((store) => {
      removed.length = 0;
      store.accounts = store.accounts.filter((account) => {
        const drop = ids.has(account.id) && stale(account);
        if (drop) removed.push(account);
        return !drop;
      });
    });
  } catch {
    return [];
  }
  for (const account of removed) {
    if (await isManagedAccountDir(account).catch(() => false)) await removeManagedAccountDir(account.configDir).catch(() => false);
  }
  return removed.map((account) => account.id);
}

/** A pending account's first confirmed sign-in makes it usable. True when a row changed. */
export async function markAccountSignedIn(provider: ProviderId, id: string): Promise<boolean> {
  let changed = false;
  try {
    const current = (await loadAgentAccounts()).accounts.find((account) => account.id === id && account.provider === provider);
    if (!current?.pending) return false;
    await mergeWriteAgentAccounts((store) => {
      const entry = store.accounts.find((account) => account.id === id && account.provider === provider);
      if (!entry?.pending) return;
      delete entry.pending;
      changed = true;
    });
  } catch {
    return false;
  }
  return changed;
}
