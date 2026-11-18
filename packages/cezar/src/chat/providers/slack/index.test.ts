import { expect, it } from 'vitest';
import { bundledChatProvider } from '../../bundled.ts';

// An installed `slack` replacement without slack-oauth-v1 gets this credential (chat-registration.ts).
it('never hands refresh tokens or the Client Secret to an adapter', () => {
 const stored = JSON.stringify({ appToken: 'xoxe.xapp-original-token', botToken: 'xoxe.xoxb-original-token', appRefreshToken: 'xoxe-app-refresh', botRefreshToken: 'xoxe-bot-refresh', clientId: '123.456', clientSecret: 'a'.repeat(32) });
 const credential = bundledChatProvider('slack')!.adapterCredential!(stored);
 expect(JSON.parse(credential)).toEqual({ appToken: 'xoxe.xapp-original-token', botToken: 'xoxe.xoxb-original-token' });
 expect(credential).not.toMatch(/refresh|a{32}|123\.456/);
});
