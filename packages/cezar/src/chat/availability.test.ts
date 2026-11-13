import { describe, expect, it } from 'vitest';
import { chatNotificationsUnavailableReason, chatUnavailableReason } from './availability.ts';

// Spec 2026-11-12-hosted-extensions: a hosted cockpit runs chat only with CEZ_REMOTE_EXTENSIONS=1.
describe('chat availability across mode and flags', () => {
  const cases = [] as { mode: 'local' | 'hosted'; remote: boolean; webhooks: boolean; inbound: boolean }[];
  for (const mode of ['local', 'hosted'] as const) for (const remote of [false, true]) for (const webhooks of [false, true]) for (const inbound of [false, true]) cases.push({ mode, remote, webhooks, inbound });
  it.each(cases)('%o', ({ mode, remote, webhooks, inbound }) => {
    const env = { ...(remote ? { CEZ_REMOTE_EXTENSIONS: '1' } : {}), CEZ_WEBHOOKS: webhooks ? '1' : '0', CEZ_CHAT_INBOUND: inbound ? '1' : '0' };
    const notifications = mode === 'hosted' && !remote ? 'hosted' : !webhooks ? 'webhooks_off' : undefined;
    expect(chatNotificationsUnavailableReason(mode, env)).toBe(notifications);
    expect(chatUnavailableReason(mode, env)).toBe(notifications ?? (inbound ? undefined : 'flag_off'));
  });
  it('an explicit runtime decision wins over the environment', () => {
    const env = { CEZ_REMOTE_EXTENSIONS: '1', CEZ_WEBHOOKS: '1', CEZ_CHAT_INBOUND: '1' };
    expect(chatUnavailableReason('hosted', env, false)).toBe('hosted');
    expect(chatUnavailableReason('hosted', { CEZ_WEBHOOKS: '1', CEZ_CHAT_INBOUND: '1' }, true)).toBeUndefined();
  });
});
