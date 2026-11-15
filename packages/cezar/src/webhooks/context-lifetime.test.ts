import { it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebhookCoordinator } from './coordinator.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { ProjectContexts, type ProjectContext } from '../server/project-context.ts';
// Repository identity lookup is unrelated to context ownership. Keep its background
// gh process from holding the fixture directory open during Windows teardown.
vi.mock('../server/forge/github.ts', async original => ({
  ...await original<typeof import('../server/forge/github.ts')>(),
  resolveRepoHandle: async () => null,
}));

it('delivers a durable failure through disk fallback after lazy context recovery rejects', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'review-context-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], singleProject: true, dryRun: true });
  const contexts = new ProjectContexts({ listProjects: async () => [{ id: 'fixture', root, status: 'ok' }] });
  let prepared: ProjectContext | undefined;
  contexts.onBeforeRecover(async context => {
    prepared = context;
    await coordinator.attach(context, 'fixture', false);
    return () => coordinator.detach(context);
  });
  contexts.onContextBuilt(context => coordinator.ready(context.root, context));
  contexts.onBeforeRecover(async () => () => { throw new Error('optional rollback failure'); });
  const store = RunStore.open(join(root, '.ai/cezar'));
  try {
    const service = await coordinator.get('fixture', root, true);
    service.attach(store, { isActive: () => false }, true);
    const { receiver } = await service.create({ name: 'Fixture', url: 'https://receiver.invalid', graceSeconds: 0 });
    await service.activate(receiver.id, 1);
    const run = store.createRun({ title: 'Task', task: 'Task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'failed' }); store.flush();
    const recovery = vi.spyOn(RunManager.prototype, 'recover').mockRejectedValueOnce(new Error('injected recovery failure'));
    await expect(contexts.context('fixture')).rejects.toThrow('injected recovery failure'); recovery.mockRestore();
    expect(contexts.peek('fixture')).toBeUndefined();
    vi.setSystemTime(new Date('2026-10-20T10:01:00Z'));
    await coordinator.discover(); await service.tick();
    expect(service.deliveries(receiver.id)[0]?.status).toBe('delivered');
    expect(prepared!.store.hasLifecycleObserver).toBe(false);
    expect(await coordinator.get('fixture', root)).toBe(service);
  } finally { await coordinator.dispose(); contexts.disposeAll(); store.flush(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});

it('keeps a successfully recovered context attached until disposal, despite optional hook failures', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'context-success-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], dryRun: true });
  const contexts = new ProjectContexts({ listProjects: async () => [{ id: 'fixture', root, status: 'not-git' }] });
  let prepared: ProjectContext | undefined;
  const cleanup = vi.fn(() => { throw new Error('optional cleanup failure'); });
  contexts.onBeforeRecover(async () => { throw new Error('optional preparation failure'); });
  contexts.onBeforeRecover(async context => {
    prepared = context;
    await coordinator.attach(context, 'fixture', false);
    return () => coordinator.detach(context);
  });
  contexts.onBeforeRecover(async () => cleanup);
  contexts.onContextBuilt(context => coordinator.ready(context.root, context));
  const recover = vi.spyOn(RunManager.prototype, 'recover').mockResolvedValue(undefined);
  try {
    const context = await contexts.context('fixture');
    expect(context).toBe(prepared);
    expect(recover).toHaveBeenCalledOnce();
    expect(context.store.hasLifecycleObserver).toBe(true);
    const service = await coordinator.get('fixture', root);
    const { receiver } = await service.create({ name: 'Fixture', url: 'https://receiver.invalid', graceSeconds: 0 });
    await service.activate(receiver.id, 1);
    const run = context.store.createRun({ title: 'Task', task: 'Task', workflow: 'w', steps: [] });
    context.store.updateRun(run.id, { status: 'failed' });
    vi.setSystemTime(new Date('2026-10-20T10:01:00Z'));
    await service.tick();
    expect(service.deliveries(receiver.id)[0]?.status).toBe('delivered');
    expect(contexts.dispose('fixture')).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(context.store.hasLifecycleObserver).toBe(false);
    await coordinator.discover();
    expect(await coordinator.get('fixture', root)).toBe(service);
    expect(contexts.dispose('fixture')).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
  } finally {
    contexts.disposeAll(); await coordinator.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
});

it('fences delayed attachment, readiness and teardown against a newer context', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'context-identity-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], dryRun: true });
  const dataDir = join(root, '.ai/cezar');
  const oldStore = RunStore.open(dataDir), newStore = RunStore.open(dataDir);
  const old = { root, store: oldStore, manager: { isActive: () => false } } as unknown as ProjectContext;
  const replacement = { root, store: newStore, manager: { isActive: () => false } } as unknown as ProjectContext;
  try {
    const service = await coordinator.get('fixture', root);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const get = vi.spyOn(coordinator, 'get').mockImplementationOnce(async () => { await gate; return service; });
    const attaching = coordinator.attach(old, 'fixture', false);
    await coordinator.attach(replacement, 'fixture', false);
    release(); await attaching; get.mockRestore();
    coordinator.detach(old);
    service.detach(old.store, old.manager);
    coordinator.ready(root, old);
    expect(oldStore.hasLifecycleObserver).toBe(false);
    expect(newStore.hasLifecycleObserver).toBe(true);
    const { receiver } = await service.create({ name: 'Fixture', url: 'https://receiver.invalid', graceSeconds: 0 });
    await service.activate(receiver.id, 1);
    const run = newStore.createRun({ title: 'Task', task: 'Task', workflow: 'w', steps: [] });
    newStore.updateRun(run.id, { status: 'failed' });
    vi.setSystemTime(new Date('2026-10-20T10:01:00Z'));
    await service.tick();
    expect(service.deliveries(receiver.id)[0]?.status).toBe('pending');
    coordinator.ready(root, replacement);
    await service.tick();
    expect(service.deliveries(receiver.id)[0]?.status).toBe('delivered');
    coordinator.detach(replacement);
    expect(newStore.hasLifecycleObserver).toBe(false);
    await coordinator.discover();
    expect(newStore.hasLifecycleObserver).toBe(false);
    // Rollback can also win while opening is pending, without a replacement.
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(coordinator, 'get').mockImplementationOnce(async () => { await pending; return service; });
    const abandoned = coordinator.attach(old, 'fixture', false);
    coordinator.detach(old);
    finish(); await abandoned;
    expect(oldStore.hasLifecycleObserver).toBe(false);
  } finally {
    await coordinator.dispose(); oldStore.flush(); newStore.flush(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
});

it('keeps preparation and rollback inert with webhooks disabled', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '0');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'context-disabled-'));
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [] });
  const contexts = new ProjectContexts({ listProjects: async () => [{ id: 'fixture', root, status: 'not-git' }] });
  contexts.onBeforeRecover(async context => {
    await coordinator.attach(context, 'fixture', false);
    return () => coordinator.detach(context);
  });
  const get = vi.spyOn(coordinator, 'get');
  vi.spyOn(RunManager.prototype, 'recover').mockResolvedValue(undefined);
  try {
    const context = await contexts.context('fixture');
    expect(context.store.hasLifecycleObserver).toBe(false);
    contexts.disposeAll();
    expect(get).not.toHaveBeenCalled();
    expect(coordinator.count()).toBe(0);
  } finally {
    contexts.disposeAll(); await coordinator.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
});
