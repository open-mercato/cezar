import { listServerInstances } from '../server-install/state.ts';
import { hostedTaskLink } from './links.ts';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebhookService, webhooksEnabled } from './service.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookStateError } from './endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
import { getRepoInfo } from '../server/git.ts';
import { parseRemote } from '../server/forge/index.ts';
type CaptureContext = Pick<ProjectContext, 'root' | 'store' | 'manager'>;
interface Project { id: string; root: string; status: string }
interface Dependencies { mode(): 'local' | 'hosted'; ports(): readonly number[]; projects(): Promise<readonly Project[]>; dryRun?: boolean; singleProject?: boolean }
/** Storage owners are independent of RunManagers; discovery never starts or recovers tasks. */
export class WebhookCoordinator {
  private services = new Map<string, WebhookService>();
  private retiring = new Map<string, WebhookService>();
  private opening = new Map<string, Promise<WebhookService>>();
  private contexts = new Map<string, { context: CaptureContext; ready: boolean; publicId: string }>();
  private pinned = new Set<string>();
  private scheduler = new WebhookScheduler();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private nextRecovery = new Map<string, number>();
  constructor(private readonly deps: Dependencies) {}
  count(): number { return this.services.size; }
  async get(projectId: string, root: string, pin = false): Promise<WebhookService> {
    if (!webhooksEnabled()) throw new WebhookStateError(409, 'Enable webhook delivery with CEZ_WEBHOOKS=1 and restart cezar');
    if (this.stopped) throw new WebhookStateError(503, 'Webhook service is unavailable');
    let canonical: string;
    try { canonical = realpathSync(root); } catch { throw new WebhookStateError(503, 'Project root is unavailable'); }
    if (pin) this.pinned.add(canonical);
    const existing = this.services.get(canonical);
    if (existing) {
      existing.setProjectId(projectId);
      if (!existing.needsRecovery) return existing;
      if ((this.nextRecovery.get(canonical) ?? 0) > Date.now()) return existing;
    }
    const pending = this.opening.get(canonical); if (pending) return pending;
    if (!existing && (this.nextRecovery.get(canonical) ?? 0) > Date.now()) {
      throw new WebhookStateError(503, 'Webhook service is unavailable; retry after recovery cooldown');
    }
    const work = (async () => {
      this.nextRecovery.set(canonical, Date.now() + 15000);
      if (existing) await existing.dispose();
      const retired = this.retiring.get(canonical);
      if (retired) { await retired.dispose(); this.retiring.delete(canonical); }
      const remote = parseRemote((await getRepoInfo(canonical))?.remote ?? '');
      const service = await WebhookService.open({ root: canonical, dataDir: join(canonical, '.ai/cezar'), projectId, mode: this.deps.mode(), serverPorts: this.deps.ports,
        cockpitLink: (projectId, taskId) => hostedTaskLink(listServerInstances(), this.deps.mode(), this.deps.ports()[0], process.env.CEZ_INSTANCE_ID, projectId, taskId),
        scheduler: this.scheduler, dryRun: this.deps.dryRun, ...(remote?.host === 'github.com' ? { repository: `${remote.owner}/${remote.repo}` } : {}) });
      if (!service) throw new WebhookStateError(409, 'Enable webhook delivery with CEZ_WEBHOOKS=1 and restart cezar');
      if (this.stopped) { await service.dispose(); throw new WebhookStateError(503, 'Webhook service is unavailable'); }
      if (existing) service.markCaptureGap();
      this.services.set(canonical, service);
      this.nextRecovery.delete(canonical);
      const attached = this.contexts.get(canonical);
      if (attached) service.attach(attached.context.store, attached.context.manager, attached.ready);
      if (this.timer) service.start();
      return service;
    })();
    this.opening.set(canonical, work);
    try { return await work; }
    catch (error) {
      // Start the cooldown after failure: a cold OS probe may itself exceed 15 seconds.
      this.nextRecovery.set(canonical, Date.now() + 15000);
      throw error;
    } finally { this.opening.delete(canonical); }
  }
  async attach(context: CaptureContext, publicId: string, ready: boolean, pin = false): Promise<void> {
    if (!webhooksEnabled()) return;
    try {
      const root = realpathSync(context.root); this.contexts.set(root, { context, ready, publicId });
      const service = await this.get(publicId, root, pin);
      // Opening can overlap rollback or a replacement attachment.
      const current = this.contexts.get(root);
      if (current?.context === context) service.attach(context.store, context.manager, current.ready);
    } catch { /* Optional integration never prevents task recovery or server boot. */ }
  }
  detach(context: CaptureContext): void {
    // Look up by identity even if the root disappeared after preparation.
    for (const [root, entry] of this.contexts) {
      if (entry.context !== context) continue;
      this.contexts.delete(root);
    }
    // A replacement may be registered but still waiting for its service to open.
    for (const service of this.services.values()) service.detach(context.store, context.manager);
  }
  ready(root: string, context?: CaptureContext): void {
    try {
      const canonical = realpathSync(root); const entry = this.contexts.get(canonical);
      if (!entry || (context && entry.context !== context)) return;
      entry.ready = true; this.services.get(canonical)?.markReady();
    } catch { /* Gone root. */ }
  }
  start(): void {
    if (this.timer || !webhooksEnabled() || this.stopped) return;
    for (const service of this.services.values()) service.start();
    this.timer = setInterval(() => { void this.discover().catch(() => undefined); }, 15000); this.timer.unref();
    void this.discover().catch(() => undefined);
  }
  async discover(): Promise<void> {
    if (!webhooksEnabled() || this.stopped) return;
    for (const [root, service] of this.retiring) {
      try { await service.dispose(); this.retiring.delete(root); } catch { /* Retry token-checked release on the next health check. */ }
    }
    for (const [root, service] of this.services) if (service.needsRecovery) await this.get(service.projectId, root).catch(() => undefined);
    const projects = this.deps.singleProject ? [] : await this.deps.projects();
    for (const project of projects) {
      if (project.status === 'missing' || !existsSync(join(project.root, '.ai/cezar/webhooks/endpoints.json'))) continue;
      await this.get(project.id, project.root).catch(() => undefined);
    }
    // The boot owner remains pinned even when omitted by workspace registration.
    // Explicit removal owns the pause policy; discovery cannot promise another owner's stop.
    for (const [root, entry] of this.contexts) if (!this.services.has(root)) await this.attach(entry.context, entry.publicId, entry.ready, this.pinned.has(root));
  }
  async remove(root: string): Promise<string | undefined> {
    let canonical: string;
    let warning: string | undefined;
    try { canonical = realpathSync(root); } catch { canonical = resolve(root); warning = 'Webhook receivers could not be paused because the project root is unavailable'; }
    await this.opening.get(canonical)?.catch(() => undefined);
    const service = this.services.get(canonical);
    this.contexts.delete(canonical); this.pinned.delete(canonical);
    if (!service) return warning ?? (existsSync(join(canonical, '.ai/cezar/webhooks/endpoints.json')) ? 'Webhook receivers may be owned by another cockpit; pause them there before unregistering' : undefined);
    try { for (const receiver of service.list().receivers) if (['active', 'suspended'].includes(receiver.state)) await service.pause(receiver.id, receiver.revision, 'project_removal'); }
    catch { warning = 'Webhook pause could not be saved; this instance stopped but another owner may resume delivery'; }
    try { await service.dispose(); }
    catch { this.retiring.set(canonical, service); warning = 'Webhook cleanup could not be saved; this instance stopped but another owner may resume delivery'; }
    finally { this.services.delete(canonical); this.nextRecovery.delete(canonical); }
    return warning;
  }
  async dispose(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled([...this.services.values(), ...this.retiring.values()].map(service => service.dispose())); this.services.clear(); this.retiring.clear(); this.contexts.clear();
  }
}
