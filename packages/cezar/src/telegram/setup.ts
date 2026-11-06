import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  telegramSetupBeginSchema, telegramSetupActivateSchema,
  type TelegramSetupBegun, type TelegramSetupStatus, type TelegramSetupActivated,
} from '@open-mercato/cezar-contract';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { telegramToken } from '../webhooks/telegram-secrets.ts';
import { receiverEligible } from './authorization.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';
import { TelegramInboundFailure } from './errors.ts';
import type { Pairings, PairingSession } from './pairing.ts';
import type { InboundGrant, InboundState, InboundStateStore } from './state.ts';

export type GateScope = 'notifications' | 'taskControl';
type PairingCreated = { pairingId: string; expiresAt: number; deepLink: string };
type PairingStatus = { status: 'waiting' | 'candidate' | 'confirmed' | 'expired'; inboundRevision: string; candidate?: PairingSession['candidate'] };
type Confirmation = { expectedRevision: string; candidateUserId: string; comparisonVerified?: true; permissions?: InboundGrant['permissions'] };
type TemporaryReceiver = PrivateReceiver & { setupToken: string; setupBotId: string };
interface SetupRecord {
  receiverId: string; bot: { id: string; username: string }; inboundRevision: string; token?: string; name?: string;
  /** Tracks the receiver created or reused by activation, including failures that need rollback. */
  createdReceiverId?: string;
  /** This setup bound the bot to the project; abandoning it releases the bot again. */
  firstSetup?: true; abandoned?: true;
}
/** What the setup flow may use of the inbound service; nothing here exposes a stored credential. */
export interface SetupHost {
  readonly pairings: Pairings;
  now(): number;
  gate(scope?: GateScope): void;
  receivers(): PrivateReceiver[];
  readonly callToken?: (token: string) => TelegramCall;
  readonly createReceiverFromToken?: (token: string, name: string | undefined, chatId: string, existingId?: string) => Promise<PrivateReceiver>;
  removeSetupReceiver?(id: string): Promise<void>;
  pair(input: z.input<typeof telegramSetupBeginSchema>): Promise<PairingCreated>;
  confirm(id: string, input: Confirmation): Promise<{ grant: InboundGrant; inboundRevision: string }>;
  pairing(id: string): PairingStatus;
  open(botId: string): Promise<{ state: InboundStateStore }>;
  snapshot(botId: string): InboundState | undefined;
  revision(botId: string): string;
  receiverRevision(receiver: PrivateReceiver): string;
  eligible(id: string): PrivateReceiver;
  expect(botId: string, revision: string): void;
  checkGroupChat(call: TelegramCall, chatId: string, consent: true | undefined, botId: string): Promise<void>;
  stateExists(botId: string): Promise<boolean>;
  /** Releases a bot that has no chats, people or pairing left; anything else keeps it. */
  releaseUnusedBot(botId: string): Promise<void>;
  isConfirmed(id: string): boolean;
  changed(): void;
}
const meSchema = z.object({ id: z.number().int().positive().safe(), username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** The bot a receiver's in-memory URL sends through, when its token is loaded. */
function botOf(url: string | undefined): string | undefined {
  try { return url ? telegramToken(url)?.split(':')[0] : undefined; } catch { return undefined; }
}

/** Setup errors name what the operator can fix; anything unrecognized passes through unchanged. */
function setupFailure(error: unknown): unknown {
  if (error instanceof TelegramApiError && error.status === 401) return new TelegramInboundFailure(400, 'invalid_token');
  if (error instanceof TelegramApiError && error.status === 403) return new TelegramInboundFailure(409, 'blocked');
  // chat_conflict is permanent (another receiver holds the chat), so it keeps its own code.
  if (error instanceof TelegramInboundFailure && ['revision_conflict', 'revision_required'].includes(error.code)) return new TelegramInboundFailure(409, 'conflict');
  if (error instanceof TelegramInboundFailure && error.code === 'credentials_unavailable') return new TelegramInboundFailure(503, 'vault_unavailable');
  if (error instanceof TelegramInboundFailure && error.code === 'reset_required') return new TelegramInboundFailure(409, 'damaged_state');
  return error;
}
function temporaryReceiver(id: string, token: string, botId: string, name: string, now: number): TemporaryReceiver {
  const at = new Date(now).toISOString();
  return {
    id, name, url: `https://api.telegram.org/bot${token}/sendMessage`, format: 'telegram.v1', telegramChatId: 'pending',
    state: 'active', lastTest: 'success', profile: 'standard', preset: 'attention', events: ['task.attention_required'],
    includeScheduledFailures: false, scope: 'main_and_questions', graceSeconds: 0, allowLocalNetwork: false,
    revision: 1, deliveryRevision: 1, secret: '', consecutiveFailures: 0, activationBlocked: false, createdAt: at, updatedAt: at,
    telegramSecret: { name: `WEBHOOK_TELEGRAM_SETUP_${id.replaceAll('-', '').toUpperCase()}`, sha256: sha256(token) },
    setupToken: token, setupBotId: botId,
  };
}

/**
 * Guided setup over the pairing source of truth, for private and group chats (spec
 * 2026-10-29-telegram-setup-and-replies). Sessions live in memory only: a restart expires the link.
 */
export class TelegramSetups {
  private setups = new Map<string, SetupRecord>();
  private temporaries = new Map<string, TemporaryReceiver>();
  private activations = new Map<string, Promise<TelegramSetupActivated>>();
  private chats = new Map<string, Promise<unknown>>();
  private releases = new Set<Promise<void>>();
  constructor(private readonly host: SetupHost) {}

  temporary(id: string | undefined): PrivateReceiver | undefined { return id ? this.temporaries.get(id) : undefined; }
  temporaryReceivers(): PrivateReceiver[] { return [...this.temporaries.values()]; }
  /** The pasted token of a setup still discovering its chat; it never reaches disk. */
  token(id: string): string | undefined { return this.temporaries.get(id)?.setupToken; }
  /** A token-led setup may finish notifications-only, so its status stays readable with task control off. */
  tokenLed(id: string): boolean { return !!this.setups.get(id)?.token; }
  temporaryFor(botId: string): string | undefined { return [...this.temporaries.values()].reverse().find(receiver => receiver.setupBotId === botId && this.host.pairings.hasReceiver(receiver.id))?.id; }
  prune(): void {
    const { pairings } = this.host;
    for (const [id, setup] of this.setups) {
      if (pairings.get(id) || this.host.isConfirmed(id)) continue;
      // Expired: the record stays to report it, but the bot it bound is released now.
      void this.abandon(setup);
      if (!pairings.wasExpired(id)) this.setups.delete(id);
    }
    const retained = new Set([...this.setups.values()].map(setup => setup.receiverId));
    for (const id of this.temporaries.keys()) if (!retained.has(id)) this.temporaries.delete(id);
  }
  /** Releases still in flight; dispose and tests wait for them. */
  settled(): Promise<unknown> { return Promise.allSettled([...this.releases, ...this.activations.values()]); }
  private abandon(setup: SetupRecord): Promise<void> {
    if (!setup.firstSetup || setup.abandoned) return Promise.resolve();
    setup.abandoned = true;
    const work = this.host.releaseUnusedBot(setup.bot.id).catch(() => this.host.changed()).finally(() => { this.releases.delete(work); });
    this.releases.add(work); return work;
  }

  async begin(raw: z.input<typeof telegramSetupBeginSchema>): Promise<TelegramSetupBegun> {
    const parsed = telegramSetupBeginSchema.parse(raw);
    // A token-led setup can end notifications-only; approving on an existing receiver is task control.
    const tokenLed = 'token' in parsed && !!parsed.token;
    this.host.gate(tokenLed ? 'notifications' : 'taskControl');
    let input = parsed, temporary: TemporaryReceiver | undefined, stateExisted = true;
    if (tokenLed) {
      if (!this.host.callToken) throw new TelegramInboundFailure(503, 'receiver_creation_unavailable');
      const me = meSchema.parse(await this.host.callToken(parsed.token!)('getMe', {})); this.host.gate('notifications');
      temporary = temporaryReceiver(randomUUID(), parsed.token!, String(me.id), parsed.name ?? `Telegram ${me.username}`, this.host.now());
      this.temporaries.set(temporary.id, temporary);
      stateExisted = await this.host.stateExists(temporary.setupBotId).catch(() => true);
      input = { ...parsed, receiverId: temporary.id, expectedRevision: this.host.receiverRevision(temporary) };
    }
    try {
      if (!input.receiverId || !input.expectedRevision) throw new TelegramInboundFailure(400, 'receiver_required');
      const receiver = this.host.eligible(input.receiverId);
      if (this.host.receiverRevision(receiver) !== input.expectedRevision) throw new TelegramInboundFailure(409, 'conflict');
      const created = await this.host.pair(input);
      const session = this.host.pairings.get(created.pairingId)!;
      const bot = { id: session.botId, username: new URL(created.deepLink).pathname.slice(1) };
      this.setups.set(created.pairingId, { receiverId: receiver.id, bot, inboundRevision: this.host.revision(session.botId),
        ...(temporary ? { token: temporary.setupToken, ...(parsed.name ? { name: parsed.name } : {}) } : {}), ...(stateExisted ? {} : { firstSetup: true as const }) });
      return { setupId: created.pairingId, receiverId: receiver.id, bot, expiresAt: created.expiresAt, deepLink: created.deepLink };
    } catch (error) {
      if (temporary) {
        // A pairing that outlived the failure would keep the bot it bound.
        this.host.pairings.cancelReceiver(temporary.id); this.temporaries.delete(temporary.id);
        if (!stateExisted) await this.host.releaseUnusedBot(temporary.setupBotId);
      }
      throw setupFailure(error);
    }
  }

  /** Never writes setup state; an expired first setup's unused bot is released (prune → abandon). */
  status(id: string): TelegramSetupStatus {
    this.prune(); const setup = this.setups.get(id);
    if (!setup) throw new TelegramInboundFailure(404, 'pairing_expired');
    const { status, candidate } = this.host.pairing(id);
    return { status, receiverId: setup.receiverId, bot: setup.bot, inboundRevision: setup.inboundRevision,
      ...(candidate ? { candidate: { userId: candidate.userId, chatType: candidate.chatType, label: candidate.label,
        ...(candidate.username ? { username: candidate.username } : {}), ...(candidate.comparisonCode ? { comparisonCode: candidate.comparisonCode } : {}),
        ...(candidate.chatTitle ? { chatTitle: candidate.chatTitle } : {}) } } : {}) };
  }

  /** Exclude the entire outbound/inbound transaction; registry writes alone cannot prevent duplicate chats. */
  activate(id: string, raw: z.input<typeof telegramSetupActivateSchema>): Promise<TelegramSetupActivated> {
    const pending = this.activations.get(id); if (pending) return pending;
    const session = this.host.pairings.get(id);
    const key = session ? `${session.botId}:${session.receiverChatId}` : id;
    const previous = this.chats.get(key) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      const setup = this.setups.get(id);
      if (!setup) throw new TelegramInboundFailure(404, 'pairing_expired');
      const original = setup.receiverId;
      const before = new Set(this.host.receivers().map(receiver => receiver.id));
      try {
        const result = await this.activateOnce(id, raw);
        this.temporaries.delete(original);
        return { ...result, inboundRevision: this.host.revision(setup.bot.id) };
      } catch (error) {
        const created = setup.createdReceiverId;
        if (created && !before.has(created) && this.host.removeSetupReceiver) {
          await this.host.removeSetupReceiver(created);
          if (this.host.snapshot(setup.bot.id)) {
            const bot = await this.host.open(setup.bot.id);
            await bot.state.change(state => {
              state.receivers = state.receivers.filter(row => row.receiverId !== created);
              state.grants = state.grants.filter(row => row.receiverId !== created);
              state.correlations = state.correlations.filter(row => row.receiverId !== created);
              state.configGeneration = randomUUID();
            });
          }
          delete setup.createdReceiverId;
          setup.receiverId = original;
          const temporary = this.temporaries.get(original);
          if (temporary && session) this.host.pairings.retarget(id, original, session.receiverChatId, temporary.deliveryRevision);
        }
        throw error;
      }
    }).finally(() => {
      this.activations.delete(id);
      if (this.chats.get(key) === work) this.chats.delete(key);
    });
    this.activations.set(id, work); this.chats.set(key, work);
    return work;
  }
  private assertPending(id: string, setup: SetupRecord): void {
    this.host.gate('notifications');
    if (this.setups.get(id) !== setup || !this.host.pairings.get(id)) throw new TelegramInboundFailure(404, 'pairing_expired');
  }
  private async activateOnce(id: string, raw: z.input<typeof telegramSetupActivateSchema>): Promise<TelegramSetupActivated> {
    const { activate: _activate, taskControl = true, groupVisibilityAccepted, ...input } = telegramSetupActivateSchema.parse(raw);
    this.host.gate(taskControl ? 'taskControl' : 'notifications');
    const setup = this.setups.get(id);
    if (!setup) throw new TelegramInboundFailure(404, 'pairing_expired');
    this.assertPending(id, setup);
    // A group's own /start is enough for notifications; task control needs the member's private /start and comparison.
    const pending = this.host.pairings.get(id);
    if (taskControl && pending?.chatId.startsWith('-') && !pending.candidate?.comparisonCode) throw new TelegramInboundFailure(400, 'comparison_required');
    const expectedRevision = setup.token ? await this.persist(id, setup, groupVisibilityAccepted) : input.expectedRevision;
    const session = this.host.pairings.get(id);
    // Re-running Add a chat (say, to rotate the token) for a person already approved keeps their grant as it is.
    if (taskControl && session?.candidate && this.host.snapshot(session.botId)?.grants
      .some(grant => grant.receiverId === session.receiverId && grant.userId === session.candidate!.userId)) {
      this.host.pairings.cancel(id); this.setups.delete(id); this.host.changed();
      return { receiverId: session.receiverId, inboundRevision: this.host.revision(session.botId) };
    }
    if (!taskControl) {
      if (!session?.candidate) throw new TelegramInboundFailure(409, 'pairing_required');
      const bot = await this.host.open(session.botId);
      await bot.state.change(state => {
        this.assertPending(id, setup); this.host.expect(session.botId, expectedRevision);
        const receiver = this.host.eligible(session.receiverId), bound = state.receivers.find(row => row.receiverId === receiver.id);
        if (!bound) throw new TelegramInboundFailure(409, 'binding_missing');
        // A re-run on a chat whose people are already approved keeps their task control.
        if (!state.grants.some(grant => grant.receiverId === receiver.id)) { bound.enabled = false; bound.acceptAfter = this.host.now(); }
        state.configGeneration = randomUUID();
      });
      this.host.pairings.cancel(id); this.setups.delete(id); this.host.changed();
      return { receiverId: session.receiverId, inboundRevision: this.host.revision(session.botId) };
    }
    const confirmed = await this.host.confirm(id, { ...input, expectedRevision });
    this.setups.delete(id);
    return confirmed;
  }

  async cancel(id: string): Promise<{ cancelled: true }> {
    this.host.gate('notifications');
    const setup = this.setups.get(id); this.host.pairings.cancel(id); this.setups.delete(id);
    if (setup?.token) this.temporaries.delete(setup.receiverId);
    if (setup) await this.abandon(setup);
    this.host.changed(); return { cancelled: true };
  }

  /**
   * Persist the discovered chat as a real receiver and bind it to the bot. Idempotent: a retry, or a
   * second setup for a chat this bot already serves, reuses that receiver instead of adding another.
   */
  private async persist(id: string, setup: SetupRecord, groupConsent: true | undefined): Promise<string> {
    const session = this.host.pairings.get(id);
    if (!session?.candidate) throw new TelegramInboundFailure(409, 'pairing_required');
    if (!this.host.createReceiverFromToken || !this.host.callToken) throw new TelegramInboundFailure(503, 'receiver_creation_unavailable');
    const chatId = session.receiverChatId, botId = session.botId;
    if (chatId.startsWith('-')) await this.host.checkGroupChat(this.host.callToken(setup.token!), chatId, groupConsent, botId);
    this.assertPending(id, setup);
    const existing = this.reusable(setup, botId, chatId);
    let receiver: PrivateReceiver;
    try { receiver = await this.host.createReceiverFromToken(setup.token!, setup.name, chatId, existing); }
    catch { throw new TelegramInboundFailure(503, 'receiver_creation_failed'); }
    setup.createdReceiverId = receiver.id;
    this.assertPending(id, setup);
    if (receiver.telegramChatId !== chatId || !receiverEligible(receiver)) throw new TelegramInboundFailure(409, 'receiver_ineligible');
    const temporary = this.temporaries.has(setup.receiverId) ? setup.receiverId : undefined;
    const bot = await this.host.open(botId);
    await bot.state.change(state => {
      this.assertPending(id, setup);
      const live = new Set(this.host.receivers().map(row => row.id));
      // The setup's placeholder and a deleted receiver's binding of the same chat would otherwise linger beside the real one.
      const dropped = new Set(state.receivers.filter(row => row.receiverId === temporary
        || (row.chatId === chatId && row.receiverId !== receiver.id && !live.has(row.receiverId))).map(row => row.receiverId));
      state.receivers = state.receivers.filter(row => !dropped.has(row.receiverId));
      state.grants = state.grants.filter(grant => !dropped.has(grant.receiverId));
      state.correlations = state.correlations.filter(row => !dropped.has(row.receiverId));
      const bound = state.receivers.find(row => row.receiverId === receiver.id);
      if (bound) {
        // begin() verified the new token with getMe, so a revoked-token stop no longer applies; conflict and blocked still wait (spec 2026-10-29-telegram-setup-and-replies).
        if (bound.credentialFingerprint !== receiver.telegramSecret!.sha256 && state.fatalStop === 'credentials-unavailable') delete state.fatalStop;
        bound.chatId = chatId; bound.deliveryRevision = receiver.deliveryRevision; bound.credentialFingerprint = receiver.telegramSecret!.sha256;
      }
      else state.receivers.push({ receiverId: receiver.id, chatId, enabled: false, generation: randomUUID(), acceptAfter: this.host.now(),
        deliveryRevision: receiver.deliveryRevision, credentialFingerprint: receiver.telegramSecret!.sha256 });
      state.transportCredentialFingerprint = receiver.telegramSecret!.sha256;
      state.configGeneration = randomUUID();
    });
    this.host.pairings.retarget(id, receiver.id, chatId, receiver.deliveryRevision);
    setup.receiverId = receiver.id; setup.inboundRevision = this.host.revision(botId);
    return setup.inboundRevision;
  }
  /** The receiver this activation already made, else the one this bot already sends to the chat through. */
  private reusable(setup: SetupRecord, botId: string, chatId: string): string | undefined {
    const receivers = this.host.receivers().filter(receiver => receiver.format === 'telegram.v1' && receiver.telegramChatId === chatId && !this.temporaries.has(receiver.id));
    const bound = new Set(this.host.snapshot(botId)?.receivers.map(row => row.receiverId) ?? []), fingerprint = sha256(setup.token!);
    return receivers.find(receiver => receiver.id === setup.createdReceiverId)?.id
      ?? receivers.find(receiver => bound.has(receiver.id))?.id
      ?? receivers.find(receiver => receiver.telegramSecret?.sha256 === fingerprint || botOf(receiver.url) === botId)?.id;
  }
}
