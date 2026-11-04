import { describe, expect, it } from 'vitest';
import { MessageReceipts } from './message-receipts.ts';

describe('MessageReceipts (telemetry 1a212342)', () => {
  const landed = async (receipts: MessageReceipts<string>, key: string, answer: string) => {
    const claim = await receipts.claim(key);
    if (!('settle' in claim)) throw new Error(`${key} was already claimed`);
    claim.settle(answer);
  };

  it('answers a landed key with its first response', async () => {
    const receipts = new MessageReceipts<string>();
    await landed(receipts, 'k', 'first');
    expect(await receipts.claim('k')).toEqual({ prior: 'first' });
  });

  it('makes a concurrent claim wait for the attempt in flight', async () => {
    const receipts = new MessageReceipts<string>();
    const first = await receipts.claim('k');
    if (!('settle' in first)) throw new Error('first claim must own the key');
    let second: unknown;
    const waiting = receipts.claim('k').then((claim) => (second = claim));
    await Promise.resolve();
    expect(second).toBeUndefined();
    first.settle('done');
    await waiting;
    expect(second).toEqual({ prior: 'done' });
  });

  it('hands a refused key to the next claim afresh', async () => {
    const receipts = new MessageReceipts<string>();
    const first = await receipts.claim('k');
    if (!('settle' in first)) throw new Error('first claim must own the key');
    const waiting = receipts.claim('k');
    first.settle(undefined);
    expect('settle' in (await waiting)).toBe(true);
  });

  it('forgets a receipt once its TTL has passed', async () => {
    let now = 1_000;
    const receipts = new MessageReceipts<string>(10_000, 1_000, () => now);
    await landed(receipts, 'old', 'answer');
    now += 10_001;
    expect('settle' in (await receipts.claim('old'))).toBe(true);
  });

  it('keeps at most `max` receipts, dropping the oldest first', async () => {
    const receipts = new MessageReceipts<string>(60_000, 2, () => 0);
    await landed(receipts, 'a', 'A');
    await landed(receipts, 'b', 'B');
    await landed(receipts, 'c', 'C');
    // The claim for `c` already pruned to two before inserting it, so `a` is the one gone.
    expect(await receipts.claim('c')).toEqual({ prior: 'C' });
    expect(await receipts.claim('b')).toEqual({ prior: 'B' });
    expect('settle' in (await receipts.claim('a'))).toBe(true);
  });
});
