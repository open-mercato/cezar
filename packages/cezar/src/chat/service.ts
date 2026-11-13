import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import {
  chatInboundReceiverPatchSchema, chatInboundGrantPatchSchema, chatInboundActivityResponseSchema, chatInboundActivityQuerySchema,
  chatSetupBeginSchema, chatSetupActivateSchema,
  type ChatInboundStateResponse, type ChatSetupBegun, type ChatSetupStatus, type ChatSetupActivated,
} from '@open-mercato/cezar-contract';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { assertNoSymlink, atomicWrite, statePath, syncDirectory } from '../webhooks/storage.ts';
import type { WebhookSource } from '../webhooks/source.ts';
import type { RunRecord } from '../runs/store.ts';
import { ChatSendBudget } from './send-budget.ts';
import { ChatBindings, readBinding } from './bindings.ts';
import { stateFingerprint } from './recovery.ts';
import { notificationsReason, chatUnavailableReason } from './availability.ts';
import { BotLease } from './ownership.ts';
import { MAX_BOT_RECEIVERS, inboundStateFilename, inboundStateBotId, deliveryReceipt, forgetReplies, freshState, InboundStateStore, readInboundState, type BotBinding, type Correlation, type InboundState, type InboundGrant } from './state.ts';
import { Pairings, type PairingSession } from './pairing.ts';
import { bindingCurrent, receiverEligible } from './authorization.ts';
import { ChatBotRuntime } from './runtime.ts';
import { chatIdentitySchema, type ChatTransport, type ChatServiceDescriptor } from './provider.ts';
import type { ConversationDependencies } from './conversation.ts';
import { ChatInboundFailure } from './errors.ts';
import { ChatSetups, type GateScope } from './setup.ts';
import { setAdapterSuspension } from './adapter-suspension.ts';

export { ChatInboundFailure } from './errors.ts';
export interface ChatServiceDependencies extends Pick<ConversationDependencies, 'context' | 'deliver' | 'createTask' | 'prepareControl' | 'episode' | 'now'> {
  provider: ChatServiceDescriptor; projectId: string; root: string; installationId: string; directory: string; mode: 'local' | 'hosted'; dryRun?: boolean;
  budgetForBot?(botId: string): ChatSendBudget;
  receivers(): PrivateReceiver[]; transport(receiverId: string): ChatTransport; changed(): void;
  credentialTransport?(token: string): ChatTransport;
  /** Creates, or with `existingId` reuses, the active receiver a token-led setup sends through. */
  createReceiverFromToken?(token: string, name: string | undefined, chatId: string, existingId?: string, expectedRevision?: number): Promise<PrivateReceiver>;
  removeSetupReceiver?(id: string): Promise<void>;
  /** Deletes every receiver that sends through this bot. */
  removeBotReceivers?(botId: string, receiverIds: readonly string[]): Promise<void>;
}
/** What a provider contributes to the shared service: its descriptor and transport factories. */
export type ChatProviderAdapter = Pick<ChatServiceDependencies, 'provider' | 'transport' | 'credentialTransport'>;
/** The caller's dependencies plus the adapter, without modifying the caller's object. Getters stay live; adapter keys stay out of spreads into the runtime. */
export function withProvider<D extends object>(deps: D, adapter: ChatProviderAdapter): D & ChatServiceDependencies {
  const hidden = (key: keyof ChatProviderAdapter) => ({ configurable: true, enumerable: false, get: () => adapter[key] });
  return Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(deps), provider: hidden('provider'), transport: hidden('transport'), credentialTransport: hidden('credentialTransport') }) as D & ChatServiceDependencies;
}
interface Bot { budget: ChatSendBudget; state: InboundStateStore; lease: BotLease; runtime?: ChatBotRuntime; starting?: Promise<void>; transportFingerprint?: string; transportAnchor?: string }
type PairingCreated = { pairingId: string; expiresAt: number; deepLink: string };
type PairingStatus = { status: 'waiting' | 'candidate' | 'confirmed' | 'expired'; inboundRevision: string; candidate?: PairingSession['candidate'] };
type Reason = NonNullable<ChatInboundStateResponse['reason']>;
const approvalSchema = z.object({
  expectedRevision: z.string(), candidateUserId: z.string(), comparisonVerified: z.literal(true).optional(), taskControl: z.boolean().optional(),
  permissions: chatInboundGrantPatchSchema.shape.permissions.optional(),
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fatal = new Set(['conflict', 'credentials-unavailable', 'blocked'] as const);
const isFatal = (state: string): state is 'conflict' | 'credentials-unavailable' | 'blocked' => fatal.has(state as never);
const meSchema = chatIdentitySchema;

/** Project configuration owns bot leases; polling is a replaceable child of that ownership. */
export class ChatInbound {
  readonly pairings: Pairings;
  private damaged = new Map<string, { binding: BotBinding; revision?: string }>();
  private resets = new Set<Promise<unknown>>();
  private maintenance = new Set<string>();
  private bots = new Map<string, Bot>();
  private opening = new Map<string, Promise<Bot>>();
  private snapshots = new Map<string, InboundState>();
  private replacements = new Map<string, { botId: string; targetRevision: string }>();
  private discovered = new Map<string, string>();
  private confirmed = new Map<string, { botId: string; receiverId: string; until: number }>();
  /** Bot usernames seen in getMe answers this process; shown instead of the numeric id. */
  private usernames = new Map<string, string>();
  private readonly setup: ChatSetups;
  private closed = false;
  private transportPaused = false;
  private transportGeneration = 0;
  private transportChanges: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly deps: ChatServiceDependencies) {
    this.now = deps.now ?? Date.now; this.pairings = new Pairings(deps.provider.presentation, this.now);
    if (realpathSync(deps.root) !== deps.root) throw new ChatInboundFailure(503, 'noncanonical_root');
    this.setup = new ChatSetups({
      pairings: this.pairings, now: () => this.now(), gate: scope => this.gate(scope), receivers: () => this.receivers(),
      get callToken() { return deps.credentialTransport; }, provider: deps.provider, get createReceiverFromToken() { return deps.createReceiverFromToken; },
      get removeSetupReceiver() { return deps.removeSetupReceiver; },
      pair: input => this.pair(input), confirm: (id, input) => this.confirm(id, input), pairing: id => this.pairing(id),
      open: botId => this.open(botId),
      anchorChanged: botId => { const bot = this.bots.get(botId); return bot ? this.run(botId, bot, true) : Promise.resolve(); },
      snapshot: botId => this.snapshot(botId), revision: botId => this.revision(botId),
      receiverRevision: receiver => this.receiverRevision(receiver), eligible: id => this.eligible(id),
      expect: (botId, revision) => this.expect(botId, revision),
      checkGroupChat: (call, chatId, consent, botId) => this.checkGroupChat(call, chatId, consent, botId),
      stateExists: async botId => !!await readInboundState(this.deps.directory, botId),
      releaseUnusedBot: botId => this.releaseUnusedBot(botId), isConfirmed: id => this.confirmed.has(id), changed: () => this.deps.changed(),
    });
  }
  /** Task control: replies, commands and grants. */
  private reason(): Reason | undefined {
    return this.closed ? 'unavailable' : chatUnavailableReason(this.deps.mode);
  }
  /** Notifications and the setup that discovers their chat need only CEZ_WEBHOOKS=1. */
  private notificationsReason(): Exclude<Reason, 'flag_off'> | undefined { return notificationsReason(this.reason()); }
  private gate(scope: GateScope = 'taskControl'): void {
    const reason = scope === 'notifications' ? this.notificationsReason() : this.reason();
    if (reason) throw new ChatInboundFailure(503, reason);
  }
  private receiver(id: string): PrivateReceiver {
    const receiver = this.receivers().find(receiver => receiver.id === id);
    if (!receiver) throw new ChatInboundFailure(404, 'receiver_missing'); return receiver;
  }
  private receivers(): PrivateReceiver[] { return [...this.deps.receivers(), ...this.setup.temporaryReceivers()]; }
  private call(receiverId: string): ChatTransport {
    const token = this.setup.token(receiverId);
    if (token) {
      if (!this.deps.credentialTransport) throw new ChatInboundFailure(503, 'receiver_creation_unavailable');
      return this.deps.credentialTransport(token);
    }
    return this.deps.transport(receiverId);
  }
  private eligible(id: string): PrivateReceiver {
    const receiver = this.receiver(id);
    if (this.setup.temporary(id) && receiver.chatId === 'pending') return receiver;
    if (!receiverEligible(receiver) || !this.deps.provider.ids.chat.safeParse(receiver.chatId).success) throw new ChatInboundFailure(409, 'receiver_ineligible');
    return receiver;
  }
  private async checkGroup(receiver: PrivateReceiver, consent?: true, botId?: string): Promise<void> {
    if (receiver.chatId && this.deps.provider.presentation.isGroup(receiver.chatId)) await this.checkGroupChat(this.call(receiver.id), receiver.chatId, consent, botId);
  }
  /** Group visibility consent, a plain (non-forum) group, and the bot itself a member. */
  private async checkGroupChat(call: ChatTransport, chatId: string, consent: true | undefined, botId?: string): Promise<void> {
    if (!consent) throw new ChatInboundFailure(400, 'group_visibility_required');
    const chat = await call.inspect(chatId);
    if (!chat.eligible || chat.kind !== 'group' || chat.id !== chatId) throw new ChatInboundFailure(409, 'group_ineligible');
    if (botId) await this.checkGroupMember(call, chatId, botId, 'bot_not_group_member');
  }
  private async checkGroupMember(call: ChatTransport, chatId: string, userId: string, failure: 'bot_not_group_member' | 'candidate_not_group_member'): Promise<void> {
    if (await call.isMember(chatId, userId) !== true) throw new ChatInboundFailure(409, failure);
  }
  private snapshot(botId: string): InboundState | undefined { return this.bots.get(botId)?.state.snapshot() ?? this.snapshots.get(botId); }
  private botFor(receiverId: string): string | undefined {
    for (const botId of new Set([...this.snapshots.keys(), ...this.bots.keys()])) if (this.snapshot(botId)?.receivers.some(receiver => receiver.receiverId === receiverId)) return botId;
    return this.discovered.get(receiverId);
  }
  /** Neither under maintenance nor damaged: its state may be read and acted on. */
  private usable(botId: string): boolean { return !this.reason() && !this.maintenance.has(botId) && !this.damaged.has(botId); }
  /** A usable bot whose runtime is polling, so inbound updates reach it now. */
  private liveBot(botId: string | undefined): ChatBotRuntime | undefined {
    const runtime = botId && this.usable(botId) ? this.bots.get(botId)?.runtime : undefined;
    return runtime && ['polling', 'backoff'].includes(runtime.health().state) ? runtime : undefined;
  }
  /** True when a Reply to this receiver's notification can reach a task (spec 2026-10-29-telegram-setup-and-replies §Telegram-originated tasks). */
  repliesActive(receiver: PrivateReceiver): boolean {
    const botId = this.botFor(receiver.id);
    return !!this.liveBot(botId) && !!this.snapshot(botId!)?.receivers.some(bound => bound.receiverId === receiver.id && bound.enabled && bindingCurrent(bound, receiver));
  }
  /** True only while the live bot runtime will itself notify a Telegram-started run's source chat; any doubt keeps webhook admission. */
  ownsSourceDelivery(run: RunRecord): boolean {
    const source = run.chatSource, runtime = this.liveBot(source?.botId);
    return !!source && !!runtime && this.receivers().find(receiver => receiver.id === source.receiverId)?.chatId === source.chatId
      && runtime.deliversSource(run);
  }
  /** Reuse only getMe-verified credentials, including outbound-only receivers of that bot. */
  sendBudget(receiver: PrivateReceiver): ChatSendBudget | undefined {
    if (receiver.format !== this.deps.provider.format || !receiver.chatSecret?.sha256) return;
    for (const [id, bot] of this.bots) {
      if (!this.usable(id)) continue;
      try { bot.state.assertReady(); } catch { continue; }
      if (bot.state.snapshot().receivers.some(bound => bound.credentialFingerprint === receiver.chatSecret!.sha256)) return bot.budget;
    }
    return undefined;
  }
  private revision(botId: string): string {
    const state = this.snapshot(botId);
    return digest([state?.binding.generation ?? 'missing', state?.configGeneration ?? 'missing',
      // A retargeted setup no longer discovers through its temporary receiver. Exclude it
      // immediately, so later status-driven pruning cannot change an approval revision.
      this.receivers().filter(receiver => state?.receivers.some(binding => binding.receiverId === receiver.id)
        || (this.discovered.get(receiver.id) === botId && (!this.setup.temporary(receiver.id) || this.pairings.hasReceiver(receiver.id))))
        .map(receiver => [receiver.id, receiver.revision, receiver.deliveryRevision]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  }
  private receiverRevision(receiver: PrivateReceiver): string {
    const botId = this.botFor(receiver.id);
    const base = botId ? this.revision(botId)
      : digest([this.deps.projectId, this.deps.installationId, this.deps.root, receiver.id, receiver.revision, receiver.deliveryRevision, 'missing']);
    const pending = this.replacements.get(receiver.id);
    return pending ? digest([base, pending.botId, this.revision(pending.botId)]) : base;
  }
  private expect(botId: string, revision: string): void {
    if (this.revision(botId) !== revision) throw new ChatInboundFailure(409, 'revision_conflict');
  }
  private liveReceiverIds(): Set<string> { return new Set(this.receivers().map(receiver => receiver.id)); }
  /** Session bookkeeping for receivers deleted from the project must not outlive them. */
  private prune(): void {
    const live = this.liveReceiverIds();
    for (const id of this.discovered.keys()) if (!live.has(id)) this.discovered.delete(id);
    for (const id of this.replacements.keys()) if (!live.has(id)) this.replacements.delete(id);
    for (const [id, value] of this.confirmed) if (value.until <= this.now() || !live.has(value.receiverId)) this.confirmed.delete(id);
    this.setup.prune();
  }
  private receiverState(receiver: PrivateReceiver, botId: string | undefined, state: InboundState | undefined): ChatInboundStateResponse['receivers'][number]['state'] {
    const binding = state?.receivers.find(binding => binding.receiverId === receiver.id);
    if (botId && this.damaged.has(botId)) return 'blocked';
    if (binding?.suspendedReason) return 'suspended';
    if (binding?.enabled && state?.grants.some(grant => grant.receiverId === receiver.id)) {
      if (!bindingCurrent(binding, receiver)) return 'suspended';
      const runtime = botId ? this.bots.get(botId)?.runtime : undefined, health = runtime?.health().state ?? state?.fatalStop;
      return !runtime?.running && !state?.fatalStop ? 'stopped' : health && isFatal(health) ? health : 'active';
    }
    return this.pairings.hasReceiver(receiver.id) ? 'pairing' : 'disabled';
  }
  list(): ChatInboundStateResponse {
    this.prune();
    const reason = this.reason(), notifications = this.notificationsReason();
    const states = [...new Set([...this.snapshots.keys(), ...this.bots.keys()])].flatMap(id => { const state = this.snapshot(id); return state ? [state] : []; });
    const healthy = states.filter(state => !this.damaged.has(state.botId)), live = this.liveReceiverIds();
    return { available: !reason, ...(reason ? { reason } : {}),
      notifications: { available: !notifications, ...(notifications ? { reason: notifications } : {}) },
      taskControl: { available: !reason, ...(reason ? { reason } : {}) },
      receivers: this.receivers().filter(receiver => receiver.format === this.deps.provider.format).map(receiver => {
        const botId = this.botFor(receiver.id), state = botId ? this.snapshot(botId) : undefined;
        const binding = state?.receivers.find(binding => binding.receiverId === receiver.id);
        return { receiverId: receiver.id, ...(botId ? { botId } : {}), inboundRevision: this.receiverRevision(receiver),
          state: this.receiverState(receiver, botId, state), ...(binding ? { generation: binding.generation } : {}),
          ...(binding?.suspendedReason ? { suspendedReason: binding.suspendedReason } : {}) };
      }),
      bots: [
        ...healthy.map(state => ({ botId: state.botId, ...this.username(state.botId), inboundRevision: this.revision(state.botId),
          health: this.bots.get(state.botId)?.runtime?.health() ?? (state.fatalStop ? { state: state.fatalStop } : { state: 'stopped' as const }) })),
        ...[...this.damaged].map(([botId, damage]) => ({ botId, ...this.username(botId), ...(damage.revision ? { inboundRevision: damage.revision } : {}), health: { state: 'blocked' as const } })),
      ],
      // A deleted receiver's grants linger in its bot's state; they are not people the operator can manage.
      grants: healthy.flatMap(state => state.grants).filter(grant => live.has(grant.receiverId)),
    };
  }
  private username(botId: string): { username?: string } {
    const username = this.usernames.get(botId); return username ? { username } : {};
  }
  private remember(me: z.infer<typeof meSchema>): z.infer<typeof meSchema> { this.usernames.set(String(me.id), me.username); return me; }
  private acquireLease(botId: string) { return BotLease.acquire(botId, this.deps.dryRun, this.deps.provider.id); }
  private ownBinding(binding: BotBinding): boolean {
    return binding.root === this.deps.root && binding.projectId === this.deps.projectId && binding.installationId === this.deps.installationId;
  }
  async load(): Promise<void> {
    let files: string[] = [];
    assertNoSymlink(this.deps.directory);
    try { files = await readdir(this.deps.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const diagnostics = new ChatBindings({ provider: this.deps.provider.id, mode: () => this.deps.mode, projects: async () => [], dryRun: this.deps.dryRun, visibleProject: () => this.deps.projectId });
    const bindings = await diagnostics.scan();
    const ids = new Set([...files.map(inboundStateBotId).filter((id): id is string => id !== undefined && this.deps.provider.ids.bot.safeParse(id).success).slice(0, 100), ...bindings.bindings.map(binding => binding.botId)]);
    for (const botId of ids) {
      const binding = await readBinding(botId, this.deps.dryRun === true, this.deps.provider.id).catch(() => undefined);
      if (!binding || !this.ownBinding(binding)) continue;
      try {
        const state = await readInboundState(this.deps.directory, botId);
        if (state && state.provider === this.deps.provider.id && this.ownBinding(state.binding) && state.binding.generation === binding.generation) {
          // A first setup interrupted by a restart left a bound bot with nothing on it: release it, never list it.
          if (!state.receivers.length && !state.grants.length && await this.releaseLoaded(botId, binding)) continue;
          this.snapshots.set(botId, state); continue;
        }
      } catch { /* Never salvage grants from malformed state. */ }
      const revision = await stateFingerprint(this.deps.directory, botId, binding).catch(() => undefined);
      this.damaged.set(botId, { binding, ...(revision ? { revision } : {}) });
    }
  }
  /** Passive status refresh can recompute reset eligibility, never starts a consumer. */
  async refreshDiagnostics(): Promise<void> {
    for (const [botId, bot] of this.bots) {
      try { bot.state.assertReady(); }
      catch { if (!this.damaged.has(botId)) this.damaged.set(botId, { binding: bot.state.snapshot().binding }); }
    }
    for (const [botId, damage] of this.damaged) {
      if (this.maintenance.has(botId)) continue;
      const binding = await readBinding(botId, this.deps.dryRun === true, this.deps.provider.id).catch(() => undefined);
      if (!binding || !this.ownBinding(binding) || binding.generation !== damage.binding.generation) { delete damage.revision; continue; }
      damage.revision = await stateFingerprint(this.deps.directory, botId, binding).catch(() => undefined);
    }
  }
  /** Opening a bot's state is setup work too; every caller gates its own scope first. */
  private gateStateOpen(selectionOnly: boolean): void {
    if (!selectionOnly) this.gate('notifications');
    else if (this.closed || this.deps.mode !== 'local') throw new ChatInboundFailure(409, 'unavailable');
  }
  private async open(botId: string, create = false, selectionOnly = false): Promise<Bot> {
    this.gateStateOpen(selectionOnly);
    if (this.maintenance.has(botId)) throw new ChatInboundFailure(409, 'bot_busy');
    if (this.damaged.has(botId)) throw new ChatInboundFailure(409, 'reset_required');
    const current = this.bots.get(botId); if (current) { current.lease.assertOwner(); return current; }
    const pending = this.opening.get(botId); if (pending) return pending;
    const work = (async () => {
      const lease = await this.acquireLease(botId);
      try {
        this.gateStateOpen(selectionOnly);
        assertNoSymlink(this.deps.directory); await mkdir(this.deps.directory, { recursive: true, mode: 0o700 }); await chmod(this.deps.directory, 0o700);
        let saved = await readInboundState(this.deps.directory, botId);
        // State without a binding is an interrupted disconnect; pairing starts over instead of stranding the bot.
        if (saved && create && !await lease.binding()) saved = undefined;
        if (saved && saved.provider !== this.deps.provider.id) throw new ChatInboundFailure(409, 'binding_conflict');
        if (saved) await lease.validate(saved.binding);
        else {
          if (!create) throw new ChatInboundFailure(409, 'state_missing');
          const identity = { projectId: this.deps.projectId, root: this.deps.root, installationId: this.deps.installationId };
          const current = await lease.binding();
          if (current) saved = freshState(botId, await lease.bind(identity), this.deps.provider.id);
          else {
            // State before binding: a first setup cut short in between leaves the bot unbound, never bound and blocked.
            saved = freshState(botId, { ...identity, generation: randomUUID() }, this.deps.provider.id);
            lease.assertOwner(); await atomicWrite(this.deps.directory, inboundStateFilename(botId), saved);
            await lease.bind(identity, saved.binding.generation);
          }
        }
        if (!this.ownBinding(saved.binding)) throw new ChatInboundFailure(409, 'foreign_state');
        const state = InboundStateStore.persisted(this.deps.directory, saved, () => lease.assertOwnerCached(), () => lease.assertOwner());
        await state.recover(); this.gateStateOpen(selectionOnly);
        const bot = { state, lease, budget: this.deps.budgetForBot?.(botId) ?? new ChatSendBudget(this.now, this.deps.provider.limits) }; this.bots.set(botId, bot); return bot;
      } catch (error) { await lease.release(); throw error; }
    })();
    this.opening.set(botId, work);
    try { return await work; } finally { this.opening.delete(botId); }
  }
  /** Passive startup demand; transport availability must not hide persisted consent. */
  needsTransport(): boolean { return !this.reason() && this.resumableBots().length > 0; }
  private resumableBots(): string[] {
    // Loaded snapshots and live stores both matter after pairing or reset.
    const live = this.liveReceiverIds();
    return [...new Set([...this.snapshots.keys(), ...this.bots.keys()])].filter(botId => {
      const state = this.snapshot(botId), health = this.bots.get(botId)?.runtime?.health().state;
      const granted = state?.receivers.some(bound => bound.enabled && live.has(bound.receiverId) && state.grants.some(grant => grant.receiverId === bound.receiverId));
      return !!state && (this.pairings.hasBot(botId) || !!granted) && !state.fatalStop && !(health && isFatal(health));
    });
  }
  async start(): Promise<void> {
    if (this.reason() || this.transportPaused) return;
    for (const botId of this.resumableBots()) {
      try {
        const bot = await this.open(botId); await this.run(botId, bot);
      } catch { this.deps.changed(); }
    }
  }
  private selectAnchor(botId: string, bot: Bot): string | undefined {
    // A verified setup token recovers polling before activation can replace a revoked durable token.
    const temporary = this.setup.temporaryFor(botId);
    if (temporary) return temporary;
    const state = bot.state.snapshot();
    const current = state.receivers.filter(binding => bindingCurrent(binding, this.receivers().find(receiver => receiver.id === binding.receiverId)));
    // Older state has no preference; once rotated, never fall back to another chat's stale token.
    return (state.transportCredentialFingerprint
      ? current.find(binding => binding.credentialFingerprint === state.transportCredentialFingerprint) : current[0])?.receiverId;
  }
  private transportChanged(botId: string, bot: Bot): boolean {
    const anchor = this.selectAnchor(botId, bot);
    return anchor !== bot.transportAnchor || this.receivers().find(receiver => receiver.id === anchor)?.chatSecret?.sha256 !== bot.transportFingerprint;
  }
  /** `explicit`: a user action (pair, enable, reset) may restart a runtime stopped by a fatal state. */
  private async run(botId: string, bot: Bot, explicit = false): Promise<void> {
    if (bot.starting) {
      if (!explicit || !this.transportChanged(botId, bot)) return bot.starting;
      if (bot.runtime && !await bot.runtime.stop()) throw new ChatInboundFailure(409, 'bot_busy');
      await bot.starting;
      return this.run(botId, bot, explicit);
    }
    const work = this.startBot(botId, bot, explicit); bot.starting = work;
    try { await work; } finally { bot.starting = undefined; }
  }
  private async startBot(botId: string, bot: Bot, explicit: boolean): Promise<void> {
    this.gate('notifications');
    if (this.transportPaused) throw new ChatInboundFailure(409, 'bot_busy');
    const transportGeneration = this.transportGeneration;
    const selectAnchor = () => this.selectAnchor(botId, bot);
    const changed = this.transportChanged(botId, bot);
    const health = bot.runtime?.running ? bot.runtime.health().state : undefined;
    if ((!changed && (health === 'polling' || health === 'backoff')) || (!explicit && (bot.runtime?.starting || (health && isFatal(health)) || bot.state.snapshot().fatalStop))) return;
    if (bot.runtime && !await bot.runtime.stop()) throw new ChatInboundFailure(409, 'bot_busy');
    this.gate('notifications');
    const state = bot.state.snapshot();
    // Bind every verified credential before constructing the reply dispatcher so
    // a recreated budget observes the process-wide 429 cooldown immediately.
    for (const bound of state.receivers) if (bound.credentialFingerprint) bot.budget.share(bound.credentialFingerprint);
    const anchor = selectAnchor();
    if (!anchor) return;
    const fingerprint = this.receivers().find(receiver => receiver.id === anchor)?.chatSecret?.sha256;
    // One wire fence for both owners: worker calls get the same gate/lease/ready checks.
    const ownsWire = () => {
      if (this.closed || this.transportPaused || transportGeneration !== this.transportGeneration) return false;
      try { this.gate('notifications'); bot.lease.assertOwner(); bot.state.assertReady(); } catch { return false; }
      return selectAnchor() === anchor;
    };
    if (this.closed || this.transportPaused || transportGeneration !== this.transportGeneration) return;
    const transport = this.call(anchor).guarded(ownsWire);
    bot.transportFingerprint = fingerprint; bot.transportAnchor = anchor;
    bot.runtime = new ChatBotRuntime({ ...this.deps, botId, state: bot.state, lease: bot.lease, budget: bot.budget, pairings: this.pairings, session: {
      send: (...args) => transport.send(...args),
      clearButtons: (...args) => transport.clearButtons(...args),
      acknowledge: (...args) => transport.acknowledge(...args),
      isMember: (...args) => transport.isMember(...args),
      // Keep the adapter's verified identity and restore the service cache after restart.
      identify: async signal => this.remember(meSchema.parse(await transport.identify(signal))),
    }, presentation: this.deps.provider.presentation,
      connect: options => {
        const connection = transport.connect({
        recover: () => bot.state.recover(), assertReady: () => bot.state.assertReady(), prepareReceive: (now, idleResetMs) => bot.state.prepareReceive(now, idleResetMs),
        snapshot: () => { const state = bot.state.snapshot(); return { epoch: state.epoch, nextOffset: state.nextOffset }; },
        duplicate: (epoch, sequence) => bot.state.duplicate(epoch, sequence), finish: (epoch, sequence) => bot.state.finish(epoch, sequence),
        touch: at => bot.state.touch(at), flush: () => bot.state.flush(),
        }, options, this.deps.now);
        return connection;
      },
      // With task control off the runtime polls only while a setup discovers its chat, and no grant authorizes.
      enabled: () => !this.reason() || (!this.notificationsReason() && this.pairings.hasBot(botId)),
      receiver: id => this.reason() ? undefined : this.receivers().find(receiver => receiver.id === id),
      assertCredentials: async () => {
        this.gate('notifications');
        const anchor = selectAnchor();
        if (!anchor) throw new ChatInboundFailure(503, 'credentials_unavailable');
        const bound = bot.state.snapshot().receivers.find(receiver => receiver.receiverId === anchor), receiver = this.eligible(anchor);
        if (this.setup.temporary(anchor)) return;
        if (receiver.chatSecret?.sha256 !== bound?.credentialFingerprint) throw new ChatInboundFailure(503, 'credentials_unavailable');
      } });
    await bot.runtime.start();
  }
  /** The pairing core under guided setup; routes reach it only through beginSetup. */
  async pair(raw: z.input<typeof chatSetupBeginSchema>): Promise<PairingCreated> {
    const input = chatSetupBeginSchema.parse(raw);
    // A token-led setup's placeholder may still end notifications-only; any other pairing is task control.
    const scope: GateScope = this.setup.temporary(input.receiverId) ? 'notifications' : 'taskControl';
    this.gate(scope);
    if (!input.receiverId || !input.expectedRevision) throw new ChatInboundFailure(400, 'receiver_required');
    const receiver = this.eligible(input.receiverId);
    if (this.receiverRevision(receiver) !== input.expectedRevision) throw new ChatInboundFailure(409, 'revision_conflict');
    const before = receiver.revision;
    const me = this.remember(meSchema.parse(await this.call(receiver.id).identify())); this.gate(scope);
    if (receiver.chatId !== 'pending') await this.checkGroup(receiver, input.groupVisibilityAccepted, String(me.id));
    if (this.eligible(receiver.id).revision !== before) throw new ChatInboundFailure(409, 'revision_conflict');
    const botId = String(me.id), known = this.botFor(receiver.id);
    const bot = await this.open(botId, true);
    const targetRevision = this.revision(botId);
    // Retargeting a receiver must replace its old chat binding explicitly, even
    // for a group or a private receiver whose last approved person was revoked.
    const existing = bot.state.snapshot().receivers.find(binding => binding.receiverId === receiver.id);
    if (existing && existing.chatId !== receiver.chatId && !input.replaceExisting)
      throw new ChatInboundFailure(409, 'replacement_required');
    if (known && known !== botId) {
      if (!input.replaceExisting) throw new ChatInboundFailure(409, 'replacement_required');
      const pending = this.replacements.get(receiver.id);
      if (!pending || pending.botId !== botId || pending.targetRevision !== targetRevision) {
        this.replacements.set(receiver.id, { botId, targetRevision });
        throw new ChatInboundFailure(409, 'revision_required');
      }
      const previous = await this.open(known);
      await previous.state.change(state => {
        this.gate();
        if (this.receiverRevision(this.eligible(receiver.id)) !== input.expectedRevision || this.revision(botId) !== targetRevision) throw new ChatInboundFailure(409, 'revision_conflict');
        state.receivers = state.receivers.filter(binding => binding.receiverId !== receiver.id);
        state.grants = state.grants.filter(grant => grant.receiverId !== receiver.id);
        state.correlations = state.correlations.filter(correlation => correlation.receiverId !== receiver.id);
        state.configGeneration = randomUUID();
      });
      this.pairings.cancelReceiver(receiver.id);
    }
    // An existing receiver confirms the bot it just discovered; a token-led placeholder already names its bot.
    if (!known && scope === 'taskControl' && bot.state.snapshot().receivers.length) {
      this.discovered.set(receiver.id, botId); throw new ChatInboundFailure(409, 'revision_required');
    }
    if (input.replaceExisting) this.pairings.cancelReceiver(receiver.id);
    let session: ReturnType<Pairings['create']>;
    try {
      session = this.pairings.create({ receiverId: receiver.id, botId, chatId: receiver.chatId!, deliveryRevision: receiver.deliveryRevision,
        ...(this.setup.temporary(receiver.id) ? { allowGroup: true } : {}) }, me.username, this.deps.provider.id.includes('/') && this.deps.provider.pairingUsesIdentityUrl !== false ? me.discoveryUrl : undefined);
    } catch (error) {
      if (error instanceof Error && error.message === 'pairing_limit') throw new ChatInboundFailure(409, 'pairing_limit');
      throw error;
    }
    try {
      await bot.state.change(state => {
        this.gate(scope);
        if (known === botId && this.receiverRevision(this.eligible(receiver.id)) !== input.expectedRevision) throw new ChatInboundFailure(409, 'revision_conflict');
        if (known && known !== botId && this.revision(botId) !== targetRevision) throw new ChatInboundFailure(409, 'revision_conflict');
        const current = this.eligible(receiver.id); if (current.revision !== before) throw new ChatInboundFailure(409, 'revision_conflict');
        if (state.receivers.some(binding => binding.chatId === current.chatId && binding.receiverId !== current.id)) throw new ChatInboundFailure(409, 'chat_conflict');
        if (input.replaceExisting) {
          state.receivers = state.receivers.filter(binding => binding.receiverId !== current.id);
          state.grants = state.grants.filter(grant => grant.receiverId !== current.id);
          state.correlations = state.correlations.filter(correlation => correlation.receiverId !== current.id);
        }
        if (current.chatId !== 'pending' && !state.receivers.some(binding => binding.receiverId === current.id)) {
          if (state.receivers.length >= MAX_BOT_RECEIVERS) throw new ChatInboundFailure(409, 'chat_limit');
          state.receivers.push({ receiverId: current.id, chatId: current.chatId!, enabled: false,
            generation: randomUUID(), acceptAfter: this.now(), deliveryRevision: current.deliveryRevision, credentialFingerprint: current.chatSecret!.sha256 });
        }
        state.configGeneration = randomUUID();
      });
      this.discovered.set(receiver.id, botId); this.replacements.delete(receiver.id);
      await this.run(botId, bot, true); this.deps.changed();
      return { pairingId: session.session.id, expiresAt: session.session.expiresAt, deepLink: session.deepLink };
    } catch (error) {
      this.pairings.cancel(session.session.id);
      if (known && known !== botId) { this.discovered.set(receiver.id, botId); this.replacements.delete(receiver.id); }
      throw error;
    }
  }
  /** Guided setup, private or group; a pasted token stays in memory until activation stores it in the vault. */
  beginSetup(raw: z.input<typeof chatSetupBeginSchema>): Promise<ChatSetupBegun> { return this.setup.begin(raw); }
  setupStatus(id: string): ChatSetupStatus { return this.setup.status(id); }
  activateSetup(id: string, raw: z.input<typeof chatSetupActivateSchema>): Promise<ChatSetupActivated> { return this.setup.activate(id, raw); }
  cancelSetup(id: string): Promise<{ cancelled: true }> { return this.setup.cancel(id); }
  pairing(id: string): PairingStatus {
    if (this.setup.tokenLed(id) ? this.notificationsReason() : this.reason()) throw new ChatInboundFailure(404, 'pairing_expired');
    this.prune(); const confirmed = this.confirmed.get(id);
    if (confirmed) return { status: 'confirmed', inboundRevision: this.revision(confirmed.botId) };
    const session = this.pairings.get(id);
    if (!session) {
      const expired = this.pairings.wasExpired(id);
      if (expired) return { status: 'expired', inboundRevision: this.revision(expired.botId) };
      throw new ChatInboundFailure(404, 'pairing_expired');
    }
    return { status: session.candidate ? 'candidate' : 'waiting', inboundRevision: this.revision(session.botId), ...(session.candidate ? { candidate: session.candidate } : {}) };
  }
  /** Every grant is task control: pairing exists only to let a person act on tasks. */
  async confirm(id: string, raw: z.input<typeof approvalSchema>): Promise<{ grant: InboundGrant; inboundRevision: string }> {
    const input = approvalSchema.parse(raw);
    this.gate(); const session = this.pairings.get(id);
    if (!session) throw new ChatInboundFailure(404, 'pairing_expired');
    const bot = await this.open(session.botId);
    const candidate = session.candidate;
    const candidateReceiver = this.eligible(session.receiverId);
    if (!candidate || candidate.userId !== input.candidateUserId || candidateReceiver.chatId !== session.chatId
      || candidateReceiver.deliveryRevision !== session.deliveryRevision) throw new ChatInboundFailure(409, 'pairing_changed');
    if (this.deps.provider.presentation.isGroup(session.chatId) && input.comparisonVerified) {
      await this.checkGroupMember(this.call(candidateReceiver.id), session.chatId, candidate.userId, 'candidate_not_group_member');
    }
    const { grant, privateChatId } = await bot.state.change(state => {
      this.gate(); this.expect(session.botId, input.expectedRevision);
      const current = this.pairings.get(id), receiver = this.eligible(session.receiverId);
      if (!current?.candidate || current.candidate.userId !== input.candidateUserId || receiver.chatId !== current.chatId
        || receiver.deliveryRevision !== current.deliveryRevision) throw new ChatInboundFailure(409, 'pairing_changed');
      if (this.deps.provider.presentation.isGroup(current.chatId) && (!current.candidate.comparisonCode || !input.comparisonVerified)) throw new ChatInboundFailure(400, 'comparison_required');
      if (current.candidate.chatType !== 'private') throw new ChatInboundFailure(409, 'pairing_changed');
      const bound = state.receivers.find(binding => binding.receiverId === receiver.id)!;
      if (bound.chatId !== receiver.chatId) throw new ChatInboundFailure(409, 'chat_changed');
      if (state.grants.some(grant => grant.receiverId === receiver.id && grant.userId === current.candidate!.userId)) throw new ChatInboundFailure(409, 'already_paired');
      if (state.grants.length >= 100) throw new ChatInboundFailure(409, 'grant_limit');
      if (!bound.enabled) {
        bound.generation = randomUUID(); bound.acceptAfter = this.now();
      }
      for (const retained of state.grants) if (retained.receiverId === receiver.id) retained.enableGeneration = bound.generation;
      delete state.fatalStop;
      delete bound.suspendedReason;
      bound.enabled = true; bound.deliveryRevision = receiver.deliveryRevision; bound.credentialFingerprint = receiver.chatSecret!.sha256;
      const grant: InboundGrant = { id: randomUUID(), receiverId: receiver.id, chatId: bound.chatId, userId: current.candidate.userId,
        label: current.candidate.label, permissions: input.permissions ?? ['respond'], capability: 'task_control', generation: randomUUID(),
        enableGeneration: bound.generation, approvedAt: this.now() };
      state.grants.push(grant); state.configGeneration = randomUUID();
      // The actor and their private destination may differ on some providers.
      // Capture the same candidate validated by this transaction, including after setup retargeting.
      return { grant, privateChatId: current.candidate.chatId };
    });
    this.pairings.cancel(id); this.confirmed.set(id, { botId: session.botId, receiverId: session.receiverId, until: this.now() + 300_000 });
    this.bots.get(session.botId)?.runtime?.notifyAccessGranted(privateChatId, grant.chatId);
    this.deps.changed();
    return { grant, inboundRevision: this.revision(session.botId) };
  }
  private grantBot(grantId: string): string | undefined {
    return this.list().bots.find(bot => this.snapshot(bot.botId)?.grants.some(grant => grant.id === grantId))?.botId;
  }
  async revoke(id: string, expectedRevision: string): Promise<{ revoked: true; inboundRevision: string }> {
    // Removing authority must work while task control is off, or a flag flip restores it.
    this.gate('notifications'); const botId = this.grantBot(id);
    if (!botId) throw new ChatInboundFailure(404, 'grant_missing'); const bot = await this.open(botId);
    await bot.state.change(state => {
      this.gate('notifications'); this.expect(botId, expectedRevision);
      const grant = state.grants.find(grant => grant.id === id); if (!grant) throw new ChatInboundFailure(404, 'grant_missing');
      state.grants = state.grants.filter(grant => grant.id !== id);
      if (!state.grants.some(other => other.receiverId === grant.receiverId)) state.receivers.find(binding => binding.receiverId === grant.receiverId)!.enabled = false;
      state.configGeneration = randomUUID();
    });
    this.deps.changed(); return { revoked: true, inboundRevision: this.revision(botId) };
  }
  async permissions(id: string, raw: z.input<typeof chatInboundGrantPatchSchema>): Promise<{ grant: InboundGrant; inboundRevision: string }> {
    const input = chatInboundGrantPatchSchema.parse(raw);
    const botId = this.grantBot(id);
    // Narrowing removes authority, so it needs only notifications; widening is task control (checked under the lock).
    const narrowing = (permissions: readonly string[] | undefined) => !!permissions && input.permissions.every(permission => permissions.includes(permission));
    this.gate('notifications');
    if (!botId) throw new ChatInboundFailure(404, 'grant_missing');
    const bot = await this.open(botId);
    const grant = await bot.state.change(state => {
      const grant = state.grants.find(grant => grant.id === id);
      this.gate(narrowing(grant?.permissions) ? 'notifications' : 'taskControl'); this.expect(botId, input.expectedRevision);
      if (!grant) throw new ChatInboundFailure(404, 'grant_missing');
      // Only this person's older messages lose effect; others on the receiver keep theirs.
      grant.permissions = input.permissions; grant.generation = randomUUID(); grant.approvedAt = this.now();
      state.configGeneration = randomUUID(); return grant;
    });
    this.deps.changed(); return { grant, inboundRevision: this.revision(botId) };
  }
  async setEnabled(receiverId: string, raw: z.input<typeof chatInboundReceiverPatchSchema>): Promise<{ state: 'active' | 'disabled'; inboundRevision: string }> {
    const input = chatInboundReceiverPatchSchema.parse(raw), botId = this.botFor(receiverId);
    const scope: GateScope = input.enabled ? 'taskControl' : 'notifications'; this.gate(scope);
    if (!botId) throw new ChatInboundFailure(404, 'binding_missing');
    const bot = await this.open(botId);
    if (input.enabled) {
      const receiver = this.eligible(receiverId), before = receiver.revision;
      const me = this.remember(meSchema.parse(await this.call(receiverId).identify()));
      await this.checkGroup(receiver, input.groupVisibilityAccepted, String(me.id));
      if (String(me.id) !== botId || this.receiver(receiverId).revision !== before) throw new ChatInboundFailure(409, 'receiver_changed');
    }
    await bot.state.change(state => {
      this.gate(scope); this.expect(botId, input.expectedRevision);
      const bound = state.receivers.find(binding => binding.receiverId === receiverId);
      if (!bound) throw new ChatInboundFailure(404, 'binding_missing');
      if (input.enabled) {
        const receiver = this.eligible(receiverId);
        if (receiver.chatId !== bound.chatId || !state.grants.some(grant => grant.receiverId === receiverId)) throw new ChatInboundFailure(409, 'pairing_required');
        delete bound.suspendedReason;
        bound.generation = randomUUID(); bound.acceptAfter = this.now();
        bound.deliveryRevision = receiver.deliveryRevision; bound.credentialFingerprint = receiver.chatSecret!.sha256;
        for (const grant of state.grants) if (grant.receiverId === receiverId) grant.enableGeneration = bound.generation;
        delete state.fatalStop;
      }
      bound.enabled = input.enabled; forgetReplies(state, correlation => correlation.receiverId === receiverId);
      state.configGeneration = randomUUID();
    });
    if (input.enabled) await this.run(botId, bot, true);
    else if (!bot.state.snapshot().receivers.some(binding => binding.enabled)) await bot.runtime?.stop();
    this.deps.changed(); return { state: input.enabled ? 'active' : 'disabled', inboundRevision: this.revision(botId) };
  }
  /** Removes every approved person; the bot's notifications keep sending. */
  async reset(botId: string, expectedRevision: string): Promise<{ reset: true; inboundRevision: string }> {
    this.gate('notifications');
    if (this.damaged.has(botId)) return this.track(this.resetDamaged(botId, expectedRevision));
    const bot = await this.open(botId); this.expect(botId, expectedRevision);
    this.maintenance.add(botId);
    try { await this.clear(botId, bot, expectedRevision); } finally { this.maintenance.delete(botId); }
    this.deps.changed(); return { reset: true, inboundRevision: this.revision(botId) };
  }
  private async track<T>(work: Promise<T>): Promise<T> {
    this.resets.add(work);
    try { return await work; } finally { this.resets.delete(work); }
  }
  /** Reset's effect; the caller holds maintenance. */
  private async clear(botId: string, bot: Bot, expectedRevision: string): Promise<void> {
    if (bot.runtime && !await bot.runtime.stop()) throw new ChatInboundFailure(409, 'bot_busy');
    await bot.state.change(state => {
      this.gate('notifications'); this.expect(botId, expectedRevision);
      this.pairings.cancelBot(botId);
      for (const bound of state.receivers) {
        bound.enabled = false; bound.generation = randomUUID(); bound.acceptAfter = this.now(); this.pairings.cancelReceiver(bound.receiverId);
      }
      state.grants = []; state.correlations = []; state.journal = []; state.epoch = randomUUID();
      state.nextOffset = null; state.phase = 'probing'; state.lastUpdateAt = null;
      delete state.fatalStop;
      state.configGeneration = randomUUID();
    });
  }
  /** `held`: the caller already holds maintenance and releases it. */
  private async resetDamaged(botId: string, expectedRevision: string, held = false): Promise<{ reset: true; inboundRevision: string }> {
    const damage = this.damaged.get(botId)!;
    if (!damage.revision) throw new ChatInboundFailure(409, 'reset_unavailable');
    if (damage.revision !== expectedRevision) throw new ChatInboundFailure(409, 'revision_conflict');
    if (!held && this.maintenance.has(botId)) throw new ChatInboundFailure(409, 'bot_busy');
    this.maintenance.add(botId);
    let lease: BotLease | undefined;
    const existing = this.bots.get(botId);
    try {
      if (existing?.runtime && !await existing.runtime.stop()) throw new ChatInboundFailure(409, 'bot_busy');
      await existing?.state.drain();
      for (const receiver of existing?.state.snapshot().receivers ?? []) this.pairings.cancelReceiver(receiver.receiverId);
      lease = existing?.lease ?? await this.acquireLease(botId); this.gate('notifications');
      await lease.validate(damage.binding);
      if (!this.ownBinding(damage.binding) || await stateFingerprint(this.deps.directory, botId, damage.binding) !== expectedRevision) {
        throw new ChatInboundFailure(409, 'revision_conflict');
      }
      assertNoSymlink(this.deps.directory); await mkdir(this.deps.directory, { recursive: true, mode: 0o700 }); await chmod(this.deps.directory, 0o700);
      const owned = lease;
      const state = InboundStateStore.persisted(this.deps.directory, freshState(botId, damage.binding, this.deps.provider.id), () => owned.assertOwnerCached(), () => owned.assertOwner());
      await state.change(() => { this.gate('notifications'); });
      this.bots.set(botId, { lease, state, budget: existing?.budget ?? this.deps.budgetForBot?.(botId) ?? new ChatSendBudget(this.now, this.deps.provider.limits) }); lease = undefined;
      this.damaged.delete(botId); this.snapshots.delete(botId); this.deps.changed();
      return { reset: true, inboundRevision: this.revision(botId) };
    } finally { if (!held) this.maintenance.delete(botId); if (!existing) await lease?.release(); }
  }
  /** Removes the bot from this project: its approved people, its state and binding, and every receiver it sends through. */
  async disconnect(botId: string, expectedRevision: string): Promise<{ disconnected: true; inboundRevision: string }> {
    this.gate('notifications');
    const bound = this.snapshot(botId)?.receivers.map(row => row.receiverId) ?? [];
    const damaged = this.damaged.has(botId), opened = damaged ? undefined : await this.open(botId);
    if (opened) this.expect(botId, expectedRevision);
    if (this.maintenance.has(botId)) throw new ChatInboundFailure(409, 'bot_busy');
    // Held to the end: a pairing or setup in between could bind a runtime that outlives the disconnect.
    this.maintenance.add(botId);
    try {
      let inboundRevision: string;
      if (opened) { await this.clear(botId, opened, expectedRevision); this.deps.changed(); inboundRevision = this.revision(botId); }
      else inboundRevision = (await this.track(this.resetDamaged(botId, expectedRevision, true))).inboundRevision;
      const bot = this.bots.get(botId);
      if (!bot) throw new ChatInboundFailure(404, 'binding_missing');
      // Receivers go first: a failure here leaves a bound, resettable bot, never a disconnected bot that still sends.
      await this.deps.removeBotReceivers?.(botId, bound);
      const binding = bot.state.snapshot().binding;
      try {
        await bot.state.drain();
        // State before binding: a crash in between leaves a resettable binding, never an unpairable orphan state.
        await unlink(statePath(this.deps.directory, inboundStateFilename(botId))).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        await syncDirectory(this.deps.directory);
        await bot.lease.disconnect(binding);
      } catch (error) {
        // The lease is released below, so this store is dead; as damaged, a retried disconnect resets and finishes.
        const revision = await stateFingerprint(this.deps.directory, botId, binding).catch(() => undefined);
        this.damaged.set(botId, { binding, ...(revision ? { revision } : {}) }); this.deps.changed();
        throw error;
      } finally {
        this.bots.delete(botId); this.snapshots.delete(botId);
        for (const [id, discovered] of this.discovered) if (discovered === botId) this.discovered.delete(id);
        await bot.lease.release();
      }
      this.deps.changed(); return { disconnected: true, inboundRevision };
    } finally { this.maintenance.delete(botId); }
  }
  /** A lost correlation never changes an already committed outbound delivery result. */
  async recordDelivery(source: WebhookSource, receiverId: string, deliveryRevision: number,
    receipt: { messageId: string; chatId: string }): Promise<boolean> {
    if (this.reason() || source.projectId !== this.deps.projectId || source.installationId !== this.deps.installationId) return false;
    const botId = this.botFor(receiverId);
    // A bot whose chats are all disabled is not opened at boot; its receipt still has to land.
    const bot = botId ? this.bots.get(botId) ?? (this.snapshots.has(botId) ? await this.open(botId).catch(() => undefined) : undefined) : undefined;
    if (!bot) return false;
    return bot.state.change(state => {
      const receiver = this.receivers().find(receiver => receiver.id === receiverId);
      const bound = state.receivers.find(binding => binding.receiverId === receiverId);
      if (this.reason() || !bound || !bindingCurrent(bound, receiver)
        || bound.deliveryRevision !== deliveryRevision || bound.chatId !== receipt.chatId) return false;
      const row: Correlation = { receiverId, chatId: receipt.chatId, messageId: receipt.messageId, privateChat: !this.deps.provider.presentation.isGroup(receipt.chatId), deliveryRevision,
        bindingGeneration: state.binding.generation, enableGeneration: bound.generation,
        runId: source.snapshot.id, type: source.type, sequence: source.sequence, episodeId: source.episodeId,
        continuation: source.snapshot.continuation, createdAt: this.now(),
        ...(source.snapshot.attentionRequest ? { requestId: source.snapshot.attentionRequest.requestId, askedAt: source.snapshot.attentionRequest.askedAt } : {}) };
      // While disabled only the receipt is kept: its stale generation never routes a Reply, and after Enable it means "already sent".
      if (!bound.enabled && !deliveryReceipt(row)) return false;
      state.correlations = state.correlations.filter(row => row.chatId !== receipt.chatId || row.messageId !== receipt.messageId);
      state.correlations.push(row);
      return true;
    });
  }
  activity(raw: z.input<typeof chatInboundActivityQuerySchema>): z.infer<typeof chatInboundActivityResponseSchema> {
    const input = chatInboundActivityQuerySchema.parse(raw);
    if (this.reason()) return { entries: [] };
    const entries = [...new Set([...this.bots.keys(), ...this.snapshots.keys()])].flatMap(id => this.snapshot(id)?.journal ?? [])
      .filter(entry => entry.state !== 'claimed' && (!input.receiverId || input.receiverId === entry.receiverId))
      .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    const start = input.before ? entries.findIndex(entry => entry.id === input.before) + 1 : 0;
    if (input.before && !start) throw new ChatInboundFailure(400, 'invalid_cursor');
    const page = entries.slice(start, start + input.limit);
    return chatInboundActivityResponseSchema.parse({ entries: page,
      ...(start + input.limit < entries.length && page.length ? { nextCursor: page.at(-1)!.id } : {}) });
  }
  private async releaseUnusedBot(botId: string): Promise<void> {
    const state = this.bots.get(botId)?.state.snapshot();
    if (!state || state.receivers.length || state.grants.length || this.pairings.hasBot(botId) || this.maintenance.has(botId) || this.damaged.has(botId)) return;
    await this.cleanupOpenedBot(botId); this.deps.changed();
  }
  /** Unbinds a bot this project opened but never kept, so another project can take its lease. */
  private async cleanupOpenedBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) return;
    this.maintenance.add(botId);
    try {
      // Keep ownership until every effect settles; the listed bot can retry via Disconnect.
      if (bot.runtime && !await bot.runtime.stop()) return;
      try {
        await bot.state.drain();
        await this.unbind(botId, bot.lease, bot.state.snapshot().binding);
      } finally {
        this.bots.delete(botId); this.snapshots.delete(botId);
        for (const [receiverId, discoveredBotId] of this.discovered) if (discoveredBotId === botId) this.discovered.delete(receiverId);
        await bot.lease.release();
      }
    } finally { this.maintenance.delete(botId); }
  }
  /** State before binding, as in disconnect. */
  private async unbind(botId: string, lease: BotLease, binding: BotBinding): Promise<void> {
    await unlink(statePath(this.deps.directory, inboundStateFilename(botId))).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await syncDirectory(this.deps.directory);
    await lease.disconnect(binding);
  }
  /** False when the lease is held elsewhere or unbinding failed: the bot is listed so Disconnect can finish it. */
  private async releaseLoaded(botId: string, binding: BotBinding): Promise<boolean> {
    const lease = await this.acquireLease(botId).catch(() => undefined);
    if (!lease) return false;
    try { await lease.validate(binding); await this.unbind(botId, lease, binding); return true; }
    catch { return false; }
    finally { await lease.release().catch(() => undefined); }
  }
  /** Explicit adapter selection only; worker restarts never change durable consent. */
  async setAdapterEnabled(enabled: boolean): Promise<void> {
    await this.replaceTransport(false);
    for (const botId of new Set([...this.snapshots.keys(), ...this.bots.keys()])) {
      const bot = await this.open(botId, false, true);
      this.maintenance.add(botId);
      try { await setAdapterSuspension(bot.state, enabled, this.now()); }
      finally { this.maintenance.delete(botId); }
    }
    this.deps.changed();
  }
  /** Replace implementation only: retain ownership, grants and journal generations. */
  replaceTransport(available: boolean): Promise<void> {
    this.transportPaused = true;
    const generation = ++this.transportGeneration;
    const operation = this.transportChanges.then(async () => {
      for (const bot of this.bots.values()) {
        if (bot.runtime && !await bot.runtime.stop()) throw new ChatInboundFailure(409, 'bot_busy');
        await bot.starting?.catch(() => undefined);
        await bot.state.drain();
        bot.runtime = undefined;
      }
      if (this.closed || generation !== this.transportGeneration || !available) return;
      this.transportPaused = false;
      await this.start();
    });
    this.transportChanges = operation.catch(() => undefined);
    return operation;
  }
  async dispose(): Promise<void> {
    this.closed = true;
    // Closing the service invalidates transport guards. Mark every runtime closed before
    // yielding, so deliberate teardown cannot be recorded as a durable operational failure.
    const stopping = Promise.allSettled([...this.bots.values()].map(bot => bot.runtime?.stop()));
    await Promise.allSettled([...this.opening.values(), ...this.resets, this.transportChanges]); await this.setup.settled();
    await stopping;
    await Promise.allSettled([...this.bots.values()].map(async bot => {
      if (bot.runtime && !await bot.runtime.stop()) return;
      // A replacement awaiting stop rejects at the closed service gate; let it settle
      // before releasing ownership. A timed-out runtime above still retains its lease.
      await bot.starting?.catch(() => undefined);
      await bot.state.drain(); await bot.lease.release();
    }));
  }
}
