import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeferredPrelaunchError, DeferredBindingError } from './deferred-start.ts';
import { AutomationStore } from './store.ts';
import { ScheduleRunner, type ScheduleRunnerHandle } from './schedule-runner.ts';
import { renderScheduleTask } from './task-template.ts';
import type { ScheduleAutomationDefinition } from './types.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const AT = Date.parse('2026-12-01T09:00:00Z');
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cez-deferred-')); dirs.push(dir);
  const store = AutomationStore.open(dir);
  const definition = store.create({ name: 'Later', kind: 'schedule', enabled: true, schedule: { type: 'once', date: '2026-12-01', hour: 9, minute: 0 },
    task: { prompt: 'Keep {{user.id}} and {{date}} literal', workflow: 'quick-task', autonomous: false },
    deferredStart: { origin: 'composer', reason: 'at', notBefore: new Date(AT).toISOString(), timeZone: 'UTC', binding: { revision: 'bound', runner: 'claude', accounts: [] }, creationKey: 'key', requestDigest: 'digest', status: 'pending', runIds: [] },
  }) as ScheduleAutomationDefinition;
  const launch = vi.fn(async (def: ScheduleAutomationDefinition) => ({ runId: def.deferredStart!.runIds[0]! }));
  const handle: ScheduleRunnerHandle = { projectId: 'p', store, timeZone: 'Pacific/Honolulu', now: () => AT, launch, validateDeferred: async () => {} };
  return { dir, store, definition, launch, handle, runner: new ScheduleRunner(handle) };
}
describe('composer starts on the existing scheduler', () => {
  it('does not launch even a millisecond early, despite ordinary schedule grace or a zone change', async () => {
    const { handle, definition, launch } = setup();
    const runner = new ScheduleRunner({ ...handle, now: () => AT - 1 });
    expect(runner.dueAt(definition)).toBe(AT);
    await runner.fire(definition);
    expect(launch).not.toHaveBeenCalled();
  });
  it('keeps the prompt verbatim and does not turn an interactive task autonomous', () => {
    const { definition } = setup();
    expect(renderScheduleTask(definition, { at: new Date(AT).toISOString(), trigger: 'schedule' }, { timeZone: 'UTC', projectName: 'p' })).toBe(definition.task.prompt);
  });
  it('Run now consumes the original occurrence; cleanup retains creation identity across restart and compaction', async () => {
    const { dir, store, definition, runner, launch } = setup();
    expect(await runner.runNow(definition)).toMatchObject({ result: 'manual' });
    await new ScheduleRunner({ projectId: 'p', store: AutomationStore.open(dir), timeZone: 'UTC', launch }).fire(definition);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.get(definition.id)).toBeUndefined();
    store.compact();
    expect(AutomationStore.open(dir).creation('key')).toMatchObject({ id: definition.id, outcome: 'launched', requestDigest: 'digest', runIds: [expect.any(String)] });
  });
  it('catches up within 24 hours and leaves an older start visible as missed', async () => {
    const { handle, definition, launch, store } = setup();
    expect(await new ScheduleRunner({ ...handle, now: () => AT + 86_400_001 }).fire(definition)).toMatchObject({ result: 'skipped' });
    expect(launch).not.toHaveBeenCalled();
    const missed = store.get(definition.id) as ScheduleAutomationDefinition;
    expect(missed).toMatchObject({ enabled: false, deferredStart: { status: 'missed' } });
    expect(await new ScheduleRunner(handle).runNow(missed)).toMatchObject({ result: 'manual' });
  });
  it('reloads state after taking the lease, so cancellation and stale revisions cannot launch', async () => {
    const { store, dir, definition, runner, launch } = setup();
    const other = AutomationStore.open(dir);
    const lease = other.acquireLease()!;
    expect((await runner.fire(definition)).result).toBe('lease-held');
    other.finishDeferred(definition.id, 'cancelled');
    lease.release();
    await runner.fire(definition);
    expect(launch).not.toHaveBeenCalled();
    expect(store.creation('key')?.outcome).toBe('cancelled');
  });
  it('classifies an invalid binding separately from a transient failure', async () => {
    const { handle, store, definition, launch } = setup();
    await new ScheduleRunner({ ...handle, validateDeferred: async () => { throw new DeferredBindingError('Account changed'); } }).fire(definition);
    const failed = store.get(definition.id) as ScheduleAutomationDefinition;
    expect(failed.deferredStart).toMatchObject({ status: 'failed', failureKind: 'binding-invalid', runIds: [], error: 'Account changed' });
    expect(launch).not.toHaveBeenCalled();
    await new ScheduleRunner(handle).runNow(failed);
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('permits cancellation or retry when preflight proves no run creation was attempted', async () => {
    const { handle, definition, store, launch } = setup();
    await new ScheduleRunner({ ...handle, launch: async () => { throw new DeferredPrelaunchError('Workflow changed'); } }).fire(definition);
    const failed = store.get(definition.id) as ScheduleAutomationDefinition;
    expect(failed.deferredStart).toMatchObject({ status: 'failed', runIds: [] });
    await new ScheduleRunner(handle).runNow(failed);
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('does not mistake an intentional multi-day account hold for an offline missed start', async () => {
    const { handle, definition, store, launch } = setup();
    const hold = AT + 3 * 86_400_000;
    await new ScheduleRunner({ ...handle, deferredHoldUntil: async () => hold }).fire(definition);
    const pending = store.get(definition.id) as ScheduleAutomationDefinition;
    await new ScheduleRunner({ ...handle, now: () => hold, deferredHoldUntil: async () => null }).fire(pending);
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('an ambiguous launch never spends on a tick; complete durable run evidence permits cleanup', async () => {
    const { handle, store, definition, launch } = setup();
    const interrupted = vi.fn(async () => { throw new Error('crash after persistence'); });
    await new ScheduleRunner({ ...handle, launch: interrupted }).fire(definition);
    const claimed = store.get(definition.id) as ScheduleAutomationDefinition;
    await new ScheduleRunner({ ...handle, deferredRunIds: async () => [] }).fire({ ...claimed, enabled: true });
    expect(launch).not.toHaveBeenCalled();
    const failed = store.get(definition.id) as ScheduleAutomationDefinition;
    expect(failed.deferredStart).toMatchObject({ status: 'failed', failureKind: 'ambiguous' });
    await new ScheduleRunner({ ...handle, deferredRunIds: async (_, ids) => ids }).runNow(failed);
    expect(store.get(definition.id)).toBeUndefined();
    expect(store.creation('key')?.outcome).toBe('launched');
    expect(launch).not.toHaveBeenCalled();
  });
  it('a remembered Run now cannot authorize retry after an ambiguous crash', async () => {
    const { handle, store, definition, launch } = setup();
    const interrupted = store.update(definition.id, definition.revision, { ...definition,
      deferredStart: { ...definition.deferredStart!, status: 'launching', manualRequested: true, runIds: ['a', 'b'] },
    }) as ScheduleAutomationDefinition;
    await new ScheduleRunner({ ...handle, deferredRunIds: async () => ['a'] }).fire(interrupted);
    expect(launch).not.toHaveBeenCalled();
    expect(store.get(definition.id)?.deferredStart).toMatchObject({ status: 'failed', failureKind: 'ambiguous' });
  });
  it('consumes a held Run now request before handing control to the launcher', async () => {
    const { handle, store, definition } = setup();
    await new ScheduleRunner({ ...handle, deferredHoldUntil: async () => AT + 1000 }).runNow(definition);
    const launch = vi.fn(async (def: ScheduleAutomationDefinition) => {
      expect(def.deferredStart?.manualRequested).toBe(false);
      throw new Error('crash');
    });
    await new ScheduleRunner({ ...handle, now: () => AT + 1000, launch }).fire(store.get(definition.id) as ScheduleAutomationDefinition);
    expect(launch).toHaveBeenCalledOnce();
    expect(store.get(definition.id)?.deferredStart?.manualRequested).toBe(false);
  });
  it('an explicit start of an ambiguous launch reuses the recorded run ids instead of minting new ones', async () => {
    const { handle, store, definition, launch } = setup();
    store.update(definition.id, definition.revision, { ...definition, task: { ...definition.task, variants: 2 } });
    await new ScheduleRunner({ ...handle, launch: async () => { throw new Error('variant B failed'); } }).fire(store.get(definition.id) as ScheduleAutomationDefinition);
    const failed = store.get(definition.id) as ScheduleAutomationDefinition;
    const recorded = failed.deferredStart!.runIds;
    expect(recorded).toHaveLength(2);
    await new ScheduleRunner({ ...handle, deferredRunIds: async () => [recorded[0]!] }).runNow(failed);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0].deferredStart!.runIds).toEqual(recorded);
    expect(store.creation('key')).toMatchObject({ outcome: 'launched', runIds: recorded });
  });
  it.each([
    ['revalidation', { validateDeferred: async () => { throw new DeferredPrelaunchError('Codex check timed out'); } }],
    ['binding', { validateDeferred: async () => { throw new DeferredBindingError('Account changed'); } }],
    ['launcher', { launch: async () => { throw new DeferredPrelaunchError('Workflow changed'); } }],
  ] as const)('a failed Start missing runs (%s) keeps the recorded runs and both exits', async (_, failing) => {
    const { handle, store, definition } = setup();
    await new ScheduleRunner({ ...handle, launch: async () => { throw new Error('crash'); } }).fire(definition);
    const ambiguous = store.get(definition.id) as ScheduleAutomationDefinition;
    await new ScheduleRunner({ ...handle, ...failing, deferredRunIds: async () => [] }).runNow(ambiguous);
    expect(store.get(definition.id)?.deferredStart).toMatchObject({ status: 'failed', failureKind: 'ambiguous', runIds: ambiguous.deferredStart!.runIds });
  });
  it('a contended cleanup after a successful launch still reports the launch and reconciles on the next tick', async () => {
    const { handle, store, definition, launch } = setup();
    const finish = vi.spyOn(store, 'finishDeferred').mockImplementationOnce(() => { throw new Error('automation mutation conflict'); });
    expect(await new ScheduleRunner(handle).fire(definition)).toMatchObject({ result: 'launched' });
    const launching = store.get(definition.id) as ScheduleAutomationDefinition;
    expect(launching.deferredStart?.status).toBe('launching');
    finish.mockRestore();
    await new ScheduleRunner({ ...handle, deferredRunIds: async (_, ids) => ids }).fire(launching);
    expect(store.creation('key')?.outcome).toBe('launched');
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it.each(['manual', 'cancel', 'reschedule'])('serializes a due tick racing a real %s process', async (action) => {
    const { dir, definition } = setup();
    const worker = fileURLToPath(new URL('./__fixtures__/deferred-worker.mjs', import.meta.url));
    const exec = promisify(execFile);
    await Promise.all(['tick', action].map(mode => exec(process.execPath, ['--import', 'tsx', worker, dir, mode, String(AT)], { timeout: 15_000 })));
    let rows: string[][] = [];
    try { rows = readFileSync(join(dir, 'launch-evidence.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { /* cancellation/reschedule won */ }
    expect(rows.length).toBeLessThanOrEqual(1);
    const reopened = AutomationStore.open(dir);
    if (rows.length) {
      expect(reopened.creation('key')).toMatchObject({ outcome: 'launched', runIds: rows[0] });
      expect(reopened.get(definition.id)).toBeUndefined();
    } else if (action === 'cancel') expect(reopened.creation('key')?.outcome).toBe('cancelled');
    else if (action === 'reschedule') expect(reopened.get(definition.id)?.revision).toBe(2);
    else throw new Error('At least one competing launcher must win');
  }, 20_000);

  it('keeps a newer hold across restart without moving the confirmed time or forgetting Run now', async () => {
    const { dir, store, definition, handle, launch } = setup();
    const hold = AT + 3_600_000;
    await new ScheduleRunner({ ...handle, now: () => AT - 1000, deferredHoldUntil: async () => hold }).runNow(definition);
    const pending = AutomationStore.open(dir).get(definition.id) as ScheduleAutomationDefinition;
    expect(pending.deferredStart).toMatchObject({ notBefore: new Date(AT).toISOString(), holdUntil: new Date(hold).toISOString(), manualRequested: true, status: 'pending' });
    expect(new ScheduleRunner(handle).dueAt(pending)).toBe(hold);
    expect(launch).not.toHaveBeenCalled();
    await new ScheduleRunner({ ...handle, now: () => hold, deferredHoldUntil: async () => null }).fire(pending);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.creation('key')?.outcome).toBe('launched');
  });

  it('does not publish an armed in-memory definition when persistence fails', () => {
    const { store, definition } = setup();
    const original = readFileSync(join(store.dataDir, 'automations.json'), 'utf8');
    vi.spyOn(store as unknown as { atomicJson: () => void }, 'atomicJson').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => store.update(definition.id, definition.revision, { ...definition, name: 'Changed' })).toThrow('disk full');
    expect(store.get(definition.id)?.name).toBe('Later');
    expect(readFileSync(join(store.dataDir, 'automations.json'), 'utf8')).toBe(original);
  });
});

it.each(['before', 'partial', 'complete'])('reconciles a real RunManager SIGKILL at the %s persistence boundary without duplicate launch', async boundary => {
  const { dir, store, definition, handle, launch } = setup();
  store.update(definition.id, definition.revision, { ...definition, task: { ...definition.task, variants: 2 } });
  const worker = fileURLToPath(new URL('./__fixtures__/deferred-crash.mjs', import.meta.url));
  await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', worker, dir, boundary], { timeout: 15_000 })).rejects.toMatchObject({ signal: 'SIGKILL' });
  // SIGKILL leaves the proper-lockfile guard; age only this dead fixture's guard
  // to exercise normal stale recovery without sleeping fifteen seconds per case.
  const old = new Date(Date.now() - 20_000);
  utimesSync(join(dir, 'automation-poll.lock.guard'), old, old);
  const reopened = AutomationStore.open(dir);
  const saved = reopened.get(definition.id) as ScheduleAutomationDefinition;
  const { RunStore } = await import('../runs/store.ts');
  const runs = RunStore.open(dir);
  const persisted = runs.listPersistedRuns();
  expect(persisted).toHaveLength(boundary === 'before' ? 0 : boundary === 'partial' ? 1 : 2);
  for (const run of persisted) {
    expect(run.automationTrigger?.automationId).toBe(definition.id);
    expect(run.deferredBinding).toEqual(saved.deferredStart!.binding);
  }
  const runner = new ScheduleRunner({ ...handle, store: reopened, deferredRunIds: async (automationId, ids) => runs.listPersistedRuns().filter(r => ids.includes(r.id) && r.automationTrigger?.automationId === automationId).map(r => r.id) });
  await runner.fire({ ...saved, enabled: true });
  expect(launch).not.toHaveBeenCalled();
  if (boundary === 'complete') {
    expect(reopened.get(definition.id)).toBeUndefined();
    expect(reopened.creation('key')?.runIds).toHaveLength(2);
  } else {
    const ambiguous = reopened.get(definition.id) as ScheduleAutomationDefinition;
    expect(ambiguous.deferredStart).toMatchObject({ status: 'failed', failureKind: 'ambiguous' });
    // Only an explicit start finishes it, with the ids recorded before the crash.
    await runner.runNow(ambiguous);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0].deferredStart!.runIds).toEqual(saved.deferredStart!.runIds);
  }
  runs.flush();
}, 20_000);

it('held explicit Start missing runs resumes missing variants when hold expires', async () => {
  const { dir, handle, store, definition, launch } = setup();
  const ids = ['existing-a', 'missing-b'];
  const partial = store.update(definition.id, definition.revision, { ...definition,
    task: { ...definition.task, variants: 2 }, enabled: false,
    deferredStart: { ...definition.deferredStart!, status: 'failed', failureKind: 'ambiguous', runIds: ids },
  }) as ScheduleAutomationDefinition;
  const held = new ScheduleRunner({ ...handle, deferredRunIds: async () => [ids[0]!], deferredHoldUntil: async () => AT + 60_000 });
  await held.runNow(partial);
  const waiting = store.get(definition.id) as ScheduleAutomationDefinition;
  expect(waiting.deferredStart).toMatchObject({ status: 'pending', manualRequested: true, runIds: ids });
  await new ScheduleRunner({ ...handle, store: AutomationStore.open(dir), now: () => AT + 60_000, deferredRunIds: async () => [ids[0]!], deferredHoldUntil: async () => null }).fire(waiting);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(launch.mock.calls[0]![0].deferredStart).toMatchObject({ runIds: ids, manualRequested: false });
});
