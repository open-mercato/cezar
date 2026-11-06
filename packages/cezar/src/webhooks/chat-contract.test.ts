import { describe, expect, it } from 'vitest';
import { createWebhookSchema, updateWebhookSchema } from '@open-mercato/cezar-contract';
const slack = 'https://hooks.slack.com/services/T1/B1/test';
const discord = `https://discord.com/api/webhooks/123456789012345678/${'x'.repeat(68)}`;
describe('chat receiver contract', () => {
  it('preserves the old custom default', () => {
    expect(createWebhookSchema.parse({ name: 'Old', url: 'http://localhost/hook' }).format).toBe('cezar.json.v1');
  });
  it.each([['slack.v1', slack], ['discord.v1', discord]])('accepts %s and rejects mismatches', (format, url) => {
    expect(createWebhookSchema.safeParse({ name: 'Chat', format, url }).success).toBe(true);
    for (const invalid of [url + '?wait=true', url + '#x', url.replace('https:', 'http:'), url.replace('.com/', '.com:443/'), url.replace('.com/', '.com.evil/'), url + '/slack']) {
      expect(createWebhookSchema.safeParse({ name: 'Chat', format, url: invalid }).success, invalid).toBe(false);
    }
    expect(createWebhookSchema.safeParse({ name: 'Chat', format, url, allowLocalNetwork: true }).success).toBe(false);
    expect(createWebhookSchema.safeParse({ name: 'Chat', url }).success).toBe(false);
  });
  it('accepts supported Discord aliases and versioned paths', () => {
    for (const host of ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']) {
      expect(createWebhookSchema.safeParse({ name: 'Chat', format: 'discord.v1', url: discord.replace('discord.com', host).replace('/api/', '/api/v10/') }).success).toBe(true);
    }
  });
  it('permits edits retaining the private URL but validates explicit URLs', () => {
    expect(updateWebhookSchema.safeParse({ name: 'Chat', format: 'slack.v1', expectedRevision: 1 }).success).toBe(true);
    expect(updateWebhookSchema.safeParse({ name: 'Chat', format: 'discord.v1', url: slack, expectedRevision: 1 }).success).toBe(false);
  });
  describe('telegram', () => {
    const telegram = `https://api.telegram.org/bot123456789:${'A'.repeat(35)}/sendMessage`;
    const base = { name: 'Chat', format: 'telegram.v1', url: telegram, telegramChatId: '-1001234567890' };
    it('accepts a bot sendMessage URL with a chat ID', () => {
      expect(createWebhookSchema.safeParse(base).success).toBe(true);
      expect(createWebhookSchema.safeParse({ ...base, telegramChatId: '@cezar_alerts' }).success).toBe(true);
    });
    it('rejects other paths, hosts, queries and local networks', () => {
      for (const url of [telegram + '?chat_id=1', telegram.replace('https:', 'http:'), telegram.replace('.org/', '.org:443/'), telegram.replace('sendMessage', 'getUpdates'),
        telegram.replace('api.telegram.org', 'api.telegram.org.evil'), 'https://api.telegram.org/bot123/sendMessage']) {
        expect(createWebhookSchema.safeParse({ ...base, url }).success, url).toBe(false);
      }
      expect(createWebhookSchema.safeParse({ ...base, allowLocalNetwork: true }).success).toBe(false);
    });
    it('requires a well-formed chat ID only for Telegram', () => {
      const { telegramChatId: _, ...missing } = base;
      expect(createWebhookSchema.safeParse(missing).success).toBe(false);
      for (const id of ['', 'chat', '@abc', '--100', '-1 00']) expect(createWebhookSchema.safeParse({ ...base, telegramChatId: id }).success, id).toBe(false);
      expect(createWebhookSchema.safeParse({ name: 'Chat', format: 'slack.v1', url: slack, telegramChatId: '1' }).success).toBe(false);
    });
    it('points a custom receiver at the Telegram setup', () => {
      const result = createWebhookSchema.safeParse({ name: 'Chat', url: telegram });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('Telegram is set up in Settings → Integrations → Telegram');
    });
    it('lets an edit change the chat ID while retaining the private URL', () => {
      expect(updateWebhookSchema.safeParse({ name: 'Chat', format: 'telegram.v1', telegramChatId: '42', expectedRevision: 1 }).success).toBe(true);
    });
  });
});
