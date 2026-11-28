import { accountLoginFingerprint } from '../agent-config/account-identity.ts';
import type { LedgerAccountRef } from './recorder.ts';
import { ledgerAccountKey } from './recorder.ts';

const lastKnown = new Map<string, string>();

/**
 * The ledger's view of an account: its key, label and a fingerprint of the login it holds now.
 * Claude rewrites `.claude.json` often, so a read that fails mid-write falls back to the last
 * fingerprint this process saw for the same folder rather than inventing a new login.
 */
export async function ledgerAccountRef(provider: 'claude' | 'codex', profile: { id: string; label: string; path: string }): Promise<LedgerAccountRef & { provider: 'claude' | 'codex' }> {
  const cacheKey = `${provider}\u0000${profile.path}`;
  let identity = process.env.CEZ_DRY_RUN === '1' ? undefined : await accountLoginFingerprint(provider, profile.path);
  if (identity) lastKnown.set(cacheKey, identity);
  else identity = lastKnown.get(cacheKey);
  return { provider, key: ledgerAccountKey(provider, profile.id), label: profile.label, ...(identity ? { identity } : {}) };
}

/** For cezar's one-shot calls: the account ref when the runner has plan limits, else undefined. */
export async function oneShotAccountRef(runner: string, profile: { id: string; label: string; path: string } | undefined) {
  if (!profile || (runner !== 'claude' && runner !== 'codex')) return undefined;
  return ledgerAccountRef(runner, profile).catch(() => undefined);
}
