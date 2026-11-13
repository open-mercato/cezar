import { expect, it, vi } from 'vitest';
import { ChatTransportError, type ChatTransport } from '../chat/provider.ts';
import { sendChatNotification, chatReceipt } from './transport.ts';
it('captures only the verified chat receipt and never includes provider responses', async () => {
 const send = vi.fn().mockResolvedValue({ chatId: 'discord:dm:123', messageId: '456' });
 const result = await sendChatNotification({ send } as unknown as ChatTransport, 'discord:dm:123', 'hello');
 expect(result).toEqual({ kind: 'http', status: 200 });
 expect(chatReceipt(result)).toEqual({ chatId: 'discord:dm:123', messageId: '456' });
 send.mockResolvedValue({ chatId: 'discord:guild:789:123', messageId: '456' });
 expect(await sendChatNotification({ send } as unknown as ChatTransport, 'discord:dm:123', 'hello')).toEqual({ kind: 'transient', reason: 'invalid_receipt' });
});
it.each(['auth', 'gone', 'rate_limited', 'transient', 'blocked', 'conflict'] as const)('classifies %s without leaking credentials or retrying a webhook', async kind => {
 const send = vi.fn().mockRejectedValue(new ChatTransportError({ kind, retryAfterMs: 2000 }));
 const result = await sendChatNotification({ send } as unknown as ChatTransport, 'private:TTEAM:UBOT:DCHAN', 'hello');
 expect(send).toHaveBeenCalledTimes(1);
 expect(result).toEqual(kind === 'auth' || kind === 'gone' ? { kind: 'http', status: 410, providerGone: true }
 : kind === 'rate_limited' ? { kind: 'http', status: 429, retryAfter: '2' }
 : kind === 'blocked' || kind === 'conflict' ? { kind: 'policy', reason: 'chat_blocked' } : { kind: 'transient', reason: 'transport_failed' });
});
