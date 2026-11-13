import { chatIdentifierSchemaFor } from '@open-mercato/cezar-contract';
import { ChatSecretReadError, type ChatSecrets, chatSecretRefSchema } from '../chat/credentials.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  chatDestinationMatchesBot, chatIdentifierSchemas, createWebhookSchema, webhookStoredSettingsSchema, updateWebhookSchema, webhookReceiverStateSchema, webhookHistoricalReceiverSchema, webhookNoticeSchema,
  type WebhookReceiver, type WebhookList,
} from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { TELEGRAM_ORIGIN, TelegramSecretError, telegramToken, TelegramSecretReadError, type TelegramSecrets } from './telegram-secrets.ts';
import { generateSigningKey } from './signing.ts';
import { maskDestination } from './destination.ts';
import { prepareWrite, readState } from './storage.ts';

// Runtime-only values for the existing redaction pipeline; never part of receiver JSON.
const credentialValues = new Map<string, string[]>();
function rememberCredential(name: string, credential: string): void {
  let values = [credential];
  try { const decoded: unknown = JSON.parse(credential); if (decoded && typeof decoded === 'object') values = [...values, ...Object.values(decoded).filter((value): value is string => typeof value === 'string')]; } catch { /* single token */ }
  credentialValues.set(name, values);
}
const timestamp = z.iso.datetime();
const BOT_DESTINATION = new Set<string>(['format', 'url', 'chatId', 'allowLocalNetwork']);
const counter = z.number().int().nonnegative();
const definitionSchema = webhookStoredSettingsSchema.strip();
export const privateReceiverSchema = webhookStoredSettingsSchema.safeExtend({
  chatSecret: chatSecretRefSchema.optional(),
  chatBotId: z.string().max(128).optional(),
  // Oldest admission revision allowed to send frozen content under the current policy.
  // Separate from deliveryRevision, which also authenticates existing bot replies.
  payloadSinceRevision: counter.min(1).optional(),
  lastResult: z.string().uuid().optional(),
  // Oldest audit revision whose result is still authoritative; only renames preserve it.
  resultRevision: counter.min(1).optional(),
  lastOperation: z.string().max(128).optional(),
  id: z.string().uuid(), state: webhookReceiverStateSchema, revision: counter.min(1), deliveryRevision: counter.min(1),
  secret: z.string().max(128), retired: z.strictObject({ secret: z.string().max(128), expiresAt: timestamp }).optional(),
  activation: z.strictObject({ installationId: z.string(), sequence: counter, revision: counter.min(1).optional(), mode: z.enum(['local', 'hosted']).default('local') }).optional(),
  createdAt: timestamp, updatedAt: timestamp, consecutiveFailures: counter,
  nextProbeAt: timestamp.optional(), activationBlocked: z.boolean(),
  lastTest: z.enum(['none', 'success', 'transient_failure', 'permanent_failure']),
  pauseReason: z.enum(['user', 'project_removal']).optional(),
});
export type PrivateReceiver = z.infer<typeof privateReceiverSchema>;
const stateSchema = z.strictObject({
  version: z.literal(1), receivers: z.array(privateReceiverSchema), history: z.array(webhookHistoricalReceiverSchema),
  changeSequence: counter, notice: webhookNoticeSchema.optional(),
});
type State = z.infer<typeof stateSchema>;
// The envelope remains strict; incompatible individual receivers must not prevent
// healthy receivers from loading. Keep their original JSON private and lossless.
const storedStateSchema = stateSchema.extend({ receivers: z.array(z.unknown()) });
export class WebhookStateError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429 | 502 | 503, message: string, readonly retryAt?: number) { super(message); }
}
export interface EndpointDependencies {
  telegramSecrets?: TelegramSecrets;
  chatSecrets?: ChatSecrets;
  installationId: string; mode?: 'local' | 'hosted'; highWater(): number; now(): number; assertOwner(): void;
  reserve?(bytes: number, definitionBytes: number, receiverCount: number): void;
  changed?(action: string, receiverId: string, revision: number, fields: string[]): void;
}
export class EndpointRegistry {
  private readonly unreadableReceivers: { index: number; value: unknown }[] = [];
  private unavailableTokens = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly deps: EndpointDependencies, private state: State) {}
  static async open(directory: string, deps: EndpointDependencies): Promise<EndpointRegistry> {
    const stored = await readState(directory, 'endpoints.json', storedStateSchema) ?? { version: 1 as const, receivers: [], history: [], changeSequence: 0 };
    const registry = new EndpointRegistry(directory, deps, { ...stored, receivers: [] });
    stored.receivers.forEach((value, index) => {
      const parsed = privateReceiverSchema.safeParse(value);
      if (parsed.success) registry.state.receivers.push(parsed.data);
      else registry.unreadableReceivers.push({ index, value });
    });
    for (const id of registry.state.receivers.map(item => item.id)) {
      const receiver = registry.get(id);
      if (receiver.format !== 'telegram.v1') { if (receiver.chatSecret) await registry.chatCredential(receiver).catch(() => registry.unavailableTokens.add(receiver.id)); continue; }
      // An entry without a vault reference has no credential to deliver with.
      try { receiver.url = await registry.destinationUrl(receiver); } catch { registry.unavailableTokens.add(receiver.id); }
    }
    return registry;
  }
  async resetIntegrity(): Promise<void> {
    const next = structuredClone(this.state);
    for (const receiver of next.receivers) {
      receiver.state = 'inactive'; receiver.activation = undefined; receiver.revision++; receiver.deliveryRevision++;
      receiver.nextProbeAt = undefined; receiver.consecutiveFailures = 0; receiver.updatedAt = this.time();
    }
    await this.commit(next, 'integrity_reset', '', 0);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result;
  }
  private get(id: string, expectedRevision?: number): PrivateReceiver {
    const receiver = this.state.receivers.find(item => item.id === id);
    if (!receiver) throw new WebhookStateError(404, 'Receiver not found');
    if (expectedRevision !== undefined && receiver.revision !== expectedRevision) throw new WebhookStateError(409, 'Receiver revision changed; refresh and try again');
    return receiver;
  }
  private public(receiver: PrivateReceiver): WebhookReceiver {
    return {
      kind: 'live', id: receiver.id, name: receiver.name, destination: maskDestination(receiver.url, receiver.chatId), format: receiver.format,
      state: receiver.state, revision: receiver.revision, deliveryRevision: receiver.deliveryRevision,
      ...(receiver.state === 'paused' && receiver.pauseReason ? { pauseReason: receiver.pauseReason } : {}),
      profile: receiver.profile, preset: receiver.preset, events: [...receiver.events], includeScheduledFailures: receiver.includeScheduledFailures,
      scope: receiver.scope, graceSeconds: receiver.graceSeconds, allowLocalNetwork: receiver.allowLocalNetwork,
      ...(receiver.chatId !== undefined ? { chatId: receiver.chatId } : {}),
      ...(receiver.includeAgentExcerpt ? { includeAgentExcerpt: true as const } : {}),
      createdAt: receiver.createdAt, updatedAt: receiver.updatedAt, pendingCount: 0, inFlightCount: 0, consecutiveFailures: receiver.consecutiveFailures,
      ...(receiver.nextProbeAt ? { nextProbeAt: receiver.nextProbeAt } : {}),
      ...(receiver.retired ? { retiredKeyExpiresAt: receiver.retired.expiresAt } : {}),
      activationBlocked: receiver.activationBlocked, lastTest: receiver.lastTest,
    };
  }
  private secrets(): string[] { return [...collectSecretValues(), ...this.state.receivers.flatMap(receiverSecretValues)]; }
  private time(): string { return new Date(this.deps.now()).toISOString(); }
  private async saveToken(receiver: PrivateReceiver) {
    if (!this.deps.telegramSecrets) throw new WebhookStateError(503, new TelegramSecretError().message);
    try { return await this.deps.telegramSecrets.save(receiver.id, receiver.url); }
    catch { throw new WebhookStateError(503, new TelegramSecretError().message); }
  }
  async chatCredential(receiver: PrivateReceiver): Promise<string> {
    try {
      if (!receiver.chatSecret || !this.deps.chatSecrets) throw new Error();
      const value = await this.deps.chatSecrets.read(receiver.chatSecret);
      rememberCredential(receiver.chatSecret.name, value); this.unavailableTokens.delete(receiver.id); return value;
    } catch (error) { throw new WebhookStateError(error instanceof ChatSecretReadError ? 503 : 409, 'Chat credentials unavailable'); }
  }
  /** Setup supplies authenticated identity. The revision is checked again inside the registry queue. */
  attachChat(input: { receiverId?: string; expectedRevision?: number; name?: string; format: string; url: string; chatId: string; botId: string; credential: string }): Promise<PrivateReceiver> {
    return this.serial(async () => {
      const old = input.receiverId ? this.get(input.receiverId, input.expectedRevision) : undefined;
      if (old && (input.expectedRevision === undefined || old.format !== input.format)) throw new WebhookStateError(409, 'Receiver changed');
      const provider = input.format.replace(/\.v1$/, '');
      chatIdentifierSchemaFor(provider).bot.parse(input.botId);
      if (!chatDestinationMatchesBot(provider, input.chatId, input.botId)) throw new WebhookStateError(409, 'Destination belongs to another bot');
      const settings = createWebhookSchema.parse({ ...(old ? definitionSchema.parse(old) : { name: input.name ?? provider, profile: 'standard', graceSeconds: 0 }), format: input.format, url: input.url, chatId: input.chatId, profile: 'standard', ...(old?.preset === 'custom' && !old.events.includes('task.attention_required') ? { events: [...old.events, 'task.attention_required'] } : {}) });
      if (!this.deps.chatSecrets) throw new WebhookStateError(503, 'Chat credentials unavailable');
      const id = old?.id ?? randomUUID();
      const ref = await this.deps.chatSecrets.save(id, input.credential);
      rememberCredential(ref.name, input.credential); settings.name = redactSecrets(settings.name, [...this.secrets(), ...credentialValues.get(ref.name)!]);
      const receiver: PrivateReceiver = { ...settings, id, secret: '', state: 'inactive', revision: (old?.revision ?? 0) + 1, deliveryRevision: (old?.deliveryRevision ?? 0) + 1,
        createdAt: old?.createdAt ?? this.time(), updatedAt: this.time(), consecutiveFailures: 0, activationBlocked: false, lastTest: 'none', chatSecret: ref, chatBotId: input.botId };
      const next = structuredClone(this.state); next.receivers = [...next.receivers.filter(row => row.id !== id), receiver];
      await this.commit(next, 'configuration_changed', id, receiver.revision);
      return structuredClone(receiver);
    });
  }
  async destinationUrl(receiver: PrivateReceiver): Promise<string> {
    if (receiver.format !== 'telegram.v1') return receiver.url;
    try {
      if (!receiver.chatSecret || !this.deps.telegramSecrets) throw new TelegramSecretError();
      const url = await this.deps.telegramSecrets.url(receiver.chatSecret);
      const current = this.state.receivers.find(item => item.id === receiver.id);
      if (current?.chatSecret?.name === receiver.chatSecret.name) current.url = url;
      this.unavailableTokens.delete(receiver.id);
      return url;
    } catch (error) {
      this.unavailableTokens.add(receiver.id);
      // 503 = the vault could not be read right now; 409 = the credential is missing or changed.
      throw error instanceof TelegramSecretReadError ? new WebhookStateError(503, error.message) : new WebhookStateError(409, new TelegramSecretError().message);
    }
  }
  private async commit(next: State, action: string, id: string, revision: number, fence?: number, openNotice: boolean | 'preserve' = true, fields: string[] = []): Promise<boolean> {
    const candidates = [...this.state.receivers, ...next.receivers].flatMap(item => item.chatSecret ? [{ ref: item.chatSecret, format: item.format }] : []);
    try { return await this.publish(next, action, id, revision, fence, openNotice, fields); }
    finally {
      // Publication can succeed before fsync fails. Consult the actual in-memory commit
      // point, never the thrown error, before deleting either an old or staged token.
      const live = new Set(this.state.receivers.map(item => item.chatSecret?.name));
      for (const { value } of this.unreadableReceivers) {
        if (value && typeof value === 'object' && 'chatSecret' in value) {
          const ref = chatSecretRefSchema.safeParse(value.chatSecret);
          if (ref.success) live.add(ref.data.name);
        }
      }
      for (const { ref, format } of new Map(candidates.map(item => [item.ref.name, item])).values()) {
        if (!live.has(ref.name)) { credentialValues.delete(ref.name); await (format === 'telegram.v1' ? this.deps.telegramSecrets : this.deps.chatSecrets)?.remove(ref); }
      }
    }
  }
  private async publish(next: State, action: string, id: string, revision: number, fence?: number, openNotice: boolean | 'preserve' = true, fields: string[] = []): Promise<boolean> {
    this.deps.assertOwner();
    next.changeSequence++;
    const receiver = next.receivers.find(item => item.id === id) ?? this.state.receivers.find(item => item.id === id);
    // Notices retain provider ownership even after the receiver has been deleted; absent = generic.
    if (openNotice === true) next.notice = { changeSequence: next.changeSequence, at: this.time(), action, source: action === 'integrity_reset' ? 'system' : 'cockpit/api', ...(receiver ? { receiverName: receiver.name, receiverId: receiver.id, destination: maskDestination(receiver.url, receiver.chatId), ...(receiver.format !== 'cezar.json.v1' ? { format: receiver.format } : {}) } : {}) };
    else if (openNotice === false) next.notice = undefined;
    for (const item of next.receivers) {
      if (item.state !== 'paused') delete item.pauseReason;
      const previous = this.state.receivers.find(old => old.id === item.id);
      if (!previous || previous.revision !== item.revision) {
        // A change that keeps the delivery revision (a rename, Telegram message options) keeps results authoritative.
        const sameDelivery = action === 'renamed' || (action === 'configuration_changed' && previous?.deliveryRevision === item.deliveryRevision);
        item.resultRevision = sameDelivery && previous ? previous.resultRevision ?? previous.revision : item.revision;
      }
    }
    const checked = stateSchema.parse(next);
    // Definitions/history cannot spend the space needed for result receipts, failure
    // counters, activation fences, key rotation and notices. This projection is also
    // smaller than every legacy serialized registry, so a full old registry still fits.
    const definitions = {
      version: checked.version,
      receivers: checked.receivers.map(receiver => ({ id: receiver.id, ...definitionSchema.parse(receiver) })),
      history: checked.history,
    };
    // Telegram URLs carry the bot token: they are runtime-only, resolved from the vault.
    const receivers: unknown[] = checked.receivers.map(item => item.format === 'telegram.v1' ? { ...item, url: TELEGRAM_ORIGIN } : item);
    for (const { index, value } of this.unreadableReceivers) receivers.splice(index, 0, value);
    const persisted = { ...checked, receivers };
    // Retained incompatible records still consume storage and receiver capacity.
    const retainedBytes = this.unreadableReceivers.reduce((bytes, { value }) => bytes + Buffer.byteLength(JSON.stringify(value)) + 1, 0);
    this.deps.reserve?.(Buffer.byteLength(JSON.stringify(checked)) + retainedBytes, Buffer.byteLength(JSON.stringify(definitions)) + retainedBytes, receivers.length);
    const prepared = await prepareWrite(this.directory, 'endpoints.json', persisted);
    try {
      this.deps.assertOwner();
      if (fence !== undefined && this.deps.highWater() !== fence) return false;
      prepared.publish(); this.state = checked;
      await prepared.finish();
      this.deps.changed?.(action, id, revision, fields);
      return true;
    } finally { await prepared.discard(); }
  }
  list(): WebhookList {
    return { receivers: this.state.receivers.map(item => this.public(item)), webhookHealth: this.unreadableReceivers.length ? { status: 'degraded', reason: `${this.unreadableReceivers.length} webhook receiver record(s) could not be loaded and remain preserved in endpoints.json. Other receivers are available.` } : this.unavailableTokens.size ? { status: 'degraded', reason: new TelegramSecretError().message } : { status: 'ready' }, changeSequence: this.state.changeSequence,
      ...(this.state.notice ? { notice: { ...this.state.notice } } : {}), history: structuredClone(this.state.history.slice(0, 100)), historyCount: this.state.history.length };
  }
  historical() { return structuredClone(this.state.history); }
  pruneHistory(retained: ReadonlySet<string>): Promise<void> {
    return this.serial(async () => {
      const next = structuredClone(this.state); next.history = next.history.filter(item => retained.has(item.id));
      if (next.history.length !== this.state.history.length) await this.commit(next, 'history_pruned', '', 0, undefined, 'preserve');
    });
  }
  invalidate(): Promise<void> {
    return this.serial(async () => { await this.commit(structuredClone(this.state), 'delivery_changed', '', 0, undefined, 'preserve'); });
  }
  privateReceiver(id: string): PrivateReceiver | undefined { const receiver = this.state.receivers.find(item => item.id === id); return receiver ? structuredClone(receiver) : undefined; }
  live(): PrivateReceiver[] { return structuredClone(this.state.receivers); }
  signingKeys(id: string): string[] {
    const receiver = this.get(id);
    if (receiver.format !== 'cezar.json.v1') return [];
    return [receiver.secret, ...(receiver.retired && Date.parse(receiver.retired.expiresAt) > this.deps.now() ? [receiver.retired.secret] : [])];
  }
  hasCapturingReceivers(): boolean { return this.state.receivers.some(receiver => receiver.state === 'active' || receiver.state === 'suspended'); }
  acknowledge(expectedChangeSequence: number): Promise<void> {
    return this.serial(async () => {
      if (expectedChangeSequence !== this.state.changeSequence) throw new WebhookStateError(409, 'Receiver notice changed; refresh and try again');
      await this.commit(structuredClone(this.state), 'notice_acknowledged', '', 0, undefined, false);
    });
  }
  create(input: unknown): Promise<{ receiver: WebhookReceiver; secret: string }> {
    return this.serial(async () => {
      const settings = createWebhookSchema.parse(input);
      if (settings.format !== 'telegram.v1' && settings.chatId) throw new WebhookStateError(409, 'Connect bot credentials through setup');
      settings.name = redactSecrets(settings.name, [...this.secrets(), ...receiverSecretValues(settings)]);
      // Stored only when on: a registry without consent stays readable by an older cezar.
      if (!settings.includeAgentExcerpt) delete settings.includeAgentExcerpt;
      settings.url = normalizeChatUrl(settings.url, settings.format);
      const receiver: PrivateReceiver = { ...settings, id: randomUUID(), secret: settings.format === 'cezar.json.v1' ? generateSigningKey() : '', state: 'inactive', revision: 1, deliveryRevision: 1,
        createdAt: this.time(), updatedAt: this.time(), consecutiveFailures: 0, activationBlocked: false, lastTest: 'none' };
      if (receiver.format === 'telegram.v1') receiver.chatSecret = await this.saveToken(receiver);
      const next = structuredClone(this.state); next.receivers.push(receiver);
      await this.commit(next, 'created', receiver.id, receiver.revision);
      return { receiver: this.public(receiver), secret: receiver.secret };
    });
  }
  update(id: string, input: unknown): Promise<WebhookReceiver> {
    return this.serial(async () => {
      const parsed = updateWebhookSchema.parse(input); const old = this.get(id, parsed.expectedRevision);
      const { expectedRevision: _, ...submitted } = parsed;
      const checked = createWebhookSchema.safeParse({ ...submitted, ...(old.chatSecret && old.format === submitted.format ? { chatId: submitted.chatId ?? old.chatId } : {}), url: submitted.url ?? await this.destinationUrl(old) });
      if (!checked.success) throw new WebhookStateError(409, 'The saved destination does not match this configuration; enter a URL for the selected destination type');
      const settings = checked.data;
      if (settings.format !== 'telegram.v1' && settings.chatId && (!old.chatSecret || settings.chatId !== old.chatId || settings.url !== old.url)) throw new WebhookStateError(409, 'Change bot destinations through setup');
      // Bot attachments are managed by setup, not by ordinary webhook settings.
      if (old.chatSecret && old.format === settings.format && settings.chatId === undefined && old.chatId !== undefined) settings.chatId = old.chatId;
      if (!settings.includeAgentExcerpt) delete settings.includeAgentExcerpt;
      settings.name = redactSecrets(settings.name, [...this.secrets(), ...receiverSecretValues({ ...settings, ...(old.chatSecret && old.format === settings.format ? { chatSecret: old.chatSecret } : {}) })]);
      settings.url = normalizeChatUrl(settings.url, settings.format);
      const fields = (['format', 'name', 'url', 'profile', 'preset', 'events', 'includeScheduledFailures', 'scope', 'graceSeconds', 'allowLocalNetwork', 'chatId', 'includeAgentExcerpt'] as const).filter(key => JSON.stringify(settings[key]) !== JSON.stringify(old[key]));
      const changed = fields.some(key => key !== 'name');
      // Message options preserve the tested bot/chat and reply correlation, but not frozen payload consent.
      const bot = old.format === settings.format && (settings.format === 'telegram.v1' || old.chatSecret !== undefined);
      const retest = changed && !(bot && fields.every(key => !BOT_DESTINATION.has(key)));
      const receiver = { ...old, ...settings, revision: old.revision + 1, updatedAt: this.time() };
      if (changed) receiver.payloadSinceRevision = receiver.revision;
      // A spread cannot remove a key: leaving Telegram must not keep its chat ID.
      if (settings.chatId === undefined && !(old.chatSecret && old.format === settings.format)) delete receiver.chatId;
      if (settings.includeAgentExcerpt === undefined) delete receiver.includeAgentExcerpt;
      if (settings.format !== old.format) {
        receiver.secret = settings.format === 'cezar.json.v1' ? generateSigningKey() : '';
        receiver.retired = undefined;
      }
      if (retest) {
        receiver.state = 'inactive'; receiver.deliveryRevision++; receiver.activation = undefined;
        receiver.activationBlocked = false; receiver.lastTest = 'none'; receiver.consecutiveFailures = 0; receiver.nextProbeAt = undefined;
      }
      if (receiver.format === 'telegram.v1') {
        if (submitted.url !== undefined || !receiver.chatSecret) receiver.chatSecret = await this.saveToken(receiver);
      } else if (receiver.format !== old.format) { delete receiver.chatSecret; delete receiver.chatBotId; }
      const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
      await this.commit(next, changed ? 'configuration_changed' : 'renamed', id, receiver.revision, undefined, true, fields);
      this.unavailableTokens.delete(id);
      return this.public(receiver);
    });
  }
  private activateAs(id: string, expectedRevision: number, resume: boolean): Promise<WebhookReceiver> {
    return this.serial(async () => {
      const old = this.get(id, expectedRevision);
      if (resume ? old.state !== 'paused' : !['inactive', 'disabled'].includes(old.state)) throw new WebhookStateError(409, 'Receiver state changed');
      if (old.activationBlocked || (old.state === 'disabled' && old.lastTest !== 'success') || ((old.format === 'telegram.v1' || old.chatSecret) && old.lastTest !== 'success')) throw new WebhookStateError(409, 'A successful test of this configuration is required');
      await this.destinationUrl(old);
      for (let attempt = 0; attempt < 3; attempt++) {
        const fence = this.deps.highWater();
        const receiver: PrivateReceiver = { ...old, state: 'active', revision: old.revision + 1, updatedAt: this.time(), consecutiveFailures: 0,
          activation: { installationId: this.deps.installationId, sequence: fence, revision: old.revision + 1, mode: this.deps.mode ?? 'local' }, nextProbeAt: undefined };
        const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
        if (await this.commit(next, resume ? 'resumed' : 'activated', id, receiver.revision, fence)) return this.public(receiver);
      }
      throw new WebhookStateError(503, 'New task updates arrived while activating. Try again.');
    });
  }
  activate(id: string, expectedRevision: number) { return this.activateAs(id, expectedRevision, false); }
  resume(id: string, expectedRevision: number) { return this.activateAs(id, expectedRevision, true); }
  pause(id: string, expectedRevision: number, reason: 'user' | 'project_removal' = 'user'): Promise<WebhookReceiver> {
    return this.serial(async () => {
      const old = this.get(id, expectedRevision);
      // Resume only re-checks activationBlocked; pausing Inactive/Disabled would make it an untested activation path.
      if (!['active', 'suspended'].includes(old.state)) throw new WebhookStateError(409, 'Only an Active or Suspended receiver can be paused');
      const receiver: PrivateReceiver = { ...old, state: 'paused', pauseReason: reason, revision: old.revision + 1, updatedAt: this.time(), nextProbeAt: undefined };
      const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
      await this.commit(next, 'paused', id, receiver.revision); return this.public(receiver);
    });
  }
  rotate(id: string, expectedRevision: number, mode: 'graceful' | 'revoke_now'): Promise<{ receiver: WebhookReceiver; secret: string }> {
    return this.serial(async () => {
      const old = this.get(id, expectedRevision);
      if (old.format !== 'cezar.json.v1') throw new WebhookStateError(409, 'Chat receivers do not use a signing key');
      if (mode === 'graceful' && old.retired && Date.parse(old.retired.expiresAt) > this.deps.now()) throw new WebhookStateError(409, 'A key overlap is already active');
      const receiver: PrivateReceiver = { ...old, secret: generateSigningKey(), retired: mode === 'graceful' ? { secret: old.secret, expiresAt: new Date(this.deps.now() + 86400000).toISOString() } : undefined, revision: old.revision + 1, updatedAt: this.time() };
      const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
      await this.commit(next, 'secret_rotated', id, receiver.revision); return { receiver: this.public(receiver), secret: receiver.secret };
    });
  }
  delete(id: string, expectedRevision: number): Promise<void> {
    return this.serial(async () => {
      const old = this.get(id, expectedRevision); const next = structuredClone(this.state);
      next.receivers = next.receivers.filter(item => item.id !== id);
      next.history.unshift({ kind: 'history', id, name: old.name, ...(old.format !== 'cezar.json.v1' ? { format: old.format } : {}), deletedAt: this.time() });
      await this.commit(next, 'deleted', id, old.revision + 1);
      this.unavailableTokens.delete(id);
    });
  }
  recordOperation(id: string, expectedRevision: number, operationId: string, action: 'test' | 'retry' | 'replay'): Promise<'applied' | 'superseded'> {
    return this.serial(async () => {
      const old = this.privateReceiver(id);
      // A later mutation can commit after admission but before acknowledgement.
      // Never replay that old consent over the new state (or resurrect a deletion).
      // A surviving acknowledgement also proves success after a later rename.
      if (old?.lastOperation === operationId && old.revision > expectedRevision) return 'applied';
      if (!old || old.revision > expectedRevision) return 'superseded';
      if (old.revision !== expectedRevision) throw new WebhookStateError(409, 'Receiver revision changed; refresh and try again');
      const receiver = { ...old, lastOperation: operationId, revision: old.revision + 1, updatedAt: this.time() };
      const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
      await this.commit(next, action, id, receiver.revision);
      return 'applied';
    });
  }
  testResult(id: string, revision: number, deliveryRevision: number, result: 'success' | 'transient_failure' | 'permanent_failure'): Promise<void> {
    return this.deliveryResult(id, revision, deliveryRevision, result === 'success' ? 'success' : result === 'permanent_failure' ? 'permanent' : 'transient', true);
  }
  deliveryResult(id: string, revision: number, deliveryRevision: number, outcome: 'success' | 'transient' | 'permanent' | 'gone' | 'rate_limited' | 'policy', test: boolean, effect?: { token: string; at: string }): Promise<void> {
    return this.serial(async () => {
      const old = this.privateReceiver(id);
      if (!old || (effect && old.lastResult === effect.token) || (revision < (old.resultRevision ?? old.revision) || revision > old.revision) || old.deliveryRevision !== deliveryRevision) return;
      const receiver = { ...old, ...(effect ? { lastResult: effect.token } : {}) };
      if (test) {
        // A destination-policy refusal repeats for this configuration until it is edited, so it blocks like a 4xx.
        receiver.lastTest = outcome === 'success' ? 'success' : ['permanent', 'gone', 'policy'].includes(outcome) ? 'permanent_failure' : 'transient_failure';
        receiver.activationBlocked = outcome === 'success' ? false : old.activationBlocked || receiver.lastTest === 'permanent_failure';
      }
      if (outcome === 'success') {
        receiver.consecutiveFailures = 0;
        if (old.state === 'suspended') { receiver.state = 'active'; receiver.nextProbeAt = undefined; }
      } else if (outcome === 'gone' && ['active', 'suspended'].includes(old.state)) {
        receiver.state = 'disabled'; receiver.nextProbeAt = undefined;
        // A Telegram activation always needs a fresh test; other formats keep their re-activation path.
        if (old.format === 'telegram.v1') receiver.lastTest = 'none';
      } else if (outcome === 'transient' && ['active', 'suspended'].includes(old.state)) {
        receiver.consecutiveFailures++;
        if (receiver.consecutiveFailures >= 10) { receiver.state = 'suspended'; receiver.nextProbeAt = new Date((effect ? Date.parse(effect.at) : this.deps.now()) + 900000).toISOString(); }
      }
      if (old.state === 'suspended' && receiver.state === 'suspended' && outcome !== 'success') receiver.nextProbeAt = new Date((effect ? Date.parse(effect.at) : this.deps.now()) + 900000).toISOString();
      if (receiver.state !== old.state) { receiver.revision++; receiver.updatedAt = this.time(); }
      const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
      await this.commit(next, test ? 'test_result' : 'delivery_result', id, receiver.revision, undefined, 'preserve');
    });
  }
}

/** Accepted legacy Discord hosts and v10 paths share one destination and limiter bucket. */
function normalizeChatUrl(url: string, format: PrivateReceiver['format']): string {
  if (format !== 'discord.v1' || url === 'https://discord.com/api/v10') return url;
  return `https://discord.com${new URL(url).pathname.replace('/api/v10/', '/api/')}`;
}

/** Include the credential itself so aliases/normalization cannot bypass redaction. */
export function receiverSecretValues(receiver: { url: string; format: PrivateReceiver['format']; secret?: string; chatSecret?: { name: string }; retired?: { secret: string } }): string[] {
  // A Slack/Discord bot posts to its provider's fixed API URL; the bot credential is the secret.
  const fixedUrl = receiver.chatSecret !== undefined && receiver.format !== 'telegram.v1' && receiver.format !== 'cezar.json.v1';
  const values = [...(receiver.chatSecret ? credentialValues.get(receiver.chatSecret.name) ?? [] : []), fixedUrl ? '' : receiver.url, receiver.secret ?? '', receiver.retired?.secret ?? ''];
  // Telegram's last path segment is `sendMessage`; its credential is the `bot<token>` segment.
  if (fixedUrl) { /* nothing in the URL is secret */ } else if (receiver.format === 'telegram.v1') {
    const token = telegramToken(receiver.url);
    if (token) values.push(`bot${token}`, token, token.slice(token.indexOf(':') + 1));
  } else if (receiver.format !== 'cezar.json.v1') values.push(new URL(receiver.url).pathname.split('/').at(-1) ?? '');
  return values.filter(Boolean);
}
