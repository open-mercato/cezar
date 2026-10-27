import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { DeferredBindingError, previewDeferredStart, resolveDeferredExecution, validateDeferredBinding } from './deferred-start.ts';
import { resolveDeferredReset } from './deferred-reset.ts';
import { saveUsageWindows } from '../workspace/usage-windows.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { AutomationStore } from './store.ts';
import { ScheduleRunner } from './schedule-runner.ts';
import type { ScheduleAutomationDefinition } from './types.ts';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'deferred-graph-')));
  mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true });
  for (const dir of ['claude', 'codex', 'override', 'home']) mkdirSync(join(root, dir));
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
  vi.stubEnv('CODEX_HOME', join(root, 'codex'));
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '0');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const task = { task: 'Later', workflow: 'parent', runner: 'claude' as const };
const start = { kind: 'at' as const, date: '2099-01-01', hour: 9, minute: 0 };
function write(name: string, definition: object) {
  writeFileSync(join(root, '.ai/cezar/workflows', `${name}.yaml`), stringify({ name, ...definition }));
}
function graph(name: string, nodes: object[]) {
  write(name, { version: 2, nodes: [{ id: 'start', type: 'start' }, ...nodes.map((n, i) => ({ id: `n${i}`, ...n }))],
    edges: nodes.map((_, i) => ({ from: i ? `n${i - 1}` : 'start', to: `n${i}` })) });
}
function child(model = 'sonnet', prompt = 'original', runner = 'claude') {
  write('child', { steps: [{ id: 'work', prompt, runner, model }] });
}
async function saved() {
  const result = await previewDeferredStart(root, { task, start }, true);
  expect((await loadWorkflows(root)).issues).toEqual([]);
  expect(result.preview.available).toBe(true);
  return { task: { prompt: task.task, workflow: task.workflow, runner: task.runner }, deferredStart: { binding: result.binding! } } as ScheduleAutomationDefinition;
}
it('rejects the audit mixed-provider dispatch reset before consulting reset data', async () => {
  graph('parent', [{ type: 'agent', prompt: 'inspect' }, { type: 'dispatch', runner: 'codex', model: 'gpt-5', prompt: 'implement' }]);
  const now = Date.now();
  await saveUsageWindows({ provider: 'claude', accountId: 'default', profilePath: join(root, 'claude') }, {
    provider: 'claude', source: 'claude-stream', observedAt: now, windows: [{ id: 'five_hour', kind: 'five-hour', applicability: 'all', models: [], resetsAt: now + 300_000, durationMinutes: 300, usedPercent: 10, status: 'allowed', observedAt: now }],
  });
  const reset = vi.fn(resolveDeferredReset);
  expect((await previewDeferredStart(root, { task, start: { kind: 'usage-reset' } }, true, reset)).preview)
    .toMatchObject({ available: false, reason: 'multi-account' });
  expect(reset).not.toHaveBeenCalled();
});
it.each(['prompt', 'model', 'provider', 'deleted', 'invalid'])('invalidates launch after nested workflow %s changes', async change => {
  graph('parent', [{ type: 'agent', prompt: 'inspect' }, { type: 'workflow', workflow: 'middle' }]);
  graph('middle', [{ type: 'workflow', workflow: 'child' }]);
  child();
  const definition = await saved();
  await expect(validateDeferredBinding(root, definition)).resolves.toBeUndefined();
  if (change === 'deleted') rmSync(join(root, '.ai/cezar/workflows/child.yaml'));
  else if (change === 'invalid') write('child', { steps: [] });
  else child(change === 'model' ? 'opus' : 'sonnet', change === 'prompt' ? 'changed' : 'original', change === 'provider' ? 'codex' : 'claude');
  await expect(validateDeferredBinding(root, definition)).rejects.toBeInstanceOf(DeferredBindingError);
});
it('passes every dispatch and nested model to reset selection, including a dispatch-only graph', async () => {
  graph('parent', [{ type: 'dispatch', prompt: 'work', model: 'opus' }, { type: 'workflow', workflow: 'child' }]);
  child();
  const reset = vi.fn(async (_execution: Awaited<ReturnType<typeof resolveDeferredExecution>>) => ({ reason: 'no-data', message: 'fixture' }));
  await previewDeferredStart(root, { task, start: { kind: 'usage-reset' } }, true, reset);
  expect(reset).toHaveBeenCalledOnce();
  expect(reset.mock.calls[0]![0].models.map((m: { model?: string }) => m.model)).toEqual(['opus', 'sonnet']);
  graph('parent', [{ type: 'dispatch', prompt: 'work' }]);
  expect((await resolveDeferredExecution(root, task)).binding.accounts).toHaveLength(1);
});
it('uses dispatch intent then parent defaults, and project accounts rather than parent overrides', async () => {
  writeFileSync(join(root, 'home/agent-accounts.json'), JSON.stringify({ accounts: [{ id: 'work', provider: 'claude', label: 'Work', configDir: join(root, 'override') }], selections: {}, defaults: {} }));
  graph('parent', [{ type: 'agent', prompt: 'inspect' }, { type: 'workflow', workflow: 'child' }, { type: 'dispatch', prompt: 'explicit', runner: 'pi', model: 'opus' }]);
  graph('child', [{ type: 'agent', prompt: 'child' }, { type: 'dispatch', prompt: 'grandchild' }]);
  const result = await resolveDeferredExecution(root, { ...task, model: 'parent-model', agentProfile: 'work', dispatch: { runner: 'codex', model: 'intent-model' } });
  expect(result.models.map(({ runner, model }) => ({ runner, model }))).toEqual([
    { runner: 'claude', model: 'parent-model' }, { runner: 'codex', model: 'intent-model' },
    { runner: 'codex', model: 'intent-model' }, { runner: 'pi', model: 'opus' },
  ]);
  expect(result.binding.accounts.map(({ runner, id }) => ({ runner, id }))).toEqual([
    { runner: 'claude', id: 'work' }, { runner: 'codex', id: 'default' }, { runner: 'pi', id: 'default' },
  ]);
  const inherited = await resolveDeferredExecution(root, { ...task, model: 'inherited' });
  expect(inherited.models.map(m => m.model)).toEqual(['inherited', 'inherited', 'inherited', 'opus']);
});
it('drops an inherited model on a child whose runner differs, like dispatch() (43bdda11)', async () => {
  graph('parent', [{ type: 'workflow', workflow: 'child', runner: 'codex' }, { type: 'dispatch', prompt: 'work', runner: 'codex' }, { type: 'dispatch', prompt: 'same' }]);
  write('child', { steps: [{ id: 'work', prompt: 'work' }] });
  const result = await resolveDeferredExecution(root, { ...task, model: 'opus' });
  expect(result.models.map(({ runner, model }) => ({ runner, model }))).toEqual([
    { runner: 'codex', model: undefined }, { runner: 'codex', model: undefined }, { runner: 'claude', model: 'opus' },
  ]);
  // An intent model follows the intent's runner, then the parent's model applies to its own runner.
  const intent = await resolveDeferredExecution(root, { ...task, model: 'opus', dispatch: { runner: 'claude', model: 'sonnet' } });
  expect(intent.models.map(m => m.model)).toEqual([undefined, undefined, 'sonnet']);
  // The preview binds what launch will run.
  const preview = await previewDeferredStart(root, { task: { ...task, model: 'opus' }, start }, true);
  expect(preview.binding!.models!.map(m => m.model)).toEqual([undefined, undefined, 'opus']);
});
it('binds no task model to an agent step on another runner, like runAgentStep', async () => {
  write('parent', { steps: [{ id: 'a', prompt: 'a', runner: 'codex' }, { id: 'b', prompt: 'b' }, { id: 'c', prompt: 'c', runner: 'codex', model: 'gpt-5.1' }] });
  const result = await resolveDeferredExecution(root, { ...task, model: 'opus' });
  expect(result.models.map(({ runner, model }) => ({ runner, model }))).toEqual([
    { runner: 'codex', model: undefined }, { runner: 'claude', model: 'opus' }, { runner: 'codex', model: 'gpt-5.1' },
  ]);
});
it.each(['missing', 'cycle', 'depth'])('refuses %s references visibly before preview', async kind => {
  graph('parent', [{ type: 'workflow', workflow: kind === 'cycle' ? 'parent' : 'child' }]);
  if (kind === 'depth') for (let i = 0; i < 35; i++) graph(i ? `child${i}` : 'child', [{ type: 'workflow', workflow: `child${i + 1}` }]);
  const result = await previewDeferredStart(root, { task, start }, true);
  expect(result.preview).toMatchObject({ available: false, message: expect.stringMatching(/workflow.*(unavailable|cycle|limit)/i) });
});
it('resolves fork agents as dispatch children', async () => {
  write('parent', { version: 2, nodes: [{ id: 's', type: 'start' }, { id: 'f', type: 'fork', branches: 2 },
    { id: 'a', type: 'agent', prompt: 'a' }, { id: 'b', type: 'agent', prompt: 'b', model: 'explicit' }, { id: 'j', type: 'join' }],
  edges: [{ from: 's', to: 'f' }, { from: 'f.1', to: 'a' }, { from: 'f.2', to: 'b' }, { from: 'a', to: 'j' }, { from: 'b', to: 'j' }] });
  expect((await loadWorkflows(root)).issues).toEqual([]);
  const result = await resolveDeferredExecution(root, { ...task, dispatch: { runner: 'codex', model: 'intent' } });
  expect(result.models.map(({ runner, model }) => ({ runner, model }))).toEqual([{ runner: 'codex', model: 'intent' }, { runner: 'codex', model: 'explicit' }]);
});
it('does not reserve or launch a run when nested content changed at the due-time gate', async () => {
  graph('parent', [{ type: 'workflow', workflow: 'child' }]); child();
  const original = await saved();
  const store = AutomationStore.open(join(root, 'automations'));
  const now = Date.now();
  const definition = store.create({ name: 'Later', kind: 'schedule', enabled: true, schedule: { type: 'once', date: '2099-01-01', hour: 9, minute: 0 }, task: original.task,
    deferredStart: { origin: 'composer', reason: 'at', notBefore: new Date(now).toISOString(), timeZone: 'UTC', binding: original.deferredStart!.binding, creationKey: 'graph', requestDigest: 'graph', status: 'pending', runIds: [] } }) as ScheduleAutomationDefinition;
  child('opus');
  const launch = vi.fn(async () => ({ runId: 'must-not-launch' }));
  await new ScheduleRunner({ projectId: 'p', store, timeZone: 'UTC', now: () => now, launch, validateDeferred: def => validateDeferredBinding(root, def) }).fire(definition);
  expect(launch).not.toHaveBeenCalled();
  expect(store.get(definition.id)?.deferredStart).toMatchObject({ status: 'failed', failureKind: 'binding-invalid', runIds: [] });
});
it('keeps repeated references distinct and bounds exponential expansion', async () => {
  graph('parent', [{ type: 'workflow', workflow: 'child' }, { type: 'workflow', workflow: 'child', runner: 'codex' }]);
  write('child', { steps: [{ id: 'work', prompt: 'work' }] });
  const result = await resolveDeferredExecution(root, task);
  expect(result.models).toEqual([{ runner: 'claude', model: undefined, step: 'n0/work' }, { runner: 'codex', model: undefined, step: 'n1/work' }]);
  for (let i = 0; i < 13; i++) graph(i ? `child${i}` : 'child', [{ type: 'workflow', workflow: `child${i + 1}` }, { type: 'workflow', workflow: `child${i + 1}` }]);
  write('child13', { steps: [{ id: 'work', prompt: 'work' }] });
  await expect(resolveDeferredExecution(root, task)).rejects.toThrow('Workflow expansion limit');
});
it('uses native models under the model lock for every declarative child', async () => {
  graph('parent', [{ type: 'dispatch', prompt: 'work', model: 'opus' }, { type: 'workflow', workflow: 'child' }]); child();
  vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
  const result = await resolveDeferredExecution(root, { ...task, dispatch: { model: 'intent' } });
  expect(result.models.map(m => m.model)).toEqual([undefined, undefined]);
});
it.each([true, false])('rejects multiple accounts of one runner regardless of child-first order (%s)', async childFirst => {
  writeFileSync(join(root, 'home/agent-accounts.json'), JSON.stringify({ accounts: [{ id: 'work', provider: 'claude', label: 'Work', configDir: join(root, 'override') }], selections: {}, defaults: {} }));
  const nodes = [{ type: 'dispatch', prompt: 'child' }, { type: 'agent', prompt: 'parent' }];
  graph('parent', childFirst ? nodes : nodes.reverse());
  for (const condition of [start, { kind: 'usage-reset' as const }]) {
    expect((await previewDeferredStart(root, { task: { ...task, agentProfile: 'work' }, start: condition }, true)).preview)
      .toMatchObject({ available: false, message: expect.stringContaining('multiple accounts for claude') });
  }
});
it('treats an empty dispatch model intent like dispatch startRun, without inheriting the parent model', async () => {
  graph('parent', [{ type: 'dispatch', prompt: 'child', model: '' }]);
  const execution = await resolveDeferredExecution(root, { ...task, model: 'parent', dispatch: { model: '' } });
  expect(execution.models.map(m => m.model)).toEqual([undefined]);
});
