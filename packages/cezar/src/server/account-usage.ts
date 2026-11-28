import { Hono } from 'hono';
import {
  accountUsageQuerySchema, accountUsageSwitchUpdateSchema,
  type AccountUsageReport, type AccountUsageResult, type AccountUsageStatus, type AccountUsageWindow,
} from '@open-mercato/cezar-contract';
import { probeCodexUsageDetailed } from '../core/codex-usage-probe.ts';
import { PROVIDER_IDS } from '../core/provider-auth.ts';
import { buildPlanUsageReport } from '../usage-ledger/report.ts';
import { loadAgentAccounts, mergeWriteAgentAccounts, usageCheckAllowed } from '../workspace/agent-accounts.ts';
import { listAgentProfiles, type ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { jsonZodValidator, queryZodValidator } from './validators.ts';

/** Fixed sentences: a provider's own error text may echo a token, so none of it is ever passed on. */
const MESSAGES: Record<Exclude<AccountUsageStatus, 'ok'>, string> = {
  'not-allowed': 'usage check not allowed for this account (Settings → Agent accounts)',
  'not-supported': 'this agent has no usage source cezar can read',
  'login-expired': 'login expired; the user must run the agent once on this account',
  forbidden: 'the provider refused the request (401/403); report it, do not retry',
  'rate-limited': 'the provider is rate limiting usage checks; retry at most once, later',
  unreachable: 'the provider could not be reached',
  unavailable: 'no usage reading is available right now',
};

const failed = (base: Pick<AccountUsageResult, 'key' | 'provider' | 'accountId' | 'label'>, status: Exclude<AccountUsageStatus, 'ok'>): AccountUsageResult =>
  ({ ...base, status, message: MESSAGES[status], windows: [] });

/** One result per account. A switched-off or unsupported account is never queried. */
export async function buildAccountUsage(account?: string): Promise<AccountUsageReport> {
  const store = await loadAgentAccounts();
  const profiles = listAgentProfiles(store, PROVIDER_IDS)
    // An unsupported agent's discovered default would only add noise; its stored accounts still answer.
    .filter((p) => !p.isDefault || p.provider === 'claude' || p.provider === 'codex')
    .filter((p) => !p.pending);
  const wanted = account ? profiles.filter((p) => `${p.provider}:${p.id}` === account) : profiles;
  const ledger = wanted.some((p) => p.provider === 'claude' && usageCheckAllowed(store, `claude:${p.id}`))
    ? buildPlanUsageReport({}).windows : [];
  const accounts = await Promise.all(wanted.map(async (profile): Promise<AccountUsageResult> => {
    const key = `${profile.provider}:${profile.id}`;
    const base = { key, provider: profile.provider, accountId: profile.id, label: profile.label };
    if (profile.provider !== 'claude' && profile.provider !== 'codex') return failed(base, 'not-supported');
    if (!usageCheckAllowed(store, key)) return failed(base, 'not-allowed');
    if (profile.provider === 'claude') return claudeFromLedger(base, ledger.filter((w) => w.account.key === key && w.current));
    return codexLive(base, profile);
  }));
  return { generatedAt: new Date().toISOString(), accounts };
}

// Claude has no probe yet (it needs a credential-reading spec): report what sessions last recorded.
function claudeFromLedger(
  base: Pick<AccountUsageResult, 'key' | 'provider' | 'accountId' | 'label'>,
  windows: ReturnType<typeof buildPlanUsageReport>['windows'],
): AccountUsageResult {
  const out: AccountUsageWindow[] = windows.map((w) => ({ kind: w.kind, usedPercent: w.usedPercent?.last ?? null, resetsAt: w.resetsAt }));
  if (out.length === 0) return failed(base, 'unavailable');
  const observedAt = windows.flatMap((w) => w.readings.map((r) => r.at)).sort().at(-1);
  return { ...base, status: 'ok', source: 'ledger', ...(observedAt ? { observedAt } : {}), windows: out };
}

async function codexLive(base: Pick<AccountUsageResult, 'key' | 'provider' | 'accountId' | 'label'>, profile: ResolvedAgentProfile): Promise<AccountUsageResult> {
  const detail = await probeCodexUsageDetailed(profile).catch(() => ({ kind: 'failed' as const, reason: 'unavailable' as const }));
  if (detail.kind === 'failed') return failed(base, detail.reason === 'no-identity' ? 'unavailable' : detail.reason);
  const { observation } = detail.result;
  const windows: AccountUsageWindow[] = observation.windows.map((w) => ({
    kind: w.kind === 'five-hour' || w.kind === 'weekly' ? w.kind : 'other',
    usedPercent: w.usedPercent,
    resetsAt: w.resetsAt ? new Date(w.resetsAt).toISOString() : null,
  }));
  if (windows.length === 0) return failed(base, 'unavailable');
  return { ...base, status: 'ok', source: 'probe', observedAt: new Date(observation.observedAt).toISOString(), windows };
}

/**
 * `GET /workspace/account-usage` (what `cez usage --live` calls) and the per-account switch.
 * Local-only: `allowed` is the same machine boundary as the accounts routes (issue #1745).
 */
export function accountUsageRoutes(allowed: () => boolean) {
  return new Hono()
    .get('/workspace/account-usage', queryZodValidator(accountUsageQuerySchema), async (c) => {
      if (!allowed()) return c.json({ error: 'account usage is available on the local cockpit only' }, 409);
      return c.json(await buildAccountUsage(c.req.valid('query').account), 200);
    })
    .get('/workspace/account-usage/switch', async (c) => {
      if (!allowed()) return c.json({ accounts: {} as Record<string, boolean> }, 200);
      return c.json({ accounts: (await loadAgentAccounts()).usageCheck }, 200);
    })
    .put('/workspace/account-usage/switch', jsonZodValidator(accountUsageSwitchUpdateSchema), async (c) => {
      if (!allowed()) return c.json({ error: 'account usage is available on the local cockpit only' }, 409);
      const { account, allowed: on } = c.req.valid('json');
      try {
        const next = await mergeWriteAgentAccounts((store) => { store.usageCheck = { ...store.usageCheck, [account]: on }; });
        return c.json({ accounts: next.usageCheck }, 200);
      } catch {
        return c.json({ error: 'Could not save the setting (is the cezar home writable?)' }, 409);
      }
    });
}
