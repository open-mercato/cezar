/** Telegram-shaped fixture for the shared-core suites: a generic ChatTransport fake over a scripted Bot API. No production consumer; the shipped adapter is packages/chat-plugins/telegram. */
import { z } from 'zod';
import { CHAT_COMMANDS, type InputMessage, type InputUpdate } from '../events.ts';
import type { ReceiveJournal } from '../connection.ts';
import { ChatTransportError, type ChatSession, type ChatFailure, type ChatTransport } from '../provider.ts';
import { ChatInbound, type ChatProviderAdapter, type ChatServiceDependencies } from '../service.ts';
import { telegramServiceDescriptor } from '../providers/telegram/index.ts';
export { ChatInboundFailure } from '../service.ts';
type TelegramMethod = 'getMe' | 'getChat' | 'getChatMember' | 'getUpdates' | 'sendMessage' | 'answerCallbackQuery' | 'editMessageReplyMarkup' | 'setMyCommands';
export class TelegramApiError extends Error {
  constructor(readonly code: 'network' | 'policy' | 'dns_not_found' | 'body_limit' | 'invalid_response' | 'http', readonly status?: number, readonly retryAfter?: number) {
    super(`Telegram request failed: ${code}`);
  }
}
export type TelegramCall = (method: TelegramMethod, body: object, signal?: AbortSignal, authorization?: { valid?: () => boolean }) => Promise<unknown>;

const integer = z.number().int().safe();
const person = z.object({ id: integer.positive(), is_bot: z.boolean(), first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(), username: z.string().max(64).optional() });
const chat = z.object({ id: integer.refine(id => id !== 0), type: z.enum(['private', 'group', 'supergroup', 'channel']), title: z.string().max(256).optional(), is_forum: z.boolean().optional() });
const message = z.object({
  message_id: integer.positive(), date: integer.nonnegative(), chat, from: person.optional(), text: z.string().max(65536).optional(),
  entities: z.array(z.object({ type: z.string().max(64), offset: integer.nonnegative(), length: integer.positive() })).max(100).optional(),
  reply_to_message: z.object({ message_id: integer.positive() }).optional(),
  forward_origin: z.unknown().optional(), via_bot: z.unknown().optional(), sender_chat: z.unknown().optional(),
  photo: z.unknown().optional(), document: z.unknown().optional(), video: z.unknown().optional(), audio: z.unknown().optional(),
  voice: z.unknown().optional(), sticker: z.unknown().optional(), animation: z.unknown().optional(),
  message_thread_id: integer.optional(), is_topic_message: z.boolean().optional(),
  migrate_to_chat_id: integer.optional(), migrate_from_chat_id: integer.optional(),
});
const telegramUpdateSchema = z.object({
  update_id: integer.nonnegative().max(Number.MAX_SAFE_INTEGER - 1), message: message.optional(),
  callback_query: z.object({ id: z.string().min(1).max(128), from: person, data: z.string().max(64).optional(),
    message: z.object({ message_id: integer.positive(), chat }).optional() }).optional(),
  my_chat_member: z.object({ chat, new_chat_member: z.object({ status: z.string().max(64) }) }).optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramMessage = NonNullable<TelegramUpdate['message']>;

function eligibleText(message: TelegramMessage, groups = false): boolean {
  return typeof message.text === 'string' && message.from?.is_bot === false
    && (message.chat.type === 'private' || (groups && ['group', 'supergroup'].includes(message.chat.type)))
    && !message.chat.is_forum && !message.is_topic_message && message.message_thread_id === undefined
    && ['forward_origin', 'via_bot', 'sender_chat', 'photo', 'document', 'video', 'audio', 'voice', 'sticker', 'animation']
      .every(key => message[key as keyof TelegramMessage] === undefined);
}
/** The one list of conversation commands: the bot menu, help and routing all read it. */
export const TELEGRAM_COMMANDS = CHAT_COMMANDS;
const conversationCommands: ReadonlySet<string> = new Set(TELEGRAM_COMMANDS.map(row => row.command));
// `start` is parsed for pairing links only; the conversation answers it with help.
const commands = new Set([...conversationCommands, 'start']);
type Command = { kind: 'command'; name: string; args: string } | { kind: 'ignore' | 'text' | 'unknown' };
function parseCommand(message: TelegramMessage, username: string): Command {
  const text = message.text ?? '';
  const entity = message.entities?.find(entity => entity.type === 'bot_command' && entity.offset === 0);
  if (!entity) return text.startsWith('/') ? { kind: 'unknown' } : { kind: 'text' };
  const token = text.slice(0, entity.length);
  const match = /^\/([a-zA-Z0-9_]{1,32})(?:@([a-zA-Z0-9_]{1,64}))?$/.exec(token);
  if (!match || (text.length > entity.length && !/\s/.test(text[entity.length]!))) return { kind: 'unknown' };
  if (match[2] && match[2].toLowerCase() !== username.toLowerCase()) return { kind: 'ignore' };
  const name = match[1]!.toLowerCase();
  return commands.has(name) ? { kind: 'command', name, args: text.slice(entity.length).trim() } : { kind: 'unknown' };
}
export function normalizeMessage(message: TelegramMessage, username: string): InputMessage | undefined {
  if (!eligibleText(message, true)) return undefined;
  const user = message.from!;
  const token = message.text!.slice(0, message.entities?.find(entity => entity.type === 'bot_command' && entity.offset === 0)?.length ?? 0);
  return { id: String(message.message_id), at: message.date * 1000,
    chat: { id: String(message.chat.id), kind: message.chat.type === 'private' ? 'private' : 'group', ...(message.chat.title ? { title: message.chat.title } : {}) },
    user: { id: String(user.id), label: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 256), ...(user.username ? { username: user.username } : {}) },
    pairingEligible: message.chat.type !== 'private' || message.from?.id === message.chat.id, text: message.text!, command: parseCommand(message, username), addressed: token.toLowerCase().endsWith(`@${username.toLowerCase()}`),
    ...(message.reply_to_message ? { replyTo: String(message.reply_to_message.message_id) } : {}) };
}
export function normalizeUpdate(update: TelegramUpdate, username: string): InputUpdate {
  const message = update.message && normalizeMessage(update.message, username);
  const callback = update.callback_query;
  const member = update.my_chat_member, raw = update.message;
  const migration = raw?.migrate_to_chat_id !== undefined || raw?.migrate_from_chat_id !== undefined;
  const affected = new Set<string>();
  if (migration && raw) { affected.add(String(raw.chat.id)); if (raw.migrate_from_chat_id !== undefined) affected.add(String(raw.migrate_from_chat_id)); }
  if (member && (['left','kicked'].includes(member.new_chat_member.status) || member.chat.is_forum)) affected.add(String(member.chat.id));
  return { sequence: update.update_id, ...(message ? { message } : {}),
    ...(callback?.message && !callback.from.is_bot && !callback.message.chat.is_forum ? { button: { id: callback.id, userId: String(callback.from.id), chatId: String(callback.message.chat.id), messageId: String(callback.message.message_id), ...(callback.data ? { data: callback.data } : {}) } } : {}),
    ...(member || migration ? { membership: { affected: [...affected], reason: migration ? 'group_migrated' as const : 'bot_removed' as const } } : {}) };
}


const identity = z.object({ id: z.number().int().positive().safe(), username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) });
const receipt = z.object({ message_id: z.number().int().positive().safe(), chat: z.object({ id: z.number().int().safe() }) });
const membership = z.object({ user: z.object({ id: z.number().int().positive().safe() }), status: z.enum(['creator', 'administrator', 'member', 'restricted', 'left', 'kicked']), is_member: z.boolean().optional() });
function telegramFailure(error: unknown): ChatFailure {
  if (!(error instanceof TelegramApiError)) return { kind: 'blocked' };
  if (error.status === 401) return { kind: 'auth' };
  if (error.status === 409) return { kind: 'conflict' };
  if (error.status === 429) return { kind: 'rate_limited', retryAfterMs: (error.retryAfter ?? 5) * 1000 };
  if (error.status === 403) return { kind: 'gone' };
  return { kind: error.code === 'network' || error.code === 'dns_not_found' || (error.status ?? 0) >= 500 ? 'transient' : 'blocked' };
}
/** The adapter alone sees Telegram method names, numeric IDs, markup and HTTP status codes. */
export function telegramSession(call: TelegramCall): ChatSession {
  const invoke = async (method: Parameters<TelegramCall>[0], body: object, signal?: AbortSignal, valid?: () => boolean) => {
    try { return await (valid ? call(method, body, signal, { valid }) : signal ? call(method, body, signal) : call(method, body)); }
    catch (error) { throw new ChatTransportError(telegramFailure(error)); }
  };
  return {
    async identify(signal) { const me = identity.parse(await invoke('getMe', {}, signal)); return { id: String(me.id), username: me.username }; },
    async send(chatId, message, signal, valid) {
      const result = receipt.parse(await invoke('sendMessage', { chat_id: chatId, text: message.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        ...(message.buttons ? { reply_markup: { inline_keyboard: message.buttons.map(row => row.map(button => ({ text: button.text, callback_data: button.data }))) } } : {}) }, signal, valid));
      return { messageId: String(result.message_id), chatId: String(result.chat.id) };
    },
    async acknowledge(eventId, text, signal) { await invoke('answerCallbackQuery', { callback_query_id: eventId, text }, signal); },
    async clearButtons(receipt, signal) { await invoke('editMessageReplyMarkup', { chat_id: receipt.chatId, message_id: Number(receipt.messageId), reply_markup: { inline_keyboard: [] } }, signal); },
    async isMember(chatId, userId, signal) {
      try {
        const parsed = membership.safeParse(await (signal ? call('getChatMember', { chat_id: chatId, user_id: Number(userId) }, signal) : call('getChatMember', { chat_id: chatId, user_id: Number(userId) })));
        if (!parsed.success || String(parsed.data.user.id) !== userId) return undefined;
        return !['left', 'kicked'].includes(parsed.data.status) && (parsed.data.status !== 'restricted' || parsed.data.is_member === true);
      } catch (error) { return error instanceof TelegramApiError && error.code === 'http' && error.status === 400 ? false : undefined; }
    },
  };
}


type PollerHealth = { state: 'stopped' | 'polling' | 'backoff' | 'conflict' | 'credentials-unavailable' | 'blocked'; lastSuccessfulPollAt?: number };
const batchSchema = z.array(z.object({ update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1) }).passthrough()).max(50);
function retryable(error: TelegramApiError): boolean {
  return error.code === 'network' || error.code === 'dns_not_found' || error.status === 429 || (error.status !== undefined && error.status >= 500);
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, Math.min(ms, 60_000));
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** One loop per leased bot; only the durable offset is sent to Telegram. */
export class TelegramPoller {
  private controller?: AbortController;
  private running?: Promise<void>;
  private current: PollerHealth = { state: 'stopped' };
  constructor(private readonly deps: {
    call: TelegramCall; store: ReceiveJournal;
    process(update: TelegramUpdate, epoch: string): Promise<void>;
    needed(): boolean;
    assertCredentials(): Promise<void>;
    onHealth?(health: PollerHealth): void;
    now?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    allowedUpdates?: readonly string[];
  }) {}
  health(): PollerHealth { return { ...this.current }; }
  start(): void {
    if (this.running) return;
    const controller = new AbortController(); this.controller = controller;
    this.running = this.loop(controller.signal).finally(() => { this.running = undefined; });
  }
  async stop(): Promise<void> { this.controller?.abort(); await this.running; this.setHealth('stopped'); }
  private setHealth(state: PollerHealth['state'], successfulAt?: number): void {
    this.current = { ...this.current, state, ...(successfulAt === undefined ? {} : { lastSuccessfulPollAt: successfulAt }) };
    this.deps.onHealth?.(this.health());
  }
  private async loop(signal: AbortSignal): Promise<void> {
    const now = this.deps.now ?? Date.now;
    let failures = 0, limit = 50, retryAt = 0;
    try {
      await this.deps.store.recover();
      while (!signal.aborted && this.deps.needed()) {
        await this.deps.store.assertReady();
        if (retryAt > now()) { await (this.deps.wait ?? pause)(retryAt - now(), signal); continue; }
        try {
          try { await this.deps.assertCredentials(); } catch { this.setHealth('credentials-unavailable'); return; }
          if (signal.aborted || !this.deps.needed()) break;
          await this.deps.store.prepareReceive(now(), 6 * 86400_000);
          const snapshot = await this.deps.store.snapshot();
          this.setHealth('polling');
          const raw = await this.deps.call('getUpdates', { timeout: 25, limit, allowed_updates: this.deps.allowedUpdates ?? ['message'],
            ...(snapshot.nextOffset === null ? {} : { offset: snapshot.nextOffset }) }, signal);
          if (signal.aborted) break;
          await this.deps.store.assertReady();
          const batch = batchSchema.parse(raw);
          // Telegram orders updates; fail closed on an invalid batch rather than acknowledging unseen data.
          if (batch.some((update, index) => index > 0 && update.update_id <= batch[index - 1]!.update_id)) throw new Error('Unordered update batch');
          this.setHealth('polling', now()); failures = 0; limit = 50;
          if (batch.length) await this.deps.store.touch(now());
          try {
            for (const rawUpdate of batch) {
              if (signal.aborted || !this.deps.needed()) break;
              if (await this.deps.store.duplicate(snapshot.epoch, rawUpdate.update_id)) continue;
              const update = telegramUpdateSchema.safeParse(rawUpdate);
              if (update.success) await this.deps.process(update.data, snapshot.epoch);
              else await this.deps.store.finish(snapshot.epoch, rawUpdate.update_id);
            }
          } finally {
            // One durable write per batch for ignored/stranger updates; Telegram replays an unflushed tail.
            if (batch.length) await this.deps.store.flush();
          }
        } catch (error) {
          if (signal.aborted) break;
          await this.deps.store.assertReady();
          if (!(error instanceof TelegramApiError)) { this.setHealth('blocked'); return; }
          if (error.code === 'body_limit') {
            if (limit === 1) { this.setHealth('blocked'); return; }
            limit = 1; continue;
          }
          if (error.status === 401) { this.setHealth('credentials-unavailable'); return; }
          if (error.status === 409) { this.setHealth('conflict'); return; }
          if (!retryable(error)) {
            this.setHealth('blocked'); return;
          }
          failures++;
          const delay = error.status === 429 ? (error.retryAfter ?? 5) * 1000
            : Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)) * (0.8 + Math.random() * 0.2);
          retryAt = now() + delay; this.setHealth('backoff');
        }
      }
      this.setHealth('stopped');
    } catch { if (!signal.aborted) this.setHealth('blocked'); }
  }
}
const chatSchema = z.object({ id: z.number().int().safe(), type: z.enum(['private', 'group', 'supergroup', 'channel']), is_forum: z.boolean().optional() });
export function telegramTransport(call: TelegramCall, identity = { username: '' }): ChatTransport {
 const session = telegramSession(call);
 return {
  ...session,
  guarded(valid) { return telegramTransport((method, body, signal, authorization) => call(method, body, signal, { valid: () => valid() && (authorization?.valid?.() ?? true) }), identity); },
  async identify(signal) { const me = await session.identify(signal); identity.username = me.username;
   return me; },
  async inspect(chatId) { try { const chat = chatSchema.safeParse(await call('getChat', { chat_id: chatId }));
   return chat.success ? { id: String(chat.data.id), kind: chat.data.type === 'private' ? 'private' : 'group', eligible: ['private','group','supergroup'].includes(chat.data.type) && !chat.data.is_forum } : { id: chatId, kind: 'group', eligible: false }; } catch (error) { throw new ChatTransportError(telegramFailure(error)); } },
  connect(journal, options, now) {
   const controller = new AbortController();
   const menu = call('setMyCommands', { commands: TELEGRAM_COMMANDS }, controller.signal).catch(() => undefined);
   const poller = new TelegramPoller({ ...options, call, store: journal, now, allowedUpdates: ['message','callback_query','my_chat_member'], process: (update, epoch) => options.process(normalizeUpdate(update, identity.username), epoch) });
   return {
    start: () => poller.start(),
    health: () => poller.health(),
    async stop() {
     // Ownership may be released only after all connection work settles, including the menu.
     controller.abort();
     await Promise.all([poller.stop(), menu]);
    },
   };
  },
 };
}

interface TelegramAdapterDependencies { call(receiverId: string): TelegramCall; callToken?(credential: string): TelegramCall }
/** Providers get only a transport, never the project dependency object; calls stay live. */
function telegramAdapter(deps: TelegramAdapterDependencies): ChatProviderAdapter {
  return {
    provider: telegramServiceDescriptor,
    transport: id => telegramTransport(deps.call(id)),
    get credentialTransport() { return deps.callToken ? (credential: string) => telegramTransport(deps.callToken!(credential)) : undefined; },
  };
}

type TelegramServiceDependencies = Omit<ChatServiceDependencies, 'provider' | 'transport' | 'credentialTransport'> & TelegramAdapterDependencies;
export class TelegramInbound extends ChatInbound {
  // Suites rotate dependencies in place, so reads stay live here; production composes once.
  constructor(deps: TelegramServiceDependencies) {
    const adapter = telegramAdapter(deps);
    super(new Proxy(deps, { get: (target, key) => key in adapter ? adapter[key as keyof ChatProviderAdapter] : Reflect.get(target, key) }) as unknown as ChatServiceDependencies);
  }
}
/** One shared instance: `connect` needs the username its own `identify` learned. */
export const telegramSeam = (call: TelegramCall) => { const transport = telegramTransport(call); return () => transport; };
type ScriptedRequest = (url: string, options: { body: string; signal: AbortSignal }) => Promise<{ statusCode: number; body: AsyncIterable<Uint8Array> }>;
/** The credential and DNS waits a real client makes before its last authorization check. */
export function scriptedTelegramCall(input: { request: ScriptedRequest; token(): Promise<string>; lookup?(): Promise<unknown> }): TelegramCall {
  return async (method, body, signal, authorization) => {
    await input.token(); await input.lookup?.();
    if (authorization?.valid && !authorization.valid()) throw new TelegramApiError('policy');
    const response = await input.request(`https://api.telegram.org/bot/${method}`, { body: JSON.stringify(body), signal: signal ?? new AbortController().signal });
    const chunks: Uint8Array[] = []; for await (const chunk of response.body) chunks.push(chunk);
    return (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { result: unknown }).result;
  };
}
