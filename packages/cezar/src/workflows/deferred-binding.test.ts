import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageWindowsObservation } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';
import { RunManager } from './run.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { loadUsageWindows } from '../workspace/usage-windows.ts';
let root: string, store: RunStore, manager: RunManager;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'deferred-binding-')));
  vi.stubEnv('CEZ_HOME', join(root, 'home')); vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'default'));
  for (const name of ['default', 'work']) { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'settings.json'), '{}'); }
  await mergeWriteAgentAccounts(s => { s.accounts.push({ id: 'work', provider: 'claude', configDir: join(root, 'work'), label: 'Work', addedAt: '' }); });
  store = RunStore.open(join(root, 'state')); manager = new RunManager(store, root);
});
afterEach(() => { manager.dispose(); store.flush(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const seam = () => manager as unknown as { agentEnvForStep(id: string, backend: 'claude' | 'codex' | 'pi', options?: { recordedProfileId?: string }): Promise<{ env: Record<string,string>; profileId: string; onUsageWindows?: (o: UsageWindowsObservation) => void }> };
function boundRun() {
  const run = store.createRun({ title: 't', task: 't', workflow: 'quick-task', runner: 'claude', agentProfile: 'work', steps: [{ id: 'task', name: 'task', kind: 'agent' }] });
  store.updateRun(run.id, { deferredBinding: { revision: 'r', runner: 'claude', accounts: [{ runner: 'claude', id: 'work', path: join(root, 'work') }] } });
  return run;
}
it('never falls back after a scheduled account is removed, including continuation resolution', async () => {
  const run = boundRun();
  expect((await seam().agentEnvForStep(run.id, 'claude')).env.CLAUDE_CONFIG_DIR).toBe(join(root, 'work'));
  await mergeWriteAgentAccounts(s => { s.accounts = []; });
  await expect(seam().agentEnvForStep(run.id, 'claude')).rejects.toThrow('binding changed');
  await expect(seam().agentEnvForStep(run.id, 'claude', { recordedProfileId: 'work' })).rejects.toThrow('binding changed');
});
it('stores ordinary usage metadata under the account actually used by the step', async () => {
  const run = store.createRun({ title: 't', task: 't', workflow: 'quick-task', runner: 'codex', steps: [] });
  const resolved = await seam().agentEnvForStep(run.id, 'claude', { recordedProfileId: 'work' });
  const now = Date.now();
  resolved.onUsageWindows?.({ provider: 'claude', source: 'claude-stream', observedAt: now, windows: [{ id: 'five_hour', kind: 'five-hour', applicability: 'all', models: [], resetsAt: now + 60000, durationMinutes: 300, usedPercent: 40, status: 'allowed', observedAt: now }] });
  await vi.waitFor(() => expect(loadUsageWindows({ provider: 'claude', accountId: 'work', profilePath: join(root, 'work') })?.windows[0]?.usedPercent).toBe(40));
  expect(loadUsageWindows({ provider: 'claude', accountId: 'default', profilePath: join(root, 'default') })).toBeNull();
});

it('keeps a confirmed workflow when the catalogue changes after queueing', () => {
  const run = boundRun();
  const snapshot: WorkflowDef = { name: 'demo', source: 'file', steps: [{ id: 'task', prompt: 'original' }] };
  const newer: WorkflowDef = { ...snapshot, steps: [{ id: 'task', prompt: 'changed' }] };
  const managerSeam = manager as unknown as { refreshQueuedWorkflow(id: string, snapshot: WorkflowDef, catalog: WorkflowDef[]): WorkflowDef };
  expect(managerSeam.refreshQueuedWorkflow(run.id, snapshot, [newer])).toBe(snapshot);
});

describe('after the scheduled launch (#1340)', () => {
  function launchedRun() {
    const run = boundRun();
    store.updateStep(run.id, 'task', { profileId: 'work' });
    return run;
  }
  it('a later step or Continue may switch account or runner', async () => {
    const run = launchedRun();
    store.updateRun(run.id, { agentProfile: 'default' });
    expect((await seam().agentEnvForStep(run.id, 'claude')).profileId).toBe('default');
    await expect(seam().agentEnvForStep(run.id, 'codex')).resolves.toMatchObject({ profileId: 'default' });
  });
  it('restart recovery reattaches to the recorded account even after it was removed', async () => {
    const run = launchedRun();
    await mergeWriteAgentAccounts(s => { s.accounts = []; });
    await expect(seam().agentEnvForStep(run.id, 'claude', { recordedProfileId: 'work' })).resolves.toBeDefined();
  });
  it('the first step still refuses a changed binding', async () => {
    const run = boundRun();
    store.updateRun(run.id, { agentProfile: 'default' });
    await expect(seam().agentEnvForStep(run.id, 'claude')).rejects.toThrow('binding changed');
    await expect(seam().agentEnvForStep(run.id, 'codex')).rejects.toThrow('binding changed');
  });
});

it('Pi launch accepts only the native default binding, never a legacy Claude path', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'absent-claude'));
  const run = store.createRun({ title: 'Pi', task: 'Pi', workflow: 'quick-task', runner: 'pi', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
  for (const account of [
    { runner: 'pi', id: 'default', path: join(root, 'default') },
    { runner: 'pi', id: 'work', path: '' },
  ]) {
    store.updateRun(run.id, { deferredBinding: { revision: 'r', runner: 'pi', accounts: [account] } });
    await expect(seam().agentEnvForStep(run.id, 'pi')).rejects.toThrow('binding changed');
  }
  store.updateRun(run.id, { deferredBinding: { revision: 'r', runner: 'pi', accounts: [{ runner: 'pi', id: 'default', path: '' }] } });
  await expect(seam().agentEnvForStep(run.id, 'pi')).resolves.toMatchObject({ profileId: 'default' });
});
