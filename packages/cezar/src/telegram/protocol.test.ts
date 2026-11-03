import { describe, expect, it } from 'vitest';
import { eligibleText, freshMessage, parseCommand, resolveTask, telegramUpdateSchema, type TelegramMessage } from './protocol.ts';
const message = (text: string): TelegramMessage => ({ message_id: 1, date: 100, chat: { id: 123, type: 'private' }, from: { id: 123, is_bot: false }, text,
  entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] });
describe('Telegram inbound protocol boundary', () => {
  it('requires human text and ignores forwards, topics, bots, media and channels', () => {
    const valid = message('/help'); expect(eligibleText(valid)).toBe(true);
    for (const patch of [{ forward_origin: {} }, { via_bot: {} }, { sender_chat: {} }, { document: {} },
      { from: { id: 123, is_bot: true } }, { message_thread_id: 1 }, { chat: { id: 123, type: 'channel' as const } }]) {
      expect(eligibleText({ ...valid, ...patch })).toBe(false);
    }
    expect(eligibleText({ ...valid, chat: { id: -123, type: 'group' } })).toBe(false);
    expect(eligibleText({ ...valid, chat: { id: -123, type: 'group' } }, true)).toBe(true);
  });
  it('only accepts commands at offset zero addressed to this bot', () => {
    expect(parseCommand(message('/reply@Test_bot abcdef12 yes'), 'test_BOT')).toEqual({ kind: 'command', name: 'reply', args: 'abcdef12 yes' });
    expect(parseCommand(message('/help@other'), 'test_bot')).toEqual({ kind: 'ignore' });
    expect(parseCommand(message('/shell rm'), 'test_bot')).toEqual({ kind: 'unknown' });
    expect(parseCommand({ ...message('/help'), entities: [] }, 'test_bot')).toEqual({ kind: 'unknown' });
    expect(parseCommand({ ...message('hello /help'), entities: [{ type: 'bot_command', offset: 6, length: 5 }] }, 'test_bot')).toEqual({ kind: 'text' });
  });
  it('validates safe IDs, including large negative chat IDs, without truncation', () => {
    const valid = { update_id: 1, message: { ...message('/help'), chat: { id: -1001234567890, type: 'supergroup' } } };
    expect(telegramUpdateSchema.parse(valid).message?.chat.id).toBe(-1001234567890);
    expect(telegramUpdateSchema.safeParse({ ...valid, update_id: Number.MAX_SAFE_INTEGER }).success).toBe(false);
    expect(telegramUpdateSchema.safeParse({ update_id: 1, message: { ...message('/help'), from: { id: 2 ** 54, is_bot: false } } }).success).toBe(false);
  });
  it('rejects expired, pre-enable and future commands', () => {
    const now = 2_000_000;
    expect(freshMessage(now / 1000, now - 1000, now)).toBe(true);
    expect(freshMessage((now - 901_000) / 1000, 0, now)).toBe(false);
    expect(freshMessage((now + 61_000) / 1000, 0, now)).toBe(false);
    expect(freshMessage((now - 1000) / 1000, now, now)).toBe(false);
  });
  it('resolves only unique nonarchived prefixes of at least eight characters', () => {
    const runs = [{ id: '12345678-aaaa' }, { id: '12345678-bbbb' }, { id: 'abcdef12-aaaa', archived: true }];
    expect(resolveTask('12345678', runs)).toBeUndefined();
    expect(resolveTask('12345678-a', runs)).toEqual(runs[0]);
    expect(resolveTask('abcdef12', runs)).toBeUndefined();
    expect(resolveTask('123', runs)).toBeUndefined();
  });
});
