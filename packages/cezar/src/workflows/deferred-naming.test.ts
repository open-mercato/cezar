import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { generateRunName } from '../runs/auto-name.ts';
import { RunManager } from './run.ts';

vi.mock('../runs/auto-name.ts', async (original) => ({
  ...await original<typeof import('../runs/auto-name.ts')>(),
  autoNamingActive: () => true,
  generateRunName: vi.fn(async () => ({ titleSummary: 'named' })),
}));
let root: string, store: RunStore, manager: RunManager;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'deferred-naming-')));
  vi.stubEnv('CEZ_HOME', join(root, 'home')); vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'default'));
  mkdirSync(join(root, 'default')); writeFileSync(join(root, 'default', 'settings.json'), '{}');
  store = RunStore.open(join(root, 'state')); manager = new RunManager(store, root);
  vi.mocked(generateRunName).mockClear();
});
afterEach(() => { manager.dispose(); store.flush(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

type Seam = {
  autoNameRun(id: string, skill: string | undefined, task: string, live?: { turnText?: string }): Promise<unknown>;
  agentEnvForStep(...args: unknown[]): Promise<unknown>;
};
function scheduledRun() {
  const run = store.createRun({ title: 't', task: 't', workflow: 'quick-task', runner: 'claude', model: 'opus', steps: [] });
  store.updateRun(run.id, {
    workflowDef: { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}', model: 'opus' }] },
    deferredBinding: { revision: 'r', runner: 'claude', accounts: [{ runner: 'claude', id: 'default', path: join(root, 'default') }] },
  });
  return run;
}

it('names a scheduled launch with the namer model under the bound account (#1340)', async () => {
  const run = scheduledRun();
  const seam = manager as unknown as Seam;
  const spy = vi.spyOn(seam, 'agentEnvForStep');
  await seam.autoNameRun(run.id, undefined, 't');
  expect(spy).toHaveBeenCalledOnce();
  expect(vi.mocked(generateRunName).mock.calls[0]?.[2]).toMatchObject({ runner: 'claude', model: 'haiku' });
});

it('a live title refresh neither re-resolves the binding nor uses the task model (#1340)', async () => {
  const run = scheduledRun();
  const seam = manager as unknown as Seam;
  const spy = vi.spyOn(seam, 'agentEnvForStep');
  await seam.autoNameRun(run.id, undefined, 't', { turnText: 'did things' });
  expect(spy).not.toHaveBeenCalled();
  expect(vi.mocked(generateRunName).mock.calls[0]?.[2]).toBeUndefined();
});
