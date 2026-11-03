import { afterEach, describe, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('undici', () => ({ Agent: class { async destroy() {} }, request }));
import * as transport from './transport.ts';
const token = '123456789:' + 'A'.repeat(35);
const input = { url: `https://api.telegram.org/bot${token}/sendMessage`, body: JSON.stringify({ chat_id: '456', text: 'private message' }),
  format: 'telegram.v1' as const, eventId: 'evt_123', secrets: [], policy: { mode: 'local' as const, allowLocalNetwork: false, serverPorts: [] } };
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
function response(value: unknown) {
  return { statusCode: 200, headers: {}, body: Object.assign((async function* () { yield Buffer.from(JSON.stringify(value)); })(), { once() {}, destroy() {} }) };
}
afterEach(() => vi.clearAllMocks());
describe('Telegram receipt capture without changing delivery', () => {
  it('retains only validated IDs outside serializable diagnostics', async () => {
    request.mockResolvedValue(response({ ok: true, result: { message_id: 5, chat: { id: 456 }, text: 'private message' } }));
    const result = await transport.sendWebhook(input, { lookup });
    expect(result).toEqual({ kind: 'http', status: 200 });
    expect(transport.telegramReceipt(result)).toEqual({ messageId: 5, chatId: '456' });
    expect(JSON.stringify(result)).not.toContain('private message');
  });
  it.each([
    {}, { ok: false, result: { message_id: 5, chat: { id: 456 } } },
    { ok: true, result: { message_id: -1, chat: { id: 456 } } },
    { ok: true, result: { message_id: 5, chat: { id: 999 } } },
  ])('keeps success with no correlation for invalid receipt %j', async value => {
    request.mockResolvedValue(response(value));
    const result = await transport.sendWebhook(input, { lookup });
    expect(result).toEqual({ kind: 'http', status: 200 });
    expect(transport.telegramReceipt(result)).toBeUndefined();
  });
});
