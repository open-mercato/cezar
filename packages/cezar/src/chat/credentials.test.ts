import { it, expect } from 'vitest';
import { encodeChatCredentials, decodeChatCredentials } from './credentials.ts';
it('roundtrips declared multiple credentials canonically without adding agent-visible fields', () => {
 const fields = [{ name: 'bot', pattern: /^bot-/ }, { name: 'app', pattern: /^app-/ }];
 const encoded = encodeChatCredentials(fields, { bot: 'bot-synthetic', app: 'app-synthetic' });
 expect(encoded).toBe('{"app":"app-synthetic","bot":"bot-synthetic"}');
 expect(decodeChatCredentials(fields, encoded)).toEqual({ bot: 'bot-synthetic', app: 'app-synthetic' });
 expect(() => encodeChatCredentials(fields, { bot: 'bot-synthetic' })).toThrow('Chat credentials are unavailable or changed.');
 expect(() => decodeChatCredentials(fields, '{"bot":"secret-not-for-errors"}')).toThrow('Chat credentials are unavailable or changed.');
 expect(() => encodeChatCredentials(fields, { bot: 'bot-synthetic', app: 'app-synthetic', extra: 'unexpected' })).toThrow();
});
it('preserves the single-token credential encoding', () => {
 expect(encodeChatCredentials([{ name: 'token' }], { token: 'synthetic-token' })).toBe('synthetic-token');
 expect(decodeChatCredentials([{ name: 'token' }], 'synthetic-token')).toEqual({ token: 'synthetic-token' });
});
