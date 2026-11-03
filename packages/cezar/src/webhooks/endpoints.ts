import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createWebhookSchema, webhookStoredSettingsSchema, updateWebhookSchema, webhookReceiverStateSchema, webhookHistoricalReceiverSchema, webhookNoticeSchema,
  type WebhookReceiver, type WebhookList,
} from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { TELEGRAM_ORIGIN, TelegramSecretError, telegramToken, TelegramSecretReadError, telegramSecretRefSchema, type TelegramSecrets } from './telegram-secrets.ts';
import { generateSigningKey } from './signing.ts';
import { maskDestination } from './destination.ts';
import { prepareWrite, readState } from './storage.ts';

const timestamp = z.iso.datetime();
const TELEGRAM_DESTINATION = new Set<string>(['format', 'url', 'telegramChatId', 'allowLocalNetwork']);
const counter = z.number().int().nonnegative();
const definitionSchema = webhookStoredSettingsSchema.strip();
export const privateReceiverSchema = webhookStoredSettingsSchema.safeExtend({
  telegramSecret: telegramSecretRefSchema.optional(),
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
export class WebhookStateError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429 | 502 | 503, message: string, readonly retryAt?: number) { super(message); }
}
export interface EndpointDependencies {
  telegramSecrets?: TelegramSecrets;
  installationId: string; mode?: 'local' | 'hosted'; highWater(): number; now(): number; assertOwner(): void;
  reserve?(bytes: number, definitionBytes: number, receiverCount: number): void;
  changed?(action: string, receiverId: string, revision: number, fields: string[]): void;
}
export class EndpointRegistry {
  private unavailableTokens = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly deps: EndpointDependencies, private state: State) {}
  static async open(directory: string, deps: EndpointDependencies): Promise<EndpointRegistry> {
    const state = await readState(directory, 'endpoints.json', stateSchema) ?? { version: 1 as const, receivers: [], history: [], changeSequence: 0 };
    const registry = new EndpointRegistry(directory, deps, state);
    for (const id of registry.state.receivers.map(item => item.id)) {
      const receiver = registry.get(id);
      if (receiver.format !== 'telegram.v1') continue;
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
      kind: 'live', id: receiver.id, name: receiver.name, destination: maskDestination(receiver.url, receiver.telegramChatId), format: receiver.format,
      state: receiver.state, revision: receiver.revision, deliveryRevision: receiver.deliveryRevision,
      ...(receiver.state === 'paused' && receiver.pauseReason ? { pauseReason: receiver.pauseReason } : {}),
      profile: receiver.profile, preset: receiver.preset, events: [...receiver.events], includeScheduledFailures: receiver.includeScheduledFailures,
      scope: receiver.scope, graceSeconds: receiver.graceSeconds, allowLocalNetwork: receiver.allowLocalNetwork,
      ...(receiver.telegramChatId !== undefined ? { telegramChatId: receiver.telegramChatId } : {}),
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
  async destinationUrl(receiver: PrivateReceiver): Promise<string> {
    if (receiver.format !== 'telegram.v1') return receiver.url;
    try {
      if (!receiver.telegramSecret || !this.deps.telegramSecrets) throw new TelegramSecretError();
      const url = await this.deps.telegramSecrets.url(receiver.telegramSecret);
      const current = this.state.receivers.find(item => item.id === receiver.id);
      if (current?.telegramSecret?.name === receiver.telegramSecret.name) current.url = url;
      this.unavailableTokens.delete(receiver.id);
      return url;
    } catch (error) {
      this.unavailableTokens.add(receiver.id);
      // 503 = the vault could not be read right now; 409 = the credential is missing or changed.
      throw error instanceof TelegramSecretReadError ? new WebhookStateError(503, error.message) : new WebhookStateError(409, new TelegramSecretError().message);
    }
  }
  private async commit(next: State, action: string, id: string, revision: number, fence?: number, openNotice: boolean | 'preserve' = true, fields: string[] = []): Promise<boolean> {
    const candidates = [...this.state.receivers, ...next.receivers].flatMap(item => item.telegramSecret ? [item.telegramSecret] : []);
    try { return await this.publish(next, action, id, revision, fence, openNotice, fields); }
    finally {
      // Publication can succeed before fsync fails. Consult the actual in-memory commit
      // point, never the thrown error, before deleting either an old or staged token.
      const live = new Set(this.state.receivers.map(item => item.telegramSecret?.name));
      for (const ref of new Map(candidates.map(ref => [ref.name, ref])).values()) {
        if (!live.has(ref.name)) await this.deps.telegramSecrets?.remove(ref);
      }
    }
  }
  private async publish(next: State, action: string, id: string, revision: number, fence?: number, openNotice: boolean | 'preserve' = true, fields: string[] = []): Promise<boolean> {
    this.deps.assertOwner();
    next.changeSequence++;
    const receiver = next.receivers.find(item => item.id === id) ?? this.state.receivers.find(item => item.id === id);
    // format is written only for Telegram so 0.17/0.18 can still read a registry without Telegram (strict schemas); absent = generic.
    if (openNotice === true) next.notice = { changeSequence: next.changeSequence, at: this.time(), action, source: action === 'integrity_reset' ? 'system' : 'cockpit/api', ...(receiver ? { receiverName: receiver.name, receiverId: receiver.id, destination: maskDestination(receiver.url, receiver.telegramChatId), ...(receiver.format === 'telegram.v1' ? { format: receiver.format } : {}) } : {}) };
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
    this.deps.reserve?.(Buffer.byteLength(JSON.stringify(checked)), Buffer.byteLength(JSON.stringify(definitions)), checked.receivers.length);
    // Telegram URLs carry the bot token: they are runtime-only, resolved from the vault.
    const persisted = { ...checked, receivers: checked.receivers.map(item => item.format === 'telegram.v1' ? { ...item, url: TELEGRAM_ORIGIN } : item) };
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
    return { receivers: this.state.receivers.map(item => this.public(item)), webhookHealth: this.unavailableTokens.size ? { status: 'degraded', reason: new TelegramSecretError().message } : { status: 'ready' }, changeSequence: this.state.changeSequence,
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
      const settings = createWebhookSchema.parse(input); settings.name = redactSecrets(settings.name, [...this.secrets(), ...receiverSecretValues(settings)]);
      // Stored only when on: a registry without consent stays readable by an older cezar.
      if (!settings.includeAgentExcerpt) delete settings.includeAgentExcerpt;
      settings.url = normalizeChatUrl(settings.url, settings.format);
      const receiver: PrivateReceiver = { ...settings, id: randomUUID(), secret: settings.format === 'cezar.json.v1' ? generateSigningKey() : '', state: 'inactive', revision: 1, deliveryRevision: 1,
        createdAt: this.time(), updatedAt: this.time(), consecutiveFailures: 0, activationBlocked: false, lastTest: 'none' };
      if (receiver.format === 'telegram.v1') receiver.telegramSecret = await this.saveToken(receiver);
      const next = structuredClone(this.state); next.receivers.push(receiver);
      await this.commit(next, 'created', receiver.id, receiver.revision);
      return { receiver: this.public(receiver), secret: receiver.secret };
    });
  }
  update(id: string, input: unknown): Promise<WebhookReceiver> {
    return this.serial(async () => {
      const parsed = updateWebhookSchema.parse(input); const old = this.get(id, parsed.expectedRevision);
      const { expectedRevision: _, ...submitted } = parsed;
      const checked = createWebhookSchema.safeParse({ ...submitted, url: submitted.url ?? await this.destinationUrl(old) });
      if (!checked.success) throw new WebhookStateError(409, 'The saved destination does not match this configuration; enter a URL for the selected destination type');
      const settings = checked.data;
      if (!settings.includeAgentExcerpt) delete settings.includeAgentExcerpt;
      settings.name = redactSecrets(settings.name, [...this.secrets(), ...receiverSecretValues(settings)]);
      settings.url = normalizeChatUrl(settings.url, settings.format);
      const fields = (['format', 'name', 'url', 'profile', 'preset', 'events', 'includeScheduledFailures', 'scope', 'graceSeconds', 'allowLocalNetwork', 'telegramChatId', 'includeAgentExcerpt'] as const).filter(key => JSON.stringify(settings[key]) !== JSON.stringify(old[key]));
      const changed = fields.some(key => key !== 'name');
      // Telegram message options change only the text; the tested bot, chat and task control stay valid.
      const retest = changed && !(old.format === 'telegram.v1' && settings.format === 'telegram.v1' && fields.every(key => !TELEGRAM_DESTINATION.has(key)));
      const receiver = { ...old, ...settings, revision: old.revision + 1, updatedAt: this.time() };
      // A spread cannot remove a key: leaving Telegram must not keep its chat ID.
      if (settings.telegramChatId === undefined) delete receiver.telegramChatId;
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
        if (submitted.url !== undefined || !receiver.telegramSecret) receiver.telegramSecret = await this.saveToken(receiver);
      } else delete receiver.telegramSecret;
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
      if (old.activationBlocked || (old.state === 'disabled' && old.lastTest !== 'success') || (old.format === 'telegram.v1' && old.lastTest !== 'success')) throw new WebhookStateError(409, 'A successful test of this configuration is required');
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
      next.history.unshift({ kind: 'history', id, name: old.name, ...(old.format === 'telegram.v1' ? { format: old.format } : {}), deletedAt: this.time() });
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
  if (format !== 'discord.v1') return url;
  return `https://discord.com${new URL(url).pathname.replace('/api/v10/', '/api/')}`;
}

/** Include the credential itself so aliases/normalization cannot bypass redaction. */
export function receiverSecretValues(receiver: { url: string; format: PrivateReceiver['format']; secret?: string; retired?: { secret: string } }): string[] {
  const values = [receiver.url, receiver.secret ?? '', receiver.retired?.secret ?? ''];
  // Telegram's last path segment is `sendMessage`; its credential is the `bot<token>` segment.
  if (receiver.format === 'telegram.v1') {
    const token = telegramToken(receiver.url);
    if (token) values.push(`bot${token}`, token, token.slice(token.indexOf(':') + 1));
  } else if (receiver.format !== 'cezar.json.v1') values.push(new URL(receiver.url).pathname.split('/').at(-1) ?? '');
  return values.filter(Boolean);
}
