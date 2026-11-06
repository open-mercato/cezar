import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cezarHomeDir } from '../paths.ts';
import { acquireOwnership, OwnershipCleanupError, type WebhookOwnership } from '../webhooks/ownership.ts';
import { assertNoSymlink, atomicWrite, readState, statePath, syncDirectory } from '../webhooks/storage.ts';
import { bindingSchema, telegramIdSchema, type BotBinding } from './state.ts';

export class BotOwnershipError extends Error {
  constructor(readonly code: 'owner_conflict' | 'binding_conflict' | 'binding_missing' | 'binding_changed') { super(code); }
}
const pendingCleanup = new Map<string, WebhookOwnership>();
export function botDirectory(botId: string, dryRun = false): string {
  if (!telegramIdSchema.safeParse(botId).success || botId.startsWith('-')) throw new Error('Invalid bot ID');
  return join(cezarHomeDir(), 'telegram', ...(dryRun ? ['dry-run'] : []), 'bots', botId);
}
async function directory(botId: string, dryRun: boolean): Promise<string> {
  const path = botDirectory(botId, dryRun); assertNoSymlink(path);
  await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
  return path;
}
export class BotLease {
  private verifiedAt = -Infinity;
  private constructor(readonly directory: string, private readonly owner: WebhookOwnership, private readonly now: () => number = performance.now.bind(performance)) {}
  static async acquire(botId: string, dryRun = false): Promise<BotLease> {
    const path = await directory(botId, dryRun);
    const cleanup = pendingCleanup.get(path);
    if (cleanup) { await cleanup.release(); pendingCleanup.delete(path); }
    let owner;
    try { owner = await acquireOwnership(path); }
    catch (error) {
      if (error instanceof OwnershipCleanupError) pendingCleanup.set(path, error.ownership);
      throw error;
    }
    if (!owner) throw new BotOwnershipError('owner_conflict');
    return new BotLease(path, owner);
  }
  /** Durable writes and decisions: always re-reads owner.lock. */
  assertOwner(): void {
    if (!this.owner.valid()) { this.verifiedAt = -Infinity; throw new BotOwnershipError('owner_conflict'); }
    this.verifiedAt = this.now();
  }
  /** Hot read paths (budget lookup, readiness): a success is reused for up to one second. */
  assertOwnerCached(): void { if (this.now() - this.verifiedAt >= 1000) this.assertOwner(); }
  async binding(): Promise<BotBinding | undefined> {
    this.assertOwner();
    const binding = await readState(this.directory, 'binding.json', bindingSchema);
    this.assertOwner(); return binding;
  }
  async bind(identity: Omit<BotBinding, 'generation'>): Promise<BotBinding> {
    const current = await this.binding();
    if (current) {
      if (current.projectId !== identity.projectId || current.root !== identity.root || current.installationId !== identity.installationId) throw new BotOwnershipError('binding_conflict');
      return current;
    }
    const next = bindingSchema.parse({ ...identity, generation: randomUUID() });
    this.assertOwner(); await atomicWrite(this.directory, 'binding.json', next); this.assertOwner();
    return next;
  }
  async validate(expected: BotBinding): Promise<void> {
    const current = await this.binding();
    if (!current) throw new BotOwnershipError('binding_missing');
    if (current.generation !== expected.generation || current.projectId !== expected.projectId
      || current.root !== expected.root || current.installationId !== expected.installationId) throw new BotOwnershipError('binding_changed');
  }
  async disconnect(expected: BotBinding): Promise<void> {
    await this.validate(expected);
    this.assertOwner(); await rm(statePath(this.directory, 'binding.json')); await syncDirectory(this.directory);
  }
  async release(): Promise<void> {
    try { await this.owner.release(); pendingCleanup.delete(this.directory); }
    catch (error) { pendingCleanup.set(this.directory, this.owner); throw error; }
  }
}
