import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { telegramBotTokenSchema, telegramSendMessagePath } from '@open-mercato/cezar-contract';
import { SecretStore, type SecretScopeRef } from '../workspace/secrets.ts';

/** Only Telegram credentials use the vault; the other receiver formats keep their storage. */
export const TELEGRAM_ORIGIN = 'https://api.telegram.org';
/** The bot token in a `…/bot<token>/sendMessage` receiver URL; throws on a malformed URL, like `new URL`. */
export const telegramToken = (url: string): string | undefined => telegramSendMessagePath.exec(new URL(url).pathname)?.[1];
export const telegramSecretRefSchema = z.strictObject({
  name: z.string().regex(/^WEBHOOK_TELEGRAM_(?:DRY_)?[A-F0-9]{32}_[A-F0-9]{32}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TelegramSecretRef = z.infer<typeof telegramSecretRefSchema>;
export class TelegramSecretError extends Error {
  constructor() { super('Telegram token is unavailable or changed in the secret store. Edit this receiver, paste its bot token and test it again.'); }
}
/** The vault itself could not be read (I/O, keychain, skipped store): retry later, never treat as revoked. */
export class TelegramSecretReadError extends TelegramSecretError {}
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export class TelegramSecrets {
  constructor(private readonly scope: Extract<SecretScopeRef, { kind: 'project' }>, private readonly store = new SecretStore(), private readonly dryRun = false) {}

  async save(receiverId: string, url: string): Promise<TelegramSecretRef> {
    try {
      const parsed = new URL(url);
      const token = telegramBotTokenSchema.parse(telegramToken(url));
      if (parsed.origin !== TELEGRAM_ORIGIN || parsed.search || parsed.hash || parsed.username || parsed.password) throw new TelegramSecretError();
      // New immutable slot per edit: a crash before publishing endpoints must not rotate
      // the credential of the previous, still-active configuration.
      const name = `WEBHOOK_TELEGRAM_${this.dryRun ? 'DRY_' : ''}${receiverId.replaceAll('-', '').toUpperCase()}_${randomUUID().replaceAll('-', '').toUpperCase()}`;
      const ref = telegramSecretRefSchema.parse({ name, sha256: digest(token) });
      // Do not let a missing key/corrupt store turn a credential edit into replacing
      // other project secrets with a fresh store. Repair remains explicit.
      const existing = await this.store.read(this.scope);
      if (existing.skipped && !existing.foreignRoot) throw new TelegramSecretError();
      await this.store.set(this.scope, ref.name, token, ['cezar']);
      // Verify before removing the plaintext from the registry. Never fall back to it.
      await this.url(ref);
      return ref;
    } catch { throw new TelegramSecretError(); }
  }

  async url(ref: TelegramSecretRef): Promise<string> {
    let read: Awaited<ReturnType<SecretStore['read']>>;
    // Exact project scope: no workspace fallback or environment-variable export.
    try { read = await this.store.read(this.scope); } catch { throw new TelegramSecretReadError(); }
    // Another root's store is a permanent mismatch, not a read failure.
    if (read.skipped && !read.foreignRoot) throw new TelegramSecretReadError();
    try {
      const entry = read.values[ref.name];
      if (!entry || entry.audiences.length !== 1 || entry.audiences[0] !== 'cezar') throw new TelegramSecretError();
      const token = telegramBotTokenSchema.parse(entry.value);
      // Editing the vault directly must not silently retarget already queued deliveries.
      if (digest(token) !== ref.sha256) throw new TelegramSecretError();
      return `${TELEGRAM_ORIGIN}/bot${token}/sendMessage`;
    } catch { throw new TelegramSecretError(); }
  }

  async remove(ref: TelegramSecretRef): Promise<void> {
    // After registry publication only. Failure can leave an unused encrypted entry,
    // never remove the credential of a live configuration or fail the whole service.
    try {
      if ((await this.store.read(this.scope)).skipped) return;
      await this.store.unset(this.scope, ref.name);
    } catch { /* Keep the unused encrypted entry if the vault is unavailable. */ }
  }
}
