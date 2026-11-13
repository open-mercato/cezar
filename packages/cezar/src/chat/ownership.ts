import type { ChatProviderId } from './provider.ts';
import { chatProviderIdSchema } from '@open-mercato/cezar-contract';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cezarHomeDir } from '../paths.ts';
import { acquireOwnership, OwnershipCleanupError, type WebhookOwnership } from '../webhooks/ownership.ts';
import { assertNoSymlink, atomicWrite, readState, statePath, syncDirectory } from '../webhooks/storage.ts';
import { bindingSchema, chatIdSchema, type BotBinding } from './state.ts';

export class BotOwnershipError extends Error {
  constructor(readonly code: 'owner_conflict' | 'binding_conflict' | 'binding_missing' | 'binding_changed') { super(code); }
}
const pendingCleanup = new Map<string, WebhookOwnership>();
export function botDirectory(botId: string, dryRun = false, provider: ChatProviderId = 'telegram'): string {
  if (!chatIdSchema.safeParse(botId).success || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(botId)) throw new Error('Invalid bot ID');
  // Platform IDs are only unique within their provider, so the lease is provider-scoped.
  if (!chatProviderIdSchema.safeParse(provider).success) throw new Error('Invalid chat provider');
  // Qualified IDs must be one segment: telegram/dry-run must not share the
  // native Telegram dry-run directory. The schema excludes percent escapes;
  // encoding is collision-free and leaves every native path and lock unchanged.
  return join(cezarHomeDir(), 'chat', encodeURIComponent(provider), ...(dryRun ? ['dry-run'] : []), 'bots', botId);
}
async function releaseOwner(path: string, owner: WebhookOwnership): Promise<void> {
  try { await owner.release(); pendingCleanup.delete(path); }
  catch (error) { pendingCleanup.set(path, owner); throw error; }
}
async function acquireOwner(path: string): Promise<WebhookOwnership> {
  const cleanup = pendingCleanup.get(path);
  if (cleanup) await releaseOwner(path, cleanup);
  let owner;
  try { owner = await acquireOwnership(path); }
  catch (error) {
    if (error instanceof OwnershipCleanupError) pendingCleanup.set(path, error.ownership);
    throw error;
  }
  if (!owner) throw new BotOwnershipError('owner_conflict');
  return owner;
}
export class BotLease {
  private verifiedAt = -Infinity;
  private constructor(readonly directory: string, private readonly owner: WebhookOwnership, private readonly now: () => number = performance.now.bind(performance)) {}
  static async acquire(botId: string, dryRun = false, provider: ChatProviderId = 'telegram'): Promise<BotLease> {
    const path = botDirectory(botId, dryRun, provider); assertNoSymlink(path);
    await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
    return new BotLease(path, await acquireOwner(path));
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
  async bind(identity: Omit<BotBinding, 'generation'>, generation: string = randomUUID()): Promise<BotBinding> {
    const current = await this.binding();
    if (current) {
      if (current.projectId !== identity.projectId || current.root !== identity.root || current.installationId !== identity.installationId) throw new BotOwnershipError('binding_conflict');
      return current;
    }
    const next = bindingSchema.parse({ ...identity, generation });
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
