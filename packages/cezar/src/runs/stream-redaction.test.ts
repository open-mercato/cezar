import { describe, expect, it } from 'vitest';
import { StreamRedaction } from './stream-redaction.ts';

const SECRET = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';
const delta = (sessionKey: string | undefined, text: string) => ({
  type: 'item.delta', stepId: 'council', itemId: 'item_1', field: 'text', delta: text,
  ...(sessionKey ? { sessionKey } : {}),
});

describe('session-scoped stream redaction', () => {
  it('keeps concurrent delta tails isolated on the same step and item', () => {
    const redaction = new StreamRedaction();
    expect(redaction.transform('run', delta('a', 'A g'), [SECRET]).delta).toBe('A ');
    expect(redaction.transform('run', delta('b', 'B'), [SECRET]).delta).toBe('B');
    expect(redaction.transform('run', delta('a', SECRET.slice(1)), [SECRET]).delta).toBe('[REDACTED]');
  });

  it.each(['item.completed', 'turn.completed', 'session.ended'])('drains only the ending session at %s and preserves its key', (type) => {
    const redaction = new StreamRedaction();
    redaction.transform('run', delta('a', 'A g'), [SECRET]);
    redaction.transform('run', delta('b', 'B gh'), [SECRET]);
    expect(redaction.drain('run', { type, stepId: 'council', sessionKey: 'b', item: { id: 'item_1' } }))
      .toEqual([delta('b', 'gh')]);
    expect(redaction.drain('run', { type, stepId: 'council', sessionKey: 'a', item: { id: 'item_1' } }))
      .toEqual([delta('a', 'g')]);
  });

  it('keeps snapshot replacements scoped to their own session', () => {
    const redaction = new StreamRedaction();
    redaction.transform('run', delta('a', 'A g'), [SECRET]);
    redaction.transform('run', { type: 'item.updated', stepId: 'council', sessionKey: 'b', item: { id: 'item_1', kind: 'message', text: 'B' } }, [SECRET]);
    expect(redaction.drain('run', { type: 'turn.completed', stepId: 'council', sessionKey: 'a' })).toEqual([delta('a', 'g')]);
  });

  it('guard: preserves streaming and drain behavior without a session key', () => {
    const redaction = new StreamRedaction();
    expect(redaction.transform('run', delta(undefined, 'hello g'), [SECRET]).delta).toBe('hello ');
    expect(redaction.drain('run', { type: 'turn.completed', stepId: 'council' })).toEqual([delta(undefined, 'g')]);
  });
});
