import type { ChatProviderId } from './provider.ts';
import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { chatOrphanBindingsSchema, chatOrphanReleasedSchema, type ChatOrphanBindings } from '@open-mercato/cezar-contract';
import { BotLease, botDirectory } from './ownership.ts';
import { bindingSchema, type BotBinding } from './state.ts';
import { assertNoSymlink, statePath } from '../webhooks/storage.ts';
import { ChatInboundFailure } from './errors.ts';
import { chatNotificationsUnavailableReason } from './availability.ts';
interface Project { id: string; root: string; status: string }
interface Dependencies {
  provider?: ChatProviderId; mode(): 'local' | 'hosted'; projects(): Promise<readonly Project[]>;
  visibleProject?(): string | undefined | Promise<string | undefined>; dryRun?: boolean;
}
const revision = (binding: BotBinding) => createHash('sha256').update(JSON.stringify([binding.projectId, binding.root, binding.installationId, binding.generation])).digest('hex');
/** Diagnostic only; decisions must reread under a lease. No file creation on GET. */
export async function readBinding(botId: string, dryRun: boolean, provider: ChatProviderId = 'telegram'): Promise<BotBinding | undefined> {
  let file;
  try { file = await open(statePath(botDirectory(botId, dryRun, provider), 'binding.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    if (!(await file.stat()).isFile()) throw new Error('Binding is not a regular file');
    const bytes = Buffer.alloc(16 * 1024 + 1); let size = 0;
    while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size === bytes.length) throw new Error('Binding exceeds limit');
    return bindingSchema.parse(JSON.parse(bytes.subarray(0, size).toString('utf8')));
  } finally { await file.close(); }
}
export class ChatBindings {
  constructor(private readonly deps: Dependencies) {}
  private gate(): void {
    const reason = chatNotificationsUnavailableReason(this.deps.mode());
    if (reason) throw new ChatInboundFailure(503, reason);
  }
  private async orphaned(binding: BotBinding): Promise<boolean> {
    const project = (await this.deps.projects()).find(project => project.id === binding.projectId);
    if (!project || project.status === 'missing') return true;
    try { return await realpath(project.root) !== binding.root; }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return true;
      throw error; // Permission/probe failure is not evidence of an orphan.
    }
  }
  /** Hosted or webhooks off: an empty diagnostic, never another project's bot ids. */
  async list(): Promise<ChatOrphanBindings> {
    if (chatNotificationsUnavailableReason(this.deps.mode())) return { bindings: [], truncated: false };
    return this.scan();
  }
  /** Ungated scan for the owning service's own startup discovery. */
  async scan(): Promise<ChatOrphanBindings> {
    const parent = dirname(botDirectory('1', this.deps.dryRun, this.deps.provider)), visible = await this.deps.visibleProject?.();
    assertNoSymlink(parent);
    let directory;
    try { directory = await opendir(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bindings: [], truncated: false }; throw error; }
    const bindings: ChatOrphanBindings['bindings'] = []; let scanned = 0, truncated = false;
    for await (const entry of directory) {
      if (++scanned > 1000 || bindings.length >= 100) { truncated = true; break; }
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(entry.name)) continue;
      try {
        const binding = await readBinding(entry.name, this.deps.dryRun === true, this.deps.provider);
        if (!binding || (visible !== undefined && binding.projectId !== visible)) continue;
        bindings.push({ botId: entry.name, projectId: binding.projectId, orphaned: await this.orphaned(binding), inboundRevision: revision(binding) });
      } catch { truncated = true; } // Invalid entries cannot authorize release; disclose an incomplete diagnostic view.
    }
    return chatOrphanBindingsSchema.parse({ bindings, truncated });
  }
  async release(botId: string, expectedRevision: string) {
    this.gate();
    const visible = await this.deps.visibleProject?.();
    const preview = await readBinding(botId, this.deps.dryRun === true, this.deps.provider);
    if (!preview || (visible !== undefined && preview.projectId !== visible)) throw new ChatInboundFailure(404, 'binding_missing');
    const lease = await BotLease.acquire(botId, this.deps.dryRun === true, this.deps.provider ?? 'telegram');
    try {
      this.gate(); const binding = await lease.binding();
      if (!binding || (visible !== undefined && binding.projectId !== visible)) throw new ChatInboundFailure(404, 'binding_missing');
      if (revision(binding) !== expectedRevision) throw new ChatInboundFailure(409, 'revision_conflict');
      if (!await this.orphaned(binding)) throw new ChatInboundFailure(409, 'project_present');
      this.gate(); await lease.disconnect(binding);
      return chatOrphanReleasedSchema.parse({ released: true });
    } finally { await lease.release(); }
  }
}
