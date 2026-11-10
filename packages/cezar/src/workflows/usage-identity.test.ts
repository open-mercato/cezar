import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UsageWindowsObservation } from '@open-mercato/cezar-contract';
import { probeCodexIdentity, probeCodexUsageWindows } from '../core/codex-usage-probe.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager, AUTO_RESUME_GRACE_MS } from './run.ts';
import { loadUsageWindows, saveUsageWindows } from '../workspace/usage-windows.ts';
import { deferredHoldUntil } from '../automations/deferred-reset.ts';
import type { ScheduleAutomationDefinition } from '../automations/types.ts';

vi.mock('../core/codex-usage-probe.ts', () => ({ probeCodexUsageWindows: vi.fn(), probeCodexIdentity: vi.fn() }));
let root: string, store: RunStore, manager: RunManager;
const identity = 'a'.repeat(64);
const otherIdentity = 'b'.repeat(64);
const binding = () => ({ provider: 'codex' as const, accountId: 'default', profilePath: join(root, 'profile'), identity });
const observation = (observedAt: number, blocked = true): UsageWindowsObservation => ({
  provider: 'codex', source: 'codex-notification', observedAt,
  windows: [{ id: 'primary', kind: 'primary', applicability: 'all', models: [],
    resetsAt: observedAt + 3600000, durationMinutes: 300, usedPercent: blocked ? 100 : 10,
    status: blocked ? 'blocked' : 'allowed', observedAt }],
});
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'usage-identity-')));
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CODEX_HOME', join(root, 'profile'));
  vi.stubEnv('CEZ_DRY_RUN', '1');
  mkdirSync(join(root, 'profile'));
  writeFileSync(join(root, 'profile', 'config.toml'), '');
  store = RunStore.open(join(root, 'state'));
  manager = new RunManager(store, root);
  vi.mocked(probeCodexUsageWindows).mockReset();
  vi.mocked(probeCodexUsageWindows).mockResolvedValue({ binding: binding(), observation: observation(Date.now(), false) });
  vi.mocked(probeCodexIdentity).mockReset();
  vi.mocked(probeCodexIdentity).mockResolvedValue({ identity });
});
afterEach(() => {
  manager.dispose(); store.flush();
  rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});
async function callback(deferred = false, launched = deferred) {
  const run = store.createRun({ title: 'test', task: 'test', workflow: 'quick-task', runner: 'codex', steps: [{ id: 'task', name: 'task', kind: 'agent' }] });
  if (deferred) store.updateRun(run.id, { deferredBinding: { revision: 'r', runner: 'codex',
    accounts: [{ runner: 'codex', id: 'default', path: binding().profilePath, identity }] } });
  // An already-launched scheduled run: its first step recorded the account it spawned under.
  if (launched) store.updateStep(run.id, 'task', { profileId: 'default' });
  const seam = manager as unknown as { agentEnvForStep(id: string, backend: 'codex'): Promise<{ onUsageWindows?: (o: UsageWindowsObservation) => void }> };
  return (await seam.agentEnvForStep(run.id, 'codex')).onUsageWindows;
}
it('an ordinary Codex step spawns no identity probe and captures no usage windows (#1340)', async () => {
  expect(await callback()).toBeUndefined();
  expect(probeCodexUsageWindows).not.toHaveBeenCalled();
  expect(probeCodexIdentity).not.toHaveBeenCalled();
});
it('scheduled Codex observations preserve identity and postpone a previously scheduled reset', async () => {
  const now = Date.now();
  expect(await saveUsageWindows(binding(), observation(now - 10000, false))).toBe(true);
  const emit = (await callback(true))!;
  await emit(observation(now));
  await vi.waitFor(() => expect(loadUsageWindows(binding())?.observedAt).toBe(now));
  const definition = { createdAt: new Date(now - 5000).toISOString(), deferredStart: {
    reason: 'usage-reset', binding: { accounts: [{ runner: 'codex', id: 'default', path: binding().profilePath, identity }] },
  } } as ScheduleAutomationDefinition;
  // Attribution re-verifies through the short identity cache, never a forced read per event.
  expect(probeCodexIdentity).toHaveBeenLastCalledWith(expect.anything(), { force: false });
  expect(probeCodexUsageWindows).not.toHaveBeenCalled();
  // At the due time the hold re-reads Codex limits live (no model call); a probe that cannot
  // answer leaves the stream's observation as the evidence.
  vi.mocked(probeCodexUsageWindows).mockResolvedValueOnce(null);
  expect(await deferredHoldUntil(definition)).toBe(now + 3600000 + AUTO_RESUME_GRACE_MS);
  expect(loadUsageWindows({ ...binding(), identity: undefined })).toBeNull();
});
it('a live Codex read at the due time supersedes an older blocked observation', async () => {
  const now = Date.now();
  expect(await saveUsageWindows(binding(), observation(now - 10000))).toBe(true);
  const definition = { createdAt: new Date(now - 60000).toISOString(), deferredStart: {
    reason: 'usage-reset', binding: { accounts: [{ runner: 'codex', id: 'default', path: binding().profilePath, identity }] },
  } } as ScheduleAutomationDefinition;
  vi.mocked(probeCodexUsageWindows).mockResolvedValueOnce({ binding: binding(), observation: observation(now, false) });
  expect(await deferredHoldUntil(definition)).toBeNull();
  vi.mocked(probeCodexUsageWindows).mockResolvedValueOnce({ binding: binding(), observation: observation(now + 1) });
  expect(await deferredHoldUntil(definition)).toBe(now + 1 + 3600000 + AUTO_RESUME_GRACE_MS);
});
it('does not attribute a changed login to the bound identity', async () => {
  const now = Date.now();
  expect(await saveUsageWindows(binding(), observation(now - 10000))).toBe(true);
  const emit = (await callback(true))!;
  vi.mocked(probeCodexIdentity).mockResolvedValue({ identity: otherIdentity });
  await emit(observation(now, false));
  await vi.waitFor(() => expect(probeCodexIdentity).toHaveBeenCalledOnce());
  expect(loadUsageWindows(binding())?.observedAt).toBe(now - 10000);
  expect(loadUsageWindows({ ...binding(), identity: otherIdentity })).toBeNull();
});
it('an unanswered verification skips only that observation', async () => {
  const now = Date.now();
  expect(await saveUsageWindows(binding(), observation(now - 10000))).toBe(true);
  const emit = (await callback(true))!;
  vi.mocked(probeCodexIdentity).mockResolvedValueOnce({ unavailable: true });
  await emit(observation(now, false));
  expect(loadUsageWindows(binding())?.observedAt).toBe(now - 10000);
  await emit(observation(now + 1, false));
  expect(loadUsageWindows(binding())?.observedAt).toBe(now + 1);
});
it('a verification error disables later attribution for that stream', async () => {
  const now = Date.now();
  expect(await saveUsageWindows(binding(), observation(now - 10000))).toBe(true);
  const emit = (await callback(true))!;
  vi.mocked(probeCodexIdentity).mockRejectedValueOnce(new Error('synthetic failure'));
  await emit(observation(now, false));
  await emit(observation(now + 1, false));
  expect(loadUsageWindows(binding())?.observedAt).toBe(now - 10000);
  expect(probeCodexIdentity).toHaveBeenCalledOnce();
});

it('still waits for verified identity before allowing a bound scheduled launch', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof probeCodexIdentity>>) => void;
  vi.mocked(probeCodexIdentity).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  let ready = false;
  const environment = callback(true, false).then(emit => { ready = true; return emit; });
  await vi.waitFor(() => expect(probeCodexIdentity).toHaveBeenCalledOnce());
  expect(ready).toBe(false);
  resolve({ identity });
  await environment;
  expect(ready).toBe(true);
});

it('refuses a scheduled launch whose Codex login changed', async () => {
  vi.mocked(probeCodexIdentity).mockResolvedValueOnce({ identity: otherIdentity });
  await expect(callback(true, false)).rejects.toThrow('identity changed');
});

it('an unanswered launch identity read is a retryable failure, not a changed identity (#1340)', async () => {
  vi.mocked(probeCodexIdentity).mockResolvedValueOnce({ unavailable: true });
  const failure = callback(true, false);
  await expect(failure).rejects.toThrow('Retry the task');
  await expect(failure).rejects.not.toThrow('identity changed');
});

it('a launched scheduled run does not re-verify the binding on later steps', async () => {
  vi.mocked(probeCodexIdentity).mockResolvedValue({ identity: otherIdentity });
  expect(await callback(true)).toBeDefined();
  expect(probeCodexIdentity).not.toHaveBeenCalled();
});
