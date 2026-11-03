import { localTimeZone, type UsageAccountBinding, type UsageWindow, type UsageWindowsSnapshot } from '@open-mercato/cezar-contract';
import { MAX_USAGE_LIMIT_WAIT_MS } from '../core/usage-limit.ts';
import { AUTO_RESUME_GRACE_MS } from '../workflows/run.ts';
import { probeCodexUsageWindows } from '../core/codex-usage-probe.ts';
import { loadUsageWindows, saveUsageWindows, isUsageWindowBlocking } from '../workspace/usage-windows.ts';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { digest, type ResetResolver } from './deferred-start.ts';

/** Unknown model applicability is not evidence that the general bucket covers that model. */
export function selectResetWindows(snapshot: UsageWindowsSnapshot, models: Array<string | undefined>, now = Date.now()): UsageWindow[] | null {
  const picked = new Map<string, UsageWindow>();
  // A window that has already reset says nothing about the next one; never let it block forever.
  snapshot = { ...snapshot, windows: snapshot.windows.filter(w => w.resetsAt === null || w.resetsAt > now) };
  for (const model of new Set(models)) {
    const applicable = snapshot.windows.filter(w => w.applicability === 'all' || w.applicability === 'models' && model !== undefined && w.models.includes(model));
    if (snapshot.windows.some(w => w.applicability === 'unknown' || w.applicability === 'models' && model === undefined)) return null;
    // Explicit exhaustion needs a known reopening time even though it cannot create a timed hold.
    if (applicable.some(w => w.resetsAt === null && (w.status === 'blocked' || (w.usedPercent ?? 0) >= 100))) return null;
    const blocking = applicable.filter(w => isUsageWindowBlocking(w, now));
    const selected = blocking.length ? blocking : applicable.filter(w => w.kind === (snapshot.provider === 'claude' ? 'five-hour' : 'primary'));
    if (!selected.length || selected.some(w => w.observedAt > now || w.resetsAt === null || w.resetsAt <= now || w.resetsAt > now + MAX_USAGE_LIMIT_WAIT_MS)) return null;
    for (const w of selected) picked.set(w.id, w);
  }
  return picked.size ? [...picked.values()] : null;
}

export const resolveDeferredReset: ResetResolver = async execution => {
  const account = execution.binding.accounts[0]!;
  if (account.runner !== 'claude' && account.runner !== 'codex') return { reason: 'unsupported', message: 'No reset data is available for this provider.' };
  let binding: UsageAccountBinding = { provider: account.runner, accountId: account.id, profilePath: account.path };
  if (account.runner === 'codex') {
    const profile: ResolvedAgentProfile = { id: account.id, provider: 'codex', label: account.id, configDir: account.path, path: account.path, isDefault: account.id === 'default' };
    const result = await probeCodexUsageWindows(profile);
    if (!result) return { reason: 'check-failed', message: 'Could not check Codex usage metadata. Retry or choose a date and time.' };
    binding = result.binding;
    if (binding.identity) account.identity = binding.identity;
    await saveUsageWindows(binding, result.observation);
  }
  const snapshot = loadUsageWindows(binding);
  if (!snapshot) return { reason: 'no-data', message: account.runner === 'claude' ? 'No reset observed for this Claude account. Cezar learns reset times from Claude tasks run here; checking only reloads saved observations and never starts a model. Choose a date and time instead.' : 'No upcoming reset is available for this Codex account. Refresh usage data or choose a date and time.' };
  const windows = selectResetWindows(snapshot, execution.models.map(m => m.model));
  if (!windows) return { reason: 'no-data', message: 'A required usage window is missing, expired or cannot be matched to every selected model. Choose a date and time.' };
  const latest = Math.max(...windows.map(w => w.resetsAt!));
  const notBefore = new Date(Math.ceil((latest + AUTO_RESUME_GRACE_MS) / 60_000) * 60_000).toISOString();
  const at = new Intl.DateTimeFormat('en-GB', { timeZone: localTimeZone(), dateStyle: 'medium', timeStyle: 'short' });
  const names = windows.map(w => {
    const minutes = Math.max(0, Math.floor((Date.now() - w.observedAt) / 60_000));
    const age = minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} days ago`;
    const label = w.durationMinutes === 300 ? '5-hour' : w.durationMinutes === 10080 ? 'Weekly' : 'Usage limit';
    return `${label}${w.usedPercent === null ? '' : ` · ${Math.round(w.usedPercent)}% used`} · resets ${at.format(new Date(w.resetsAt!))}${w.resetsAt === latest ? ' (sets start)' : ''} · observed ${age}`;
  }).join('; ');
  return { notBefore, observation: `${account.runner} / ${account.id}: ${names}. Previously observed resets, not a live allowance guarantee.`, revision: digest(windows.map(w => ({ id: w.id, resetsAt: w.resetsAt, applicability: w.applicability, models: w.models }))) };
};

/** A newer confirmed block may postpone execution, never rewrite the user's original time. */
export async function deferredHoldUntil(definition: import('./types.ts').ScheduleAutomationDefinition): Promise<number | null> {
  if (!definition.deferredStart || definition.deferredStart.reason !== 'usage-reset') return null;
  let until = 0;
  const now = Date.now();
  for (const account of definition.deferredStart.binding.accounts) {
    if (account.runner !== 'claude' && account.runner !== 'codex') continue;
    if (account.runner === 'codex') {
      // Codex limits are readable without a model turn; read them fresh at the due time
      // rather than relying on ordinary runs to have observed them.
      const profile: ResolvedAgentProfile = { id: account.id, provider: 'codex', label: account.id, configDir: account.path, path: account.path, isDefault: account.id === 'default' };
      const live = await probeCodexUsageWindows(profile, { force: true });
      if (live && live.binding.identity === account.identity) await saveUsageWindows(live.binding, live.observation).catch(() => undefined);
    }
    const snapshot = loadUsageWindows({ provider: account.runner, accountId: account.id, profilePath: account.path, ...(account.identity ? { identity: account.identity } : {}) });
    const models = definition.deferredStart.binding.models?.filter(model => model.runner === account.runner);
    // Old definitions did not retain resolved step models; only account-wide holds can
    // safely apply to those. New definitions include every confirmed agent step.
    for (const window of snapshot?.windows ?? []) {
      if (window.applicability !== 'all' && !(window.applicability === 'models' && models?.some(m => m.model !== undefined && window.models.includes(m.model)))) continue;
      if (window.observedAt > Date.parse(definition.createdAt) && isUsageWindowBlocking(window, now) && window.resetsAt! <= now + MAX_USAGE_LIMIT_WAIT_MS) until = Math.max(until, window.resetsAt! + AUTO_RESUME_GRACE_MS);
    }
  }
  return until || null;
}
