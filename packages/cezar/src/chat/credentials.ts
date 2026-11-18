import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SecretStore, type SecretScopeRef } from '../workspace/secrets.ts';
export const chatSecretRefSchema = z.strictObject({
 name: z.string().regex(/^WEBHOOK_CHAT_(?:DRY_)?[A-F0-9]{32}_[A-F0-9]{32}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ChatSecretRef = z.infer<typeof chatSecretRefSchema>;
export class ChatSecretError extends Error { constructor() { super('Chat credentials are unavailable or changed.'); } }
export class ChatSecretReadError extends ChatSecretError {}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Project-only encrypted credential blobs. Providers get decoded values, never this store. */
export class ChatSecrets {
 constructor(private readonly scope: Extract<SecretScopeRef, { kind: 'project' }>, private readonly store = new SecretStore(), private readonly dryRun = false) {}
 async save(receiverId: string, value: string): Promise<ChatSecretRef> {
  try {
   z.string().min(1).max(32768).parse(value);
   const name = `WEBHOOK_CHAT_${this.dryRun ? 'DRY_' : ''}${receiverId.replaceAll('-', '').toUpperCase()}_${randomUUID().replaceAll('-', '').toUpperCase()}`;
   const ref = chatSecretRefSchema.parse({ name, sha256: digest(value) });
   const existing = await this.store.read(this.scope);
   if (existing.skipped && !existing.foreignRoot) throw new ChatSecretError();
   await this.store.set(this.scope, ref.name, value, ['cezar']);
   await this.read(ref); return ref;
  } catch { throw new ChatSecretError(); }
 }
 async read(ref: ChatSecretRef): Promise<string> {
  let read: Awaited<ReturnType<SecretStore['read']>>;
  try { read = await this.store.read(this.scope); } catch { throw new ChatSecretReadError(); }
  if (read.skipped && !read.foreignRoot) throw new ChatSecretReadError();
  const entry = read.values[ref.name];
  if (!entry || entry.audiences.length !== 1 || entry.audiences[0] !== 'cezar' || digest(entry.value) !== ref.sha256) throw new ChatSecretError();
  return entry.value;
 }
 async remove(ref: ChatSecretRef): Promise<void> {
  try { if (!(await this.store.read(this.scope)).skipped) await this.store.unset(this.scope, ref.name); } catch { /* An unused encrypted entry is safer than deleting live credentials. */ }
 }
}

/** Canonical multi-field credential envelope. The single `token` representation stays unchanged. */
export function encodeChatCredentials(fields: readonly { name: string; pattern?: RegExp; optional?: boolean }[], values: Record<string, string>): string {
 const entries = fields.filter(field => !field.optional || values[field.name] !== undefined).map(field => {
  const value = values[field.name];
  if (!value || value.length > 4096 || (field.pattern && !new RegExp(field.pattern.source, field.pattern.flags.replace(/[gy]/g, '')).test(value))) throw new ChatSecretError();
  return [field.name, value] as const;
 });
 if (!entries.length || new Set(entries.map(([name]) => name)).size !== entries.length || Object.keys(values).some(name => !fields.some(field => field.name === name))) throw new ChatSecretError();
 return entries.length === 1 && entries[0]![0] === 'token' ? entries[0]![1] : JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))));
}
export function decodeChatCredentials(fields: readonly { name: string; pattern?: RegExp; optional?: boolean }[], value: string): Record<string, string> {
 try {
  const values = fields.length === 1 && fields[0]!.name === 'token' ? { token: value } : z.record(z.string(), z.string()).parse(JSON.parse(value));
  encodeChatCredentials(fields, values); return values;
 } catch { throw new ChatSecretError(); }
}
