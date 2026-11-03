import { createHash, randomBytes, randomUUID, randomInt } from 'node:crypto';
import type { TelegramMessage } from './protocol.ts';
import { eligibleText, freshMessage, parseCommand } from './protocol.ts';

export interface PairingSession {
  id: string; receiverId: string; botId: string; chatId: string; receiverChatId: string; deliveryRevision: number; allowGroup?: boolean;
  createdAt: number; expiresAt: number; hash: string; candidate?: { userId: string; chatId: string; chatType: 'private' | 'group'; label: string; username?: string; comparisonCode?: string; chatTitle?: string };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class Pairings {
  private readonly sessions = new Map<string, PairingSession>();
  /** Keep expired ids briefly so the HTTP status can distinguish expiry from an unknown id. */
  private readonly expired = new Map<string, PairingSession>();
  constructor(private readonly now: () => number = Date.now) {}
  prune(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) {
      this.sessions.delete(id); this.expired.set(id, session);
    }
    for (const [id, session] of this.expired) if (session.expiresAt + 300_000 <= now) this.expired.delete(id);
  }
  create(input: Pick<PairingSession, 'receiverId' | 'botId' | 'chatId' | 'deliveryRevision' | 'allowGroup'>, username: string): { session: PairingSession; deepLink: string } {
    this.prune();
    if (this.sessions.size >= 3) throw new Error('pairing_limit');
    if (!/^[A-Za-z0-9_]{1,64}$/.test(username)) throw new Error('invalid_bot_username');
    const code = randomBytes(24).toString('base64url');
    const session: PairingSession = { ...input, receiverChatId: input.chatId, id: randomUUID(), createdAt: this.now(), expiresAt: this.now() + 300_000, hash: hash(code) };
    this.expired.delete(session.id); this.sessions.set(session.id, session);
    return { session: structuredClone(session), deepLink: `https://t.me/${username}?start=${code}` };
  }
  get(id: string): PairingSession | undefined { this.prune(); const session = this.sessions.get(id); return session ? structuredClone(session) : undefined; }
  hasBot(botId: string): boolean { this.prune(); return [...this.sessions.values()].some(session => session.botId === botId); }
  hasReceiver(receiverId: string): boolean { this.prune(); return [...this.sessions.values()].some(session => session.receiverId === receiverId); }
  cancel(id: string): void { this.sessions.delete(id); this.expired.delete(id); }
  cancelBot(botId: string): void { for (const session of this.sessions.values()) if (session.botId === botId) this.sessions.delete(session.id); }
  cancelReceiver(receiverId: string): void { for (const session of this.sessions.values()) if (session.receiverId === receiverId) this.sessions.delete(session.id); }
  retarget(id: string, receiverId: string, chatId: string, deliveryRevision: number): void {
    const session = this.sessions.get(id); if (!session) return;
    session.receiverId = receiverId; session.chatId = chatId; session.receiverChatId = chatId; session.deliveryRevision = deliveryRevision;
  }
  wasExpired(id: string): PairingSession | undefined { this.prune(); const session = this.expired.get(id); return session ? structuredClone(session) : undefined; }
  comparisonCode(botId: string, username: string, message: TelegramMessage): string | undefined {
    const command = parseCommand(message, username);
    if (command.kind !== 'command' || command.name !== 'start') return undefined;
    this.prune();
    return [...this.sessions.values()].find(session => session.botId === botId && session.hash === hash(command.args)
      && session.candidate?.userId === String(message.from?.id))?.candidate?.comparisonCode;
  }
  accept(botId: string, username: string, message: TelegramMessage): 'candidate' | 'wrong_chat' | 'ignored' {
    this.prune();
    const command = parseCommand(message, username);
    if (command.kind !== 'command' || command.name !== 'start' || !/^[A-Za-z0-9_-]{32}$/.test(command.args)) return 'ignored';
    const digest = hash(command.args);
    const session = [...this.sessions.values()].find(session => session.botId === botId && session.hash === digest);
    if (!session || !freshMessage(message.date, session.createdAt, this.now())) return 'ignored';
    if (!eligibleText(message, session.allowGroup)) return 'ignored';
    const user = message.from!;
    const group = message.chat.type === 'group' || message.chat.type === 'supergroup';
    // Only token-led setup starts with a pending chat. Existing receiver pairings
    // remain private-only; the pending session is the explicit authorization for
    // discovering a group from its first /start message.
    if (message.chat.type !== 'private' && !(group && session.allowGroup)) return 'ignored';
    if (!group && message.chat.id !== user.id) return 'ignored';
    if (group && session.chatId !== 'pending') return 'ignored';
    if (session.chatId !== 'pending' && !session.chatId.startsWith('-') && String(user.id) !== session.chatId) return 'wrong_chat';
    if (session.candidate && session.candidate.userId !== String(user.id)) return 'ignored';
    if (group) {
      session.chatId = String(message.chat.id);
      session.receiverChatId = session.chatId;
    } else if (session.chatId === 'pending') {
      session.chatId = String(message.chat.id);
      session.receiverChatId = session.chatId;
    }
    const privateConfirmation = message.chat.type === 'private' && session.chatId.startsWith('-');
    // The member's private confirmation keeps the title the group's own /start revealed.
    const chatTitle = group ? message.chat.title?.slice(0, 256) : privateConfirmation ? session.candidate?.chatTitle : undefined;
    session.candidate = { userId: String(user.id), chatId: String(message.chat.id), chatType: group ? 'group' : 'private', label: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 256),
      ...(user.username ? { username: user.username } : {}), ...(chatTitle ? { chatTitle } : {}),
      // A token-led group setup may begin with /start in the group so that
      // notifications can be configured. Do not create (or disclose) the
      // comparison code until that same member proves their private chat.
      ...(privateConfirmation ? { comparisonCode: session.candidate?.comparisonCode ?? String(randomInt(0, 1000000)).padStart(6, '0') } : {}) };
    return 'candidate';
  }
}
