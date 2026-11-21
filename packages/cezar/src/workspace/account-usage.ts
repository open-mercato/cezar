import { realpathSync } from 'node:fs';
import type { AccountUsageEntry, RunLiveUsage, UsageWindow, UsageWindowsSnapshot } from '@open-mercato/cezar-contract';
import { agentAccountRouteId } from '@open-mercato/cezar-contract';
import type { ProviderId } from '../core/provider-auth.ts';
import { DEFAULT_AGENT_ACCOUNT_ID, loadAgentAccounts, type AgentAccountStore } from './agent-accounts.ts';
import { listAgentProfiles, type ResolvedAgentProfile } from './agent-profiles.ts';
import { futureUsageWindows, loadAllUsageWindows, loadLatestUsageWindows } from './usage-windows.ts';

const USAGE_PROVIDERS = ['claude', 'codex'] as const satisfies readonly ProviderId[];

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function sameProfilePath(a: string, b: string): boolean {
  if (a === b) return true;
  return safeRealpath(a) === safeRealpath(b);
}

function windowKey(window: UsageWindow, provider: 'claude' | 'codex'): string | null {
  if (provider === 'claude') {
    if (window.id === 'terminal-limit') return 'five_hour';
    if (window.id === 'five_hour' || window.id === 'seven_day') return window.id;
    if (window.durationMinutes !== null && window.durationMinutes !== undefined) {
      if (window.durationMinutes <= 360) return 'five_hour';
      if (window.durationMinutes >= 1440) return 'seven_day';
    }
    return null;
  }
  if (window.applicability === 'all' || window.applicability === 'unknown') {
    if (window.durationMinutes !== null && window.durationMinutes !== undefined) {
      if (window.durationMinutes <= 360) return 'five_hour';
      if (window.durationMinutes >= 1440) return 'seven_day';
    }
    if (window.kind === 'primary') return 'five_hour';
    if (window.kind === 'secondary') return 'seven_day';
  }
  return null;
}

/** Plan windows the cockpit shows, in status-line order. */
export function pickAccountUsageWindows(
  snapshot: UsageWindowsSnapshot,
  now = Date.now(),
): UsageWindow[] {
  const order = ['five_hour', 'seven_day'] as const;
  const future = futureUsageWindows(snapshot, now).filter((w) => w.usedPercent !== null);
  const byKey = new Map<string, UsageWindow>();
  for (const window of future) {
    const key = windowKey(window, snapshot.provider);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, window);
      continue;
    }
    if (window.status === 'blocked' && existing.status !== 'blocked') {
      if (window.observedAt >= existing.observedAt) {
        byKey.set(key, window);
      }
    } else if (existing.status === 'blocked' && window.status !== 'blocked') {
      if (window.observedAt > existing.observedAt) {
        byKey.set(key, window);
      }
    } else if (window.observedAt > existing.observedAt) {
      byKey.set(key, window);
    }
  }
  return order.map((key) => byKey.get(key)).filter((w): w is UsageWindow => w !== undefined);
}

export function snapshotToRunLiveUsage(snapshot: UsageWindowsSnapshot, now = Date.now()): RunLiveUsage | null {
  const windows = pickAccountUsageWindows(snapshot, now);
  if (!windows.length) return null;
  const windowObservedAt = Math.max(...windows.map((w) => w.observedAt));
  return {
    at: new Date(windowObservedAt).toISOString(),
    limits: windows.map((w) => {
      const key = windowKey(w, snapshot.provider)!;
      return {
        window: key,
        utilization: Math.min(1, Math.max(0, (w.usedPercent ?? 0) / 100)),
        resetsAt: new Date(w.resetsAt!).toISOString(),
      };
    }),
  };
}

export function usageEntryForProfile(
  profile: ResolvedAgentProfile,
  snapshots: UsageWindowsSnapshot[],
  now = Date.now(),
): AccountUsageEntry | null {
  if (profile.provider !== 'claude' && profile.provider !== 'codex') return null;
  const binding = {
    provider: profile.provider,
    accountId: profile.id,
    profilePath: profile.path,
  };
  const matches = snapshots.filter(
    (s) =>
      s.binding.provider === binding.provider &&
      s.binding.accountId === binding.accountId &&
      sameProfilePath(s.binding.profilePath, binding.profilePath),
  );
  let snapshot = matches.length
    ? matches.reduce((best, next) => (next.observedAt > best.observedAt ? next : best))
    : null;
  if (!snapshot) {
    const loaded = loadLatestUsageWindows(binding);
    if (loaded && sameProfilePath(loaded.binding.profilePath, binding.profilePath)) {
      snapshot = loaded;
    } else {
      const all = loadAllUsageWindows().filter(
        (s) =>
          s.binding.provider === binding.provider &&
          s.binding.accountId === binding.accountId &&
          sameProfilePath(s.binding.profilePath, binding.profilePath),
      );
      if (all.length) {
        snapshot = all.reduce((best, next) => (next.observedAt > best.observedAt ? next : best));
      }
    }
  }
  if (!snapshot) return null;
  const usage = snapshotToRunLiveUsage(snapshot, now);
  if (!usage) return null;
  return {
    id: profile.id,
    provider: profile.provider,
    label: profile.label,
    isDefault: profile.isDefault,
    routeId: agentAccountRouteId(profile),
    usage,
  };
}

/** Every claude/codex profile that still has an unexpired plan window in the store. */
export async function listAccountUsage(now = Date.now()): Promise<AccountUsageEntry[]> {
  let store: AgentAccountStore;
  try {
    store = await loadAgentAccounts();
  } catch {
    return [];
  }
  const snapshots = loadAllUsageWindows();
  const profiles = listAgentProfiles(store, USAGE_PROVIDERS).filter(
    (p) => p.provider === 'claude' || p.provider === 'codex',
  );
  const entries: AccountUsageEntry[] = [];
  for (const profile of profiles) {
    const entry = usageEntryForProfile(profile, snapshots, now);
    if (entry) entries.push(entry);
  }
  // Stable order: non-default first (stored order), then discovered default per provider.
  return entries.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
}

export { DEFAULT_AGENT_ACCOUNT_ID };
