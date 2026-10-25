import { describe, expect, it } from 'vitest';
import { normalizeClaudeUsageWindows, normalizeCodexUsageWindows } from '../core/usage-windows.ts';
import { selectResetWindows } from './deferred-reset.ts';
import type { UsageWindow, UsageWindowsSnapshot } from '@open-mercato/cezar-contract';
const NOW = Date.parse('2026-10-13T09:00:00Z');
const window = (extra: Partial<UsageWindow> = {}): UsageWindow => ({ id: 'five_hour', kind: 'five-hour', applicability: 'all', models: [], resetsAt: NOW + 300_000, durationMinutes: 300, usedPercent: 20, status: 'allowed', observedAt: NOW - 3_600_000, ...extra });
const snapshot = (windows: UsageWindow[], provider: 'claude' | 'codex' = 'claude'): UsageWindowsSnapshot => ({ provider, source: provider === 'claude' ? 'claude-stream' : 'codex-read', observedAt: NOW, windows, binding: { provider, accountId: 'default', profilePath: '/profile' } });
describe('usage reset selection', () => {
  it('keeps an old observation eligible until its selected window expires', () => {
    const w = window();
    expect(selectResetWindows(snapshot([w]), ['sonnet'], NOW)).toEqual([w]);
    expect(selectResetWindows(snapshot([w]), ['sonnet'], w.resetsAt!)).toBeNull();
  });
  it('considers every model and keeps the latest contributing reset', () => {
    const first = window({ applicability: 'models', models: ['sonnet'] });
    const second = window({ id: 'opus', applicability: 'models', models: ['opus'], resetsAt: NOW + 600_000 });
    expect(selectResetWindows(snapshot([first, second]), ['sonnet', 'opus'], NOW)).toEqual([first, second]);
    expect(selectResetWindows(snapshot([first]), ['sonnet', 'opus'], NOW)).toBeNull();
  });
  it('does not silently forget an older observed weekly block or infer unknown applicability', () => {
    const blocked = window({ id: 'seven_day', kind: 'weekly', status: 'blocked', resetsAt: NOW + 6 * 86_400_000, observedAt: NOW - 86_400_000 });
    expect(selectResetWindows(snapshot([window(), blocked]), ['sonnet'], NOW)).toEqual([blocked]);
    expect(selectResetWindows(snapshot([window(), window({ id: 'unknown', applicability: 'unknown' })]), ['sonnet'], NOW)).toBeNull();
  });
  it.each(['claude', 'codex'] as const)('refuses an exhausted %s optional window with no known reset', provider => {
    const observation = provider === 'codex'
      ? normalizeCodexUsageWindows({ rateLimits: {
        primary: { usedPercent: 20, resetsAt: (NOW + 3_600_000) / 1000 },
        secondary: { usedPercent: 100, resetsAt: null },
      } }, 'codex-read', NOW)
      : normalizeClaudeUsageWindows({ type: 'rate_limit_event', rate_limit_info: {
        rateLimitType: 'seven_day', status: 'rejected', unifiedWindows: {
          five_hour: { utilization: 0.2, resetsAt: (NOW + 3_600_000) / 1000 },
          seven_day: { utilization: 1 },
        },
      } }, NOW)!;
    expect(selectResetWindows(snapshot(observation.windows, provider), [undefined], NOW)).toBeNull();
  });
  it.each([{ status: 'blocked' as const, usedPercent: null }, { status: 'unknown' as const, usedPercent: 100 }])('requires reset knowledge for exhaustion %j', exhaustion => {
    const primary = window();
    const optional = window({ id: 'weekly', kind: 'weekly', resetsAt: null, ...exhaustion });
    expect(selectResetWindows(snapshot([primary, optional]), ['sonnet'], NOW)).toBeNull();
    expect(selectResetWindows(snapshot([primary, { ...optional, applicability: 'models', models: ['opus'] }]), ['sonnet'], NOW)).toEqual([primary]);
  });
  it.each([null, 0, 99])('supports nonblocking optional windows with unknown reset and usage %s', usedPercent => {
    const primary = window();
    expect(selectResetWindows(snapshot([primary, window({ id: 'weekly', kind: 'weekly', resetsAt: null, status: 'unknown', usedPercent })]), ['sonnet'], NOW)).toEqual([primary]);
  });
  it('stops an unknown window from disabling reset scheduling once it has reset', () => {
    const w = window();
    expect(selectResetWindows(snapshot([w, window({ id: 'unknown', applicability: 'unknown', resetsAt: NOW - 1 })]), ['sonnet'], NOW)).toEqual([w]);
  });
  it('accepts a single Codex weekly primary and rejects dates over seven days away', () => {
    const primary = window({ id: 'codex:primary', kind: 'primary', durationMinutes: 10080, resetsAt: NOW + 6 * 86_400_000 });
    expect(selectResetWindows(snapshot([primary], 'codex'), [undefined], NOW)).toEqual([primary]);
    expect(selectResetWindows(snapshot([{ ...primary, resetsAt: NOW + 8 * 86_400_000 }], 'codex'), [undefined], NOW)).toBeNull();
  });
});

it('applies newer holds to the confirmed step models, including overrides, but not unrelated models', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { vi } = await import('vitest');
  const { deferredHoldUntil } = await import('./deferred-reset.ts');
  const { saveUsageWindows } = await import('../workspace/usage-windows.ts');
  const root = mkdtempSync(join(tmpdir(), 'deferred-hold-'));
  vi.stubEnv('CEZ_HOME', root);
  const now = Date.now();
  const definition = { createdAt: new Date(now - 1000).toISOString(), deferredStart: { reason: 'usage-reset', binding: {
    accounts: [{ runner: 'claude', id: 'default', path: '/synthetic-profile' }], models: [{ runner: 'claude', model: 'sonnet' }],
  } } } as unknown as import('./types.ts').ScheduleAutomationDefinition;
  const blocked = window({ id: 'opus-weekly', kind: 'weekly', applicability: 'models', models: ['opus'], status: 'blocked', observedAt: now, resetsAt: now + 86_400_000 });
  try {
    await saveUsageWindows({ provider: 'claude', accountId: 'default', profilePath: '/synthetic-profile' }, { provider: 'claude', source: 'claude-stream', observedAt: now, windows: [blocked] });
    expect(await deferredHoldUntil(definition)).toBeNull();
    definition.deferredStart!.binding.models!.push({ runner: 'claude', model: 'opus' });
    expect(await deferredHoldUntil(definition)).toBe(blocked.resetsAt! + 30_000);
    definition.deferredStart!.binding.models = undefined;
    expect(await deferredHoldUntil(definition)).toBeNull();
    await saveUsageWindows({ provider: 'claude', accountId: 'default', profilePath: '/synthetic-profile' }, { provider: 'claude', source: 'claude-stream', observedAt: now, windows: [{ ...blocked, applicability: 'all', models: [] }] });
    expect(await deferredHoldUntil(definition)).toBe(blocked.resetsAt! + 30_000);
    await saveUsageWindows({ provider: 'claude', accountId: 'default', profilePath: '/synthetic-profile' }, { provider: 'claude', source: 'claude-stream', observedAt: now, windows: [{ ...blocked, applicability: 'all', models: [], resetsAt: null }] });
    expect(await deferredHoldUntil(definition)).toBeNull();
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});

it.each([true, false])('retains a terminal Claude reset through the real manager independently of auto-resume=%s', async autoResume => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { vi } = await import('vitest');
  const { RunStore } = await import('../runs/store.ts');
  const { RunManager, AUTO_RESUME_GRACE_MS } = await import('../workflows/run.ts');
  const { WorkspaceSemaphore } = await import('../workspace/semaphore.ts');
  const { previewDeferredStart, resolveDeferredExecution } = await import('./deferred-start.ts');
  const { resolveDeferredReset } = await import('./deferred-reset.ts');
  const { loadUsageWindows, saveUsageWindows } = await import('../workspace/usage-windows.ts');
  const { normalizeClaudeTerminalUsageLimit, normalizeClaudeUsageWindows } = await import('../core/usage-windows.ts');
  const { parseUsageLimit } = await import('../core/usage-limit.ts');
  const root = mkdtempSync(join(tmpdir(), 'terminal-preview-'));
  const profile = join(root, 'profile'); mkdirSync(profile);
  const calls = join(root, 'calls.ndjson');
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', profile);
  vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_MOCK_PACE', '0');
  vi.stubEnv('CEZ_CLAUDE_BIN', ''); vi.stubEnv('CEZ_MOCK_ARGS_FILE', calls);
  vi.stubEnv('CEZ_MOCK_LIMIT_RESET_SECONDS', '3600');
  let manager: InstanceType<typeof RunManager> | undefined;
  let store: ReturnType<typeof RunStore.open> | undefined;
  try {
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, 'README.md'), 'Fixture\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture']);
    const input = { task: { task: 'Later', workflow: 'quick-task', runner: 'claude' as const }, start: { kind: 'usage-reset' as const } };
    const execution = await resolveDeferredExecution(root, input.task);
    const account = execution.binding.accounts[0]!;
    const binding = { provider: 'claude' as const, accountId: account.id, profilePath: account.path };
    expect((await previewDeferredStart(root, input, true, resolveDeferredReset)).preview).toMatchObject({ available: false, reason: 'no-data' });
    expect(existsSync(calls)).toBe(false);
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { autoResumeOnUsageLimit: autoResume } }) });
    const record = manager.startRun({ name: 'quick-task', source: 'built-in', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}', runner: 'claude' }] }, { task: 'mock:limit terminal observation', worktree: false });
    await expect.poll(() => store!.getRun(record.id)?.status, { timeout: 15_000 }).toBe('failed');
    await expect.poll(() => manager!.isActive(record.id), { timeout: 15_000 }).toBe(false);
    const error = store.getRun(record.id)!.error!;
    const hit = parseUsageLimit(error)!;
    const resetAt = hit.resetAt.getTime();
    await expect.poll(() => loadUsageWindows(binding)?.windows[0]?.resetsAt).toBe(resetAt);
    expect(loadUsageWindows(binding)?.windows).toEqual([expect.objectContaining({ id: 'terminal-limit', kind: 'other', status: 'blocked' })]);
    if (autoResume) expect(store.getRun(record.id)?.autoResumeAt).toBe(new Date(resetAt + AUTO_RESUME_GRACE_MS).toISOString());
    else expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    const beforePreview = readFileSync(calls, 'utf8');
    expect((await previewDeferredStart(root, input, true, resolveDeferredReset)).preview).toMatchObject({
      available: true, notBefore: new Date(Math.ceil((resetAt + 30_000) / 60_000) * 60_000).toISOString(),
    });
    expect(readFileSync(calls, 'utf8')).toBe(beforePreview);
    for (const changed of [{ ...account, id: 'different' }, { ...account, path: `${profile}/different` }]) {
      expect(await resolveDeferredReset({ ...execution, binding: { ...execution.binding, accounts: [changed] } })).toMatchObject({ reason: 'no-data' });
    }
    // Stable id replaces the previous terminal block; richer ordinary windows coexist.
    const observedAt = Date.now() + 1;
    await saveUsageWindows(binding, normalizeClaudeTerminalUsageLimit({ type: 'result', is_error: true, result: error }, observedAt)!);
    expect(loadUsageWindows(binding)?.windows.filter(w => w.id === 'terminal-limit')).toHaveLength(1);
    await saveUsageWindows(binding, normalizeClaudeUsageWindows({ type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'five_hour', status: 'allowed', utilization: 0.1, resetsAt: resetAt / 1000,
    } }, observedAt + 1)!);
    expect(loadUsageWindows(binding)?.windows.map(w => w.id).sort()).toEqual(['five_hour', 'terminal-limit']);
    expect((await previewDeferredStart(root, input, true, resolveDeferredReset)).preview.available).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(resetAt);
    expect((await previewDeferredStart(root, input, true, resolveDeferredReset)).preview).toMatchObject({ available: false, reason: 'no-data' });
    expect(readFileSync(calls, 'utf8')).toBe(beforePreview);
  } finally {
    vi.restoreAllMocks();
    if (manager && store) {
      for (const run of store.listRuns()) manager.cancel(run.id);
      await expect.poll(() => store!.listRuns().some(run => manager!.isActive(run.id)), { timeout: 10_000 }).toBe(false);
      manager.dispose(); store.flush();
    }
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
