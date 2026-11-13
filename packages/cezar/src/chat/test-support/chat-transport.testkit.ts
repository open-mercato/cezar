/** The generic ChatTransport fake that shared-core suites drive; no provider wire format reaches them. */
import { ChatTransportError, type ChatEvent, type ChatMessage, type ChatReceipt, type ChatTransport } from '../provider.ts';
import type { ChatConnection, ChatConnectionOptions, ChatHealth } from '../connection.ts';

export interface FakeChatTransportOptions {
 botId: string; username?: string;
 isGroup(chatId: string): boolean;
 identify?(signal?: AbortSignal): Promise<void>;
 send?(chatId: string, message: ChatMessage): ChatReceipt | Promise<ChatReceipt>;
 isMember?(chatId: string, userId: string): boolean | undefined | Promise<boolean | undefined>;
}
export class FakeChatConnection implements ChatConnection {
 private state: ChatHealth = { state: 'stopped' };
 constructor(readonly options: ChatConnectionOptions, private readonly valid: () => boolean) {}
 private update(state: ChatHealth['state']) { this.state = { state, ...(state === 'polling' ? { lastSuccessfulPollAt: Date.now() } : {}) }; this.options.onHealth(this.state); }
 start() { setTimeout(() => { if (this.state.state === 'stopped') this.update('polling'); }, 0); }
 /** A closing core drops the fence first; the core must not persist that as a fatal stop. */
 async stop() { if (!this.valid()) this.update('blocked'); this.state = { state: 'stopped' }; }
 health() { return this.state; }
 /** One platform event, behind the checks every shipped receive loop applies first. */
 async accept(event: ChatEvent) { await this.options.assertCredentials(); if (!this.valid()) throw new ChatTransportError({ kind: 'blocked' }); await this.options.accept(event); }
 /** A frame with no event: all it can do is find the wire fence gone. */
 pulse() { if (!this.valid()) this.update('blocked'); }
 fail(state: 'conflict' | 'credentials-unavailable' | 'blocked') { this.update(state); }
}
export function fakeChatTransport(input: FakeChatTransportOptions) {
 const connections: FakeChatConnection[] = [];
 const build = (valid: () => boolean): ChatTransport => ({
  async identify(signal) { await input.identify?.(signal); return { id: input.botId, username: input.username ?? input.botId }; },
  async inspect(chatId) { return { id: chatId, kind: input.isGroup(chatId) ? 'group' : 'private', eligible: true }; },
  async send(chatId, message, _signal, check) {
   if (!valid() || check?.() === false) throw new ChatTransportError({ kind: 'blocked' });
   return await input.send?.(chatId, message) ?? { chatId, messageId: '1700000000.000001' };
  },
  async clearButtons() {}, async acknowledge() {},
  async isMember(chatId, userId) { return input.isMember ? input.isMember(chatId, userId) : true; },
  guarded: check => build(() => valid() && check()),
  connect(_journal, options) { const connection = new FakeChatConnection(options, valid); connections.push(connection); return connection; },
 });
 return { transport: build(() => true), connections };
}
