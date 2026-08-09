import { readdir, realpath } from 'node:fs/promises';
import { profileEnv, looksLikeProfileDir } from '../core/agent-profiles.ts';
import type { ProviderId } from '../core/provider-auth.ts';
import { agentHomePaths, expandTilde } from '../paths.ts';
import {
  DEFAULT_AGENT_ACCOUNT_ID,
  loadAgentAccounts,
  selectionFor,
  type AgentAccount,
  type AgentAccountStore,
} from './agent-accounts.ts';

/**
 * Resolving an agent account against `~/.cezar/agent-accounts.json` — the I/O half of
 * `src/core/agent-profiles.ts` (which stays pure and owns the vendor knowledge).
 *
 * Nothing here is cached. `~/.cezar/` is shared by every cezar process on the machine (a `serve`
 * per repo, headless `cezar run`s, a settings PUT), so a snapshot is a staleness bug waiting to
 * happen — and one small JSON read is free next to spawning an agent CLI.
 */

/** An account as the rest of the codebase consumes it: id, provider, and the dir to point at. */
export interface ResolvedAgentProfile {
  id: string;
  provider: ProviderId;
  label: string;
  /** As stored (`~` kept) — what the user typed, or the discovered default's path. */
  configDir: string;
  /** Expanded absolute path — what actually gets handed to the CLI. */
  path: string;
  /** True for the discovered account, which is never stored and cannot be edited or deleted. */
  isDefault: boolean;
}

/**
 * The implicit account for a provider: whatever `agentHomePaths()` discovers, which already
 * honours the vendors' own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME`. Setting one of
 * those on the cezar process therefore moves the DEFAULT account rather than being ignored.
 */
export function defaultAgentProfile(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentProfile {
  const home = agentHomePaths(env);
  const path = provider === 'codex' ? home.codex : provider === 'opencode' ? home.opencodeConfig : home.claude;
  return {
    id: DEFAULT_AGENT_ACCOUNT_ID,
    provider,
    label: 'Default',
    configDir: path,
    path,
    isDefault: true,
  };
}

/** Expand a stored account into its resolved form. Pure; the caller supplies the row. */
export function resolveStoredProfile(account: AgentAccount): ResolvedAgentProfile {
  return {
    id: account.id,
    provider: account.provider,
    label: account.label || account.id,
    configDir: account.configDir,
    path: expandTilde(account.configDir),
    isDefault: false,
  };
}

/** Every account for `provider`, discovered default first, then the stored extras in file order. */
export function profilesForProvider(
  store: Pick<AgentAccountStore, 'accounts'>,
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentProfile[] {
  return [
    defaultAgentProfile(provider, env),
    ...store.accounts.filter((a) => a.provider === provider).map(resolveStoredProfile),
  ];
}

/** Every account across every provider — the listing route's source. */
export function listAgentProfiles(
  store: Pick<AgentAccountStore, 'accounts'>,
  providers: readonly ProviderId[],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentProfile[] {
  return providers.flatMap((provider) => profilesForProvider(store, provider, env));
}

/**
 * The account a given `(project, provider)` pair resolves to.
 *
 * `profileId` is the caller's explicit choice — a run's recorded account, or a composer override.
 * When it is absent the project's stored selection decides, and when THAT is absent (or names an
 * account that no longer exists) the answer is the discovered default.
 *
 * Note the deliberate asymmetry with a missing DIRECTORY: an UNKNOWN id degrades silently to the
 * default, because a dangling reference names no account and the default is the only safe answer.
 * A KNOWN id whose directory has vanished does NOT degrade — see `profileDirState`. Falling back
 * there would run the task on the personal subscription while the UI still said "Work", and a
 * billing boundary is not a preference to degrade quietly across.
 */
export function selectProfile(
  store: AgentAccountStore,
  options: { provider: ProviderId; repoRoot?: string; profileId?: string; env?: NodeJS.ProcessEnv },
): ResolvedAgentProfile {
  const { provider, repoRoot, profileId } = options;
  const env = options.env ?? process.env;
  const chosen = profileId ?? selectionFor(store, repoRoot, provider);
  if (chosen === undefined || chosen === DEFAULT_AGENT_ACCOUNT_ID) return defaultAgentProfile(provider, env);
  const stored = store.accounts.find((a) => a.id === chosen && a.provider === provider);
  return stored ? resolveStoredProfile(stored) : defaultAgentProfile(provider, env);
}

/**
 * The env a spawned `provider` process needs for the account selected by `repoRoot`/`profileId`.
 *
 * `{}` for the default account, which is the whole point: the zero-config path adds nothing to the
 * child environment. Reads the store per call (see the module note) and never throws — an
 * unreadable home degrades to the default account, which is the behaviour cezar had before
 * accounts existed.
 */
export async function resolveProfileEnvForRoot(
  repoRoot: string | undefined,
  provider: ProviderId,
  profileId?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: ResolvedAgentProfile; env: Record<string, string> }> {
  let store: AgentAccountStore;
  try {
    store = await loadAgentAccounts();
  } catch {
    return { profile: defaultAgentProfile(provider, env), env: {} };
  }
  const profile = selectProfile(store, { provider, repoRoot, profileId, env });
  // The default account contributes nothing: `agentHomePaths()` already reflects whatever the host
  // env says, so re-exporting it would be a no-op at best and a surprise at worst.
  return { profile, env: profile.isDefault ? {} : profileEnv(provider, profile.path) };
}

/** Whether an account's directory exists and looks like the agent wrote it. Never throws. */
export async function profileDirState(
  provider: ProviderId,
  path: string,
): Promise<{ exists: boolean; looksValid: boolean }> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return { exists: false, looksValid: false };
  }
  return { exists: true, looksValid: looksLikeProfileDir(provider, entries) };
}

/**
 * Is `path` the same directory as an existing account's (or the default's)?
 *
 * Compared through `realpath` so two spellings of one dir — a symlink, a trailing slash — cannot
 * become two accounts that silently share a session store. A path that does not exist yet cannot
 * collide with anything, which is correct: the CLI has not created it, so it is nobody's home.
 */
export async function sameProfileDir(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}
