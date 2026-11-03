import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { telegramOrphanBindingsSchema, telegramOrphanReleasedSchema, type TelegramOrphanBindings } from '@open-mercato/cezar-contract';
import { BotLease, botDirectory } from './ownership.ts';
import { bindingSchema, type BotBinding } from './state.ts';
import { assertNoSymlink, statePath } from '../webhooks/storage.ts';
import { TelegramInboundFailure } from './errors.ts';
import { telegramNotificationsUnavailableReason } from './availability.ts';
interface Project { id: string; root: string; status: string }
interface Dependencies {
  mode(): 'local' | 'hosted'; projects(): Promise<readonly Project[]>;
  visibleProject?(): string | undefined | Promise<string | undefined>; dryRun?: boolean;
}
const revision = (binding: BotBinding) => createHash('sha256').update(JSON.stringify([binding.projectId, binding.root, binding.installationId, binding.generation])).digest('hex');
/** Diagnostic only; decisions must reread under a lease. No file creation on GET. */
export async function readBinding(botId: string, dryRun: boolean): Promise<BotBinding | undefined> {
  let file;
  try { file = await open(statePath(botDirectory(botId, dryRun), 'binding.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    if (!(await file.stat()).isFile()) throw new Error('Binding is not a regular file');
    const bytes = Buffer.alloc(16 * 1024 + 1); let size = 0;
    while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size === bytes.length) throw new Error('Binding exceeds limit');
    return bindingSchema.parse(JSON.parse(bytes.subarray(0, size).toString('utf8')));
  } finally { await file.close(); }
}
export class TelegramBindings {
  constructor(private readonly deps: Dependencies) {}
  private gate(): void {
    const reason = telegramNotificationsUnavailableReason(this.deps.mode());
    if (reason) throw new TelegramInboundFailure(503, reason);
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
  async list(): Promise<TelegramOrphanBindings> {
    if (telegramNotificationsUnavailableReason(this.deps.mode())) return { bindings: [], truncated: false };
    return this.scan();
  }
  /** Ungated scan for the owning service's own startup discovery. */
  async scan(): Promise<TelegramOrphanBindings> {
    const parent = dirname(botDirectory('1', this.deps.dryRun)), visible = await this.deps.visibleProject?.();
    assertNoSymlink(parent);
    let directory;
    try { directory = await opendir(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bindings: [], truncated: false }; throw error; }
    const bindings: TelegramOrphanBindings['bindings'] = []; let scanned = 0, truncated = false;
    for await (const entry of directory) {
      if (++scanned > 1000 || bindings.length >= 100) { truncated = true; break; }
      if (!entry.isDirectory() || !/^[1-9][0-9]{0,15}$/.test(entry.name) || !Number.isSafeInteger(Number(entry.name))) continue;
      try {
        const binding = await readBinding(entry.name, this.deps.dryRun === true);
        if (!binding || (visible !== undefined && binding.projectId !== visible)) continue;
        bindings.push({ botId: entry.name, projectId: binding.projectId, orphaned: await this.orphaned(binding), inboundRevision: revision(binding) });
      } catch { truncated = true; } // Invalid entries cannot authorize release; disclose an incomplete diagnostic view.
    }
    return telegramOrphanBindingsSchema.parse({ bindings, truncated });
  }
  async release(botId: string, expectedRevision: string) {
    this.gate();
    const visible = await this.deps.visibleProject?.();
    const preview = await readBinding(botId, this.deps.dryRun === true);
    if (!preview || (visible !== undefined && preview.projectId !== visible)) throw new TelegramInboundFailure(404, 'binding_missing');
    const lease = await BotLease.acquire(botId, this.deps.dryRun);
    try {
      this.gate(); const binding = await lease.binding();
      if (!binding || (visible !== undefined && binding.projectId !== visible)) throw new TelegramInboundFailure(404, 'binding_missing');
      if (revision(binding) !== expectedRevision) throw new TelegramInboundFailure(409, 'revision_conflict');
      if (!await this.orphaned(binding)) throw new TelegramInboundFailure(409, 'project_present');
      this.gate(); await lease.disconnect(binding);
      return telegramOrphanReleasedSchema.parse({ released: true });
    } finally { await lease.release(); }
  }
}
