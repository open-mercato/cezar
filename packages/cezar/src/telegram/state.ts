import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { telegramInboundActivityBaseSchema, telegramInboundGrantSchema, telegramInboundIdSchema, telegramInboundPermissionSchema, telegramSourceRecordSchema, type TelegramSourceRecord } from '@open-mercato/cezar-contract';
import { atomicWrite, statePath } from '../webhooks/storage.ts';

export const MAX_STATE_BYTES = 2 * 1024 * 1024;
export const telegramIdSchema = telegramInboundIdSchema;
const id = z.string().min(1).max(128);
const time = z.number().int().nonnegative().safe();
export const permissionSchema = telegramInboundPermissionSchema;
export const bindingSchema = z.strictObject({
  projectId: id, installationId: id, root: z.string().min(1).max(4096), generation: z.uuid(),
});
export const receiverBindingSchema = z.strictObject({
  receiverId: id, chatId: telegramIdSchema, enabled: z.boolean(), generation: z.uuid(), acceptAfter: time,
  suspendedReason: z.enum(['bot_removed', 'group_migrated']).optional(),
  deliveryRevision: z.number().int().nonnegative(), credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const grantSchema = telegramInboundGrantSchema.strict();
export const correlationSchema = z.strictObject({
  receiverId: id, chatId: telegramIdSchema, messageId: z.number().int().positive().safe(),
  deliveryRevision: z.number().int().nonnegative(), bindingGeneration: z.uuid(), enableGeneration: z.uuid(),
  runId: id, type: z.string().max(64), sequence: z.number().int().nonnegative().safe(),
  episodeId: id, continuation: z.number().int().nonnegative(), requestId: id.optional(), askedAt: z.string().max(128).optional(),
  createdAt: time,
});
/** The task a private chat last addressed explicitly; plain text follows the newest interaction. */
export const chatContextSchema = z.strictObject({ receiverId: id, chatId: telegramIdSchema, userId: telegramIdSchema, runId: id, at: time });
export const journalEntrySchema = telegramInboundActivityBaseSchema.safeExtend({
  state: z.enum(['claimed', 'accepted', 'queued', 'deferred', 'rejected', 'uncertain']),
}).refine(row => row.kind !== 'rejection_summary' || row.state === 'rejected', 'Summary must be rejected');
export const inboundStateSchema = z.strictObject({
  schemaVersion: z.literal(1), botId: telegramIdSchema, binding: bindingSchema, configGeneration: z.uuid(),
  receivers: z.array(receiverBindingSchema).max(20), grants: z.array(grantSchema).max(100),
  fatalStop: z.enum(['conflict', 'credentials-unavailable', 'blocked']).optional(),
  transportCredentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  epoch: z.uuid(), phase: z.enum(['probing', 'active']), nextOffset: z.number().int().nonnegative().safe().nullable(),
  lastUpdateAt: time.nullable(), correlations: z.array(correlationSchema).max(5000), contexts: z.array(chatContextSchema).max(100).optional(), sources: z.array(telegramSourceRecordSchema).max(1000).default([]), journal: z.array(journalEntrySchema).max(501),
}).superRefine((state, ctx) => {
  if (state.journal.filter(entry => entry.state === 'claimed').length > 1) ctx.addIssue({ code: 'custom', message: 'Multiple pending actions' });
  if (state.sources.filter(entry => entry.state === 'claimed' || entry.state === 'received').length > 1) ctx.addIssue({ code: 'custom', message: 'Multiple pending sources' });
  if (new Set(state.sources.map(entry => `${entry.botId}:${entry.epoch}:${entry.receiverId}:${entry.updateId}`)).size !== state.sources.length) ctx.addIssue({ code: 'custom', message: 'Duplicate Telegram source' });
  for (const key of ['receiverId', 'chatId'] as const) {
    if (new Set(state.receivers.map(receiver => receiver[key])).size !== state.receivers.length) ctx.addIssue({ code: 'custom', message: 'Duplicate receiver binding' });
  }
  if (state.phase === 'probing' && state.nextOffset !== null) ctx.addIssue({ code: 'custom', message: 'Probing with offset' });
});
export type InboundState = z.infer<typeof inboundStateSchema>;
export type BotBinding = z.infer<typeof bindingSchema>;
export type InboundGrant = z.infer<typeof grantSchema>;
export type Correlation = z.infer<typeof correlationSchema>;
export type JournalEntry = z.infer<typeof journalEntrySchema>;
export type ChatContext = z.infer<typeof chatContextSchema>;
export type { TelegramSourceRecord };

/** A private chat's record that a notice was delivered; the runtime's only durable "already sent". */
export const deliveryReceipt = (row: Correlation): boolean => row.type !== 'task.attention_required' && !row.chatId.startsWith('-');
/** Drops the matching reply routes but keeps delivery receipts, so a Disable/Enable never resends a notice. */
export function forgetReplies(state: InboundState, matches: (row: Correlation) => boolean): void {
  state.correlations = state.correlations.filter(row => !matches(row) || deliveryReceipt(row));
}

export function freshState(botId: string, binding: BotBinding): InboundState {
  return inboundStateSchema.parse({ schemaVersion: 1, botId, binding, configGeneration: randomUUID(), receivers: [], grants: [],
    epoch: randomUUID(), phase: 'probing', nextOffset: null, lastUpdateAt: null, correlations: [], sources: [], journal: [] });
}

export async function readInboundState(directory: string, botId: string): Promise<InboundState | undefined> {
  telegramIdSchema.parse(botId);
  let file;
  try { file = await open(statePath(directory, `${botId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Inbound state is not a regular file');
    if (stat.size > MAX_STATE_BYTES) throw new Error('Inbound state exceeds limit');
    // A bounded read also covers a file growing between stat and read.
    const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_STATE_BYTES) throw new Error('Inbound state exceeds limit');
    const state = inboundStateSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
    if (state.botId !== botId) throw new Error('Inbound bot mismatch');
    return state;
  } finally { await file.close(); }
}

function compact(state: InboundState, now: number): void {
  state.correlations = state.correlations.filter(entry => entry.createdAt > now - 7 * 86400_000).slice(-5000);
  state.sources = state.sources.filter(entry => entry.state === 'claimed' || entry.updatedAt > now - 7 * 86400_000).slice(-1000);
  if (state.contexts) state.contexts = state.contexts.filter(entry => entry.at > now - 7 * 86400_000).slice(-100);
  const complete = [...state.journal.filter(entry => entry.state !== 'claimed' && entry.kind !== 'rejection_summary').slice(-450),
    ...state.journal.filter(entry => entry.kind === 'rejection_summary').slice(-50)].sort((a, b) => a.at - b.at);
  state.journal = [...complete, ...state.journal.filter(entry => entry.state === 'claimed')];
  // Account each removed element once. Re-stringifying a multi-MiB snapshot for
  // each eviction blocks the event loop exactly when the bounded store is full.
  let bytes = Buffer.byteLength(JSON.stringify(state) + '\n');
  while (bytes > MAX_STATE_BYTES) {
    const index = state.sources.findIndex(entry => entry.state !== 'claimed' && entry.state !== 'received');
    if (index === -1) break;
    bytes -= Buffer.byteLength(JSON.stringify(state.sources[index])) + (state.sources.length > 1 ? 1 : 0);
    state.sources.splice(index, 1);
  }
  let removed = 0;
  while (bytes > MAX_STATE_BYTES && removed < state.correlations.length) {
    bytes -= Buffer.byteLength(JSON.stringify(state.correlations[removed])) + (state.correlations.length - removed > 1 ? 1 : 0);
    removed++;
  }
  if (removed) state.correlations.splice(0, removed);
  while (bytes > MAX_STATE_BYTES) {
    const index = state.journal.findIndex(entry => entry.state !== 'claimed');
    if (index === -1) throw new Error('Inbound state exceeds limit');
    bytes -= Buffer.byteLength(JSON.stringify(state.journal[index])) + (state.journal.length > 1 ? 1 : 0);
    state.journal.splice(index, 1);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
type DurableParts = Pick<InboundState, 'binding' | 'receivers' | 'grants' | 'correlations' | 'contexts' | 'sources'>;
const quietReasons = new Set(['unauthorized', 'rate_limited']);

/** Single writer: readers see only published snapshots; failed durability blocks all further effects. */
export class InboundStateStore {
  private tail: Promise<unknown> = Promise.resolve();
  private blocked = false;
  // Frozen read views, rebuilt once per published version instead of cloning per read.
  private parts?: DurableParts;
  private view?: InboundState;
  private dirty = false;
  constructor(private state: InboundState, private readonly dependencies: {
    assertOwner(): void;
    /** Uncached ownership check around durable writes; defaults to assertOwner. */
    assertWriter?(): void;
    write(state: InboundState): Promise<void>;
    now?: () => number;
  }) { this.state = inboundStateSchema.parse(state); }

  static persisted(directory: string, state: InboundState, assertOwner: () => void, assertWriter?: () => void): InboundStateStore {
    return new InboundStateStore(state, { assertOwner, ...(assertWriter ? { assertWriter } : {}), write: value => atomicWrite(directory, `${value.botId}.json`, value) });
  }
  async drain(): Promise<void> { await this.tail; }
  /** Deep-frozen and shared until the next change: callers must never mutate it. */
  snapshot(): InboundState {
    if (this.view) return this.view;
    const { binding, receivers, grants, correlations, contexts, sources } = this.state;
    this.parts ??= deepFreeze(structuredClone({ binding, receivers, grants, correlations, contexts, sources }));
    return this.view = Object.freeze({ ...this.state, ...this.parts, journal: deepFreeze(structuredClone(this.state.journal)) });
  }
  assertReady(): void {
    if (this.blocked) throw new Error('Inbound state blocked');
    this.dependencies.assertOwner();
  }
  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async commit<T>(mutation: (state: InboundState) => T): Promise<T> {
    this.assertReady();
    const draft = structuredClone(this.state);
    const result = mutation(draft);
    compact(draft, this.dependencies.now?.() ?? Date.now());
    inboundStateSchema.parse(draft);
    const assertWriter = () => (this.dependencies.assertWriter ?? this.dependencies.assertOwner)();
    try {
      assertWriter();
      await this.dependencies.write(draft);
      assertWriter();
    } catch (error) { this.blocked = true; throw error; }
    this.state = draft; this.parts = undefined; this.view = undefined; this.dirty = false;
    return result;
  }
  change<T>(mutation: (state: InboundState) => T): Promise<T> { return this.enqueue(() => this.commit(mutation)); }
  /** Offset/journal bookkeeping only, published in memory; replay after a crash is deduplicated. */
  private quiet(mutation: (state: InboundState) => void): void {
    this.assertReady(); mutation(this.state); this.view = undefined; this.dirty = true;
  }
  /** Persists quiet bookkeeping; the poller calls it once per batch. */
  flush(): Promise<void> { return this.enqueue(async () => { if (this.dirty) await this.commit(() => undefined); }); }
  touch(at: number): Promise<void> { return this.enqueue(() => this.quiet(state => { state.lastUpdateAt = at; })); }
  async recover(): Promise<void> {
    await this.change(state => {
      for (const entry of state.journal) if (entry.state === 'claimed') {
        if (entry.epoch !== state.epoch) throw new Error('Pending action in old epoch');
        entry.state = 'uncertain'; entry.reason = 'interrupted';
        state.nextOffset = Math.max(state.nextOffset ?? 0, entry.updateId + 1);
        state.phase = 'active';
      }
      for (const source of state.sources) if (source.state === 'claimed' || source.state === 'received') {
        source.state = 'uncertain'; source.updatedAt = this.dependencies.now?.() ?? Date.now();
      }
    });
  }
  async preparePoll(now: number): Promise<void> {
    this.assertReady();
    if (this.state.phase === 'probing' || this.state.lastUpdateAt === null || now - this.state.lastUpdateAt < 6 * 86400_000) return;
    await this.recover();
    await this.change(state => { state.epoch = randomUUID(); state.phase = 'probing'; state.nextOffset = null; });
  }
  duplicate(epoch: string, updateId: number): boolean {
    this.assertReady();
    return epoch !== this.state.epoch || (this.state.nextOffset !== null && updateId < this.state.nextOffset)
      || this.state.journal.some(entry => entry.epoch === epoch && entry.updateId === updateId);
  }
  /** Moves a private chat's implicit context to `runId`; one row per (receiver, chat, person). */
  remember(context: ChatContext): Promise<void> {
    return this.change(state => {
      const rows = (state.contexts ?? []).filter(row => !(row.receiverId === context.receiverId && row.chatId === context.chatId && row.userId === context.userId));
      state.contexts = [...rows, chatContextSchema.parse(context)];
    });
  }
  async claim(entry: JournalEntry): Promise<boolean> {
    return this.change(state => {
      if (entry.epoch !== state.epoch || (state.nextOffset !== null && entry.updateId < state.nextOffset)
        || state.journal.some(row => row.epoch === entry.epoch && row.updateId === entry.updateId)) return false;
      if (state.journal.some(row => row.state === 'claimed')) throw new Error('Pending action requires recovery');
      state.journal.push(journalEntrySchema.parse({ ...entry, state: 'claimed' }));
      return true;
    });
  }
  async claimSource(entry: JournalEntry, source: TelegramSourceRecord): Promise<boolean> {
    return this.change(state => {
      if (entry.epoch !== state.epoch || (state.nextOffset !== null && entry.updateId < state.nextOffset)
        || state.journal.some(row => row.epoch === entry.epoch && row.updateId === entry.updateId)
        || state.sources.some(row => row.botId === source.botId && row.epoch === source.epoch
          && row.receiverId === source.receiverId && row.updateId === source.updateId)) return false;
      if (state.journal.some(row => row.state === 'claimed') || state.sources.some(row => row.state === 'claimed')) throw new Error('Pending action requires recovery');
      state.journal.push(journalEntrySchema.parse({ ...entry, state: 'claimed' }));
      state.sources.push(telegramSourceRecordSchema.parse({ ...source, state: 'claimed' }));
      return true;
    });
  }
  /** Settle source provenance, journal outcome and offset in one published durable snapshot. */
  async settleSource(epoch: string, updateId: number, id: string, outcome: JournalEntry,
    sourceResult: { state: 'finished' | 'expired' | 'delivery_failed' | 'uncertain' | 'policy_refused'; runId?: string;
      policyReason?: 'account_unavailable' | 'provider_unavailable' | 'project_unavailable' }): Promise<void> {
    await this.change(state => {
      const source = state.sources.find(row => row.id === id);
      if (!source || source.state !== 'claimed') throw new Error('Telegram source is not claimed');
      if (source.epoch !== epoch || source.updateId !== updateId) throw new Error('Telegram source identity changed');
      source.state = sourceResult.state; source.updatedAt = this.dependencies.now?.() ?? Date.now();
      if (sourceResult.runId) source.runId = sourceResult.runId;
      if (sourceResult.policyReason) source.policyReason = sourceResult.policyReason;
      this.settle(state, epoch, updateId, outcome);
    });
  }
  /** Ignored and stranger-rejected updates stay in memory until the next flush; effect outcomes are durable at once. */
  async finish(epoch: string, updateId: number, outcome?: JournalEntry): Promise<void> {
    await this.enqueue(async () => {
      const known = this.state.journal.some(entry => entry.epoch === epoch && entry.updateId === updateId);
      const quiet = !known && (!outcome || (outcome.state === 'rejected' && quietReasons.has(outcome.reason)));
      if (quiet) this.quiet(state => this.settle(state, epoch, updateId, outcome));
      else await this.commit(state => this.settle(state, epoch, updateId, outcome));
    });
  }
  /** Validates before mutating, so a refused quiet update leaves the published state untouched. */
  private settle(state: InboundState, epoch: string, updateId: number, outcome?: JournalEntry): void {
    if (epoch !== state.epoch) throw new Error('Inbound epoch changed');
    if (state.nextOffset !== null && updateId < state.nextOffset) return;
    const existing = state.journal.findIndex(entry => entry.epoch === epoch && entry.updateId === updateId);
    if (outcome?.state === 'rejected' && quietReasons.has(outcome.reason) && existing < 0) {
      if (outcome.epoch !== epoch || outcome.updateId !== updateId) throw new Error('Invalid action result');
      const minute = Math.floor(outcome.at / 60_000) * 60_000;
      const summary = state.journal.find(row => row.kind === 'rejection_summary' && row.epoch === epoch && row.botId === outcome.botId && row.at === minute && row.reason === outcome.reason);
      if (summary) summary.count = Math.min(Number.MAX_SAFE_INTEGER, summary.count! + 1);
      else state.journal.push(journalEntrySchema.parse({ id: outcome.id, epoch, updateId, at: minute, botId: outcome.botId, kind: 'rejection_summary', state: 'rejected', reason: outcome.reason, count: 1 }));
      state.nextOffset = updateId + 1; state.phase = 'active'; return;
    }
    if (outcome) {
      if (outcome.epoch !== epoch || outcome.updateId !== updateId || outcome.state === 'claimed') throw new Error('Invalid action result');
      if (existing >= 0) state.journal[existing] = outcome;
      else state.journal.push(outcome);
    } else if (existing >= 0 && state.journal[existing]!.state === 'claimed') throw new Error('Missing action result');
    state.nextOffset = Math.max(state.nextOffset ?? 0, updateId + 1); state.phase = 'active';
  }
}
