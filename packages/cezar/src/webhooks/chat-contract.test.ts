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
});
