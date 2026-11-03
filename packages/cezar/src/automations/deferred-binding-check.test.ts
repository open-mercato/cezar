import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { AutomationStore } from './store.ts';
import type { ScheduleAutomationDefinition } from './types.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => vi.fn());
vi.mock('../core/codex-usage-probe.ts', () => ({ probeCodexIdentity: probe }));
const { previewDeferredStart, validateDeferredBinding, DeferredBindingError, DeferredPrelaunchError } = await import('./deferred-start.ts');

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'deferred-check-')));
  mkdirSync(join(root, 'codex'));
  vi.stubEnv('CEZ_HOME', join(root, 'home')); vi.stubEnv('CODEX_HOME', join(root, 'codex')); vi.stubEnv('CEZ_DRY_RUN', '');
  probe.mockReset();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const task = { task: 'Later', workflow: 'quick-task', runner: 'codex' } as const;
const start = { kind: 'at', date: '2099-01-01', hour: 9, minute: 0 } as const;
const result = (identity?: string) => ({ identity: identity ?? null });
async function scheduled(identity?: string) {
  probe.mockResolvedValueOnce(result(identity));
  const { binding, schedule, preview } = await previewDeferredStart(root, { task, start }, true);
  expect(preview.available).toBe(true);
  return { deferredStart: { binding: binding! }, task: { prompt: 'Later', workflow: 'quick-task', runner: 'codex' }, schedule } as unknown as Parameters<typeof validateDeferredBinding>[1];
}

it('binds an API-key Codex login (no identity) by profile location instead of refusing', async () => {
  const definition = await scheduled();
  expect(definition.deferredStart!.binding.accounts[0]).not.toHaveProperty('identity');
  await expect(validateDeferredBinding(root, definition)).resolves.toBeUndefined();
});
it('treats an unanswered identity check as transient, and only a different login as invalid', async () => {
  const definition = await scheduled('alice');
  probe.mockResolvedValueOnce({ unavailable: true });
  const transient = await validateDeferredBinding(root, definition).catch(e => e);
  expect(transient).toBeInstanceOf(DeferredPrelaunchError);
  expect(transient).not.toBeInstanceOf(DeferredBindingError);
  probe.mockResolvedValueOnce(result('bob'));
  await expect(validateDeferredBinding(root, definition)).rejects.toBeInstanceOf(DeferredBindingError);
  probe.mockResolvedValueOnce(result('alice'));
  await expect(validateDeferredBinding(root, definition)).resolves.toBeUndefined();
});
it('still refuses a preview when the Codex check gets no answer', async () => {
  probe.mockResolvedValueOnce({ unavailable: true });
  expect((await previewDeferredStart(root, { task, start }, true)).preview).toMatchObject({ available: false, reason: 'account-unverifiable' });
});
it('lets dry runs schedule Codex by date without a login probe', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  expect((await previewDeferredStart(root, { task, start }, true)).preview.available).toBe(true);
  expect(probe).not.toHaveBeenCalled();
});
it('names a missing profile directory instead of a generic verification failure', async () => {
  vi.stubEnv('CODEX_HOME', join(root, 'missing'));
  expect((await previewDeferredStart(root, { task, start }, true)).preview).toMatchObject({ available: false, message: expect.stringContaining('profile directory is missing') });
});
it('previews use the cached identity read; launch revalidation reads fresh', async () => {
  const definition = await scheduled('alice');
  expect(probe.mock.calls[0]![1]).toEqual({ force: false });
  probe.mockResolvedValueOnce(result('alice'));
  await validateDeferredBinding(root, definition);
  expect(probe.mock.calls[1]![1]).toBeUndefined();
});

it('previews, confirms, persists and validates a Pi date without a Claude directory', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'missing-claude'));
  const piTask = { ...task, runner: 'pi' as const, model: 'pi-model' };
  const previewed = await previewDeferredStart(root, { task: piTask, start }, true);
  expect(previewed.preview.available).toBe(true);
  if (!previewed.preview.available) throw new Error('Pi preview unavailable');
  expect(previewed.binding?.accounts).toEqual([{ runner: 'pi', id: 'default', path: '' }]);
  expect(previewed.binding?.models).toEqual([expect.objectContaining({ runner: 'pi', model: 'pi-model' })]);

  // Confirmation uses the same resolver again, just as the create endpoint does.
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'another-missing-claude'));
  const confirmed = await previewDeferredStart(root, { task: piTask, start }, true);
  expect(confirmed.preview).toEqual(previewed.preview);
  const store = AutomationStore.open(join(root, 'automations'));
  const definition = store.create({
    name: 'Pi later', kind: 'schedule', enabled: true, schedule: confirmed.schedule!,
    task: { prompt: piTask.task, workflow: piTask.workflow, runner: piTask.runner, model: piTask.model },
    deferredStart: {
      origin: 'composer', reason: 'at', notBefore: previewed.preview.notBefore,
      timeZone: previewed.preview.timeZone, binding: confirmed.binding!,
      creationKey: 'pi-date', requestDigest: 'pi-date', status: 'pending', runIds: [],
    },
  }) as ScheduleAutomationDefinition;
  const persisted = AutomationStore.open(join(root, 'automations')).get(definition.id)!;
  await expect(validateDeferredBinding(root, persisted)).resolves.toBeUndefined();
  expect(probe).not.toHaveBeenCalled();
  // The directory workaround must neither be needed nor change the saved binding.
  mkdirSync(join(root, 'another-missing-claude'));
  await expect(validateDeferredBinding(root, persisted)).resolves.toBeUndefined();
  await expect(validateDeferredBinding(root, { ...persisted, task: { ...persisted.task, model: 'changed' } }))
    .rejects.toBeInstanceOf(DeferredBindingError);
});

it('keeps Pi reset scheduling unsupported and refuses an uncarryable Pi account', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'missing-claude'));
  const piTask = { ...task, runner: 'pi' as const };
  expect((await previewDeferredStart(root, { task: piTask, start: { kind: 'usage-reset' } }, true)).preview)
    .toMatchObject({ available: false, reason: 'unsupported' });
  expect((await previewDeferredStart(root, { task: { ...piTask, agentProfile: 'work' }, start }, true)).preview)
    .toMatchObject({ available: false, reason: 'account-unverifiable', message: 'Pi supports only the default account.' });
});

it('still requires the Claude directory in a workflow mixing Pi and Claude', async () => {
  const claudeDir = join(root, 'claude');
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
  const mixed = { task: 'Later', runner: 'pi' as const, steps: [
    { id: 'pi-step', type: 'agent' as const, prompt: 'Pi', runner: 'pi' as const },
    { id: 'claude-step', type: 'agent' as const, prompt: 'Claude', runner: 'claude' as const },
  ] };
  expect((await previewDeferredStart(root, { task: mixed, start }, true)).preview)
    .toMatchObject({ available: false, reason: 'account-unverifiable' });
  mkdirSync(claudeDir);
  const ready = await previewDeferredStart(root, { task: mixed, start }, true);
  expect(ready.preview.available).toBe(true);
  expect(ready.binding?.accounts).toEqual([
    { runner: 'pi', id: 'default', path: '' },
    { runner: 'claude', id: 'default', path: realpathSync(claudeDir) },
  ]);
  const definition = { task: { ...mixed, prompt: mixed.task }, deferredStart: { binding: ready.binding! } } as unknown as Parameters<typeof validateDeferredBinding>[1];
  rmSync(claudeDir, { recursive: true });
  await expect(validateDeferredBinding(root, definition)).rejects.toBeInstanceOf(DeferredBindingError);
});

it.each([
  ['claude', 'CLAUDE_CONFIG_DIR'],
  ['codex', 'CODEX_HOME'],
  ['opencode', 'XDG_CONFIG_HOME'],
  ['cursor', 'CURSOR_CONFIG_DIR'],
  ['junie', 'HOME'],
  ['copilot', 'COPILOT_HOME'],
] as const)('keeps the missing-profile gate for %s', async (runner, env) => {
  vi.stubEnv(env, join(root, 'missing-provider-home'));
  expect((await previewDeferredStart(root, { task: { ...task, runner }, start }, true)).preview)
    .toMatchObject({ available: false, reason: 'account-unverifiable' });
  expect(probe).not.toHaveBeenCalled();
});
