import { execFileSync } from 'node:child_process';
import { realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WebhookService } from './service.ts';
import type { ProjectContext } from '../server/project-context.ts';
import { WebhookCoordinator } from './coordinator.ts';
const roots: string[] = [];
const instances: WebhookCoordinator[] = [];
function root() { const value = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-coordinator-')); roots.push(value); execFileSync('git', ['init', '-q'], { cwd: value }); return value; }
afterEach(async () => { for (const coordinator of instances.splice(0)) await coordinator.dispose(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
describe('lightweight project webhook enrollment', () => {
  it('reopens a broken cached service during discovery preserving its public slug', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const project = root();
    const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], singleProject: true }); instances.push(coordinator);
    const service = await coordinator.get('public-slug', project, true);
    vi.spyOn(service.endpoints, 'create').mockRejectedValueOnce(new Error('temporary storage failure'));
    await expect(service.create({ name: 'Ops', url: 'https://example.com' })).rejects.toThrow();
    await coordinator.discover();
    const repaired = await coordinator.get('public-slug', project);
    expect(repaired).not.toBe(service); expect(repaired.list().webhookHealth.status).toBe('degraded');
    await expect(repaired.create({ name: 'Ops', url: 'https://example.com' })).resolves.toBeDefined();
  });
  it('unregisters and closes listeners even when owner release fails', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const project = root();
    const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [] }); instances.push(coordinator);
    const service = await coordinator.get('project', project); const disposed = vi.fn(); service.on('dispose', disposed);
    const ownership = (service as unknown as { ownership: { release(): Promise<void> } }).ownership;
    vi.spyOn(ownership, 'release').mockRejectedValueOnce(new Error('EACCES'));
    expect(await coordinator.remove(project)).toContain('stopped');
    expect(coordinator.count()).toBe(0); expect(disposed).toHaveBeenCalledOnce(); expect(service.listenerCount('dispose')).toBe(0);
    await service.dispose();
  });
  it('reattaches ready capture after repair without backfilling the gap or changing the public slug', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const project = root(); const dataDir = join(project, '.ai/cezar');
    const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], singleProject: true, dryRun: true }); instances.push(coordinator);
    const store = RunStore.open(dataDir);
    const context = { id: 'default', root: project, store, manager: { isActive: () => false } } as unknown as ProjectContext;
    await coordinator.attach(context, 'public-slug', true, true);
    const service = await coordinator.get('public-slug', project);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.id, 1);
    vi.spyOn(service.endpoints, 'create').mockRejectedValueOnce(new Error('disk'));
    await expect(service.create({ name: 'Second', url: 'https://example.com' })).rejects.toThrow('disk');
    const old = store.createRun({ title: 'gap', task: 'gap', workflow: 'w', steps: [] }); store.updateRun(old.id, { status: 'done' });
    await coordinator.discover(); const repaired = await coordinator.get('public-slug', project);
    expect(repaired.projectId).toBe('public-slug');
    const fresh = store.createRun({ title: 'new', task: 'new', workflow: 'w', steps: [] }); store.updateRun(fresh.id, { status: 'done' });
    await repaired.tick();
    expect(repaired.deliveries(receiver.id)).toHaveLength(1);
    expect(JSON.parse(repaired.deliveries(receiver.id)[0]!.body!)).toMatchObject({ task: { id: fresh.id }, source: { projectId: 'public-slug' } });
    store.flush();
  });
  it('bounds failed reopen attempts and refuses to steal a live owner', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const project = root();
    const deps = { mode: () => 'local' as const, ports: () => [], projects: async () => [] };
    const coordinator = new WebhookCoordinator(deps), other = new WebhookCoordinator(deps); instances.push(coordinator, other);
    const service = await coordinator.get('project', project);
    await expect(other.get('project', project)).rejects.toMatchObject({ status: 503 });
    vi.spyOn(service.endpoints, 'create').mockRejectedValueOnce(new Error('disk'));
    await expect(service.create({ name: 'Ops', url: 'https://example.com' })).rejects.toThrow('disk');
    const spy = vi.spyOn(WebhookService, 'open').mockRejectedValue(new Error('disk still unavailable'));
    try { await coordinator.discover(); await coordinator.discover(); expect(spy).toHaveBeenCalledTimes(1); }
    finally { spy.mockRestore(); }
  });
  it('pins an unregistered boot root and aliases use one canonical owner', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const boot = root(), other = root();
    const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [4317], projects: async () => [{ id: 'a', root: other, status: 'ok' }] }); instances.push(coordinator);
    const first = await coordinator.get('boot-slug', boot, true);
    await coordinator.discover();
    expect(await coordinator.get('registered-later', boot)).toBe(first);
    expect(coordinator.count()).toBe(1);
  });
  it('does not discover other enrolled roots in single-project mode', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const boot = root(), other = root();
    const seed = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [] }); instances.push(seed);
    await (await seed.get('other', other)).create({ name: 'Other', url: 'https://example.com' }); await seed.dispose();
    const projects = vi.fn(async () => [{ id: 'other', root: other, status: 'ok' }]);
    const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects, singleProject: true }); instances.push(coordinator);
    await coordinator.get('boot', boot, true); await coordinator.discover();
    expect(coordinator.count()).toBe(1); expect(projects).not.toHaveBeenCalled();
  });
  it('pauses an owned project durably on explicit removal but not routine discovery', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const project = root();
    const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [] }); instances.push(coordinator);
    const service = await coordinator.get('project', project, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    await coordinator.discover(); expect(service.list().receivers[0]!.state).toBe('active');
    expect(await coordinator.remove(project)).toBeUndefined();
    const reopened = await coordinator.get('project', project, true);
    expect(reopened.list().receivers[0]).toMatchObject({ state: 'paused', pauseReason: 'project_removal' });
  });
});

it('throttles failed first opens across aliases and retries after failure cooldown', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const project = root();
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [] });
  instances.push(coordinator);
  let now = 100000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const open = vi.spyOn(WebhookService, 'open').mockImplementation(async () => {
    now += 30000; // A cold probe can outlast the retry interval.
    throw new Error('owner unavailable');
  });
  try {
    await expect(coordinator.get('project', project)).rejects.toThrow();
    await expect(coordinator.get('alias', project)).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
    now += 15000;
    await expect(coordinator.get('alias', project)).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(2);
  } finally { open.mockRestore(); clock.mockRestore(); }
});
