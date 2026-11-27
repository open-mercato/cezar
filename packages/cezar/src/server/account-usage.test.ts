import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAccountsPath } from '../paths.ts';

const probe = vi.fn();
vi.mock('../core/codex-usage-probe.ts', () => ({ probeCodexUsageDetailed: (...a: unknown[]) => probe(...a) }));

const { accountUsageRoutes, buildAccountUsage } = await import('./account-usage.ts');
const { classifyCodexProbeError } = await vi.importActual<typeof import('../core/codex-usage-probe.ts')>('../core/codex-usage-probe.ts');

function seed(usageCheck: Record<string, boolean>): void {
  mkdirSync(join(agentAccountsPath(), '..'), { recursive: true });
  writeFileSync(agentAccountsPath(), JSON.stringify({
    version: 1, usageCheck,
    accounts: [
      { id: 'work', provider: 'codex', configDir: '/tmp/cez-test-codex-work', label: 'Work' },
      { id: 'gem', provider: 'kimi', configDir: '/tmp/cez-test-kimi', label: 'Gem' },
    ],
  }));
}
const find = async (key: string, account?: string) => (await buildAccountUsage(account)).accounts.find((a) => a.key === key)!;

beforeEach(() => { probe.mockReset(); seed({}); });

describe('account usage (#1745)', () => {
  it('never queries an account whose switch is off and says so', async () => {
    const report = await buildAccountUsage();
    expect(probe).not.toHaveBeenCalled();
    const codex = report.accounts.find((a) => a.key === 'codex:work')!;
    expect(codex).toMatchObject({ status: 'not-allowed', windows: [] });
    expect(report.accounts.find((a) => a.key === 'claude:default')!.status).toBe('not-allowed');
  });

  it('reports an agent without a usage source as not-supported, switch or no switch', async () => {
    seed({ 'kimi:gem': true });
    expect((await find('kimi:gem')).status).toBe('not-supported');
  });

  it('returns used % and reset time for an allowed Codex account', async () => {
    seed({ 'codex:work': true });
    probe.mockResolvedValue({ kind: 'ok', result: { binding: {}, observation: { provider: 'codex', source: 'codex-read', observedAt: 1_800_000_000_000, windows: [
      { id: 'a', kind: 'five-hour', applicability: 'all', models: [], resetsAt: 1_800_003_600_000, durationMinutes: 300, usedPercent: 42, status: 'allowed', observedAt: 1_800_000_000_000 },
    ] } } });
    const row = await find('codex:work', 'codex:work');
    expect(row).toMatchObject({ status: 'ok', source: 'probe', windows: [{ kind: 'five-hour', usedPercent: 42, resetsAt: new Date(1_800_003_600_000).toISOString() }] });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each(['login-expired', 'forbidden', 'rate-limited', 'unreachable', 'unavailable'] as const)('maps %s to its own non-fatal status', async (reason) => {
    seed({ 'codex:work': true });
    probe.mockResolvedValue({ kind: 'failed', reason });
    const row = await find('codex:work');
    expect(row.status).toBe(reason);
    expect(row.windows).toEqual([]);
  });

  it('degrades to unavailable when the probe throws, and never echoes its message', async () => {
    seed({ 'codex:work': true });
    probe.mockRejectedValue(new Error('Bearer sk-secret-token-123 rejected'));
    const body = JSON.stringify(await buildAccountUsage());
    expect(body).not.toContain('sk-secret');
    expect((await find('codex:work')).status).toBe('unavailable');
  });

  it('classifies provider errors by words only', () => {
    expect(classifyCodexProbeError(new Error('429 Too Many Requests'))).toBe('rate-limited');
    expect(classifyCodexProbeError(new Error('HTTP 403 forbidden'))).toBe('forbidden');
    expect(classifyCodexProbeError(new Error('401 unauthorized'))).toBe('forbidden');
    expect(classifyCodexProbeError(new Error('refresh token expired, please log in again'))).toBe('login-expired');
    expect(classifyCodexProbeError(new Error('getaddrinfo ENOTFOUND chatgpt.com'))).toBe('unreachable');
    expect(classifyCodexProbeError('boom')).toBe('unavailable');
    expect(classifyCodexProbeError(undefined)).toBe('unavailable');
  });
});

describe('account usage routes', () => {
  it('saves a switch, reads it back, and refuses a malformed key', async () => {
    const app = accountUsageRoutes(() => true);
    const put = await app.request('/workspace/account-usage/switch', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'codex:work', allowed: true }) });
    expect(put.status).toBe(200);
    expect(await (await app.request('/workspace/account-usage/switch')).json()).toEqual({ accounts: { 'codex:work': true } });
    const bad = await app.request('/workspace/account-usage/switch', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: '../x', allowed: true }) });
    expect(bad.status).toBe(400);
  });

  it('is local-only: a hosted cockpit gets 409 and no switch values', async () => {
    seed({ 'codex:work': true });
    const app = accountUsageRoutes(() => false);
    expect((await app.request('/workspace/account-usage')).status).toBe(409);
    expect(await (await app.request('/workspace/account-usage/switch')).json()).toEqual({ accounts: {} });
    expect((await app.request('/workspace/account-usage/switch', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'codex:work', allowed: false }) })).status).toBe(409);
  });
});
