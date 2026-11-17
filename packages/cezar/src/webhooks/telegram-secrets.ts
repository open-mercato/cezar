import { telegramBotTokenSchema, telegramSendMessagePath } from '@open-mercato/cezar-contract';
import { SecretStore, type SecretScopeRef } from '../workspace/secrets.ts';
import { ChatSecrets, ChatSecretReadError, type ChatSecretRef } from '../chat/credentials.ts';
export const TELEGRAM_ORIGIN = 'https://api.telegram.org';
export const telegramToken = (url: string): string | undefined => telegramSendMessagePath.exec(new URL(url).pathname)?.[1];
export type TelegramSecretRef = ChatSecretRef;
export class TelegramSecretError extends Error {
 constructor() { super('Telegram token is unavailable or changed in the secret store. Edit this receiver, paste its bot token and test it again.'); }
}
export class TelegramSecretReadError extends TelegramSecretError {}
/** Telegram's credential codec; storage, audience, fingerprint and scope guarantees are shared. */
export class TelegramSecrets {
 private readonly credentials: ChatSecrets;
 constructor(scope: Extract<SecretScopeRef, { kind: 'project' }>, store = new SecretStore(), dryRun = false) { this.credentials = new ChatSecrets(scope, store, dryRun); }
 async save(receiverId: string, url: string): Promise<TelegramSecretRef> {
  try {
   const parsed = new URL(url), token = telegramBotTokenSchema.parse(telegramToken(url));
   if (parsed.origin !== TELEGRAM_ORIGIN || parsed.search || parsed.hash || parsed.username || parsed.password) throw new TelegramSecretError();
   const ref = await this.credentials.save(receiverId, token); await this.url(ref); return ref;
  } catch { throw new TelegramSecretError(); }
 }
 async url(ref: TelegramSecretRef): Promise<string> {
  try { return `${TELEGRAM_ORIGIN}/bot${telegramBotTokenSchema.parse(await this.credentials.read(ref))}/sendMessage`; }
  catch (error) { throw error instanceof ChatSecretReadError ? new TelegramSecretReadError() : new TelegramSecretError(); }
 }
 remove(ref: TelegramSecretRef): Promise<void> { return this.credentials.remove(ref); }
}
